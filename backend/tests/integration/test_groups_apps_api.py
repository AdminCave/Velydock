"""Groups, applications, and what members see in their workspace."""

from __future__ import annotations

import base64
from collections.abc import Iterator
from urllib.parse import urlsplit

import pytest

from tests.conftest import SANDBOX_URL, World
from velydock.config import Settings
from velydock.models import AppType, EmbedStatus, Role, Tenant, User
from velydock.services import apps as apps_service
from velydock.services.embedcheck import EmbedResult

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>'


def data_url(data: bytes, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


@pytest.fixture
def embed_result(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, object]]:
    """Replace the network check; tests decide what it reports and see which URLs were checked."""
    state: dict[str, object] = {
        "result": EmbedResult(EmbedStatus.OK, "no framing restriction found", 200),
        "urls": [],
    }

    async def fake(url: str, settings: Settings) -> EmbedResult:
        state["urls"].append(url)  # type: ignore[union-attr]
        return state["result"]  # type: ignore[return-value]

    monkeypatch.setattr(apps_service, "run_embed_check", fake)
    yield state


@pytest.fixture
async def acme(world: World) -> Tenant:
    return await world.tenant("Acme")


@pytest.fixture
async def admin(world: World, acme: Tenant) -> User:
    return await world.user(acme, "anna", Role.TENANT_ADMIN)


class TestGroups:
    async def test_admin_manages_groups(self, world: World, acme: Tenant, admin: User) -> None:
        mia = await world.user(acme, "mia")
        ben = await world.user(acme, "ben")
        async with await world.login(admin) as client:
            created = await client.post(
                "/api/v1/admin/groups",
                json={"name": "Büro", "description": "Alle im Büro", "member_ids": [str(mia.id)]},
            )
            assert created.status_code == 201, created.text
            gid = created.json()["id"]
            assert created.json()["member_ids"] == [str(mia.id)]

            updated = await client.patch(
                f"/api/v1/admin/groups/{gid}",
                json={"name": "Office", "member_ids": [str(mia.id), str(ben.id)]},
            )
            assert updated.json()["name"] == "Office" and updated.json()["member_count"] == 2

            listed = (await client.get("/api/v1/admin/groups")).json()
            assert [(g["name"], g["member_count"], g["app_count"]) for g in listed] == [("Office", 2, 0)]
            user = (await client.get(f"/api/v1/admin/users/{mia.id}")).json()
            assert [g["name"] for g in user["groups"]] == ["Office"]

            assert (await client.delete(f"/api/v1/admin/groups/{gid}")).status_code == 204
            assert (await client.get("/api/v1/admin/groups")).json() == []
            assert (await client.get(f"/api/v1/admin/users/{mia.id}")).json()["groups"] == []
            actions = [e["action"] for e in (await client.get("/api/v1/admin/audit")).json()["items"]]
            assert actions == ["group.delete", "group.update", "group.create"]

    async def test_group_names_are_unique_per_tenant_only(
        self, world: World, acme: Tenant, admin: User
    ) -> None:
        globex = await world.tenant("Globex")
        await world.group(globex, "Büro")
        async with await world.login(admin) as client:
            assert (await client.post("/api/v1/admin/groups", json={"name": "Büro"})).status_code == 201
            duplicate = await client.post("/api/v1/admin/groups", json={"name": "büro"})
            assert (duplicate.status_code, duplicate.json()["error"]["code"]) == (409, "group_name_taken")
            other = (await client.post("/api/v1/admin/groups", json={"name": "IT"})).json()
            renamed = await client.patch(f"/api/v1/admin/groups/{other['id']}", json={"name": "BÜRO"})
            assert renamed.status_code == 409

    async def test_assigning_groups_to_a_user(self, world: World, acme: Tenant, admin: User) -> None:
        mia = await world.user(acme, "mia")
        office = await world.group(acme, "Büro")
        it = await world.group(acme, "IT")
        async with await world.login(admin) as client:
            response = await client.patch(
                f"/api/v1/admin/users/{mia.id}", json={"group_ids": [str(office.id), str(it.id)]}
            )
            assert sorted(g["name"] for g in response.json()["groups"]) == ["Büro", "IT"]
            response = await client.patch(f"/api/v1/admin/users/{mia.id}", json={"group_ids": []})
            assert response.json()["groups"] == []


