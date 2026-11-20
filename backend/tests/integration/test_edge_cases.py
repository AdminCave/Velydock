"""The cases beside the happy path: odd identities, half-failed operations, races, hostile input.

Each test here pins down a defect that an independent review found in version 0.1 - most of them
places where a request ended in "Internal Server Error", or where Velydock and the identity
provider could drift apart.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlalchemy import select, update

from tests.conftest import World
from tests.support.mini_idp import Identity
from velydock.api.deps import TENANT_HEADER
from velydock.db import Scope, transaction
from velydock.idp.base import IdpError, IdpUnavailable
from velydock.models import AuditLog, AuthSession, Membership, Role, Tenant, User
from velydock.security.http import MAX_BODY_BYTES


async def sign_in(
    world: World, identity: Identity, **claims: object
) -> tuple[httpx.AsyncClient, httpx.Response]:
    client = world.client()
    start = await client.get("/api/auth/login")
    response = await client.get(world.mini.authorize(start.headers["location"], identity, **claims))
    return client, response


async def users() -> dict[str, User]:
    async with transaction(Scope.SYSTEM) as db:
        return {u.username: u for u in (await db.execute(select(User))).scalars()}


async def session_count(user: User) -> int:
    async with transaction(Scope.SYSTEM) as db:
        rows = await db.execute(select(AuthSession).where(AuthSession.user_id == user.id))
        return len(list(rows.scalars()))


async def audit_actions() -> list[str]:
    async with transaction(Scope.SYSTEM) as db:
        return [a.action for a in (await db.execute(select(AuditLog).order_by(AuditLog.id))).scalars()]


@pytest.fixture
async def acme(world: World) -> Tenant:
    return await world.tenant("Acme")


class TestSignInWithUnusualIdentities:
    """Accounts from a directory or made in Keycloak do not look like the ones Velydock creates."""

    async def test_an_identity_without_e_mail_address_is_provisioned(self, world: World) -> None:
        client, response = await sign_in(world, Identity(str(uuid.uuid4()), "ldap.user"))
        async with client:
            assert response.status_code == 302 and response.headers["location"] == "/"
            me = (await client.get("/api/v1/me")).json()
        assert me["user"]["username"] == "ldap.user" and me["user"]["email"] is None

    async def test_a_known_user_whose_address_was_removed_still_signs_in(
        self, world: World, acme: Tenant
    ) -> None:
        anna = await world.user(acme, "anna", email="anna@acme.example")
        identity = Identity(anna.idp_id, "anna", None, "Anna", "Test")
        client, response = await sign_in(world, identity)
        await client.aclose()
        assert response.headers["location"] == "/"
        assert (await users())["anna"].email is None

    async def test_two_identities_without_address_do_not_collide(self, world: World) -> None:
        for name in ("first.user", "second.user"):
            client, response = await sign_in(world, Identity(str(uuid.uuid4()), name))
            await client.aclose()
            assert response.headers["location"] == "/"

    async def test_names_longer_than_the_columns_are_cut(self, world: World) -> None:
        identity = Identity(str(uuid.uuid4()), "longname", None, "A" * 180, "B" * 255)
        client, response = await sign_in(world, identity)
        await client.aclose()
        assert response.headers["location"] == "/"
        user = (await users())["longname"]
        assert (len(user.first_name), len(user.last_name)) == (100, 100)

    async def test_a_user_name_that_cannot_be_stored_is_refused_cleanly(self, world: World) -> None:
        client, response = await sign_in(world, Identity(str(uuid.uuid4()), "u" * 200))
        await client.aclose()
        assert response.headers["location"] == "/login?error=account_conflict"

    async def test_a_renamed_account_keeps_its_name_while_another_row_holds_the_new_one(
        self, world: World, acme: Tenant
    ) -> None:
        anna = await world.user(acme, "anna")
        await world.user(acme, "stale")  # a row whose account was renamed or removed in Keycloak
        client, response = await sign_in(world, Identity(anna.idp_id, "stale", None, "Anna", "Test"))
        await client.aclose()
        assert response.headers["location"] == "/", "the sign-in itself must not fail"
        assert {u.username for u in (await users()).values()} == {"anna", "stale"}

    async def test_two_simultaneous_first_sign_ins_of_one_identity(self, world: World) -> None:
        identity = Identity(str(uuid.uuid4()), "newcomer", "new@acme.example")
        results = await asyncio.gather(sign_in(world, identity), sign_in(world, identity, sid="sid-2"))
        for client, response in results:
            await client.aclose()
            assert response.headers["location"] == "/", "neither browser sees an error"
        assert list(await users()) == ["newcomer"]

    async def test_a_non_ascii_state_is_a_mismatch_not_an_error(self, world: World, acme: Tenant) -> None:
        anna = await world.user(acme, "anna")
        async with world.client() as client:
            start = await client.get("/api/auth/login")
            callback = world.mini.authorize(start.headers["location"], world.identity(anna))
            code = parse_qs(urlsplit(callback).query)["code"][0]
            response = await client.get("/api/auth/callback", params={"code": code, "state": "ä"})
        assert response.headers["location"] == "/login?error=state"


class TestSignOutWithoutALiveSession:
    """Signing out must end the Keycloak session even when the Velydock session is already gone."""

    async def expire(self, user: User) -> None:
        async with transaction(Scope.SYSTEM) as db:
            await db.execute(
                update(AuthSession)
                .where(AuthSession.user_id == user.id)
                .values(last_seen_at=datetime.now(UTC) - timedelta(hours=5))
            )

    async def test_after_the_idle_timeout_sign_out_still_ends_the_provider_session(
        self, world: World, acme: Tenant
    ) -> None:
        anna = await world.user(acme, "anna")
        async with await world.login(anna) as client:
            await self.expire(anna)
            assert (await client.get("/api/v1/me")).status_code == 401
            response = await client.post("/api/auth/logout")
            assert response.status_code == 200
            url = urlsplit(response.json()["redirect_url"])
            query = {k: v[0] for k, v in parse_qs(url.query).items()}
            assert url.path.endswith("/protocol/openid-connect/logout")
            # The stored token still names the session at the provider, so it ends without a question.
            assert query["id_token_hint"] == "id-token"
            assert "Max-Age=0" in response.headers["set-cookie"] or '=""' in response.headers["set-cookie"]
        assert await session_count(anna) == 0

    async def test_without_any_session_the_answer_still_leads_to_the_provider(self, world: World) -> None:
        async with world.client() as client:
            response = await client.post("/api/auth/logout")
        assert response.status_code == 200
        query = parse_qs(urlsplit(response.json()["redirect_url"]).query)
        assert query["client_id"] == ["velydock"] and "id_token_hint" not in query

    async def test_it_still_needs_the_csrf_header(self, world: World) -> None:
        async with world.client(csrf=False) as client:
            assert (await client.post("/api/auth/logout")).status_code == 403


class TestSessionEndsWhileARequestRuns:
    async def test_the_request_is_answered_as_signed_out_not_as_an_error(
        self, world: World, acme: Tenant, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A sign-out in another tab can remove the session row between the moment a request
        has read it and the moment it writes to it."""
        from sqlalchemy import delete

        from velydock.api import deps

        anna = await world.user(acme, "anna")
        original = deps.resolve_tenant

        async def session_vanishes_meanwhile(db: object, user: object, session: object) -> object:
            chosen = await original(db, user, session)  # type: ignore[arg-type]
            async with transaction(Scope.SYSTEM) as other:
                await other.execute(delete(AuthSession).where(AuthSession.user_id == anna.id))
            return chosen

        monkeypatch.setattr(deps, "resolve_tenant", session_vanishes_meanwhile)
        async with await world.login(anna) as client:
            response = await client.get("/api/v1/me")
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "not_authenticated"


