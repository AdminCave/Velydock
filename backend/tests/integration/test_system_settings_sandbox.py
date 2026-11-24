"""System administration, settings precedence, and delivery of custom apps on the sandbox host."""

from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import select, update

from tests.conftest import PUBLIC_URL, SANDBOX_URL, World
from velydock.db import Scope, get_engine, transaction
from velydock.models import App, AppType, Base, Group, Membership, Role, Tenant, User
from velydock.security.tokens import sign
from velydock.services.apps import SANDBOX_TOKEN_PURPOSE
from velydock.services.custom_apps import SANDBOX_FLAGS, SEALED_SANDBOX_FLAGS


@pytest.fixture
async def root(world: World) -> User:
    main = await world.tenant("Admin Cave", "main")
    return await world.user(main, "root", Role.TENANT_ADMIN, system_admin=True)


class TestTenants:
    async def test_system_admin_creates_a_tenant_and_its_first_admin(self, world: World, root: User) -> None:
        async with await world.login(root) as client:
            created = await client.post("/api/v1/system/tenants", json={"slug": "acme", "name": "Acme GmbH"})
            assert created.status_code == 201, created.text
            tenant = created.json()
            assert (tenant["slug"], tenant["name"], tenant["active"], tenant["member_count"]) == (
                "acme",
                "Acme GmbH",
                True,
                0,
            )
            # The tenant is mirrored as an organization in the identity provider.
            assert [o["alias"] for o in world.idp.organizations.values()] == ["main", "acme"]

            switched = await client.post("/api/v1/me/active-tenant", json={"tenant_id": tenant["id"]})
            assert switched.json()["active_tenant"]["slug"] == "acme"
            assert switched.json()["role"] is None  # entered as system administrator, not as a member
            admin = await client.post(
                "/api/v1/admin/users",
                json={"username": "anna", "first_name": "Anna", "last_name": "Admin", "role": "tenant_admin"},
            )
            assert admin.status_code == 201
            assert admin.json()["user"]["role"] == "tenant_admin"
            listed = (await client.get("/api/v1/system/tenants")).json()
            assert [(t["slug"], t["member_count"]) for t in listed] == [("acme", 1), ("main", 1)]
            actions = [e["action"] for e in (await client.get("/api/v1/system/audit")).json()["items"]]
            assert actions == ["tenant.create"]

    async def test_names_and_slugs_are_unique(self, world: World, root: User) -> None:
        async with await world.login(root) as client:
            await client.post("/api/v1/system/tenants", json={"slug": "acme", "name": "Acme"})
            same_slug = await client.post("/api/v1/system/tenants", json={"slug": "acme", "name": "Other"})
            same_name = await client.post("/api/v1/system/tenants", json={"slug": "acme2", "name": "ACME"})
            assert same_slug.json()["error"]["code"] == "tenant_slug_taken"
            assert same_name.json()["error"]["code"] == "tenant_name_taken"
            assert len(world.idp.organizations) == 2

    async def test_rename_and_deactivate(self, world: World, root: User) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna", Role.TENANT_ADMIN)
        cookie = await world.session(anna)
        async with await world.login(root) as client:
            renamed = await client.patch(f"/api/v1/system/tenants/{acme.id}", json={"name": "Acme AG"})
            assert renamed.json()["name"] == "Acme AG"
            assert world.idp.organizations[acme.idp_org_id or ""]["name"] == "Acme AG"
            off = await client.patch(f"/api/v1/system/tenants/{acme.id}", json={"active": False})
            assert off.json()["active"] is False
            assert world.idp.organizations[acme.idp_org_id or ""]["enabled"] is False
        # Members of a deactivated tenant keep their account but have nowhere to go.
        async with world.client(cookie) as client:
            me = (await client.get("/api/v1/me")).json()
            assert me["active_tenant"] is None and me["memberships"] == []
            assert (await client.get("/api/v1/admin/users")).status_code == 403
            assert (await client.get("/api/v1/workspace/apps")).status_code == 403

    async def test_delete_removes_everything_the_tenant_owns(self, world: World, root: User) -> None:
        acme = await world.tenant("Acme")
        globex = await world.tenant("Globex")
        anna = await world.user(acme, "anna", Role.TENANT_ADMIN)
        guest = await world.user(globex, "gero")
        await world.member(acme, guest)
        await world.group(acme, "Büro", [anna])
        await world.app_(acme, "Wiki", visible_to_all=True)
        annas_cookie = await world.session(anna)
        async with await world.login(root) as client:
            wrong = await client.post(
                f"/api/v1/system/tenants/{acme.id}/delete", json={"confirm_slug": "globex"}
            )
            assert wrong.json()["error"]["code"] == "confirmation_mismatch"
            assert (
                await client.post(f"/api/v1/system/tenants/{acme.id}/delete", json={"confirm_slug": "acme"})
            ).status_code == 204
        assert anna.idp_id not in world.idp.users, "identities owned by the tenant are deleted"
        assert guest.idp_id in world.idp.users, "guests keep their account"
        assert acme.idp_org_id not in world.idp.organizations
        async with transaction(Scope.SYSTEM) as db:
            assert await db.get(Tenant, acme.id) is None
            assert await db.get(User, anna.id) is None
            assert await db.get(User, guest.id) is not None
            assert (await db.execute(select(Group).where(Group.tenant_id == acme.id))).all() == []
            assert (await db.execute(select(App).where(App.tenant_id == acme.id))).all() == []
            assert (await db.execute(select(Membership).where(Membership.tenant_id == acme.id))).all() == []
        async with world.client(annas_cookie) as client:
            assert (await client.get("/api/v1/me")).status_code == 401

    async def test_the_operators_own_tenant_is_protected(self, world: World, root: User) -> None:
        async with await world.login(root) as client:
            main_id = (await client.get("/api/v1/me")).json()["active_tenant"]["id"]
            deleted = await client.post(
                f"/api/v1/system/tenants/{main_id}/delete", json={"confirm_slug": "main"}
            )
            deactivated = await client.patch(f"/api/v1/system/tenants/{main_id}", json={"active": False})
            assert deleted.json()["error"]["code"] == "tenant_protected"
            assert deactivated.json()["error"]["code"] == "tenant_protected"