class TestAppAdministration:
    async def test_create_edit_delete(
        self, world: World, acme: Tenant, admin: User, embed_result: dict[str, object]
    ) -> None:
        office = await world.group(acme, "Büro")
        async with await world.login(admin) as client:
            created = await client.post(
                "/api/v1/admin/apps",
                json={
                    "name": "Wiki",
                    "description": "Unser Handbuch",
                    "type": "embedded",
                    "url": "https://wiki.acme.example/",
                    "icon": {"name": "book-open"},
                    "group_ids": [str(office.id)],
                    "frame_permissions": ["fullscreen", "clipboard-write", "fullscreen"],
                },
            )
            assert created.status_code == 201, created.text
            app = created.json()
            assert (app["type"], app["enabled"], app["visible_to_all"], app["icon_name"]) == (
                "embedded",
                True,
                False,
                "book-open",
            )
            assert app["group_ids"] == [str(office.id)]
            assert app["frame_permissions"] == ["clipboard-write", "fullscreen"]
            assert app["embed_status"] == "ok"
            assert embed_result["urls"] == ["https://wiki.acme.example/"]

            edited = await client.patch(
                f"/api/v1/admin/apps/{app['id']}",
                json={
                    "name": "Handbuch",
                    "type": "external",
                    "enabled": False,
                    "visible_to_all": True,
                    "group_ids": [],
                },
            )
            assert edited.status_code == 200, edited.text
            body = edited.json()
            assert (body["name"], body["type"], body["enabled"], body["visible_to_all"]) == (
                "Handbuch",
                "external",
                False,
                True,
            )
            assert (
                body["group_ids"] == []
                and body["frame_permissions"] == []
                and body["embed_status"] == "unknown"
            )

            assert (await client.delete(f"/api/v1/admin/apps/{app['id']}")).status_code == 204
            assert (await client.get("/api/v1/admin/apps")).json() == []

    async def test_blocked_embedding_is_recorded(
        self, world: World, admin: User, embed_result: dict[str, object]
    ) -> None:
        embed_result["result"] = EmbedResult(EmbedStatus.BLOCKED, "X-Frame-Options: SAMEORIGIN", 200)
        async with await world.login(admin) as client:
            preview = await client.post(
                "/api/v1/admin/apps/check-embed", json={"url": "https://cloud.acme.example/"}
            )
            assert preview.json() == {
                "status": "blocked",
                "detail": "X-Frame-Options: SAMEORIGIN",
                "http_status": 200,
            }
            app = (
                await client.post(
                    "/api/v1/admin/apps",
                    json={"name": "Cloud", "type": "embedded", "url": "https://cloud.acme.example/"},
                )
            ).json()
            assert (app["embed_status"], app["embed_detail"]) == ("blocked", "X-Frame-Options: SAMEORIGIN")
            embed_result["result"] = EmbedResult(EmbedStatus.OK, "no framing restriction found", 200)
            rechecked = await client.post(f"/api/v1/admin/apps/{app['id']}/recheck")
            assert rechecked.json()["embed_status"] == "ok"

    @pytest.mark.parametrize(
        ("payload", "code"),
        [
            ({"name": "X", "type": "embedded"}, "url_required"),
            ({"name": "X", "type": "external", "url": ""}, "url_required"),
            ({"name": "X", "type": "external", "url": "javascript:alert(document.cookie)"}, "url_invalid"),
            (
                {"name": "X", "type": "external", "url": "data:text/html,<script>alert(1)</script>"},
                "url_invalid",
            ),
            ({"name": "X", "type": "external", "url": "file:///etc/passwd"}, "url_invalid"),
            ({"name": "X", "type": "external", "url": "//evil.example/"}, "url_invalid"),
            ({"name": "X", "type": "external", "url": "https://user:pw@intranet.example/"}, "url_invalid"),
            ({"name": "X", "type": "embedded", "url": "http://wiki.acme.example/"}, "url_needs_https"),
            ({"name": "X", "type": "custom"}, "content_required"),
            ({"name": "X", "type": "custom", "custom_html": "   "}, "content_required"),
        ],
    )
    async def test_unsafe_or_incomplete_apps_are_rejected(
        self,
        world: World,
        admin: User,
        embed_result: dict[str, object],
        payload: dict[str, object],
        code: str,
    ) -> None:
        async with await world.login(admin) as client:
            response = await client.post("/api/v1/admin/apps", json=payload)
            assert (response.status_code, response.json()["error"]["code"]) == (422, code)
            assert (await client.get("/api/v1/admin/apps")).json() == []

    @pytest.mark.parametrize(
        "payload",
        [
            {"name": "", "type": "external", "url": "https://x.example/"},
            {"name": "X", "type": "portal", "url": "https://x.example/"},
            {
                "name": "X",
                "type": "embedded",
                "url": "https://x.example/",
                "frame_permissions": ["geolocation"],
            },
            {
                "name": "X",
                "type": "external",
                "url": "https://x.example/",
                "icon": {"name": "../../etc/passwd"},
            },
            {"name": "X", "type": "custom", "custom_html": "x" * 300_001},
            {
                "name": "X",
                "type": "external",
                "url": "https://x.example/",
                "tenant_id": "00000000-0000-0000-0000-000000000000",
            },
        ],
    )
    async def test_schema_violations_are_rejected(
        self, world: World, admin: User, payload: dict[str, object]
    ) -> None:
        async with await world.login(admin) as client:
            assert (await client.post("/api/v1/admin/apps", json=payload)).status_code == 422

    async def test_plain_http_is_fine_for_apps_opened_in_a_new_tab(self, world: World, admin: User) -> None:
        async with await world.login(admin) as client:
            response = await client.post(
                "/api/v1/admin/apps",
                json={"name": "Drucker", "type": "external", "url": "http://192.168.1.20/"},
            )
            assert response.status_code == 201

    async def test_icon_upload(self, world: World, acme: Tenant, admin: User) -> None:
        mia = await world.user(acme, "mia")
        async with await world.login(admin) as client:
            app = (
                await client.post(
                    "/api/v1/admin/apps",
                    json={
                        "name": "Logo",
                        "type": "external",
                        "url": "https://x.example/",
                        "visible_to_all": True,
                        "icon": {"data_url": data_url(PNG, "image/png")},
                    },
                )
            ).json()
            assert app["icon_name"] is None and app["icon_url"].startswith(
                f"/api/v1/apps/{app['id']}/icon?v="
            )
            icon = await client.get(app["icon_url"])
            assert icon.content == PNG and icon.headers["content-type"] == "image/png"
            assert icon.headers["x-content-type-options"] == "nosniff"
            assert "sandbox" in icon.headers["content-security-policy"]

            svg = await client.patch(
                f"/api/v1/admin/apps/{app['id']}", json={"icon": {"data_url": data_url(SVG, "image/svg+xml")}}
            )
            served = await client.get(svg.json()["icon_url"])
            assert served.headers["content-type"] == "image/svg+xml"
            # A script inside an uploaded SVG can never run: the response sandboxes the document.
            assert (
                served.headers["content-security-policy"]
                == "default-src 'none'; style-src 'unsafe-inline'; sandbox"
            )

            removed = await client.patch(f"/api/v1/admin/apps/{app['id']}", json={"icon": None})
            assert removed.json()["icon_url"] is None
            assert (await client.get(app["icon_url"])).status_code == 404
        async with await world.login(mia) as client:
            assert (await client.get(f"/api/v1/apps/{app['id']}/icon")).status_code == 404

    @pytest.mark.parametrize(
        ("icon", "code"),
        [
            ({"data_url": data_url(b"<html><script>alert(1)</script></html>", "image/png")}, "icon_invalid"),
            ({"data_url": data_url(b"<html><script>alert(1)</script></html>", "text/html")}, "icon_invalid"),
            ({"data_url": data_url(b"MZ\x90\x00binary", "image/svg+xml")}, "icon_invalid"),
            ({"data_url": "https://evil.example/icon.png"}, "icon_invalid"),
            ({"data_url": "data:image/png;base64,@@@not-base64@@@"}, "icon_invalid"),
            ({"data_url": data_url(PNG + b"\x00" * (256 * 1024), "image/png")}, "icon_too_large"),
        ],
    )
    async def test_bad_icons_are_rejected(
        self, world: World, admin: User, icon: dict[str, str], code: str
    ) -> None:
        async with await world.login(admin) as client:
            response = await client.post(
                "/api/v1/admin/apps",
                json={"name": "X", "type": "external", "url": "https://x.example/", "icon": icon},
            )
            assert (response.status_code, response.json()["error"]["code"]) == (422, code)

    async def test_declared_type_of_an_icon_is_not_trusted(self, world: World, admin: User) -> None:
        async with await world.login(admin) as client:
            app = (
                await client.post(
                    "/api/v1/admin/apps",
                    json={
                        "name": "X",
                        "type": "external",
                        "url": "https://x.example/",
                        "icon": {"data_url": data_url(PNG, "text/html")},
                    },
                )
            ).json()
            assert (await client.get(app["icon_url"])).headers["content-type"] == "image/png"

    async def test_reordering(self, world: World, acme: Tenant, admin: User) -> None:
        first = await world.app_(acme, "A", sort_order=10, visible_to_all=True)
        second = await world.app_(acme, "B", sort_order=20, visible_to_all=True)
        third = await world.app_(acme, "C", sort_order=30, visible_to_all=True)
        async with await world.login(admin) as client:
            order = [str(third.id), str(first.id), str(second.id)]
            response = await client.put("/api/v1/admin/apps/order", json={"app_ids": order})
            assert [a["name"] for a in response.json()] == ["C", "A", "B"]
            assert [a["name"] for a in (await client.get("/api/v1/workspace/apps")).json()] == ["C", "A", "B"]
            incomplete = await client.put("/api/v1/admin/apps/order", json={"app_ids": order[:2]})
            assert incomplete.json()["error"]["code"] == "order_mismatch"


