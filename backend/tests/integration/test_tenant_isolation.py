"""Tenant isolation.

Two layers are tested separately:

* the API – an administrator of one tenant gets "not found" for everything of another tenant,
  including when ids are guessed or swapped into otherwise valid requests;
* the database – row-level security denies cross-tenant access even to code that forgot a filter.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from tests.conftest import World
from velydock.db import Scope, transaction
from velydock.models import (
    App,
    AppType,
    AuditLog,
    AuthSession,
    Group,
    GroupMember,
    Membership,
    Role,
    Tenant,
    User,
)


@dataclass
class TwoTenants:
    acme: Tenant
    globex: Tenant
    acme_admin: User
    globex_admin: User
    globex_user: User
    globex_group: Group
    globex_app: App
    globex_custom_app: App
    acme_group: Group
    acme_app: App


@pytest.fixture
async def two(world: World) -> TwoTenants:
    acme = await world.tenant("Acme")
    globex = await world.tenant("Globex")
    acme_admin = await world.user(acme, "anna", Role.TENANT_ADMIN, email="anna@acme.example")
    globex_admin = await world.user(globex, "gina", Role.TENANT_ADMIN, email="gina@globex.example")
    globex_user = await world.user(globex, "gero", Role.MEMBER, email="gero@globex.example")
    globex_group = await world.group(globex, "Vertrieb", [globex_user])
    globex_app = await world.app_(
        globex, "Globex CRM", url="https://crm.globex.example/", visible_to_all=True
    )
    globex_custom = await world.app_(
        globex, "Globex intern", type=AppType.CUSTOM, custom_html="<p>secret</p>", visible_to_all=True
    )
    acme_group = await world.group(acme, "Büro", [acme_admin])
    acme_app = await world.app_(acme, "Acme Wiki", url="https://wiki.acme.example/", visible_to_all=True)
    return TwoTenants(
        acme,
        globex,
        acme_admin,
        globex_admin,
        globex_user,
        globex_group,
        globex_app,
        globex_custom,
        acme_group,
        acme_app,
    )


def assert_hidden(response: httpx.Response) -> None:
    """Foreign resources must look exactly like missing ones."""
    assert response.status_code == 404, (
        f"{response.request.method} {response.request.url}: {response.status_code} {response.text}"
    )
    assert response.json()["error"]["code"] == "not_found"


class TestApiIsolation:
    async def test_lists_only_show_the_own_tenant(self, world: World, two: TwoTenants) -> None:
        async with await world.login(two.acme_admin) as client:
            users = (await client.get("/api/v1/admin/users")).json()
            assert [u["username"] for u in users["items"]] == ["anna"]
            assert users["total"] == 1
            assert [g["name"] for g in (await client.get("/api/v1/admin/groups")).json()] == ["Büro"]
            assert [a["name"] for a in (await client.get("/api/v1/admin/apps")).json()] == ["Acme Wiki"]
            assert [a["name"] for a in (await client.get("/api/v1/workspace/apps")).json()] == ["Acme Wiki"]

    async def test_search_does_not_find_foreign_users(self, world: World, two: TwoTenants) -> None:
        async with await world.login(two.acme_admin) as client:
            for term in ("gero", "globex", "gina@globex.example", "%", "_", ""):
                found = (await client.get("/api/v1/admin/users", params={"search": term})).json()
                assert all(u["username"] == "anna" for u in found["items"]), term

    async def test_foreign_user_ids_are_not_found(self, world: World, two: TwoTenants) -> None:
        uid = two.globex_user.id
        async with await world.login(two.acme_admin) as client:
            assert_hidden(await client.get(f"/api/v1/admin/users/{uid}"))
            assert_hidden(await client.patch(f"/api/v1/admin/users/{uid}", json={"first_name": "Hacked"}))
            assert_hidden(await client.patch(f"/api/v1/admin/users/{uid}", json={"active": False}))
            assert_hidden(await client.patch(f"/api/v1/admin/users/{uid}", json={"role": "tenant_admin"}))
            assert_hidden(await client.post(f"/api/v1/admin/users/{uid}/reset-password"))
            assert_hidden(await client.post(f"/api/v1/admin/users/{uid}/end-sessions"))
            assert_hidden(await client.delete(f"/api/v1/admin/users/{uid}"))
        # Nothing reached the identity provider or the database.
        assert world.idp.users[two.globex_user.idp_id].enabled
        assert world.idp.users[two.globex_user.idp_id].password == ""
        assert world.idp.logged_out == []
        async with transaction(Scope.SYSTEM) as db:
            user = await db.get(User, uid)
            assert user is not None and user.first_name == "Gero" and user.active

    async def test_foreign_group_ids_are_not_found(self, world: World, two: TwoTenants) -> None:
        gid = two.globex_group.id
        async with await world.login(two.acme_admin) as client:
            assert_hidden(await client.get(f"/api/v1/admin/groups/{gid}"))
            assert_hidden(await client.patch(f"/api/v1/admin/groups/{gid}", json={"name": "Hacked"}))
            assert_hidden(await client.patch(f"/api/v1/admin/groups/{gid}", json={"member_ids": []}))
            assert_hidden(await client.delete(f"/api/v1/admin/groups/{gid}"))
        async with transaction(Scope.SYSTEM) as db:
            group = await db.get(Group, gid)
            assert group is not None and group.name == "Vertrieb"
            assert len((await db.execute(select(GroupMember).where(GroupMember.group_id == gid))).all()) == 1

    async def test_foreign_app_ids_are_not_found(self, world: World, two: TwoTenants) -> None:
        aid = two.globex_app.id
        async with await world.login(two.acme_admin) as client:
            assert_hidden(await client.get(f"/api/v1/admin/apps/{aid}"))
            assert_hidden(
                await client.patch(f"/api/v1/admin/apps/{aid}", json={"url": "https://evil.example/"})
            )
            assert_hidden(await client.post(f"/api/v1/admin/apps/{aid}/recheck"))
            assert_hidden(await client.delete(f"/api/v1/admin/apps/{aid}"))
            assert_hidden(await client.post(f"/api/v1/workspace/apps/{aid}/launch", json={}))
            assert_hidden(await client.get(f"/api/v1/apps/{aid}/icon"))
            assert_hidden(
                await client.post(f"/api/v1/workspace/apps/{two.globex_custom_app.id}/launch", json={})
            )
        async with transaction(Scope.SYSTEM) as db:
            app = await db.get(App, aid)
            assert app is not None and app.url == "https://crm.globex.example/"

    async def test_foreign_ids_cannot_be_smuggled_into_own_objects(
        self, world: World, two: TwoTenants
    ) -> None:
        """Valid request on an own resource, but referencing ids of the other tenant."""
        async with await world.login(two.acme_admin) as client:
            foreign_group, foreign_user = str(two.globex_group.id), str(two.globex_user.id)

            new_user = {"username": "neu", "first_name": "N", "last_name": "N", "group_ids": [foreign_group]}
            response = await client.post("/api/v1/admin/users", json=new_user)
            assert (response.status_code, response.json()["error"]["code"]) == (422, "unknown_group")
            assert not [u for u in world.idp.users.values() if u.username == "neu"]

            response = await client.patch(
                f"/api/v1/admin/users/{two.acme_admin.id}", json={"group_ids": [foreign_group]}
            )
            assert response.json()["error"]["code"] == "unknown_group"

            response = await client.post(
                "/api/v1/admin/groups", json={"name": "X", "member_ids": [foreign_user]}
            )
            assert response.json()["error"]["code"] == "unknown_user"
            response = await client.patch(
                f"/api/v1/admin/groups/{two.acme_group.id}", json={"member_ids": [foreign_user]}
            )
            assert response.json()["error"]["code"] == "unknown_user"

            app = {"name": "X", "type": "external", "url": "https://x.example/"}
            response = await client.post("/api/v1/admin/apps", json={**app, "group_ids": [foreign_group]})
            assert response.json()["error"]["code"] == "unknown_group"
            response = await client.post("/api/v1/admin/apps", json={**app, "user_ids": [foreign_user]})
            assert response.json()["error"]["code"] == "unknown_user"
            response = await client.patch(
                f"/api/v1/admin/apps/{two.acme_app.id}", json={"user_ids": [foreign_user]}
            )
            assert response.json()["error"]["code"] == "unknown_user"

            order = [str(two.acme_app.id), str(two.globex_app.id)]
            assert (await client.put("/api/v1/admin/apps/order", json={"app_ids": order})).status_code == 422

    async def test_filtering_by_a_foreign_group_reveals_nothing(self, world: World, two: TwoTenants) -> None:
        async with await world.login(two.acme_admin) as client:
            found = (
                await client.get("/api/v1/admin/users", params={"group_id": str(two.globex_group.id)})
            ).json()
            assert found == {"items": [], "total": 0, "page": 1, "page_size": 25}

    async def test_a_tenant_id_in_the_request_is_ignored_or_rejected(
        self, world: World, two: TwoTenants
    ) -> None:
        """The tenant comes from the session only; clients cannot name another one."""
        async with await world.login(two.acme_admin) as client:
            body = {"name": "Mine", "tenant_id": str(two.globex.id)}
            assert (await client.post("/api/v1/admin/groups", json=body)).status_code == 422
            listed = await client.get("/api/v1/admin/users", params={"tenant_id": str(two.globex.id)})
            assert [u["username"] for u in listed.json()["items"]] == ["anna"]
            headers = {"X-Tenant-Id": str(two.globex.id), "X-Tenant": "globex"}
            assert [
                g["name"] for g in (await client.get("/api/v1/admin/groups", headers=headers)).json()
            ] == ["Büro"]

    async def test_switching_into_a_foreign_tenant_is_refused(self, world: World, two: TwoTenants) -> None:
        async with await world.login(two.acme_admin) as client:
            assert_hidden(
                await client.post("/api/v1/me/active-tenant", json={"tenant_id": str(two.globex.id)})
            )
            assert_hidden(
                await client.post("/api/v1/me/active-tenant", json={"tenant_id": str(uuid.uuid4())})
            )
            me = (await client.get("/api/v1/me")).json()
            assert me["active_tenant"]["slug"] == "acme"
            assert [m["tenant"]["slug"] for m in me["memberships"]] == ["acme"]

    async def test_a_session_pinned_to_a_foreign_tenant_falls_back(
        self, world: World, two: TwoTenants
    ) -> None:
        """Even a manipulated session row does not grant access to a tenant without membership."""
        cookie = await world.session(two.acme_admin, two.globex)
        async with world.client(cookie) as client:
            me = (await client.get("/api/v1/me")).json()
            assert me["active_tenant"]["slug"] == "acme"
            assert [a["name"] for a in (await client.get("/api/v1/admin/apps")).json()] == ["Acme Wiki"]

    async def test_tenant_admins_cannot_use_the_system_api(self, world: World, two: TwoTenants) -> None:
        tid = two.globex.id
        async with await world.login(two.acme_admin) as client:
            checks = [
                await client.get("/api/v1/system/tenants"),
                await client.post("/api/v1/system/tenants", json={"slug": "evil", "name": "Evil"}),
                await client.patch(f"/api/v1/system/tenants/{tid}", json={"active": False}),
                await client.post(f"/api/v1/system/tenants/{tid}/delete", json={"confirm_slug": "globex"}),
                await client.post(
                    f"/api/v1/system/tenants/{tid}/members", json={"user_id": str(two.acme_admin.id)}
                ),
                await client.get("/api/v1/system/users"),
                await client.patch(
                    f"/api/v1/system/users/{two.acme_admin.id}", json={"is_system_admin": True}
                ),
                await client.get("/api/v1/system/settings"),
                await client.patch("/api/v1/system/settings", json={"instance_name": "Hacked"}),
                await client.get("/api/v1/system/audit"),
            ]
            assert [r.status_code for r in checks] == [403] * len(checks)

    async def test_audit_log_is_per_tenant(self, world: World, two: TwoTenants) -> None:
        async with await world.login(two.globex_admin) as client:
            assert (
                await client.post("/api/v1/admin/groups", json={"name": "Geheimprojekt"})
            ).status_code == 201
        async with await world.login(two.acme_admin) as client:
            assert (await client.post("/api/v1/admin/groups", json={"name": "Einkauf"})).status_code == 201
            entries = (await client.get("/api/v1/admin/audit")).json()["items"]
            assert [e["target_label"] for e in entries] == ["Einkauf"]

    async def test_a_guest_identity_is_protected_from_the_host_tenant(
        self, world: World, two: TwoTenants
    ) -> None:
        """A user of Globex is a guest in Acme: Acme may remove the guest, never change the account."""
        await world.member(two.acme, two.globex_user)
        uid = two.globex_user.id
        async with await world.login(two.acme_admin) as client:
            guest = (await client.get(f"/api/v1/admin/users/{uid}")).json()
            assert guest["managed"] is False
            assert guest["home_tenant"] is None  # the owning tenant is not disclosed
            assert guest["can_edit_identity"] is False
            for change in ({"first_name": "Hacked"}, {"email": "attacker@evil.example"}, {"active": False}):
                assert (await client.patch(f"/api/v1/admin/users/{uid}", json=change)).status_code == 403
            assert (await client.post(f"/api/v1/admin/users/{uid}/reset-password")).status_code == 403
            assert (await client.post(f"/api/v1/admin/users/{uid}/end-sessions")).status_code == 403
            removed = await client.delete(f"/api/v1/admin/users/{uid}")
            assert removed.json() == {"deleted_identity": False}
        assert two.globex_user.idp_id in world.idp.users, "the identity must survive"
        assert world.idp.users[two.globex_user.idp_id].password == ""
        async with await world.login(two.globex_admin) as client:
            assert (await client.get(f"/api/v1/admin/users/{uid}")).json()["username"] == "gero"


class TestRowLevelSecurity:
    """The database itself enforces the boundary, independent of the application code above."""

    async def test_without_context_nothing_is_visible(self, two: TwoTenants) -> None:
        async with transaction(Scope.NONE) as db:
            for model in (Tenant, User, Membership, Group, GroupMember, App, AuditLog, AuthSession):
                assert (await db.execute(select(model))).all() == [], model.__tablename__

    async def test_connection_without_any_setting_sees_nothing(self, two: TwoTenants) -> None:
        from velydock.db import get_engine

        async with get_engine().connect() as conn:
            for table in ("tenants", "users", "memberships", "groups", "apps", "sessions", "audit_log"):
                assert (await conn.execute(text(f"SELECT count(*) FROM {table}"))).scalar_one() == 0, table

    async def test_tenant_scope_sees_only_its_own_rows(self, two: TwoTenants) -> None:
        async with transaction(Scope.TENANT, tenant_id=two.acme.id, user_id=two.acme_admin.id) as db:
            assert [t.slug for t in (await db.execute(select(Tenant))).scalars()] == ["acme"]
            assert [u.username for u in (await db.execute(select(User))).scalars()] == ["anna"]
            assert [g.name for g in (await db.execute(select(Group))).scalars()] == ["Büro"]
            assert [a.name for a in (await db.execute(select(App))).scalars()] == ["Acme Wiki"]
            assert {m.tenant_id for m in (await db.execute(select(Membership))).scalars()} == {two.acme.id}
            assert await db.get(App, two.globex_app.id) is None
            assert await db.get(User, two.globex_user.id) is None

    async def test_updates_and_deletes_do_not_reach_foreign_rows(self, two: TwoTenants) -> None:
        async with transaction(Scope.TENANT, tenant_id=two.acme.id, user_id=two.acme_admin.id) as db:
            updated = await db.execute(text("UPDATE apps SET url = 'https://evil.example/'"))
            assert updated.rowcount == 1  # only the own app
            deleted = await db.execute(text("DELETE FROM groups"))
            assert deleted.rowcount == 1
            assert (await db.execute(text("UPDATE users SET first_name = 'Hacked'"))).rowcount == 1
            assert (await db.execute(text("DELETE FROM memberships"))).rowcount == 1
        async with transaction(Scope.SYSTEM) as db:
            app = await db.get(App, two.globex_app.id)
            assert app is not None and app.url == "https://crm.globex.example/"
            assert await db.get(Group, two.globex_group.id) is not None
            assert (await db.get(User, two.globex_user.id)).first_name == "Gero"  # type: ignore[union-attr]

    @pytest.mark.parametrize(
        "statement",
        [
            "INSERT INTO groups (id, tenant_id, name) VALUES (gen_random_uuid(), :other, 'Planted')",
            "INSERT INTO apps (id, tenant_id, name, type, url) VALUES (gen_random_uuid(), :other, 'Planted', 'external', 'https://evil.example/')",
            "INSERT INTO memberships (id, tenant_id, user_id, role) VALUES (gen_random_uuid(), :other, :me, 'tenant_admin')",
            "INSERT INTO audit_log (tenant_id, action) VALUES (:other, 'forged')",
            "UPDATE apps SET tenant_id = :other",
            "UPDATE memberships SET tenant_id = :other",
            "INSERT INTO tenants (id, slug, name) VALUES (gen_random_uuid(), 'evil', 'Evil')",
            "INSERT INTO sessions (id_hash, user_id, expires_at) VALUES ('x', :me, now() + interval '1 hour')",
            "INSERT INTO system_settings (key, value) VALUES ('general', '{}')",
        ],
    )
    async def test_rows_cannot_be_planted_outside_the_own_tenant(
        self, two: TwoTenants, statement: str
    ) -> None:
        with pytest.raises(DBAPIError, match="row-level security"):
            async with transaction(Scope.TENANT, tenant_id=two.acme.id, user_id=two.acme_admin.id) as db:
                await db.execute(text(statement), {"other": two.globex.id, "me": two.acme_admin.id})

    @pytest.mark.parametrize(
        "statement",
        [
            "UPDATE users SET is_system_admin = true WHERE id = :me",
            "UPDATE users SET home_tenant_id = NULL WHERE id = :me",
            "UPDATE users SET idp_id = 'someone-else' WHERE id = :me",
            "INSERT INTO users (id, idp_id, username, is_system_admin, home_tenant_id) "
            "VALUES (gen_random_uuid(), 'x', 'evil', true, :own)",
            "UPDATE tenants SET slug = 'renamed'",
            "UPDATE tenants SET active = false",
        ],
    )
    async def test_protected_columns_cannot_be_changed_in_tenant_scope(
        self, two: TwoTenants, statement: str
    ) -> None:
        """Self-promotion to system administrator is blocked by a trigger, not just by the API."""
        with pytest.raises(DBAPIError, match="system scope"):
            async with transaction(Scope.TENANT, tenant_id=two.acme.id, user_id=two.acme_admin.id) as db:
                await db.execute(text(statement), {"me": two.acme_admin.id, "own": two.acme.id})

    async def test_sessions_are_invisible_outside_system_scope(self, world: World, two: TwoTenants) -> None:
        await world.session(two.globex_admin)
        await world.session(two.acme_admin)
        async with transaction(Scope.TENANT, tenant_id=two.acme.id, user_id=two.acme_admin.id) as db:
            assert (await db.execute(select(AuthSession))).all() == []
            assert (await db.execute(text("DELETE FROM sessions"))).rowcount == 0

    async def test_audit_log_is_append_only(self, world: World, two: TwoTenants) -> None:
        async with await world.login(two.acme_admin) as client:
            await client.post("/api/v1/admin/groups", json={"name": "Einkauf"})
        for scope, tenant in ((Scope.TENANT, two.acme.id), (Scope.SYSTEM, None)):
            async with transaction(scope, tenant_id=tenant, user_id=two.acme_admin.id) as db:
                assert (
                    await db.execute(text("UPDATE audit_log SET action = 'nothing happened'"))
                ).rowcount == 0
                assert (await db.execute(text("DELETE FROM audit_log"))).rowcount == 0
        async with transaction(Scope.SYSTEM) as db:
            assert [e.action for e in (await db.execute(select(AuditLog))).scalars()] == ["group.create"]

    async def test_the_context_does_not_leak_between_transactions(self, two: TwoTenants) -> None:
        async with transaction(Scope.SYSTEM) as db:
            assert len((await db.execute(select(Tenant))).all()) == 2
        async with transaction(Scope.NONE) as db:
            assert (await db.execute(select(Tenant))).all() == []
            assert (
                await db.execute(text("SELECT current_setting('app.scope', true)"))
            ).scalar_one() == "none"

    async def test_application_role_cannot_bypass_row_level_security(self, two: TwoTenants) -> None:
        async with transaction(Scope.SYSTEM) as db:
            row = (
                await db.execute(
                    text("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
                )
            ).one()
            assert (row.rolsuper, row.rolbypassrls) == (False, False)
            unprotected = (
                await db.execute(
                    text(
                        "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                        "WHERE n.nspname = 'public' AND c.relkind = 'r' AND relname <> 'alembic_version' "
                        "AND NOT (relrowsecurity AND relforcerowsecurity)"
                    )
                )
            ).all()
            assert unprotected == [], "every table must enforce row-level security"
