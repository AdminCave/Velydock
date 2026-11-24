"""Appearance per organization and per user: theme, accent colour, dock position, app bar, logo."""

from __future__ import annotations

import base64

import pytest
from sqlalchemy import select

from tests.conftest import World
from velydock.db import Scope, transaction
from velydock.models import Role, Tenant, User

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><script>alert(1)</script><rect width="8" height="8"/></svg>'


def data_url(data: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


@pytest.fixture
async def acme(world: World) -> Tenant:
    return await world.tenant("Acme")


@pytest.fixture
async def anna(world: World, acme: Tenant) -> User:
    return await world.user(acme, "anna", Role.TENANT_ADMIN)


@pytest.fixture
async def mia(world: World, acme: Tenant) -> User:
    return await world.user(acme, "mia")


async def settings_of(world: World, user: User) -> dict[str, object]:
    async with await world.login(user) as client:
        return (await client.get("/api/v1/me")).json()["settings"]  # type: ignore[no-any-return]


# What an organization can set, as (its default, its lock, the user's own setting, two values,
# what applies when nobody chose anything).
SETTINGS = [
    ("default_theme", "theme_locked", "theme", "dark", "light", "system"),
    ("accent_color", "accent_locked", "accent_color", "#c2410c", "#0f766e", None),
    ("default_nav_position", "nav_position_locked", "nav_position", "right", "bottom", "left"),
    ("default_app_bar", "app_bar_locked", "app_bar", "bottom", "top", "hidden"),
]


class TestWhoDecides:
    @pytest.mark.parametrize(("default", "lock", "own", "of_org", "of_user", "otherwise"), SETTINGS)
    async def test_the_users_choice_wins_until_the_organization_locks_its_own(
        self,
        world: World,
        anna: User,
        mia: User,
        default: str,
        lock: str,
        own: str,
        of_org: str,
        of_user: str,
        otherwise: str | None,
    ) -> None:
        async def applies() -> tuple[object, object]:
            settings = await settings_of(world, mia)
            return settings[own], settings[lock]

        assert await applies() == (otherwise, False)
        # The organization's default applies to everybody who has not chosen …
        async with await world.login(anna) as admin:
            saved = await admin.patch("/api/v1/admin/tenant", json={default: of_org})
            assert saved.status_code == 200 and saved.json()[default] == of_org
        assert await applies() == (of_org, False)
        # … the user's own choice wins over it …
        async with await world.login(mia) as client:
            chosen = await client.patch("/api/v1/me/settings", json={own: of_user})
            assert chosen.status_code == 200 and chosen.json()["own_settings"][own] == of_user
        assert await applies() == (of_user, False)
        # … until the organization fixes its own for everybody.
        async with await world.login(anna) as admin:
            assert (await admin.patch("/api/v1/admin/tenant", json={lock: True})).json()[lock] is True
        assert await applies() == (of_org, True)
        # The user's choice is kept, not thrown away: unlocked, it is back.
        async with await world.login(anna) as admin:
            await admin.patch("/api/v1/admin/tenant", json={lock: False})
        assert await applies() == (of_user, False)
        # Without a default of the organization and without an own choice: what came before.
        async with await world.login(anna) as admin:
            assert (await admin.patch("/api/v1/admin/tenant", json={default: None})).json()[default] is None
        async with await world.login(mia) as client:
            await client.patch("/api/v1/me/settings", json={own: None})
        assert await applies() == (otherwise, False)

    async def test_a_lock_without_a_default_fixes_what_the_installation_uses(
        self, world: World, anna: User, mia: User
    ) -> None:
        async with await world.login(mia) as client:
            await client.patch("/api/v1/me/settings", json={"theme": "dark", "accent_color": "#c2410c"})
        async with await world.login(anna) as admin:
            await admin.patch("/api/v1/admin/tenant", json={"theme_locked": True, "accent_locked": True})
        settings = await settings_of(world, mia)
        assert (settings["theme"], settings["accent_color"]) == ("system", None)

    async def test_each_organization_has_its_own_appearance(
        self, world: World, anna: User, mia: User
    ) -> None:
        globex = await world.tenant("Globex")
        gina = await world.user(globex, "gina", Role.TENANT_ADMIN)
        async with await world.login(anna) as admin:
            await admin.patch(
                "/api/v1/admin/tenant",
                json={"accent_color": "#c2410c", "default_app_bar": "bottom", "app_bar_locked": True},
            )
        acme_view, globex_view = await settings_of(world, mia), await settings_of(world, gina)
        assert (acme_view["accent_color"], acme_view["app_bar"], acme_view["app_bar_locked"]) == (
            "#c2410c",
            "bottom",
            True,
        )
        assert (globex_view["accent_color"], globex_view["app_bar"], globex_view["app_bar_locked"]) == (
            None,
            "hidden",
            False,
        )

    async def test_a_guest_sees_the_organization_they_are_in(
        self, world: World, acme: Tenant, anna: User
    ) -> None:
        globex = await world.tenant("Globex")
        guest = await world.user(globex, "gast")
        await world.member(acme, guest, Role.MEMBER)
        async with await world.login(anna) as admin:
            await admin.patch("/api/v1/admin/tenant", json={"accent_color": "#c2410c", "accent_locked": True})
        async with await world.login(guest) as client:
            await client.patch("/api/v1/me/settings", json={"accent_color": "#0f766e"})
            for tenant, applies in ((globex, "#0f766e"), (acme, "#c2410c"), (globex, "#0f766e")):
                assert (
                    await client.post("/api/v1/me/active-tenant", json={"tenant_id": str(tenant.id)})
                ).status_code == 200
                assert (await client.get("/api/v1/me")).json()["settings"]["accent_color"] == applies


class TestWhatIsAccepted:
    async def test_colours_and_positions(self, world: World, anna: User, mia: User) -> None:
        async with await world.login(mia) as client:
            for bad in ("red", "#12345", "#1234567", "#gggggg", "c2410c", "rgb(1,2,3)", ""):
                response = await client.patch("/api/v1/me/settings", json={"accent_color": bad})
                assert response.status_code == 422, bad
            ok = await client.patch("/api/v1/me/settings", json={"accent_color": " #C2410C "})
            assert ok.json()["own_settings"]["accent_color"] == "#c2410c"
            assert (await client.patch("/api/v1/me/settings", json={"app_bar": "left"})).status_code == 422
        async with await world.login(anna) as admin:
            for body in ({"accent_color": "blue"}, {"default_app_bar": "side"}, {"default_theme": "pink"}):
                assert (await admin.patch("/api/v1/admin/tenant", json=body)).status_code == 422, body
            assert (await admin.patch("/api/v1/admin/tenant", json={"logo_url": "x"})).status_code == 422

    async def test_only_administrators_change_the_organization(
        self, world: World, acme: Tenant, mia: User
    ) -> None:
        uwe = await world.user(acme, "uwe", Role.USER_MANAGER)
        for user in (mia, uwe):
            async with await world.login(user) as client:
                assert (await client.get("/api/v1/admin/tenant")).status_code == 403
                refused = await client.patch("/api/v1/admin/tenant", json={"accent_color": "#c2410c"})
                assert refused.status_code == 403
        assert (await settings_of(world, mia))["accent_color"] is None

    async def test_the_log_says_what_changed_and_nothing_when_nothing_did(
        self, world: World, anna: User
    ) -> None:
        async with await world.login(anna) as admin:
            body = {
                "accent_color": "#c2410c",
                "theme_locked": True,
                "logo": {"data_url": data_url(PNG, "image/png")},
            }
            assert (await admin.patch("/api/v1/admin/tenant", json=body)).status_code == 200
            # The same again changes nothing - except the logo, which was sent again.
            again = {"accent_color": "#c2410c", "theme_locked": True}
            assert (await admin.patch("/api/v1/admin/tenant", json=again)).status_code == 200
            entries = [
                e
                for e in (await admin.get("/api/v1/admin/audit")).json()["items"]
                if e["action"] == "tenant.settings"
            ]
        assert len(entries) == 1
        assert entries[0]["details"] == {"accent_color": "#c2410c", "theme_locked": True, "logo": "changed"}


class TestLogo:
    async def test_an_administrator_sets_and_removes_the_logo(
        self, world: World, anna: User, mia: User
    ) -> None:
        async with await world.login(mia) as client:
            assert (await client.get("/api/v1/me")).json()["active_tenant"]["logo_url"] is None
            assert (await client.get("/api/v1/tenant/logo")).status_code == 404
        async with await world.login(anna) as admin:
            saved = await admin.patch(
                "/api/v1/admin/tenant", json={"logo": {"data_url": data_url(PNG, "image/png")}}
            )
            assert saved.status_code == 200
            assert saved.json()["logo_url"].startswith("/api/v1/tenant/logo?v=")
        async with await world.login(mia) as client:
            url = (await client.get("/api/v1/me")).json()["active_tenant"]["logo_url"]
            assert url == saved.json()["logo_url"]
            image = await client.get(url)
            assert image.status_code == 200 and image.content == PNG
            assert image.headers["content-type"] == "image/png"
        async with await world.login(anna) as admin:
            removed = await admin.patch("/api/v1/admin/tenant", json={"logo": None})
            assert removed.json()["logo_url"] is None
        async with await world.login(mia) as client:
            assert (await client.get("/api/v1/tenant/logo")).status_code == 404

    async def test_what_counts_as_an_image_is_decided_by_its_content(self, world: World, anna: User) -> None:
        async with await world.login(anna) as admin:
            for body, code in (
                (data_url(b"<html><script>alert(1)</script></html>", "image/png"), "logo_invalid"),
                (data_url(b"not an image", "image/svg+xml"), "logo_invalid"),
                ("https://example.org/logo.png", "logo_invalid"),
                (data_url(PNG + b"0" * (256 * 1024), "image/png"), "logo_too_large"),
            ):
                response = await admin.patch("/api/v1/admin/tenant", json={"logo": {"data_url": body}})
                assert response.status_code == 422, code
                assert response.json()["error"]["code"] == code
            assert (await admin.get("/api/v1/admin/tenant")).json()["logo_url"] is None
            # The claimed type does not matter: a PNG sent as "text/html" is stored as what it is.
            assert (
                await admin.patch(
                    "/api/v1/admin/tenant", json={"logo": {"data_url": data_url(PNG, "text/html")}}
                )
            ).status_code == 200
            assert (await admin.get("/api/v1/tenant/logo")).headers["content-type"] == "image/png"

    async def test_a_script_in_an_uploaded_svg_can_never_run(self, world: World, anna: User) -> None:
        async with await world.login(anna) as admin:
            await admin.patch(
                "/api/v1/admin/tenant", json={"logo": {"data_url": data_url(SVG, "image/svg+xml")}}
            )
            image = await admin.get("/api/v1/tenant/logo")
        assert image.headers["content-type"].startswith("image/svg+xml")
        assert "sandbox" in image.headers["content-security-policy"]
        assert "default-src 'none'" in image.headers["content-security-policy"]
        assert image.headers["x-content-type-options"] == "nosniff"

    async def test_nobody_reaches_the_logo_of_another_organization(self, world: World, anna: User) -> None:
        globex = await world.tenant("Globex")
        gero = await world.user(globex, "gero")
        nobody = await world.user(None, "ohne")
        async with await world.login(anna) as admin:
            await admin.patch("/api/v1/admin/tenant", json={"logo": {"data_url": data_url(PNG, "image/png")}})
        # There is no address that names an organization: everybody gets their own, or nothing.
        for user in (gero, nobody):
            async with await world.login(user) as client:
                assert (await client.get("/api/v1/tenant/logo")).status_code == 404
                assert (
                    await client.get("/api/v1/tenant/logo", params={"tenant_id": "acme"})
                ).status_code == 404
        async with world.client() as anonymous:
            assert (await anonymous.get("/api/v1/tenant/logo")).status_code == 401

    async def test_the_image_is_not_loaded_with_every_request(
        self, world: World, acme: Tenant, anna: User
    ) -> None:
        """A tenant row is read for every request; the logo must not travel along each time."""
        async with await world.login(anna) as admin:
            await admin.patch("/api/v1/admin/tenant", json={"logo": {"data_url": data_url(PNG, "image/png")}})
        async with transaction(Scope.SYSTEM) as db:
            tenant = (await db.execute(select(Tenant).where(Tenant.id == acme.id))).scalar_one()
            assert "logo_data" not in tenant.__dict__
            assert tenant.logo_mime == "image/png"

    async def test_a_new_logo_gets_a_new_address(self, world: World, anna: User) -> None:
        """The image is cached for a day; a replaced logo must not stay hidden behind the old one,
        even when it is replaced right away."""
        async with await world.login(anna) as admin:
            urls = []
            for image, mime in ((PNG, "image/png"), (SVG, "image/svg+xml"), (PNG, "image/png")):
                saved = await admin.patch(
                    "/api/v1/admin/tenant", json={"logo": {"data_url": data_url(image, mime)}}
                )
                urls.append(saved.json()["logo_url"])
        assert len(set(urls)) == 3, urls