class TestWorkspace:
    async def test_apps_appear_only_for_entitled_users(self, world: World, acme: Tenant, admin: User) -> None:
        mia = await world.user(acme, "mia")
        ben = await world.user(acme, "ben")
        eva = await world.user(acme, "eva")
        office = await world.group(acme, "Büro", [mia])
        await world.app_(acme, "Für alle", visible_to_all=True, sort_order=1)
        await world.app_(acme, "Nur Büro", groups=[office], sort_order=2)
        await world.app_(acme, "Nur Ben", users=[ben], sort_order=3)
        await world.app_(acme, "Niemand", sort_order=4)
        await world.app_(acme, "Abgeschaltet", visible_to_all=True, enabled=False, sort_order=5)

        async def visible(user: User) -> list[str]:
            async with await world.login(user) as client:
                return [a["name"] for a in (await client.get("/api/v1/workspace/apps")).json()]

        assert await visible(mia) == ["Für alle", "Nur Büro"]
        assert await visible(ben) == ["Für alle", "Nur Ben"]
        assert await visible(eva) == ["Für alle"]
        # Administrators get no extra apps in their own workspace; they manage them elsewhere.
        assert await visible(admin) == ["Für alle"]

    async def test_changes_take_effect_immediately(self, world: World, acme: Tenant, admin: User) -> None:
        mia = await world.user(acme, "mia")
        office = await world.group(acme, "Büro")
        app = await world.app_(acme, "Wiki", groups=[office])
        async with await world.login(mia) as member, await world.login(admin) as manager:
            assert (await member.get("/api/v1/workspace/apps")).json() == []
            await manager.patch(f"/api/v1/admin/users/{mia.id}", json={"group_ids": [str(office.id)]})
            assert [a["name"] for a in (await member.get("/api/v1/workspace/apps")).json()] == ["Wiki"]
            await manager.patch(f"/api/v1/admin/apps/{app.id}", json={"enabled": False})
            assert (await member.get("/api/v1/workspace/apps")).json() == []
            await manager.patch(f"/api/v1/admin/apps/{app.id}", json={"enabled": True})
            await manager.delete(f"/api/v1/admin/groups/{office.id}")
            assert (await member.get("/api/v1/workspace/apps")).json() == []

    async def test_an_app_the_user_may_not_see_cannot_be_launched(self, world: World, acme: Tenant) -> None:
        mia = await world.user(acme, "mia")
        hidden = await world.app_(acme, "Niemand", type=AppType.CUSTOM, custom_html="<p>x</p>")
        disabled = await world.app_(
            acme, "Aus", type=AppType.CUSTOM, custom_html="<p>x</p>", visible_to_all=True, enabled=False
        )
        async with await world.login(mia) as client:
            for app in (hidden, disabled):
                assert (
                    await client.post(f"/api/v1/workspace/apps/{app.id}/launch", json={})
                ).status_code == 404
                assert (await client.get(f"/api/v1/apps/{app.id}/icon")).status_code == 404

    async def test_workspace_listing_reveals_no_admin_details(self, world: World, acme: Tenant) -> None:
        mia = await world.user(acme, "mia")
        await world.app_(
            acme,
            "Eigene",
            type=AppType.CUSTOM,
            custom_html="<p>secret markup</p>",
            custom_js="secret()",
            visible_to_all=True,
        )
        async with await world.login(mia) as client:
            listing = (await client.get("/api/v1/workspace/apps")).json()
            assert set(listing[0]) == {
                "id",
                "name",
                "description",
                "type",
                "url",
                "icon_name",
                "icon_url",
                "frame_permissions",
                "embed_status",
            }
            assert "secret" not in str(listing)

    async def test_launching_a_custom_app_yields_a_sandbox_url(self, world: World, acme: Tenant) -> None:
        mia = await world.user(acme, "mia")
        app = await world.app_(
            acme, "Eigene", type=AppType.CUSTOM, custom_html="<p>hi</p>", visible_to_all=True
        )
        link = await world.app_(acme, "Link", url="https://x.example/", visible_to_all=True)
        async with await world.login(mia) as client:
            launched = (
                await client.post(f"/api/v1/workspace/apps/{app.id}/launch", json={"theme": "dark"})
            ).json()
            url = urlsplit(launched["url"])
            assert f"{url.scheme}://{url.netloc}" == SANDBOX_URL
            assert url.path.startswith("/c/") and launched["expires_in"] == 300
            plain = (await client.post(f"/api/v1/workspace/apps/{link.id}/launch", json={})).json()
            assert plain == {"url": "https://x.example/", "expires_in": None}

    async def test_system_admin_previews_a_tenant_without_being_a_member(
        self, world: World, acme: Tenant
    ) -> None:
        await world.app_(acme, "Nur Gruppe", groups=[await world.group(acme, "Büro")])
        root = await world.user(None, "root", None, system_admin=True, home=None)
        async with await world.login(root, acme) as client:
            assert [a["name"] for a in (await client.get("/api/v1/workspace/apps")).json()] == ["Nur Gruppe"]