class TestSystemUsers:
    async def test_existing_identity_becomes_a_guest_elsewhere(self, world: World, root: User) -> None:
        acme = await world.tenant("Acme")
        globex = await world.tenant("Globex")
        gero = await world.user(globex, "gero")
        async with await world.login(root) as client:
            found = (await client.get("/api/v1/system/users", params={"search": "ger"})).json()
            assert [u["username"] for u in found["items"]] == ["gero"]
            added = await client.post(
                f"/api/v1/system/tenants/{acme.id}/members", json={"user_id": str(gero.id), "role": "member"}
            )
            assert added.status_code == 201
            assert sorted(m["tenant"]["slug"] for m in added.json()["memberships"]) == ["acme", "globex"]
            assert added.json()["home_tenant"]["slug"] == "globex"
            again = await client.post(
                f"/api/v1/system/tenants/{acme.id}/members", json={"user_id": str(gero.id)}
            )
            assert again.json()["error"]["code"] == "already_member"
        assert gero.idp_id in world.idp.members[acme.idp_org_id or ""]
        async with await world.login(gero) as client:
            me = (await client.get("/api/v1/me")).json()
            assert sorted(m["tenant"]["slug"] for m in me["memberships"]) == ["acme", "globex"]
            switched = await client.post("/api/v1/me/active-tenant", json={"tenant_id": str(acme.id)})
            assert switched.json()["active_tenant"]["slug"] == "acme"
            # The choice sticks for the next sign-in.
        async with await world.login(gero) as client:
            assert (await client.get("/api/v1/me")).json()["active_tenant"]["slug"] == "acme"

    async def test_unassigned_identity_gets_its_first_home(self, world: World, root: User) -> None:
        acme = await world.tenant("Acme")
        nora = await world.user(None, "nora", None, home=None)
        async with await world.login(root) as client:
            added = await client.post(
                f"/api/v1/system/tenants/{acme.id}/members", json={"user_id": str(nora.id)}
            )
            assert added.json()["home_tenant"]["slug"] == "acme"

    async def test_granting_and_revoking_system_administrator(self, world: World, root: User) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with await world.login(root) as client:
            granted = await client.patch(f"/api/v1/system/users/{anna.id}", json={"is_system_admin": True})
            assert granted.json()["is_system_admin"] is True
            own = await client.patch(f"/api/v1/system/users/{root.id}", json={"is_system_admin": False})
            assert own.json()["error"]["code"] == "self_action"
        async with await world.login(anna) as client:
            assert (await client.get("/api/v1/system/tenants")).status_code == 200
            revoked = await client.patch(f"/api/v1/system/users/{root.id}", json={"is_system_admin": False})
            assert revoked.json()["is_system_admin"] is False
        async with await world.login(root) as client:
            assert (await client.get("/api/v1/system/tenants")).status_code == 403

    async def test_at_least_one_system_admin_remains(self, world: World, root: User) -> None:
        acme = await world.tenant("Acme")
        disabled_root = await world.user(acme, "old-root", system_admin=True, active=False)
        async with await world.login(root) as client:
            # Disabled administrators do not count as a remaining one.
            assert (
                await client.patch(
                    f"/api/v1/system/users/{disabled_root.id}", json={"is_system_admin": False}
                )
            ).status_code == 200


