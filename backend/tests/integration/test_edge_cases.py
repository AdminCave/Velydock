"""The cases beside the happy path: odd identities, half-failed operations, races, hostile input.

Each test here pins down a defect that an independent review found in version 0.1 - most of them
places where a request ended in "Internal Server Error", or where Velydock and the identity
provider could drift apart.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from typing import ClassVar
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlalchemy import select, update

from tests.conftest import World, refusal
from tests.support.mini_idp import Identity
from velydock.api.deps import TENANT_HEADER
from velydock.db import Scope, transaction
from velydock.idp.base import IdpError, IdpNotFound, IdpUnavailable
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
        # Its own reason, and the session at the provider is ended: otherwise the next click on
        # "sign in" would run silently into the same refusal.
        assert refusal(response) == "account_unsupported"

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

    @pytest.mark.parametrize("how", ["lock", "delete"])
    async def test_the_last_active_system_administrator_cannot_be_locked_or_deleted(
        self, world: World, acme: Tenant, how: str
    ) -> None:
        """Two system administrators act on each other at the same moment: exactly one wins,
        the other is refused as the last one standing - and both sides agree on the result."""
        first = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        second = await world.user(acme, "ruth", Role.TENANT_ADMIN, system_admin=True)

        def act(client: httpx.AsyncClient, target: User):  # type: ignore[no-untyped-def]
            if how == "lock":
                return client.patch(f"/api/v1/admin/users/{target.id}", json={"active": False})
            return client.delete(f"/api/v1/admin/users/{target.id}")

        async with await world.login(first) as a, await world.login(second) as b:
            results = await asyncio.gather(act(a, second), act(b, first))
        assert sorted(r.status_code for r in results) == [200, 422], [r.text for r in results]
        refused = next(r for r in results if r.status_code == 422)
        assert refused.json()["error"]["code"] == "last_system_admin"

        stored = await users()
        remaining = [u for u in stored.values() if u.is_system_admin and u.active]
        assert len(remaining) == 1
        # The identity provider tells the same story as the database.
        for user in (first, second):
            row = stored.get(user.username)
            fake = world.idp.users.get(user.idp_id)
            if row is None:
                assert fake is None, "deleted here, so deleted there"
            else:
                assert fake is not None and fake.enabled == row.active


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


# ---------------------------------------------------------------------------------------------
# Second review round: Velydock and the identity provider under concurrency and behind its back
# ---------------------------------------------------------------------------------------------


async def session_ids(user: User) -> list[str]:
    async with transaction(Scope.SYSTEM) as db:
        rows = await db.execute(select(AuthSession.idp_sid).where(AuthSession.user_id == user.id))
        return [str(sid) for sid in rows.scalars()]


class TestWhatTheIdentityProviderKnows:
    """Keycloak reports most endings of a session (back-channel logout) - but not an account
    disabled or deleted in its console, a realm-wide sign-out, or a session that ran out there.
    A session in use is therefore checked against it every few minutes."""

    async def test_a_session_that_ended_at_the_provider_ends_here(self, world: World, acme: Tenant) -> None:
        anna = await world.user(acme, "anna")
        laptop = await world.session(anna, sid="sid-laptop")
        phone = await world.session(anna, sid="sid-phone")
        world.idp.ended_sessions.add("sid-laptop")
        async with world.client(laptop) as client:
            assert (await client.get("/api/v1/me")).status_code == 401
        # Stored although the request itself failed: the row is gone, the other session is not.
        assert await session_ids(anna) == ["sid-phone"]
        async with world.client(phone) as client:
            assert (await client.get("/api/v1/me")).status_code == 200
        assert (await users())["anna"].active is True

    @pytest.mark.parametrize("how", ["disabled", "deleted"])
    async def test_an_account_disabled_or_deleted_at_the_provider_is_locked_here(
        self, world: World, acme: Tenant, how: str
    ) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia")
        first, second = await world.session(mia), await world.session(mia)
        if how == "disabled":
            world.idp.users[mia.idp_id].enabled = False
        else:
            del world.idp.users[mia.idp_id]
        async with world.client(first) as client:
            assert (await client.get("/api/v1/me")).status_code == 401
        # Every session of the account is over, and the account shows as deactivated ...
        async with world.client(second) as client:
            assert (await client.get("/api/v1/me")).status_code == 401
        assert await session_ids(mia) == []
        assert (await users())["mia"].active is False
        # ... with an entry in the organization's log that says why.
        async with await world.login(admin) as boss:
            entries = (await boss.get("/api/v1/admin/audit")).json()["items"]
        entry = next(e for e in entries if e["target_label"] == "mia")
        assert entry["action"] == "user.update" and entry["actor_name"] == "system"
        assert how in entry["details"]["reason"]

    async def test_an_account_that_is_gone_at_the_provider_can_be_locked_and_deleted_not_changed(
        self, world: World, acme: Tenant
    ) -> None:
        """Deleted in Keycloak's console, never used again: no session ever notices. The
        administrator who then touches the row is told what is wrong, and can clear it up."""
        anna = await world.user(acme, "anna", Role.TENANT_ADMIN)
        gone = await world.user(acme, "gone")
        async with await world.login(anna) as client:
            for body, operation in (
                ({"first_name": "Neu"}, "update_user"),
                ({"active": True}, "set_enabled"),
            ):
                if operation == "set_enabled":  # reactivating needs an inactive account first
                    assert (
                        await client.patch(f"/api/v1/admin/users/{gone.id}", json={"active": False})
                    ).status_code == 200
                world.idp.fail_next, world.idp.fail_on = IdpNotFound("User not found", status=404), operation
                response = await client.patch(f"/api/v1/admin/users/{gone.id}", json=body)
                assert response.status_code == 409, response.text
                assert response.json()["error"]["code"] == "missing_at_idp"
            assert (
                await client.patch(f"/api/v1/admin/users/{gone.id}", json={"active": True})
            ).status_code == 200
            # Locking stands although the provider has nothing to lock any more.
            world.idp.fail_next, world.idp.fail_on = IdpNotFound("User not found", status=404), "set_enabled"
            locked = await client.patch(f"/api/v1/admin/users/{gone.id}", json={"active": False})
            assert locked.status_code == 200 and locked.json()["active"] is False
            world.idp.fail_next, world.idp.fail_on = (
                IdpNotFound("User not found", status=404),
                "set_temporary_password",
            )
            reset = await client.post(f"/api/v1/admin/users/{gone.id}/reset-password")
            assert (reset.status_code, reset.json()["error"]["code"]) == (409, "missing_at_idp")
            world.idp.fail_next, world.idp.fail_on = IdpNotFound("User not found", status=404), "delete_user"
            assert (await client.delete(f"/api/v1/admin/users/{gone.id}")).status_code == 200

    async def test_an_unreachable_provider_signs_nobody_out(self, world: World, acme: Tenant) -> None:
        anna = await world.user(acme, "anna")
        async with await world.login(anna) as client:
            world.idp.fail_next, world.idp.fail_on = IdpUnavailable("down"), "account_state"
            assert (await client.get("/api/v1/me")).status_code == 200
            assert (await client.get("/api/v1/me")).status_code == 200

    async def test_the_provider_is_asked_once_in_a_while_not_with_every_request(
        self, world: World, acme: Tenant
    ) -> None:
        anna = await world.user(acme, "anna")
        async with await world.login(anna) as client:
            for _ in range(5):
                assert (await client.get("/api/v1/me")).status_code == 200
        assert world.idp.state_checks == [anna.idp_id]

    async def test_a_session_that_just_began_is_not_asked_about(self, world: World, acme: Tenant) -> None:
        anna = await world.user(acme, "anna")
        client, response = await sign_in(world, world.identity(anna))
        async with client:
            assert response.headers["location"] == "/"
            assert (await client.get("/api/v1/me")).status_code == 200
        assert world.idp.state_checks == []

    async def test_a_later_check_ends_a_session_that_was_fine_before(
        self, world: World, acme: Tenant, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from velydock.security import sessions as session_store

        anna = await world.user(acme, "anna")
        cookie = await world.session(anna, sid="sid-1")
        async with world.client(cookie) as client:
            assert (await client.get("/api/v1/me")).status_code == 200
            world.idp.ended_sessions.add("sid-1")
            assert (await client.get("/api/v1/me")).status_code == 200, "not asked again so soon"
            # Five minutes later.
            monkeypatch.setattr(session_store, "_idp_checked", {})
            assert (await client.get("/api/v1/me")).status_code == 401


class TestSessionLifetimeDetails:
    async def test_a_sign_in_without_password_does_not_start_a_new_day(
        self, world: World, acme: Tenant
    ) -> None:
        """After the idle timeout Keycloak still knows the user and signs them in silently. The
        lifetime then counts from the real authentication, like Keycloak's own session."""
        import time

        anna = await world.user(acme, "anna")
        six_hours_ago = int(time.time()) - 6 * 3600
        client, response = await sign_in(world, world.identity(anna), auth_time=six_hours_ago)
        await client.aclose()
        assert response.headers["location"] == "/"
        async with transaction(Scope.SYSTEM) as db:
            row = (await db.execute(select(AuthSession))).scalar_one()
        remaining = (row.expires_at - datetime.now(UTC)).total_seconds() / 3600
        assert 5.9 < remaining < 6.1, "twelve hours after the real sign-in, not after this one"

    async def test_signing_out_after_the_idle_timeout_still_names_the_session_when_others_signed_in(
        self, world: World, acme: Tenant
    ) -> None:
        """Every sign-in tidies up expired sessions. One that merely idled out must survive that:
        its row holds the token that lets "sign out" end the provider's session without a question."""
        anna = await world.user(acme, "anna")
        ben = await world.user(acme, "ben")
        async with await world.login(anna) as tab:
            async with transaction(Scope.SYSTEM) as db:
                await db.execute(
                    update(AuthSession)
                    .where(AuthSession.user_id == anna.id)
                    .values(last_seen_at=datetime.now(UTC) - timedelta(hours=5))
                )
            colleague, _ = await sign_in(world, world.identity(ben), sid="sid-ben")
            await colleague.aclose()
            response = await tab.post("/api/auth/logout")
        query = parse_qs(urlsplit(response.json()["redirect_url"]).query)
        assert query["id_token_hint"] == ["id-token"]

    async def test_sessions_past_their_absolute_lifetime_are_removed_at_the_next_sign_in(
        self, world: World, acme: Tenant
    ) -> None:
        anna = await world.user(acme, "anna")
        ben = await world.user(acme, "ben")
        await world.session(anna)
        async with transaction(Scope.SYSTEM) as db:
            await db.execute(update(AuthSession).values(expires_at=datetime.now(UTC) - timedelta(minutes=1)))
        client, _ = await sign_in(world, world.identity(ben))
        await client.aclose()
        assert await session_ids(anna) == []

    async def test_the_session_vanishes_while_the_user_enters_another_organization(
        self, world: World, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from contextlib import asynccontextmanager

        from sqlalchemy import delete

        from velydock.api import me

        acme, globex = await world.tenant("Acme"), await world.tenant("Globex")
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        original = me.system_scope

        @asynccontextmanager
        async def signed_out_elsewhere(db):  # type: ignore[no-untyped-def]
            async with original(db):
                async with transaction(Scope.SYSTEM) as other:
                    await other.execute(delete(AuthSession).where(AuthSession.user_id == root.id))
                yield

        async with await world.login(root, acme) as client:
            assert (await client.get("/api/v1/me")).status_code == 200
            monkeypatch.setattr(me, "system_scope", signed_out_elsewhere)
            response = await client.post("/api/v1/me/active-tenant", json={"tenant_id": str(globex.id)})
        assert response.status_code == 401


class TestOneAccountOneChangeAtATime:
    async def test_only_the_changed_fields_are_sent_to_the_provider(self, world: World, acme: Tenant) -> None:
        """Sending everything would overwrite what changed at the provider meanwhile - a lock
        set a moment ago, or a field an operator edited in Keycloak."""
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia", email="mia@acme.example", first_name="Mia", last_name="Alt")
        async with await world.login(admin) as boss, await world.login(mia) as member:
            assert (
                await boss.patch(f"/api/v1/admin/users/{mia.id}", json={"last_name": "Neu"})
            ).status_code == 200
            assert world.idp.updates[-1] == {"last_name": "Neu"}
            saved = await boss.patch(
                f"/api/v1/admin/users/{mia.id}",
                json={"first_name": "Mia", "last_name": "Neu", "email": "mia@acme.example", "active": True},
            )
            assert saved.status_code == 200
            assert len(world.idp.updates) == 1, "nothing changed, nothing sent"
            # The user's own profile: the address is not theirs to send at all.
            assert (
                await member.patch("/api/v1/me/profile", json={"first_name": "Maria", "last_name": "Neu"})
            ).status_code == 200
            assert world.idp.updates[-1] == {"first_name": "Maria"}
        fake = world.idp.users[mia.idp_id]
        assert (fake.first_name, fake.last_name, fake.email) == ("Maria", "Neu", "mia@acme.example")

    async def test_deactivating_again_repairs_an_account_that_is_locked_here_but_not_there(
        self, world: World, acme: Tenant
    ) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia", active=False)
        assert world.idp.users[mia.idp_id].enabled is True  # the two sides disagree
        async with await world.login(admin) as boss:
            assert (
                await boss.patch(f"/api/v1/admin/users/{mia.id}", json={"active": False})
            ).status_code == 200
        assert world.idp.users[mia.idp_id].enabled is False
        assert world.idp.logged_out == [mia.idp_id]

    async def test_changes_to_one_account_take_turns(self, world: World, acme: Tenant) -> None:
        """An edit and a lock at the same moment: whatever the order, both sides agree afterwards."""
        first = await world.user(acme, "anna", Role.TENANT_ADMIN)
        second = await world.user(acme, "arne", Role.TENANT_ADMIN)
        for attempt in range(6):
            mia = await world.user(acme, f"mia{attempt}", email=f"mia{attempt}@acme.example")
            async with (
                await world.login(first) as a,
                await world.login(second) as b,
                await world.login(mia) as own,
            ):
                results = await asyncio.gather(
                    a.patch(f"/api/v1/admin/users/{mia.id}", json={"active": False}),
                    b.patch(f"/api/v1/admin/users/{mia.id}", json={"first_name": f"Neu{attempt}"}),
                    own.patch("/api/v1/me/profile", json={"first_name": "Selbst", "last_name": "Test"}),
                )
            assert results[0].status_code == 200 and results[1].status_code == 200
            stored = (await users())[f"mia{attempt}"]
            fake = world.idp.users[mia.idp_id]
            assert (stored.active, fake.enabled) == (False, False)
            assert stored.first_name == fake.first_name
            assert await session_ids(mia) == []

    async def test_a_reset_password_reaches_the_administrator_even_if_the_logout_fails(
        self, world: World, acme: Tenant
    ) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia")
        async with await world.login(admin) as boss, await world.login(mia) as member:
            world.idp.fail_next, world.idp.fail_on = IdpUnavailable("timeout"), "logout_user"
            response = await boss.post(f"/api/v1/admin/users/{mia.id}/reset-password")
            assert response.status_code == 200
            assert response.json()["temporary_password"] == world.idp.users[mia.idp_id].password
            assert (await member.get("/api/v1/me")).status_code == 401

    async def test_deleting_an_organization_and_creating_a_user_in_it_at_the_same_moment(
        self, world: World
    ) -> None:
        """Either the user is deleted with the organization or was never created - never an
        account that survives on both sides without any organization."""
        acme = await world.tenant("Acme")
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        for attempt in range(4):
            slug = f"kunde{attempt}"
            async with await world.login(root) as setup:
                tenant_id = (
                    await setup.post("/api/v1/system/tenants", json={"slug": slug, "name": slug})
                ).json()["id"]
            async with await world.login(root) as creator, await world.login(root) as deleter:
                assert (
                    await creator.post("/api/v1/me/active-tenant", json={"tenant_id": tenant_id})
                ).status_code == 200
                created, deleted = await asyncio.gather(
                    creator.post(
                        "/api/v1/admin/users",
                        json={"username": f"neu{attempt}", "first_name": "N", "last_name": "N"},
                    ),
                    deleter.post(f"/api/v1/system/tenants/{tenant_id}/delete", json={"confirm_slug": slug}),
                )
            assert deleted.status_code == 204, deleted.text
            assert created.status_code in (201, 404, 409), created.text
            stored = await users()
            assert f"neu{attempt}" not in stored
            assert f"neu{attempt}" not in {u.username for u in world.idp.users.values()}


class TestMembershipsTheProviderManages:
    """An account that came in through an identity provider or an invitation of an organization
    in Keycloak is deleted there when its membership is removed. Velydock never removes those."""

    async def test_a_managed_guest_is_not_removed(self, world: World) -> None:
        acme, globex = await world.tenant("Acme"), await world.tenant("Globex")
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        guest = await world.user(globex, "gero")
        await world.member(acme, guest)
        assert acme.idp_org_id is not None
        await world.idp.add_organization_member(acme.idp_org_id, guest.idp_id)
        world.idp.managed.add((acme.idp_org_id, guest.idp_id))
        async with await world.login(admin) as boss:
            response = await boss.delete(f"/api/v1/admin/users/{guest.id}")
            assert response.status_code == 409
            assert response.json()["error"]["code"] == "managed_by_idp"
            assert (await boss.get(f"/api/v1/admin/users/{guest.id}")).status_code == 200, "still a member"
        assert guest.idp_id in world.idp.users and guest.idp_id in world.idp.members[acme.idp_org_id]

    async def test_the_address_of_a_managed_member_is_not_removed(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia", email="mia@acme.example")
        assert acme.idp_org_id is not None
        world.idp.managed.add((acme.idp_org_id, mia.idp_id))
        async with await world.login(admin) as boss:
            response = await boss.patch(f"/api/v1/admin/users/{mia.id}", json={"email": None})
            assert response.status_code == 409
            assert response.json()["error"]["code"] == "managed_by_idp"
        assert (await users())["mia"].email == "mia@acme.example"
        assert world.idp.users[mia.idp_id].email == "mia@acme.example"

    async def test_memberships_lost_while_an_address_was_removed_come_back(
        self, world: World, acme: Tenant
    ) -> None:
        """Removing an address lifts the memberships at the provider for a moment. If it fails
        right then, they are gone there - the next successful attempt puts them back."""
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia", email="mia@acme.example")
        assert acme.idp_org_id is not None
        world.idp.members[acme.idp_org_id].discard(mia.idp_id)  # what the failed attempt left
        async with await world.login(admin) as boss:
            assert (
                await boss.patch(f"/api/v1/admin/users/{mia.id}", json={"email": None})
            ).status_code == 200
        assert mia.idp_id in world.idp.members[acme.idp_org_id]


class TestOrganizationsBehindVelydocksBack:
    async def test_saving_an_organization_whose_mirror_was_deleted_puts_it_back(self, world: World) -> None:
        acme = await world.tenant("Acme")
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        mia = await world.user(acme, "mia")
        assert acme.idp_org_id is not None
        await world.idp.delete_organization(acme.idp_org_id)
        async with await world.login(root) as client:
            response = await client.patch(f"/api/v1/system/tenants/{acme.id}", json={"name": "Acme AG"})
            assert response.status_code == 200, response.text
        restored = await world.idp.find_organization("acme")
        assert restored is not None and restored != acme.idp_org_id
        assert world.idp.organizations[restored]["name"] == "Acme AG"
        assert world.idp.members[restored] == {root.idp_id, mia.idp_id}

    async def test_start_up_repairs_what_it_can_and_never_gives_up(
        self, world: World, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        """One organization that cannot be repaired (someone re-created it under another alias
        in Keycloak) must not keep Velydock from starting, nor the others from being repaired."""
        from velydock import cli

        acme, globex = await world.tenant("Acme"), await world.tenant("Globex", active=False)
        mia = await world.user(globex, "mia")
        assert acme.idp_org_id and globex.idp_org_id
        # Acme: deleted and re-created by hand under another alias - its name is taken now.
        await world.idp.delete_organization(acme.idp_org_id)
        await world.idp.create_organization(name="Acme", alias="acme-neu")
        # Globex: renamed, enabled and emptied in Keycloak, although the tenant is inactive.
        world.idp.organizations[globex.idp_org_id].update(name="Fremd", enabled=True)
        world.idp.members[globex.idp_org_id].clear()

        monkeypatch.setattr(cli, "KeycloakIdp", lambda settings, http: world.idp)
        await cli.reconcile(world.settings, None)  # type: ignore[arg-type]

        assert "acme" in caplog.text and "could not be brought in line" in caplog.text
        assert world.idp.organizations[globex.idp_org_id] == {
            "name": "Globex",
            "alias": "globex",
            "enabled": False,
        }
        assert world.idp.members[globex.idp_org_id] == {mia.idp_id}
        assert world.idp.default_locale == "de"


class TestSettingsThatReachTheProvider:
    SMTP: ClassVar[dict[str, object]] = {
        "host": "mail.example.org",
        "port": 587,
        "from_address": "dock@example.org",
        "from_name": "Dock",
        "username": "dock",
        "password": "geheim",
        "encryption": "starttls",
    }

    async def test_an_empty_password_keeps_the_stored_one_only_while_the_connection_is_the_same(
        self, world: World, acme: Tenant
    ) -> None:
        """Keycloak drops the stored password when the connection changes. Saving such a change
        with the password field left empty would silently break mail delivery."""
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(root) as client:
            assert (
                await client.patch("/api/v1/system/settings", json={"smtp": self.SMTP})
            ).status_code == 200
            kept = {**self.SMTP, "password": "", "from_name": "Velydock"}
            assert (await client.patch("/api/v1/system/settings", json={"smtp": kept})).status_code == 200
            for field, value in (("host", "smtp.example.org"), ("port", 465), ("username", "andere")):
                changed = {**self.SMTP, "password": "", field: value}
                response = await client.patch("/api/v1/system/settings", json={"smtp": changed})
                assert response.status_code == 422, field
                assert response.json()["error"]["code"] == "smtp_password_required"
                assert response.json()["error"]["details"]["fields"][0]["field"] == "smtp.password"
            assert world.idp.smtp.host == "mail.example.org"
            # With the password it is a normal change; switching mail off needs none.
            again = {**self.SMTP, "host": "smtp.example.org"}
            assert (await client.patch("/api/v1/system/settings", json={"smtp": again})).status_code == 200
            assert (
                await client.patch("/api/v1/system/settings", json={"smtp": {"host": ""}})
            ).status_code == 200

    async def test_a_name_of_the_installation_that_reads_as_markup_is_refused(
        self, world: World, acme: Tenant
    ) -> None:
        """The name is printed on the provider's sign-in pages and in its e-mails, where markup
        in it would be markup: a link on the sign-in page of every organization."""
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(root) as client:
            for name in ('<a href="https://elsewhere.example/">Weiter</a>', "&lt;b&gt;Portal", "a > b"):
                response = await client.patch("/api/v1/system/settings", json={"instance_name": name})
                assert response.status_code == 422, name
                assert response.json()["error"]["details"]["fields"][0]["field"] == "instance_name"
            assert world.idp.display_name == "Velydock"
            fine = await client.patch("/api/v1/system/settings", json={"instance_name": "Müller  & Söhne"})
            assert fine.status_code == 200
            assert fine.json()["instance_name"] == world.idp.display_name == "Müller & Söhne"

    async def test_the_default_language_becomes_the_language_of_the_providers_pages_and_mails(
        self, world: World, acme: Tenant
    ) -> None:
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(root) as client:
            assert (
                await client.patch("/api/v1/system/settings", json={"default_language": "en"})
            ).status_code == 200
        assert world.idp.default_locale == "en"

    async def test_a_mail_server_that_refuses_is_named_as_such(self, world: World, acme: Tenant) -> None:
        from velydock.idp.base import IdpMailFailed, SmtpConfig

        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        world.idp.smtp = SmtpConfig(host="mail.example.org", from_address="dock@example.org")
        async with await world.login(admin) as boss:
            world.idp.fail_next, world.idp.fail_on = (
                IdpMailFailed("smtp down", status=500),
                "send_password_setup_email",
            )
            response = await boss.post(
                "/api/v1/admin/users",
                json={
                    "username": "mia",
                    "first_name": "M",
                    "last_name": "M",
                    "email": "m@x.example",
                    "send_email": True,
                },
            )
        assert response.status_code == 502 and response.json()["error"]["code"] == "email_failed"
        assert "mia" not in await users(), "the account is not left behind without a way in"
        assert [u.username for u in world.idp.users.values()] == ["anna"]

    async def test_a_name_only_the_provider_refuses_is_a_field_error_in_the_own_profile_too(
        self, world: World, acme: Tenant
    ) -> None:
        from velydock.idp.base import IdpInvalid

        mia = await world.user(acme, "mia")
        async with await world.login(mia) as client:
            world.idp.fail_next, world.idp.fail_on = IdpInvalid("first_name", "refused"), "update_user"
            response = await client.patch(
                "/api/v1/me/profile", json={"first_name": "Mx", "last_name": "Test"}
            )
        assert response.status_code == 422
        assert response.json()["error"]["details"]["fields"][0]["field"] == "first_name"
        assert (await users())["mia"].first_name == "Mia"


class TestMoreRankRules:
    async def test_a_group_with_higher_ranks_in_it_cannot_be_deleted_by_a_user_manager(
        self, world: World, acme: Tenant
    ) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        manager = await world.user(acme, "uwe", Role.USER_MANAGER)
        mia = await world.user(acme, "mia")
        chefs = await world.group(acme, "Chefs", [admin, mia])
        team = await world.group(acme, "Team", [mia])
        async with await world.login(manager) as client:
            assert (await client.delete(f"/api/v1/admin/groups/{chefs.id}")).status_code == 403
            assert (await client.delete(f"/api/v1/admin/groups/{team.id}")).status_code == 204
        async with await world.login(admin) as client:
            assert (await client.delete(f"/api/v1/admin/groups/{chefs.id}")).status_code == 204


class TestSignInRaces:
    async def test_an_address_taken_in_the_last_moment_does_not_fail_the_sign_in(
        self, world: World, acme: Tenant, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A known user arrives with a new address from Keycloak; between the check and the
        write another account takes it. The sign-in keeps the stored profile and goes on."""
        from sqlalchemy.ext.asyncio import AsyncSession

        anna = await world.user(acme, "anna", email="anna@acme.example")
        ben = await world.user(acme, "ben")
        real = AsyncSession.begin_nested
        state = {"done": False}

        def begin_nested_after_the_other_commit(self):  # type: ignore[no-untyped-def]
            inner = real(self)

            class Savepoint:
                async def __aenter__(self_inner):  # type: ignore[no-untyped-def]
                    if not state["done"]:
                        state["done"] = True
                        async with transaction(Scope.SYSTEM) as other:
                            await other.execute(
                                update(User).where(User.id == ben.id).values(email="neu@acme.example")
                            )
                    return await inner.__aenter__()

                async def __aexit__(self_inner, *exc_info):  # type: ignore[no-untyped-def]
                    return await inner.__aexit__(*exc_info)

            return Savepoint()

        monkeypatch.setattr(AsyncSession, "begin_nested", begin_nested_after_the_other_commit)
        identity = Identity(anna.idp_id, "anna", "neu@acme.example", "Anna", "Test")
        client, response = await sign_in(world, identity)
        async with client:
            assert response.status_code == 302 and response.headers["location"] == "/"
            assert (await client.get("/api/v1/me")).status_code == 200
        assert (await users())["anna"].email == "anna@acme.example"


class TestSmallerRegressions:
    async def test_deeply_nested_json_is_a_validation_error(self, world: World, acme: Tenant) -> None:
        mia = await world.user(acme, "mia")
        nested: object = "dark"
        for _ in range(3000):
            nested = [nested]
        async with await world.login(mia) as client:
            response = await client.patch("/api/v1/me/settings", json={"theme": nested})
        assert response.status_code == 422

    async def test_head_on_an_api_path_is_not_answered_with_the_application_shell(self, world: World) -> None:
        async with world.client() as client:
            response = await client.head("/api/v1/nope")
        assert response.status_code == 404 and response.headers["content-type"].startswith("application/json")

    async def test_the_way_back_from_a_refused_sign_in_leads_to_the_login_page_only(
        self, world: World
    ) -> None:
        """The identity provider sends the browser to /api/auth/refused/<reason> after it has
        ended its session. Anybody can open that address; it must not lead anywhere else."""
        async with world.client() as client:
            for reason in ("disabled", "account_conflict", "second_factor_required"):
                response = await client.get(f"/api/auth/refused/{reason}")
                assert (response.status_code, response.headers["location"]) == (302, f"/login?error={reason}")
            for odd in ("Disabled", "a-b", "x" * 41, "%2F%2Fevil.example", "a%26b=c", "a%0d%0ab"):
                response = await client.get(f"/api/auth/refused/{odd}")
                assert response.status_code in (302, 404), odd
                if response.status_code == 302:
                    assert response.headers["location"] == "/login?error=invalid", odd


# ---------------------------------------------------------------------------------------------
# Second review round: what someone using the product ran into
# ---------------------------------------------------------------------------------------------


class TestPendingSecondFactorEnrolment:
    """Velydock asks Keycloak to demand an authenticator from administrators. If the person
    never completes it and stops being an administrator, the demand must not stay for good."""

    async def pending(self, world: World, user: User) -> bool:
        return user.idp_id in world.idp.second_factor_required

    async def test_it_is_withdrawn_when_the_role_is_taken_away(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        ben = await world.user(acme, "ben", Role.TENANT_ADMIN)
        await world.idp.require_second_factor_setup(ben.idp_id)
        async with await world.login(admin) as boss:
            assert (
                await boss.patch(f"/api/v1/admin/users/{ben.id}", json={"role": "user_manager"})
            ).status_code == 200
            assert await self.pending(world, ben), "still a role that needs the second factor"
            assert (
                await boss.patch(f"/api/v1/admin/users/{ben.id}", json={"role": "member"})
            ).status_code == 200
        assert not await self.pending(world, ben)

    async def test_it_stays_while_another_organization_or_the_system_role_needs_it(
        self, world: World
    ) -> None:
        acme, globex = await world.tenant("Acme"), await world.tenant("Globex")
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        ben = await world.user(acme, "ben", Role.TENANT_ADMIN)
        await world.member(globex, ben, Role.USER_MANAGER)
        ruth = await world.user(acme, "ruth", Role.TENANT_ADMIN, system_admin=True)
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        for user in (ben, ruth):
            await world.idp.require_second_factor_setup(user.idp_id)
        async with await world.login(admin) as boss:
            assert (
                await boss.patch(f"/api/v1/admin/users/{ben.id}", json={"role": "member"})
            ).status_code == 200
        assert await self.pending(world, ben), "user manager in Globex"
        async with await world.login(root) as system:
            assert (
                await system.patch(f"/api/v1/admin/users/{ruth.id}", json={"role": "member"})
            ).status_code == 200
            assert await self.pending(world, ruth), "still a system administrator"
            revoked = await system.patch(f"/api/v1/system/users/{ruth.id}", json={"is_system_admin": False})
            assert revoked.status_code == 200
        assert not await self.pending(world, ruth)

    async def test_it_is_withdrawn_for_everyone_when_the_requirement_is_switched_off(
        self, world: World, acme: Tenant
    ) -> None:
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        uwe = await world.user(acme, "uwe", Role.USER_MANAGER)
        for user in (root, uwe):
            await world.idp.require_second_factor_setup(user.idp_id)
        async with await world.login(root) as client:
            assert (
                await client.patch("/api/v1/system/settings", json={"require_admin_2fa": True})
            ).status_code == 200
            assert await self.pending(world, uwe)
            assert (
                await client.patch("/api/v1/system/settings", json={"require_admin_2fa": False})
            ).status_code == 200
        assert not await self.pending(world, uwe) and not await self.pending(world, root)
        # And the log says what the setting was changed to.
        async with transaction(Scope.SYSTEM) as db:
            entries = list(
                (
                    await db.execute(
                        select(AuditLog).where(AuditLog.action == "system.settings").order_by(AuditLog.id)
                    )
                ).scalars()
            )
        assert [e.details["values"] for e in entries] == [
            {"require_admin_2fa": True},
            {"require_admin_2fa": False},
        ]


class TestWhatTheInterfaceIsTold:
    async def test_someone_whose_only_organization_is_deactivated_is_told_so(self, world: World) -> None:
        """They are not "without organization" - theirs is switched off."""
        acme, globex = await world.tenant("Acme"), await world.tenant("Globex", active=False)
        gero = await world.user(globex, "gero")
        mia = await world.user(acme, "mia")
        nobody = await world.user(None, "neu", role=None, home=None)
        expected = {gero: (None, 1), mia: ("Acme", 0), nobody: (None, 0)}
        for user, (organization, inactive) in expected.items():
            async with await world.login(user) as client:
                me = (await client.get("/api/v1/me")).json()
            assert (me["active_tenant"] or {}).get("name") == organization
            assert me["inactive_memberships"] == inactive

    async def test_an_organization_that_cannot_be_deactivated_or_deleted_is_marked(
        self, world: World
    ) -> None:
        acme = await world.tenant("Acme")
        await world.tenant("Globex")
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(root) as client:
            tenants = {t["slug"]: t["protected"] for t in (await client.get("/api/v1/system/tenants")).json()}
        assert tenants == {"acme": True, "globex": False}

    async def test_the_e_mail_invitation_is_only_offered_with_a_mail_server(
        self, world: World, acme: Tenant
    ) -> None:
        from velydock.idp.base import SmtpConfig

        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia")
        async with await world.login(admin) as boss:
            assert (await boss.get("/api/v1/admin/capabilities")).json() == {"email_invitations": False}
            world.idp.smtp = SmtpConfig(host="mail.example.org", from_address="dock@example.org")
            assert (await boss.get("/api/v1/admin/capabilities")).json() == {"email_invitations": True}
        async with await world.login(mia) as member:
            assert (await member.get("/api/v1/admin/capabilities")).status_code == 403

    async def test_the_sign_in_pages_come_in_the_language_chosen_in_velydock(self, world: World) -> None:
        async with world.client() as client:
            for requested, expected in (("en", ["en"]), ("de", ["de"]), ("xx", None), ("en-US;evil", None)):
                start = await client.get("/api/auth/login", params={"lang": requested})
                query = parse_qs(urlsplit(start.headers["location"]).query)
                assert query.get("ui_locales") == expected, requested
            assert "ui_locales" not in parse_qs(
                urlsplit((await client.get("/api/auth/login")).headers["location"]).query
            )

    async def test_the_language_is_kept_when_the_sign_in_is_sent_round_again(
        self, world: World, acme: Tenant
    ) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(root) as system:
            assert (
                await system.patch("/api/v1/system/settings", json={"require_admin_2fa": True})
            ).status_code == 200
        async with world.client() as client:
            start = await client.get("/api/auth/login", params={"lang": "en"})
            again = await client.get(world.mini.authorize(start.headers["location"], world.identity(admin)))
        assert parse_qs(urlsplit(again.headers["location"]).query)["ui_locales"] == ["en"]


class TestNamesAndOrder:
    async def test_names_that_differ_only_in_blanks_are_the_same_name(
        self, world: World, acme: Tenant
    ) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            first = await client.post("/api/v1/admin/groups", json={"name": "Büro & Verwaltung"})
            assert first.status_code == 201
            second = await client.post("/api/v1/admin/groups", json={"name": "Büro  &   Verwaltung "})
            assert second.status_code == 409 and second.json()["error"]["code"] == "group_name_taken"

    async def test_lists_are_sorted_the_way_a_reader_expects(self, world: World) -> None:
        """By the name as shown, with umlauts next to their base letter - not after "Z"."""
        for name in ("Zeta AG", "Äcme GmbH", "Hauptorganisation", "acme zwei"):
            await world.tenant(name, slug=f"t{abs(hash(name)) % 10**8}")
        main = await world.tenant("Büro")
        root = await world.user(
            main, "root", Role.TENANT_ADMIN, system_admin=True, first_name="Ronja", last_name="Root"
        )
        for username, first, last in (
            ("u1", "Zoe", "Alt"),
            ("u2", "Ärne", "Zimmer"),
            ("u3", "anna", "Berg"),
            ("u4", "Émile", "A"),
        ):
            await world.user(main, username, first_name=first, last_name=last)
        async with await world.login(root) as client:
            tenants = [t["name"] for t in (await client.get("/api/v1/system/tenants")).json()]
            assert tenants == ["Äcme GmbH", "acme zwei", "Büro", "Hauptorganisation", "Zeta AG"]
            assert [
                m["tenant"]["name"] for m in (await client.get("/api/v1/me")).json()["memberships"]
            ] == tenants
            shown = [u["display_name"] for u in (await client.get("/api/v1/admin/users")).json()["items"]]
            assert shown == ["anna Berg", "Ärne Zimmer", "Émile A", "Ronja Root", "Zoe Alt"]
            everyone = [u["display_name"] for u in (await client.get("/api/v1/system/users")).json()["items"]]
            assert everyone == shown

    async def test_saving_an_organization_unchanged_is_not_an_event(self, world: World) -> None:
        acme = await world.tenant("Acme")
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(root) as client:
            assert (
                await client.patch(f"/api/v1/system/tenants/{acme.id}", json={"name": "Acme"})
            ).status_code == 200
            assert "tenant.update" not in await audit_actions()
            assert (
                await client.patch(f"/api/v1/system/tenants/{acme.id}", json={"name": "Acme AG"})
            ).status_code == 200
        async with transaction(Scope.SYSTEM) as db:
            entry = (
                await db.execute(select(AuditLog).where(AuditLog.action == "tenant.update"))
            ).scalar_one()
        assert entry.details == {"name": "Acme AG"}


class TestDatabaseOutage:
    """While the database is away: a clear answer, one log line per request, and a health check
    that says so - instead of a traceback of a few hundred lines per request and a green light."""

    async def test_requests_are_answered_503_with_one_log_line(
        self, world: World, acme: Tenant, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        import socket

        from velydock.api import deps

        mia = await world.user(acme, "mia")
        cookie = await world.session(mia)

        async def away(*args: object, **kwargs: object) -> None:
            raise socket.gaierror(-5, "No address associated with hostname")

        monkeypatch.setattr(deps, "set_rls_context", away)
        caplog.clear()
        async with world.client(cookie) as client:
            response = await client.get("/api/v1/me")
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "unavailable"
        records = [r for r in caplog.records if r.name.startswith("velydock")]
        assert len(records) == 1 and "database unreachable" in records[0].getMessage()
        assert records[0].exc_info is None, "no traceback"

    async def test_the_health_check_reports_it(self, world: World, monkeypatch: pytest.MonkeyPatch) -> None:
        from velydock import app as application

        async with world.client() as client:
            healthy = await client.get("/api/health")
            assert healthy.status_code == 200 and healthy.json()["status"] == "ok"

            class Away:
                def connect(self) -> object:
                    raise ConnectionRefusedError("database is down")

            monkeypatch.setattr(application, "get_engine", lambda: Away())
            down = await client.get("/api/health")
        assert down.status_code == 503
        assert down.json() == {"status": "unavailable", "version": down.json()["version"], "database": False}
