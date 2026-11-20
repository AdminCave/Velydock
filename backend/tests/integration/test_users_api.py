"""User administration inside a tenant."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from tests.conftest import World
from velydock.db import Scope, transaction
from velydock.idp.base import IdpError, IdpUnavailable, SmtpConfig
from velydock.models import AuditLog, AuthSession, Membership, Role, Tenant, User

NEW_USER = {"username": "mia", "first_name": "Mia", "last_name": "Mitglied", "email": "mia@acme.example"}


@pytest.fixture
async def acme(world: World) -> Tenant:
    return await world.tenant("Acme")


class TestCreate:
    async def test_admin_creates_a_user(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        group = await world.group(acme, "Büro")
        async with await world.login(admin) as client:
            response = await client.post(
                "/api/v1/admin/users", json={**NEW_USER, "group_ids": [str(group.id)]}
            )
            assert response.status_code == 201, response.text
            body = response.json()
            user = body["user"]
            assert (user["username"], user["role"], user["managed"], user["active"]) == (
                "mia",
                "member",
                True,
                True,
            )
            assert [g["name"] for g in user["groups"]] == ["Büro"]
            assert body["email_sent"] is False

            # The one-time password is returned once and is the one set in the identity provider.
            password = body["temporary_password"]
            created = next(u for u in world.idp.users.values() if u.username == "mia")
            assert created.password == password and created.must_change_password
            assert created.email == "mia@acme.example"
            assert created.id in world.idp.members[acme.idp_org_id or ""]

            listed = (await client.get("/api/v1/admin/users")).json()
            assert sorted(u["username"] for u in listed["items"]) == ["anna", "mia"]
            # It is not readable afterwards.
            assert password not in (await client.get(f"/api/v1/admin/users/{user['id']}")).text
            audit = (await client.get("/api/v1/admin/audit")).json()["items"][0]
            assert (audit["action"], audit["target_label"], audit["actor_name"]) == (
                "user.create",
                "mia",
                "anna",
            )
            assert password not in str(audit)

    async def test_velydock_stores_no_password(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            password = (await client.post("/api/v1/admin/users", json=NEW_USER)).json()["temporary_password"]
        async with transaction(Scope.SYSTEM) as db:
            for table in (User, AuditLog):
                for row in (await db.execute(select(table))).scalars():
                    assert password not in repr(vars(row))

    async def test_user_without_email(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            response = await client.post(
                "/api/v1/admin/users", json={"username": "ben", "first_name": "Ben", "last_name": "B"}
            )
            assert response.status_code == 201
            assert response.json()["user"]["email"] is None

    async def test_usernames_and_emails_are_unique_across_the_installation(
        self, world: World, acme: Tenant
    ) -> None:
        globex = await world.tenant("Globex")
        await world.user(globex, "gero", email="gero@globex.example")
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            taken_name = await client.post("/api/v1/admin/users", json={**NEW_USER, "username": "GERO"})
            assert (taken_name.status_code, taken_name.json()["error"]["code"]) == (409, "username_taken")
            taken_mail = await client.post(
                "/api/v1/admin/users", json={**NEW_USER, "email": "Gero@Globex.example"}
            )
            assert (taken_mail.status_code, taken_mail.json()["error"]["code"]) == (409, "email_taken")
            # The answer does not say where the name is in use.
            assert "globex" not in taken_name.text.lower().replace("gero@globex", "")
        assert not [u for u in world.idp.users.values() if u.username == "mia"]

    @pytest.mark.parametrize(
        "payload",
        [
            {**NEW_USER, "username": "x"},
            {**NEW_USER, "username": "<script>alert(1)</script>"},
            {**NEW_USER, "email": "not-an-email"},
            {**NEW_USER, "first_name": ""},
            {**NEW_USER, "role": "system_admin"},
            {**NEW_USER, "is_system_admin": True},
            {**NEW_USER, "group_ids": ["not-a-uuid"]},
            {"username": "mia"},
        ],
    )
    async def test_invalid_input_is_rejected(
        self, world: World, acme: Tenant, payload: dict[str, object]
    ) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            response = await client.post("/api/v1/admin/users", json=payload)
            assert response.status_code == 422
            assert response.json()["error"]["code"] == "validation"
        assert len(world.idp.users) == 1

    async def test_nothing_is_left_behind_if_the_identity_provider_fails(
        self, world: World, acme: Tenant
    ) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            world.idp.fail_next, world.idp.fail_on = IdpUnavailable("down"), "create_user"
            response = await client.post("/api/v1/admin/users", json=NEW_USER)
            assert (response.status_code, response.json()["error"]["code"]) == (503, "idp_unavailable")
            assert [u["username"] for u in (await client.get("/api/v1/admin/users")).json()["items"]] == [
                "anna"
            ]

            # Fails after the account exists in the provider: it must be removed again.
            world.idp.fail_next, world.idp.fail_on = IdpError("boom"), "add_organization_member"
            assert (await client.post("/api/v1/admin/users", json=NEW_USER)).status_code == 502
            assert not [u for u in world.idp.users.values() if u.username == "mia"]
            assert [u["username"] for u in (await client.get("/api/v1/admin/users")).json()["items"]] == [
                "anna"
            ]
            # And a retry works.
            assert (await client.post("/api/v1/admin/users", json=NEW_USER)).status_code == 201

    async def test_invitation_by_email(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            not_configured = await client.post("/api/v1/admin/users", json={**NEW_USER, "send_email": True})
            assert not_configured.json()["error"]["code"] == "smtp_not_configured"
            world.idp.smtp = SmtpConfig(host="mail.example", from_address="noreply@example.org")
            no_address = await client.post(
                "/api/v1/admin/users",
                json={"username": "ben", "first_name": "B", "last_name": "B", "send_email": True},
            )
            assert no_address.json()["error"]["code"] == "email_required"
            invited = await client.post("/api/v1/admin/users", json={**NEW_USER, "send_email": True})
            assert invited.status_code == 201
            assert invited.json()["temporary_password"] is None and invited.json()["email_sent"] is True
            assert len(world.idp.setup_emails) == 1


class TestRoles:
    async def test_user_manager_creates_members_only(self, world: World, acme: Tenant) -> None:
        manager = await world.user(acme, "uwe", Role.USER_MANAGER)
        async with await world.login(manager) as client:
            assert (await client.post("/api/v1/admin/users", json=NEW_USER)).status_code == 201
            for role in ("user_manager", "tenant_admin"):
                response = await client.post(
                    "/api/v1/admin/users", json={**NEW_USER, "username": "xx1", "email": None, "role": role}
                )
                assert response.status_code == 403, role

    async def test_user_manager_cannot_escalate(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        manager = await world.user(acme, "uwe", Role.USER_MANAGER)
        member = await world.user(acme, "mia", Role.MEMBER)
        async with await world.login(manager) as client:
            # Not by promoting anyone (including themselves) …
            for target in (member, manager):
                promoted = await client.patch(
                    f"/api/v1/admin/users/{target.id}", json={"role": "tenant_admin"}
                )
                assert promoted.status_code == 403
            # … and not by taking over an administrator's account.
            assert (await client.post(f"/api/v1/admin/users/{admin.id}/reset-password")).status_code == 403
            assert (
                await client.patch(f"/api/v1/admin/users/{admin.id}", json={"email": "uwe@evil.example"})
            ).status_code == 403
            assert (
                await client.patch(f"/api/v1/admin/users/{admin.id}", json={"active": False})
            ).status_code == 403
            assert (await client.delete(f"/api/v1/admin/users/{admin.id}")).status_code == 403
            # Members are fine.
            assert (await client.post(f"/api/v1/admin/users/{member.id}/reset-password")).status_code == 200
        assert world.idp.users[admin.idp_id].password == ""

    async def test_members_have_no_access_to_administration(self, world: World, acme: Tenant) -> None:
        member = await world.user(acme, "mia", Role.MEMBER)
        other = await world.user(acme, "ben", Role.MEMBER)
        async with await world.login(member) as client:
            checks = [
                await client.get("/api/v1/admin/users"),
                await client.post("/api/v1/admin/users", json=NEW_USER),
                await client.get(f"/api/v1/admin/users/{other.id}"),
                await client.patch(f"/api/v1/admin/users/{member.id}", json={"role": "tenant_admin"}),
                await client.post(f"/api/v1/admin/users/{other.id}/reset-password"),
                await client.delete(f"/api/v1/admin/users/{other.id}"),
                await client.get("/api/v1/admin/groups"),
                await client.post("/api/v1/admin/groups", json={"name": "X"}),
                await client.get("/api/v1/admin/apps"),
                await client.post(
                    "/api/v1/admin/apps", json={"name": "X", "type": "external", "url": "https://x.example"}
                ),
                await client.get("/api/v1/admin/tenant"),
                await client.patch("/api/v1/admin/tenant", json={"nav_position_locked": True}),
                await client.get("/api/v1/admin/audit"),
            ]
            assert [r.status_code for r in checks] == [403] * len(checks)

    async def test_admin_changes_roles_but_not_their_own(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        member = await world.user(acme, "mia", Role.MEMBER)
        async with await world.login(admin) as client:
            promoted = await client.patch(f"/api/v1/admin/users/{member.id}", json={"role": "user_manager"})
            assert promoted.json()["role"] == "user_manager"
            assert (
                await client.patch(f"/api/v1/admin/users/{admin.id}", json={"role": "member"})
            ).status_code == 403

    async def test_tenant_admin_cannot_touch_a_system_admin(self, world: World, acme: Tenant) -> None:
        root = await world.user(acme, "root", Role.MEMBER, system_admin=True)
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            assert (await client.post(f"/api/v1/admin/users/{root.id}/reset-password")).status_code == 403
            assert (
                await client.patch(f"/api/v1/admin/users/{root.id}", json={"active": False})
            ).status_code == 403
            assert (
                await client.patch(f"/api/v1/admin/users/{root.id}", json={"role": "user_manager"})
            ).status_code == 403
            assert (await client.delete(f"/api/v1/admin/users/{root.id}")).status_code == 403
            # The API offers no way to set the flag at all.
            assert (
                await client.patch(f"/api/v1/admin/users/{admin.id}", json={"is_system_admin": True})
            ).status_code == 422


class TestEdit:
    async def test_edit_profile_and_email(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia", email="mia@acme.example")
        async with await world.login(admin) as client:
            response = await client.patch(
                f"/api/v1/admin/users/{mia.id}", json={"last_name": "Neu", "email": "mia.neu@acme.example"}
            )
            assert response.status_code == 200, response.text
            assert (response.json()["last_name"], response.json()["email"]) == ("Neu", "mia.neu@acme.example")
            assert world.idp.users[mia.idp_id].email == "mia.neu@acme.example"
            cleared = await client.patch(f"/api/v1/admin/users/{mia.id}", json={"email": None})
            assert cleared.json()["email"] is None and world.idp.users[mia.idp_id].email is None

    async def test_email_must_stay_unique(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN, email="anna@acme.example")
        mia = await world.user(acme, "mia", email="mia@acme.example")
        async with await world.login(admin) as client:
            response = await client.patch(
                f"/api/v1/admin/users/{mia.id}", json={"email": "ANNA@acme.example"}
            )
            assert (response.status_code, response.json()["error"]["code"]) == (409, "email_taken")

    async def test_search_filter_and_paging(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN, first_name="Anna", last_name="Admin")
        await world.user(acme, "mia", first_name="Mia", last_name="Müller", email="mia@acme.example")
        await world.user(acme, "max", first_name="Max", last_name="Meier", active=False)
        group = await world.group(acme, "Büro", [admin])
        async with await world.login(admin) as client:

            async def names(**params: object) -> list[str]:
                page = (await client.get("/api/v1/admin/users", params=params)).json()  # type: ignore[arg-type]
                return [u["username"] for u in page["items"]]

            assert await names(search="müll") == ["mia"]
            assert await names(search="MIA@ACME") == ["mia"]
            assert await names(search="max meier") == ["max"]
            assert await names(search="m") == ["anna", "max", "mia"]  # "Admin" contains an m as well
            assert await names(search="100%") == []
            assert await names(active="false") == ["max"]
            assert await names(role="tenant_admin") == ["anna"]
            assert await names(group_id=str(group.id)) == ["anna"]
            first = (await client.get("/api/v1/admin/users", params={"page_size": 2})).json()
            second = (await client.get("/api/v1/admin/users", params={"page_size": 2, "page": 2})).json()
            assert (first["total"], len(first["items"]), len(second["items"])) == (3, 2, 1)
            assert (await client.get("/api/v1/admin/users", params={"page_size": 100000})).status_code == 422

    async def test_sql_metacharacters_in_search_are_harmless(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            for term in (
                "' OR 1=1 --",
                "'; DROP TABLE users; --",
                "\\",
                "%' UNION SELECT * FROM sessions --",
            ):
                response = await client.get("/api/v1/admin/users", params={"search": term})
                assert response.status_code == 200 and response.json()["items"] == []
            assert (await client.get("/api/v1/admin/users")).json()["total"] == 1


class TestDeactivateAndRemove:
    async def test_deactivating_blocks_sign_in_and_ends_sessions(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia")
        mias_cookie = await world.session(mia)
        async with await world.login(admin) as client:
            response = await client.patch(f"/api/v1/admin/users/{mia.id}", json={"active": False})
            assert response.json()["active"] is False
        assert world.idp.users[mia.idp_id].enabled is False
        assert world.idp.logged_out == [mia.idp_id]
        async with world.client(mias_cookie) as mias_browser:
            assert (await mias_browser.get("/api/v1/me")).status_code == 401
        async with transaction(Scope.SYSTEM) as db:
            assert (await db.execute(select(AuthSession).where(AuthSession.user_id == mia.id))).all() == []
        async with await world.login(admin) as client:
            assert (await client.patch(f"/api/v1/admin/users/{mia.id}", json={"active": True})).json()[
                "active"
            ] is True
        assert world.idp.users[mia.idp_id].enabled is True

    async def test_nobody_deactivates_or_removes_themselves(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(admin) as client:
            for response in (
                await client.patch(f"/api/v1/admin/users/{admin.id}", json={"active": False}),
                await client.delete(f"/api/v1/admin/users/{admin.id}"),
            ):
                assert (response.status_code, response.json()["error"]["code"]) == (422, "self_action")

    async def test_password_reset_and_ending_sessions(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia")
        cookie = await world.session(mia)
        async with await world.login(admin) as client:
            password = (await client.post(f"/api/v1/admin/users/{mia.id}/reset-password")).json()[
                "temporary_password"
            ]
            assert world.idp.users[mia.idp_id].password == password
            assert world.idp.users[mia.idp_id].must_change_password
            async with world.client(cookie) as old:
                assert (await old.get("/api/v1/me")).status_code == 401
            cookie = await world.session(mia)
            assert (await client.post(f"/api/v1/admin/users/{mia.id}/end-sessions")).status_code == 204
            async with world.client(cookie) as old:
                assert (await old.get("/api/v1/me")).status_code == 401

    async def test_deleting_a_managed_user_removes_the_identity(self, world: World, acme: Tenant) -> None:
        admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia")
        async with await world.login(admin) as client:
            assert (await client.delete(f"/api/v1/admin/users/{mia.id}")).json() == {"deleted_identity": True}
            assert (await client.get(f"/api/v1/admin/users/{mia.id}")).status_code == 404
        assert mia.idp_id not in world.idp.users
        async with transaction(Scope.SYSTEM) as db:
            assert await db.get(User, mia.id) is None
            assert (await db.execute(select(Membership).where(Membership.user_id == mia.id))).all() == []

    async def test_the_last_system_admin_cannot_be_deleted(self, world: World, acme: Tenant) -> None:
        root = await world.user(acme, "root", Role.TENANT_ADMIN, system_admin=True)
        other_root = await world.user(acme, "root2", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(other_root) as client:
            assert (await client.delete(f"/api/v1/admin/users/{root.id}")).status_code == 200
        only_root = await world.user(acme, "root3", Role.TENANT_ADMIN, system_admin=True)
        async with transaction(Scope.SYSTEM) as db:
            keep = await db.get(User, other_root.id)
            assert keep is not None
            keep.is_system_admin = False
        async with await world.login(other_root) as client:
            response = await client.delete(f"/api/v1/admin/users/{only_root.id}")
            assert response.status_code == 403  # a tenant admin cannot touch a system admin at all


class TestOwnProfile:
    async def test_users_change_their_name_but_not_their_email(self, world: World, acme: Tenant) -> None:
        mia = await world.user(acme, "mia", email="mia@acme.example")
        async with await world.login(mia) as client:
            response = await client.patch(
                "/api/v1/me/profile", json={"first_name": "Maria", "last_name": "Neu"}
            )
            assert response.json()["user"]["display_name"] == "Maria Neu"
            assert world.idp.users[mia.idp_id].first_name == "Maria"
            assert world.idp.users[mia.idp_id].email == "mia@acme.example"
            forbidden = await client.patch(
                "/api/v1/me/profile",
                json={"first_name": "M", "last_name": "N", "email": "attacker@evil.example"},
            )
            assert forbidden.status_code == 422