class TestSettings:
    async def test_personal_settings_persist(self, world: World) -> None:
        acme = await world.tenant("Acme")
        mia = await world.user(acme, "mia")
        async with await world.login(mia) as client:
            me = (await client.get("/api/v1/me")).json()
            assert me["settings"] == {
                "theme": "system",
                "nav_position": "left",
                "accent_color": None,
                "app_bar": "hidden",
                "language": "de",
                "theme_locked": False,
                "nav_position_locked": False,
                "accent_locked": False,
                "app_bar_locked": False,
            }
            assert me["own_settings"] == {
                "theme": None,
                "nav_position": None,
                "accent_color": None,
                "app_bar": None,
                "language": None,
            }
            saved = await client.patch(
                "/api/v1/me/settings", json={"theme": "dark", "nav_position": "bottom", "language": "en"}
            )
            assert saved.status_code == 200
        # A fresh session (new browser, later day) sees the stored values.
        async with await world.login(mia) as client:
            me = (await client.get("/api/v1/me")).json()
            assert (me["settings"]["theme"], me["settings"]["nav_position"], me["settings"]["language"]) == (
                "dark",
                "bottom",
                "en",
            )
            reset = await client.patch("/api/v1/me/settings", json={"nav_position": None})
            assert reset.json()["settings"]["nav_position"] == "left"
            assert reset.json()["settings"]["theme"] == "dark"

    @pytest.mark.parametrize("position", ["left", "right", "top", "bottom"])
    async def test_all_four_navigation_positions_are_accepted(self, world: World, position: str) -> None:
        acme = await world.tenant("Acme")
        mia = await world.user(acme, "mia")
        async with await world.login(mia) as client:
            saved = await client.patch("/api/v1/me/settings", json={"nav_position": position})
            assert saved.json()["settings"]["nav_position"] == position
            assert (
                await client.patch("/api/v1/me/settings", json={"nav_position": "center"})
            ).status_code == 422

    async def test_navigation_position_precedence(self, world: World, root: User) -> None:
        """User choice > tenant default > system default; a tenant lock overrides the user."""
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna", Role.TENANT_ADMIN)
        mia = await world.user(acme, "mia")

        async def position(user: User) -> tuple[str, bool]:
            async with await world.login(user) as client:
                settings = (await client.get("/api/v1/me")).json()["settings"]
                return settings["nav_position"], settings["nav_position_locked"]

        assert await position(mia) == ("left", False)
        async with await world.login(root) as client:
            assert (
                await client.patch("/api/v1/system/settings", json={"default_nav_position": "right"})
            ).status_code == 200
        assert await position(mia) == ("right", False)
        async with await world.login(anna) as client:
            saved = await client.patch("/api/v1/admin/tenant", json={"default_nav_position": "top"})
            assert saved.json()["default_nav_position"] == "top"
        assert await position(mia) == ("top", False)
        async with await world.login(mia) as client:
            await client.patch("/api/v1/me/settings", json={"nav_position": "bottom"})
        assert await position(mia) == ("bottom", False)
        async with await world.login(anna) as client:
            await client.patch("/api/v1/admin/tenant", json={"nav_position_locked": True})
        assert await position(mia) == ("top", True)
        async with await world.login(anna) as client:
            await client.patch(
                "/api/v1/admin/tenant", json={"nav_position_locked": False, "default_nav_position": None}
            )
        assert await position(mia) == ("bottom", False)
        assert await position(anna) == ("right", False)

    async def test_system_settings(self, world: World, root: User) -> None:
        async with await world.login(root) as client:
            current = (await client.get("/api/v1/system/settings")).json()
            assert (current["instance_name"], current["smtp_configured"]) == ("Velydock", False)
            saved = await client.patch(
                "/api/v1/system/settings",
                json={
                    "instance_name": "Admin Cave Dock",
                    "default_theme": "dark",
                    "default_language": "en",
                    "smtp": {
                        "host": "mail.example.org",
                        "port": 465,
                        "from_address": "dock@example.org",
                        "username": "dock",
                        "password": "s3cret-smtp",
                        "encryption": "ssl",
                    },
                },
            )
            assert saved.status_code == 200, saved.text
            body = saved.json()
            assert (body["instance_name"], body["default_theme"], body["smtp_configured"]) == (
                "Admin Cave Dock",
                "dark",
                True,
            )
            assert body["smtp"]["password"] == "" and "s3cret-smtp" not in saved.text
            assert world.idp.smtp.password == "s3cret-smtp" and world.idp.display_name == "Admin Cave Dock"
            assert "s3cret-smtp" not in (await client.get("/api/v1/system/audit")).text
        async with world.client() as anonymous:
            public = (await anonymous.get("/api/v1/public")).json()
            assert (public["instance_name"], public["default_language"], public["default_theme"]) == (
                "Admin Cave Dock",
                "en",
                "dark",
            )
            assert set(public) == {"instance_name", "default_language", "default_theme", "version"}


