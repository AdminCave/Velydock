"""Sign-in, sessions and sign-out, end to end through the HTTP API.

The identity provider is the test double from ``tests/support/mini_idp.py``; the relying-party
code under test is the production code.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import httpx
from sqlalchemy import select, update

from tests.conftest import World, refusal
from tests.support.mini_idp import Identity
from velydock.db import Scope, transaction
from velydock.models import AuthSession, Role, User
from velydock.security.http import CSRF_HEADER


async def start_login(client: httpx.AsyncClient, return_to: str = "/") -> str:
    response = await client.get("/api/auth/login", params={"return_to": return_to})
    assert response.status_code == 302, response.text
    return response.headers["location"]


async def sign_in(
    world: World, identity: Identity, *, return_to: str = "/", **claims: object
) -> tuple[httpx.AsyncClient, httpx.Response]:
    client = world.client()
    authorization_url = await start_login(client, return_to)
    response = await client.get(world.mini.authorize(authorization_url, identity, **claims))
    return client, response


async def session_rows() -> list[AuthSession]:
    async with transaction(Scope.SYSTEM) as db:
        return list((await db.execute(select(AuthSession))).scalars())


class TestSignIn:
    async def test_login_redirects_to_the_identity_provider_with_pkce(self, world: World) -> None:
        async with world.client() as client:
            location = await start_login(client)
        url = urlsplit(location)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        assert (
            f"{url.scheme}://{url.netloc}{url.path}"
            == "https://auth.test/realms/velydock/protocol/openid-connect/auth"
        )
        assert query["client_id"] == "velydock"
        assert query["redirect_uri"] == "https://dock.test/api/auth/callback"
        assert query["code_challenge_method"] == "S256"
        assert len(query["state"]) >= 20 and len(query["nonce"]) >= 20 and len(query["code_challenge"]) >= 43

    async def test_successful_sign_in_creates_a_session(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna", Role.TENANT_ADMIN, email="anna@acme.example")
        client, response = await sign_in(world, world.identity(anna), return_to="/admin/users")
        async with client:
            assert response.status_code == 302
            assert response.headers["location"] == "/admin/users"
            me = await client.get("/api/v1/me")
            assert me.status_code == 200
            assert me.json()["user"]["username"] == "anna"
        rows = await session_rows()
        assert len(rows) == 1 and rows[0].idp_sid == "sid-1"

    async def test_session_cookie_is_locked_down(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        client, response = await sign_in(world, world.identity(anna))
        await client.aclose()
        cookies = [
            c for c in response.headers.get_list("set-cookie") if c.startswith("__Host-velydock_session=")
        ]
        assert len(cookies) == 1
        attributes = [part.strip().lower() for part in cookies[0].split(";")[1:]]
        assert "httponly" in attributes
        assert "secure" in attributes
        assert "samesite=lax" in attributes
        assert "path=/" in attributes
        assert not [a for a in attributes if a.startswith("domain")]

    async def test_only_a_hash_of_the_cookie_is_stored(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        client, _ = await sign_in(world, world.identity(anna))
        value = client.cookies.get("__Host-velydock_session")
        await client.aclose()
        assert value
        rows = await session_rows()
        assert rows[0].id_hash != value and len(rows[0].id_hash) == 64

    async def test_state_mismatch_is_rejected(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        async with world.client() as client:
            callback = world.mini.authorize(await start_login(client), world.identity(anna))
            tampered = callback.replace("state=", "state=x")
            response = await client.get(tampered)
            assert response.headers["location"] == "/login?error=state"
            assert (await client.get("/api/v1/me")).status_code == 401
        assert await session_rows() == []

    async def test_callback_without_login_cookie_is_rejected(self, world: World) -> None:
        """A callback URL is useless in another browser: the state is bound to a cookie."""
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        async with world.client() as victim_browser:
            callback = world.mini.authorize(await start_login(victim_browser), world.identity(anna))
        async with world.client() as attacker_browser:
            response = await attacker_browser.get(callback)
            assert response.headers["location"] == "/login?error=expired"
        assert await session_rows() == []

    async def test_authorization_code_cannot_be_replayed(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        async with world.client() as client:
            callback = world.mini.authorize(await start_login(client), world.identity(anna))
            login_cookie = client.cookies.get("__Host-velydock_login")
            assert (await client.get(callback)).headers["location"] == "/"
            client.cookies.set("__Host-velydock_login", login_cookie or "")
            assert (await client.get(callback)).headers["location"] == "/login?error=invalid"
        assert len(await session_rows()) == 1

    async def test_token_with_wrong_nonce_is_rejected(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        client, response = await sign_in(world, world.identity(anna), nonce="injected")
        await client.aclose()
        assert response.headers["location"] == "/login?error=invalid"
        assert await session_rows() == []

    async def test_provider_error_is_reported(self, world: World) -> None:
        async with world.client() as client:
            await start_login(client)
            response = await client.get("/api/auth/callback", params={"error": "access_denied", "state": "x"})
            assert response.headers["location"] == "/login?error=cancelled"

    async def test_disabled_account_cannot_sign_in(self, world: World) -> None:
        acme = await world.tenant("Acme")
        ina = await world.user(acme, "ina", active=False)
        client, response = await sign_in(world, world.identity(ina))
        await client.aclose()
        assert refusal(response) == "disabled"
        assert await session_rows() == []

    async def test_open_redirect_is_not_possible(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        for target in ("https://evil.example/", "//evil.example/", "/\\evil.example"):
            client, response = await sign_in(world, world.identity(anna), return_to=target)
            await client.aclose()
            assert response.headers["location"] == "/"

    async def test_unknown_identity_is_provisioned_without_any_organization(self, world: World) -> None:
        await world.tenant("Acme")
        stranger = Identity("sub-new", "nora", "nora@elsewhere.example", "Nora", "Neu")
        client, response = await sign_in(world, stranger)
        async with client:
            assert response.headers["location"] == "/"
            me = (await client.get("/api/v1/me")).json()
            assert me["user"]["username"] == "nora"
            assert me["active_tenant"] is None
            assert me["permissions"] == []
            assert (await client.get("/api/v1/workspace/apps")).status_code == 403
            assert (await client.get("/api/v1/admin/users")).status_code == 403

    async def test_new_identity_cannot_take_over_an_existing_username(self, world: World) -> None:
        acme = await world.tenant("Acme")
        await world.user(acme, "anna", Role.TENANT_ADMIN, email="anna@acme.example")
        impostor = Identity("another-subject", "anna", "other@elsewhere.example")
        client, response = await sign_in(world, impostor)
        await client.aclose()
        assert refusal(response) == "account_conflict"
        assert await session_rows() == []

    async def test_profile_is_refreshed_from_the_token(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna", first_name="Anna", last_name="Alt")
        renamed = Identity(anna.idp_id, "anna", "anna@new.example", "Anna", "Neu")
        client, _ = await sign_in(world, renamed)
        async with client:
            me = (await client.get("/api/v1/me")).json()["user"]
        assert (me["last_name"], me["email"]) == ("Neu", "anna@new.example")


class TestSecondFactor:
    async def enable(self, world: World) -> None:
        root = await world.user(None, "setup-root", None, system_admin=True, home=None)
        async with await world.login(root) as client:
            assert (
                await client.patch("/api/v1/system/settings", json={"require_admin_2fa": True})
            ).status_code == 200

    async def test_admin_without_second_factor_is_sent_to_enrol(self, world: World) -> None:
        await self.enable(world)
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna", Role.TENANT_ADMIN)
        client, response = await sign_in(world, world.identity(anna))
        async with client:
            # No session yet: the browser is sent to the identity provider once more.
            assert response.status_code == 302
            assert response.headers["location"].startswith("https://auth.test/")
            assert anna.idp_id in world.idp.second_factor_required
            assert (await client.get("/api/v1/me")).status_code == 401
            # The user enrols there and comes back.
            world.idp.second_factors.add(anna.idp_id)
            final = await client.get(world.mini.authorize(response.headers["location"], world.identity(anna)))
            assert final.headers["location"] == "/"
            assert (await client.get("/api/v1/me")).status_code == 200

    async def test_no_endless_loop_if_enrolment_did_not_happen(self, world: World) -> None:
        await self.enable(world)
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna", Role.USER_MANAGER)
        client, response = await sign_in(world, world.identity(anna))
        async with client:
            final = await client.get(world.mini.authorize(response.headers["location"], world.identity(anna)))
            assert refusal(final) == "second_factor_required"

    async def test_members_are_not_forced(self, world: World) -> None:
        await self.enable(world)
        acme = await world.tenant("Acme")
        mia = await world.user(acme, "mia", Role.MEMBER)
        client, response = await sign_in(world, world.identity(mia))
        await client.aclose()
        assert response.headers["location"] == "/"
        assert world.idp.second_factor_required == set()


class TestSessionLifetime:
    async def test_idle_session_expires(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        async with await world.login(anna) as client:
            assert (await client.get("/api/v1/me")).status_code == 200
            idle = datetime.now(UTC) - timedelta(minutes=world.settings.session_idle_minutes + 1)
            async with transaction(Scope.SYSTEM) as db:
                await db.execute(update(AuthSession).values(last_seen_at=idle))
            assert (await client.get("/api/v1/me")).status_code == 401

    async def test_session_ends_at_its_absolute_lifetime_even_if_active(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        async with await world.login(anna) as client:
            async with transaction(Scope.SYSTEM) as db:
                await db.execute(
                    update(AuthSession).values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
                )
            assert (await client.get("/api/v1/me")).status_code == 401

    async def test_activity_keeps_the_session_alive(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        async with await world.login(anna) as client:
            almost_idle = datetime.now(UTC) - timedelta(minutes=world.settings.session_idle_minutes - 5)
            async with transaction(Scope.SYSTEM) as db:
                await db.execute(update(AuthSession).values(last_seen_at=almost_idle))
            assert (await client.get("/api/v1/me")).status_code == 200
            rows = await session_rows()
            assert rows[0].last_seen_at > datetime.now(UTC) - timedelta(minutes=1)

    async def test_unknown_or_forged_cookie_is_rejected(self, world: World) -> None:
        for value in ("", "x", "a" * 43, "../../etc/passwd", "a" * 5000):
            async with world.client(value) as client:
                assert (await client.get("/api/v1/me")).status_code == 401

    async def test_deactivated_user_loses_access_immediately(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        async with await world.login(anna) as client:
            assert (await client.get("/api/v1/me")).status_code == 200
            async with transaction(Scope.SYSTEM) as db:
                await db.execute(update(User).where(User.id == anna.id).values(active=False))
            assert (await client.get("/api/v1/me")).status_code == 401


class TestSignOut:
    async def test_logout_ends_the_session_and_points_to_the_provider(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        async with await world.login(anna) as client:
            response = await client.post("/api/auth/logout")
            assert response.status_code == 200
            url = urlsplit(response.json()["redirect_url"])
            query = {k: v[0] for k, v in parse_qs(url.query).items()}
            assert url.path.endswith("/protocol/openid-connect/logout")
            assert query["post_logout_redirect_uri"] == "https://dock.test/login?signed_out=1"
            assert query["id_token_hint"] == "id-token"
            cleared = response.headers["set-cookie"]
            assert cleared.startswith('__Host-velydock_session=""') or "Max-Age=0" in cleared
            assert (await client.get("/api/v1/me")).status_code == 401
        assert await session_rows() == []

    async def test_stolen_cookie_is_dead_after_logout(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        cookie = await world.session(anna)
        async with world.client(cookie) as client:
            assert (await client.post("/api/auth/logout")).status_code == 200
        async with world.client(cookie) as thief:
            assert (await thief.get("/api/v1/me")).status_code == 401

    async def test_logout_needs_the_csrf_header(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        async with await world.login(anna, csrf=False) as client:
            assert (await client.post("/api/auth/logout")).status_code == 403
            assert (await client.get("/api/v1/me")).status_code == 200


class TestBackChannelLogout:
    async def post(self, world: World, token: str) -> httpx.Response:
        async with world.client(csrf=False) as keycloak:
            return await keycloak.post(
                "/api/auth/backchannel-logout",
                content=f"logout_token={token}",
                headers={"content-type": "application/x-www-form-urlencoded"},
            )

    async def test_ends_exactly_the_named_session(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        laptop = await world.session(anna, sid="sid-laptop")
        phone = await world.session(anna, sid="sid-phone")
        assert (await self.post(world, world.mini.logout_token(sid="sid-laptop"))).status_code == 200
        async with world.client(laptop) as client:
            assert (await client.get("/api/v1/me")).status_code == 401
        async with world.client(phone) as client:
            assert (await client.get("/api/v1/me")).status_code == 200

    async def test_subject_only_token_ends_all_sessions_of_the_user(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        mia = await world.user(acme, "mia")
        await world.session(anna)
        await world.session(anna)
        mias = await world.session(mia)
        assert (await self.post(world, world.mini.logout_token(sub=anna.idp_id))).status_code == 200
        rows = await session_rows()
        assert [r.user_id for r in rows] == [mia.id]
        async with world.client(mias) as client:
            assert (await client.get("/api/v1/me")).status_code == 200

    async def test_forged_or_malformed_tokens_end_nothing(self, world: World) -> None:
        from cryptography.hazmat.primitives.asymmetric import rsa

        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna")
        await world.session(anna, sid="sid-1")
        attacker_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        import jwt

        claims = jwt.decode(world.mini.logout_token(sid="sid-1"), options={"verify_signature": False})
        forged = world.mini.sign(claims, key=attacker_key)
        id_token = world.mini.sign(world.mini.id_token_claims(world.identity(anna), nonce="n"))
        for bad in (
            forged,
            id_token,
            "garbage",
            "",
            world.mini.logout_token(sid="sid-1", aud="other-client"),
        ):
            assert (await self.post(world, bad)).status_code == 400
        assert len(await session_rows()) == 1


class TestCsrf:
    async def test_state_changes_need_the_custom_header(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(anna, csrf=False) as client:
            assert (await client.get("/api/v1/admin/groups")).status_code == 200
            response = await client.post("/api/v1/admin/groups", json={"name": "Hacked"})
            assert response.status_code == 403
            assert response.json()["error"]["code"] == "csrf"
            assert (await client.get("/api/v1/admin/groups")).json() == []

    async def test_foreign_origin_is_rejected_even_with_the_header(self, world: World) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(anna) as client:
            for headers in (
                {"Origin": "https://evil.example"},
                {"Origin": "https://sandbox.test"},
                {"Origin": "null"},
                {"Sec-Fetch-Site": "cross-site"},
                {"Sec-Fetch-Site": "same-site"},
            ):
                response = await client.post("/api/v1/admin/groups", json={"name": "Hacked"}, headers=headers)
                assert response.status_code == 403, headers
            ok = await client.post(
                "/api/v1/admin/groups",
                json={"name": "Legit"},
                headers={"Origin": "https://dock.test", "Sec-Fetch-Site": "same-origin", CSRF_HEADER: "1"},
            )
            assert ok.status_code == 201


class TestSecurityHeaders:
    async def test_api_and_error_responses_carry_the_headers(self, world: World) -> None:
        async with world.client() as client:
            for path in ("/api/health", "/api/v1/me", "/api/nope"):
                headers = (await client.get(path)).headers
                csp = headers["content-security-policy"]
                assert "default-src 'self'" in csp
                assert (
                    "script-src 'self'" in csp
                    and "'unsafe-inline'" not in csp.split("script-src")[1].split(";")[0]
                )
                assert "frame-ancestors 'none'" in csp
                assert "object-src 'none'" in csp
                assert headers["x-content-type-options"] == "nosniff"
                assert headers["x-frame-options"] == "DENY"
                assert "max-age=" in headers["strict-transport-security"]
                assert headers["cache-control"] == "no-store"

    async def test_no_cors_headers_are_sent(self, world: World) -> None:
        async with world.client() as client:
            response = await client.get("/api/v1/public", headers={"Origin": "https://evil.example"})
            assert "access-control-allow-origin" not in response.headers
            preflight = await client.options(
                "/api/v1/admin/groups",
                headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
            )
            assert "access-control-allow-origin" not in preflight.headers