class TestAnonymousGarbage:
    """Requests anyone can send must end in a refusal, never in an unhandled error."""

    async def test_logout_token_naming_the_real_key_with_another_algorithm(self, world: World) -> None:
        import base64
        import json

        def b64(data: dict[str, object]) -> str:
            return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()

        forged = f"{b64({'alg': 'ES256', 'kid': world.mini.kid})}.{b64({'sub': 'x'})}.AAAA"
        async with world.client(csrf=False) as client:
            response = await client.post(
                "/api/auth/backchannel-logout",
                content=f"logout_token={forged}",
                headers={"content-type": "application/x-www-form-urlencoded"},
            )
        assert response.status_code == 400

    async def test_oversized_bodies_are_refused_before_anything_reads_them(self, world: World) -> None:
        async with world.client(csrf=False) as client:
            for path in ("/api/auth/backchannel-logout", "/api/v1/admin/groups"):
                response = await client.post(path, content=b"a" * (MAX_BODY_BYTES + 1))
                assert response.status_code == 413, path
                assert response.json()["error"]["code"] == "too_large"

    async def test_nul_bytes_in_the_query_are_refused(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            assert (await client.get("/api/v1/admin/users?search=a%00b")).status_code == 400

    async def test_the_sandbox_host_with_a_trailing_dot_is_still_the_sandbox(self, world: World) -> None:
        async with world.client(base_url="https://sandbox.test.") as client:
            assert (await client.get("/api/health")).status_code == 404
            assert (await client.get("/api/v1/public")).status_code == 404


class TestExpectedOrganization:
    """The active organization belongs to the session. A tab that still shows another one says so,
    and its changes are refused instead of landing in the wrong organization."""

    async def test_a_change_meant_for_another_organization_is_refused(self, world: World) -> None:
        acme, globex = await world.tenant("Acme"), await world.tenant("Globex")
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(root, acme) as tab:
            # Tab A shows Acme. Tab B (same session) enters Globex.
            switched = await tab.post("/api/v1/me/active-tenant", json={"tenant_id": str(globex.id)})
            assert switched.status_code == 200
            stale = {TENANT_HEADER: str(acme.id)}
            created = await tab.post("/api/v1/admin/groups", json={"name": "Büro"}, headers=stale)
            assert created.status_code == 409
            assert created.json()["error"]["code"] == "tenant_changed"
            assert (await tab.get("/api/v1/admin/users", headers=stale)).status_code == 409
            # Nothing was created in Globex.
            assert (await tab.get("/api/v1/admin/groups")).json() == []
            # With the right organization, and without the header (scripts), it works as before.
            fresh = {TENANT_HEADER: str(globex.id)}
            assert (
                await tab.post("/api/v1/admin/groups", json={"name": "Büro"}, headers=fresh)
            ).status_code == 201
            assert (await tab.post("/api/v1/admin/groups", json={"name": "Lager"})).status_code == 201

    async def test_reading_who_i_am_and_switching_are_never_refused(self, world: World) -> None:
        acme, globex = await world.tenant("Acme"), await world.tenant("Globex")
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(root, acme) as client:
            stale = {TENANT_HEADER: str(globex.id)}
            me = await client.get("/api/v1/me", headers=stale)
            assert me.status_code == 200 and me.json()["active_tenant"]["id"] == str(acme.id)
            switch = await client.post(
                "/api/v1/me/active-tenant",
                json={"tenant_id": str(globex.id)},
                headers={TENANT_HEADER: str(acme.id)},
            )
            assert switch.status_code == 200

    async def test_the_header_cannot_select_an_organization(self, world: World) -> None:
        acme, globex = await world.tenant("Acme"), await world.tenant("Globex")
        anna = await world.user(acme, "anna", Role.TENANT_ADMIN)
        await world.user(globex, "gina", Role.TENANT_ADMIN)
        async with await world.login(anna) as client:
            response = await client.get("/api/v1/admin/users", headers={TENANT_HEADER: str(globex.id)})
            assert response.status_code == 409
            assert "gina" not in response.text

    async def test_a_removed_membership_shows_as_a_changed_organization(self, world: World) -> None:
        acme, globex = await world.tenant("Acme"), await world.tenant("Globex")
        anna = await world.user(acme, "anna", Role.TENANT_ADMIN)
        await world.member(globex, anna, Role.TENANT_ADMIN)
        async with await world.login(anna, globex) as client:
            assert (await client.get("/api/v1/me")).json()["active_tenant"]["id"] == str(globex.id)
            async with transaction(Scope.SYSTEM) as db:
                membership = (
                    await db.execute(
                        select(Membership).where(
                            Membership.tenant_id == globex.id, Membership.user_id == anna.id
                        )
                    )
                ).scalar_one()
                await db.delete(membership)
            response = await client.post(
                "/api/v1/admin/groups", json={"name": "Büro"}, headers={TENANT_HEADER: str(globex.id)}
            )
            assert response.status_code == 409, (
                "the session fell back to Acme; the change must not land there"
            )


class TestNewRightsNeedANewSession:
    """The second-factor rule is enforced at sign-in, so a running session must not gain admin rights."""

    async def test_a_promoted_member_is_sent_through_sign_in_again(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia")
        async with await world.login(admin) as boss, await world.login(mia) as member:
            assert (await member.get("/api/v1/admin/users")).status_code == 403
            assert (
                await boss.patch(f"/api/v1/admin/users/{mia.id}", json={"role": "tenant_admin"})
            ).status_code == 200
            # The session that began as a plain member is over; it never sees the admin API.
            assert (await member.get("/api/v1/admin/users")).status_code == 401
            assert (await boss.get("/api/v1/me")).status_code == 200, "the administrator stays signed in"

    async def test_a_demotion_takes_effect_at_once_without_signing_out(
        self, world: World, acme: Tenant
    ) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        uwe = await world.user(acme, "uwe", Role.USER_MANAGER)
        async with await world.login(admin) as boss, await world.login(uwe) as manager:
            assert (
                await boss.patch(f"/api/v1/admin/users/{uwe.id}", json={"role": "member"})
            ).status_code == 200
            assert (await manager.get("/api/v1/me")).status_code == 200
            assert (await manager.get("/api/v1/admin/users")).status_code == 403

    async def test_a_new_system_administrator_is_sent_through_sign_in_again(
        self, world: World, acme: Tenant
    ) -> None:
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        mia = await world.user(acme, "mia")
        async with await world.login(root) as boss, await world.login(mia) as member:
            granted = await boss.patch(f"/api/v1/system/users/{mia.id}", json={"is_system_admin": True})
            assert granted.status_code == 200, granted.text
            assert (await member.get("/api/v1/me")).status_code == 401

    async def test_a_guest_added_as_administrator_is_sent_through_sign_in_again(self, world: World) -> None:
        acme, globex = await world.tenant("Acme"), await world.tenant("Globex")
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        gero = await world.user(globex, "gero")
        async with await world.login(root) as boss, await world.login(gero) as member:
            added = await boss.post(
                f"/api/v1/system/tenants/{acme.id}/members",
                json={"user_id": str(gero.id), "role": "tenant_admin"},
            )
            assert added.status_code == 201, added.text
            assert (await member.get("/api/v1/me")).status_code == 401


class TestHalfFailedChanges:
    """Velydock and the identity provider are changed one after the other. A failure in between
    must not leave them telling different stories."""

    async def test_locking_an_account_holds_even_if_its_provider_sessions_cannot_be_ended(
        self, world: World, acme: Tenant
    ) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia")
        async with await world.login(admin) as boss, await world.login(mia) as member:
            world.idp.fail_next, world.idp.fail_on = IdpUnavailable("timeout"), "logout_user"
            response = await boss.patch(f"/api/v1/admin/users/{mia.id}", json={"active": False})
            assert response.status_code == 200 and response.json()["active"] is False
            assert world.idp.users[mia.idp_id].enabled is False
            assert (await member.get("/api/v1/me")).status_code == 401, "the Velydock session ended"
        assert "user.update" in await audit_actions()

    async def test_a_profile_change_is_taken_back_if_the_lock_then_fails(
        self, world: World, acme: Tenant
    ) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia", email="mia@acme.example", first_name="Alt")
        async with await world.login(admin) as boss:
            world.idp.fail_next, world.idp.fail_on = IdpError("refused"), "set_enabled"
            response = await boss.patch(
                f"/api/v1/admin/users/{mia.id}",
                json={"first_name": "Neu", "email": "neu@acme.example", "active": False},
            )
            assert response.status_code == 502
        fake = world.idp.users[mia.idp_id]
        stored = (await users())["mia"]
        assert (
            (fake.first_name, fake.email) == (stored.first_name, stored.email) == ("Alt", "mia@acme.example")
        )

    async def test_a_failure_after_the_account_exists_removes_it_again(
        self, world: World, acme: Tenant, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Otherwise the user name is blocked for everyone while no such user is visible anywhere."""
        from velydock.services import users as users_service

        async def failing_record(*args: object, **kwargs: object) -> None:
            raise RuntimeError("audit log unavailable")

        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        transport = httpx.ASGITransport(app=world.app, raise_app_exceptions=False)
        async with await world.login(admin) as boss:
            boss._transport = transport
            monkeypatch.setattr(users_service.audit, "record", failing_record)
            failed = await boss.post(
                "/api/v1/admin/users", json={"username": "mia", "first_name": "Mia", "last_name": "M"}
            )
            assert failed.status_code == 500
            assert "mia" not in {u.username for u in world.idp.users.values()}
            monkeypatch.undo()
            retried = await boss.post(
                "/api/v1/admin/users", json={"username": "mia", "first_name": "Mia", "last_name": "M"}
            )
            assert retried.status_code == 201

    async def test_an_organization_left_over_from_a_failed_attempt_is_taken_over(self, world: World) -> None:
        acme = await world.tenant("Acme")
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        # Left behind in the identity provider, still with a member, but no tenant uses the name.
        leftover = await world.idp.create_organization(name="Globex alt", alias="globex")
        await world.idp.add_organization_member(leftover, root.idp_id)
        async with await world.login(root) as client:
            created = await client.post("/api/v1/system/tenants", json={"slug": "globex", "name": "Globex"})
            assert created.status_code == 201, created.text
        async with transaction(Scope.SYSTEM) as db:
            tenant = (await db.execute(select(Tenant).where(Tenant.slug == "globex"))).scalar_one()
        assert tenant.idp_org_id == leftover
        assert world.idp.organizations[leftover]["name"] == "Globex"
        assert world.idp.members[leftover] == set(), "nobody inherits membership of the new organization"

    async def test_a_name_clash_with_a_living_organization_is_still_a_conflict(self, world: World) -> None:
        acme = await world.tenant("Acme")
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        await world.idp.create_organization(name="Globex", alias="other-alias")
        async with await world.login(root) as client:
            created = await client.post("/api/v1/system/tenants", json={"slug": "globex", "name": "Globex"})
        assert created.status_code == 409


class TestRankRulesEverywhere:
    async def test_groups_of_higher_ranks_cannot_be_changed_through_the_group_either(
        self, world: World, acme: Tenant
    ) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        manager = await world.user(acme, "uwe", Role.USER_MANAGER)
        mia = await world.user(acme, "mia")
        group = await world.group(acme, "Büro", [admin, root, mia])
        everyone = [str(u.id) for u in (admin, root, mia)]
        async with await world.login(manager) as client:
            url = f"/api/v1/admin/groups/{group.id}"
            # Removing the administrators: refused, like in user administration.
            assert (await client.patch(url, json={"member_ids": []})).status_code == 403
            assert (await client.patch(url, json={"member_ids": [str(mia.id)]})).status_code == 403
            # Changing only members of the own rank or below: fine, the others stay untouched.
            kept = await client.patch(url, json={"member_ids": [str(admin.id), str(root.id)]})
            assert kept.status_code == 200
            assert sorted(kept.json()["member_ids"]) == sorted([str(admin.id), str(root.id)])
            # Renaming needs no member rights at all.
            assert (await client.patch(url, json={"name": "Büro 2"})).status_code == 200
            # A new group must not pull an administrator in either.
            assert (
                await client.post("/api/v1/admin/groups", json={"name": "Chefs", "member_ids": everyone})
            ).status_code == 403
            assert (
                await client.post("/api/v1/admin/groups", json={"name": "Team", "member_ids": [str(mia.id)]})
            ).status_code == 201
        async with await world.login(admin) as client:
            assert (
                await client.patch(f"/api/v1/admin/groups/{group.id}", json={"member_ids": []})
            ).status_code == 403
        async with await world.login(root) as client:
            assert (
                await client.patch(f"/api/v1/admin/groups/{group.id}", json={"member_ids": []})
            ).status_code == 200

    async def test_nobody_changes_their_own_role_not_even_a_system_administrator(
        self, world: World, acme: Tenant
    ) -> None:
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(root) as client:
            response = await client.patch(f"/api/v1/admin/users/{root.id}", json={"role": "member"})
            assert response.status_code == 403
            assert (await client.get(f"/api/v1/admin/users/{root.id}")).json()["can_assign_role"] is False

    async def test_own_password_and_sessions_are_not_handled_through_administration(
        self, world: World, acme: Tenant
    ) -> None:
        """Ending the session a request runs in would make the provider's logout notification wait
        for that very request."""
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            for action in ("reset-password", "end-sessions"):
                response = await client.post(f"/api/v1/admin/users/{admin.id}/{action}")
                assert response.status_code == 422, action
                assert response.json()["error"]["code"] == "self_action"
            assert (await client.get("/api/v1/me")).status_code == 200
        assert world.idp.logged_out == []

    async def test_two_system_administrators_cannot_remove_each_other_at_the_same_moment(
        self, world: World, acme: Tenant
    ) -> None:
        first = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        second = await world.user(acme, "ruth", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(first) as a, await world.login(second) as b:
            results = await asyncio.gather(
                a.patch(f"/api/v1/system/users/{second.id}", json={"is_system_admin": False}),
                b.patch(f"/api/v1/system/users/{first.id}", json={"is_system_admin": False}),
            )
        assert sorted(r.status_code for r in results) == [200, 422]
        remaining = [u for u in (await users()).values() if u.is_system_admin]
        assert len(remaining) == 1

    async def test_the_last_active_system_administrator_cannot_be_locked(
        self, world: World, acme: Tenant
    ) -> None:
        first = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        second = await world.user(acme, "ruth", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(first) as a, await world.login(second) as b:
            results = await asyncio.gather(
                a.patch(f"/api/v1/admin/users/{second.id}", json={"active": False}),
                b.patch(f"/api/v1/admin/users/{first.id}", json={"active": False}),
            )
        # One of them wins. The other is refused - as the last one standing (422), or because the
        # two requests blocked each other and the database ended one (409, "try again").
        statuses = sorted(r.status_code for r in results)
        assert statuses in ([200, 409], [200, 422]), [r.text for r in results]
        refused = next(r for r in results if r.status_code != 200)
        assert refused.json()["error"]["code"] in ("try_again", "last_system_admin")
        assert sum(u.active for u in (await users()).values() if u.is_system_admin) == 1


class TestInputThatUsedToEndInAnError:
    @pytest.mark.parametrize(
        "url",
        ["https://example.com:99999/", "https://[::1/", "https://example..com/", "https://exa mple.com/"],
    )
    async def test_addresses_that_are_none(self, world: World, acme: Tenant, url: str) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            for app_type in ("embedded", "external"):
                created = await client.post(
                    "/api/v1/admin/apps", json={"name": "Wiki", "type": app_type, "url": url}
                )
                assert created.status_code == 422, (app_type, created.text)
                assert created.json()["error"]["code"] == "url_invalid"
            checked = await client.post("/api/v1/admin/apps/check-embed", json={"url": url})
            assert checked.status_code in (200, 422)
            if checked.status_code == 200:
                assert checked.json()["status"] == "unknown"

    async def test_nul_characters_in_a_body(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            for path, body in (
                ("/api/v1/admin/groups", {"name": "Büro\x00"}),
                ("/api/v1/admin/apps", {"name": "Notizen", "type": "custom", "custom_html": "a\x00b"}),
                ("/api/v1/admin/users", {"username": "mia", "first_name": "M\x00", "last_name": "M"}),
            ):
                assert (await client.post(path, json=body)).status_code == 422, path

    async def test_null_for_a_system_setting_means_unchanged(self, world: World, acme: Tenant) -> None:
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(root) as client:
            before = (await client.get("/api/v1/system/settings")).json()
            response = await client.patch(
                "/api/v1/system/settings",
                json={"instance_name": None, "default_theme": None, "default_language": "en"},
            )
            assert response.status_code == 200, response.text
            after = response.json()
        assert after["instance_name"] == before["instance_name"]
        assert after["default_theme"] == before["default_theme"]
        assert after["default_language"] == "en"

    async def test_adding_the_same_member_twice_at_once(self, world: World) -> None:
        acme, globex = await world.tenant("Acme"), await world.tenant("Globex")
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        gero = await world.user(globex, "gero")
        body = {"user_id": str(gero.id), "role": "member"}
        async with await world.login(root) as a, await world.login(root) as b:
            results = await asyncio.gather(
                a.post(f"/api/v1/system/tenants/{acme.id}/members", json=body),
                b.post(f"/api/v1/system/tenants/{acme.id}/members", json=body),
            )
        assert sorted(r.status_code for r in results) == [201, 409]

    async def test_unknown_fields_are_refused_when_opening_an_app(self, world: World, acme: Tenant) -> None:
        mia = await world.user(acme, "mia")
        app = await world.app_(acme, "Wiki")
        async with await world.login(mia) as client:
            response = await client.post(
                f"/api/v1/workspace/apps/{app.id}/launch", json={"theme": "dark", "tenant_id": str(acme.id)}
            )
        assert response.status_code == 422

    async def test_user_names_and_names_the_provider_would_refuse(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            for body in (
                {"username": "zq", "first_name": "Zoe", "last_name": "Q"},
                {"username": "anne", "first_name": "Anne", "last_name": "Müller (extern)"},
            ):
                response = await client.post("/api/v1/admin/users", json=body)
                assert response.status_code == 422, body
        assert set(world.idp.users) == {admin.idp_id}, "nothing reached the identity provider"