class TestSandboxHost:
    async def launch(self, world: World, user: User, app: App) -> str:
        async with await world.login(user) as client:
            response = await client.post(
                f"/api/v1/workspace/apps/{app.id}/launch", json={"theme": "dark", "language": "de"}
            )
            assert response.status_code == 200, response.text
            return str(response.json()["url"])

    @pytest.fixture
    async def setup(self, world: World) -> tuple[User, App]:
        acme = await world.tenant("Acme")
        mia = await world.user(acme, "mia")
        app = await world.app_(
            acme,
            "Eigene",
            type=AppType.CUSTOM,
            visible_to_all=True,
            custom_html="<h1 id=t>Hallo</h1>",
            custom_css="h1{color:red}",
            custom_js="document.title='x'",
        )
        return mia, app

    async def test_custom_app_is_served_in_a_confining_wrapper(
        self, world: World, setup: tuple[User, App]
    ) -> None:
        # A network-off app is delivered as a script-less wrapper that frames the app one level
        # down; the wrapper's frame-src confines every navigation the app makes to the sandbox
        # host, so the app cannot carry data to a foreign address even on a click.
        mia, app = setup
        url = await self.launch(world, mia, app)
        async with world.client(csrf=False, base_url=SANDBOX_URL) as sandbox:
            wrapper = await sandbox.get(url)
            # 1. /c/<token> is the wrapper: the app's HTML and script are NOT here.
            assert wrapper.status_code == 200
            assert "<h1 id=t>Hallo</h1>" not in wrapper.text
            assert "<script" not in wrapper.text.lower()
            assert "<iframe" in wrapper.text and "?d=1" in wrapper.text
            wcsp = wrapper.headers["content-security-policy"]
            assert f"sandbox {SEALED_SANDBOX_FLAGS};" in wcsp
            assert "allow-popups" not in wcsp and "allow-same-origin" not in wcsp
            assert f"frame-src {SANDBOX_URL}" in wcsp  # the inner app is pinned to the sandbox host
            assert f"frame-ancestors {PUBLIC_URL}" in wcsp  # only Velydock may frame the wrapper
            assert wrapper.headers["x-dns-prefetch-control"] == "off"
            assert "set-cookie" not in wrapper.headers
            # 2. the app document itself (?d=1): the author's code, sealed and network-closed.
            doc = await sandbox.get(url + "?d=1")
            assert doc.status_code == 200
            assert "<h1 id=t>Hallo</h1>" in doc.text and 'data-theme="dark"' in doc.text
            csp = doc.headers["content-security-policy"]
            assert csp.startswith(f"sandbox {SEALED_SANDBOX_FLAGS};")
            assert (
                "allow-popups" not in csp
                and "allow-same-origin" not in csp
                and "allow-top-navigation" not in csp
            )
            assert "connect-src 'none'" in csp and "frame-src 'none'" in csp and "form-action 'none'" in csp
            assert "frame-ancestors" not in csp  # framed by the wrapper, which carries the check
            assert doc.headers["referrer-policy"] == "no-referrer"
            assert doc.headers["cache-control"] == "no-store"
            assert doc.headers["x-dns-prefetch-control"] == "off"
            assert "set-cookie" not in doc.headers

    async def test_the_inner_marker_is_no_bypass_of_the_token(
        self, world: World, setup: tuple[User, App]
    ) -> None:
        # The signed token stays the only grant: the "?d=1" marker that selects the app document
        # inside the wrapper does not skip the signature or version check.
        mia, app = setup
        token = (await self.launch(world, mia, app)).rsplit("/", 1)[1]
        forged = sign(
            "another-secret-key-" + "0" * 32,
            SANDBOX_TOKEN_PURPOSE,
            {"app": str(app.id), "ver": int(app.updated_at.timestamp())},
            300,
        )
        async with world.client(csrf=False, base_url=SANDBOX_URL) as sandbox:
            assert (await sandbox.get("/c/not-a-token?d=1")).status_code == 403
            assert (await sandbox.get(f"/c/{forged}?d=1")).status_code == 403
            assert "<h1 id=t>Hallo</h1>" in (await sandbox.get(f"/c/{token}?d=1")).text

    async def test_sandbox_host_serves_nothing_else(self, world: World, setup: tuple[User, App]) -> None:
        mia, _ = setup
        cookie = await world.session(mia)
        # Even with a valid session cookie sent along, the sandbox host has no API and no UI.
        async with world.client(cookie, base_url=SANDBOX_URL) as sandbox:
            for path in (
                "/api/v1/me",
                "/api/health",
                "/api/auth/login",
                "/",
                "/admin/users",
                "/api/v1/workspace/apps",
            ):
                response = await sandbox.get(path)
                assert response.status_code == 404, path
                assert response.text == "" and "set-cookie" not in response.headers
            assert (await sandbox.post("/api/auth/logout")).status_code == 404
        async with world.client(cookie) as main:
            assert (await main.get("/api/v1/me")).status_code == 200, "the session was not touched"

    async def test_main_host_never_serves_custom_content(self, world: World, setup: tuple[User, App]) -> None:
        mia, app = setup
        path = (await self.launch(world, mia, app)).removeprefix(SANDBOX_URL)
        async with await world.login(mia) as main:
            response = await main.get(path)
            assert "Hallo" not in response.text
            assert response.status_code == 404

    async def test_host_header_decides_not_the_url(self, world: World, setup: tuple[User, App]) -> None:
        mia, app = setup
        path = (await self.launch(world, mia, app)).removeprefix(SANDBOX_URL)
        async with world.client(csrf=False) as client:
            spoofed = await client.get(path, headers={"Host": "sandbox.test"})
            # The sandbox host serves the custom app (here its confining wrapper); the main host
            # below does not, whatever the path.
            assert spoofed.status_code == 200 and "<iframe" in spoofed.text and "?d=1" in spoofed.text
            for host in ("dock.test", "evil.example", "sandbox.test.evil.example", "SANDBOX.TEST:443"):
                response = await client.get("/api/v1/me", headers={"Host": host})
                assert response.status_code in (401, 404), host
            mixed_case = await client.get("/api/v1/me", headers={"Host": "SANDBOX.TEST"})
            assert mixed_case.status_code == 404

    async def test_links_expire_and_cannot_be_forged(self, world: World, setup: tuple[User, App]) -> None:
        mia, app = setup
        url = await self.launch(world, mia, app)
        token = url.rsplit("/", 1)[1]
        payload, signature = token.split(".")
        version = int(app.updated_at.timestamp())
        expired = sign(
            world.settings.secret_key, SANDBOX_TOKEN_PURPOSE, {"app": str(app.id), "ver": version}, -10
        )
        other_key = sign(
            "another-secret-key-" + "0" * 32, SANDBOX_TOKEN_PURPOSE, {"app": str(app.id), "ver": version}, 300
        )
        other_purpose = sign(
            world.settings.secret_key, "login-state", {"app": str(app.id), "ver": version}, 300
        )
        async with world.client(csrf=False, base_url=SANDBOX_URL) as sandbox:
            for bad in (
                expired,
                other_key,
                other_purpose,
                f"{payload}.{signature[::-1]}",
                f"{payload}x.{signature}",
                "x",
                "a.b",
            ):
                response = await sandbox.get(f"/c/{bad}")
                assert response.status_code == 403, bad
                assert "Hallo" not in response.text
                assert "sandbox" in response.headers["content-security-policy"]

    async def test_old_links_die_when_the_app_changes_or_is_disabled(
        self, world: World, setup: tuple[User, App]
    ) -> None:
        mia, app = setup
        url = await self.launch(world, mia, app)
        async with transaction(Scope.SYSTEM) as db:
            await db.execute(
                update(App)
                .where(App.id == app.id)
                .values(updated_at=datetime.now(UTC) + timedelta(seconds=5))
            )
        async with world.client(csrf=False, base_url=SANDBOX_URL) as sandbox:
            assert (await sandbox.get(url)).status_code == 404
        async with transaction(Scope.SYSTEM) as db:
            refreshed = await db.get(App, app.id)
            assert refreshed is not None
            version = int(refreshed.updated_at.timestamp())
            await db.execute(
                update(App).where(App.id == app.id).values(enabled=False, updated_at=refreshed.updated_at)
            )
        fresh = sign(
            world.settings.secret_key, SANDBOX_TOKEN_PURPOSE, {"app": str(app.id), "ver": version}, 300
        )
        async with world.client(csrf=False, base_url=SANDBOX_URL) as sandbox:
            assert (await sandbox.get(f"/c/{fresh}")).status_code == 404

    async def test_network_access_is_opt_in(self, world: World, setup: tuple[User, App]) -> None:
        mia, app = setup
        async with transaction(Scope.SYSTEM) as db:
            await db.execute(
                update(App)
                .where(App.id == app.id)
                .values(custom_allow_network=True, updated_at=App.updated_at)
            )
        url = await self.launch(world, mia, app)
        async with world.client(csrf=False, base_url=SANDBOX_URL) as sandbox:
            response = await sandbox.get(url)
        csp = response.headers["content-security-policy"]
        assert "connect-src https:" in csp
        assert csp.startswith(f"sandbox {SANDBOX_FLAGS};") and "allow-same-origin" not in csp
        # An app with network access is served directly (no wrapper): it keeps popups and can
        # exfiltrate by design, so confining its navigation would buy nothing.
        assert "<h1 id=t>Hallo</h1>" in response.text
        assert f"frame-ancestors {PUBLIC_URL}" in csp

    def test_token_lifetime_is_short(self) -> None:
        from velydock.services.apps import SANDBOX_TOKEN_TTL

        assert SANDBOX_TOKEN_TTL <= 600
        assert time.time() > 0


class TestSchema:
    async def test_migrations_match_the_models(self, clean_db: None) -> None:
        """Guards against changing a model without writing a migration."""

        def diff(connection: object) -> list[object]:
            context = MigrationContext.configure(connection, opts={"compare_type": True})  # type: ignore[arg-type]
            return list(compare_metadata(context, Base.metadata))

        async with get_engine().connect() as conn:
            assert await conn.run_sync(diff) == []
