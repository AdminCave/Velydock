"""Publishing apps through the bundled reverse proxy.

What is tested here is Velydock's side: what may be published, the routes handed to the proxy,
and the sign-in check the proxy asks for. That the proxy does with these what is meant is the
business of the browser suite, which runs the real one.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import parse_qs, quote, urlsplit

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from tests.conftest import World
from tests.support.fake_idp import FakeIdp
from tests.support.mini_idp import MiniIdp
from velydock.api.auth import safe_return_path
from velydock.app import create_app
from velydock.config import Settings
from velydock.db import Scope, transaction
from velydock.errors import ApiError
from velydock.models import AppPublication, AuthSession, ProxyTarget, Role, Tenant, User
from velydock.security.oidc import OidcClient
from velydock.security.tokens import hash_token
from velydock.services import proxy

SECRET = "proxy-secret-for-the-tests"
INTERNAL = {"Host": "velydock:8000"}
FROM_PROXY = {**INTERNAL, "X-Velydock-Proxy-Secret": SECRET}


@pytest.fixture
async def world(settings: Settings, clean_db: None) -> AsyncIterator[World]:
    """The usual world, on an installation that has an apps host."""
    proxied = Settings.model_validate(
        {
            **settings.model_dump(),
            "apps_url": "https://apps.test",
            "proxy_secret": SECRET,
            "proxy_tls_resolver": "le",
        }
    )
    idp = FakeIdp()
    mini = MiniIdp(proxied)
    http = httpx.AsyncClient(transport=mini.transport())
    proxy.forget_decisions()
    yield World(
        settings=proxied, idp=idp, mini=mini, app=create_app(proxied, idp=idp, oidc=OidcClient(proxied, http))
    )
    await http.aclose()


@pytest.fixture
async def acme(world: World) -> Tenant:
    return await world.tenant("Acme")


@pytest.fixture
async def anna(world: World, acme: Tenant) -> User:
    return await world.user(acme, "anna", Role.TENANT_ADMIN)


@pytest.fixture
async def root(world: World) -> User:
    main = await world.tenant("Admin Cave", "main")
    return await world.user(main, "root", Role.TENANT_ADMIN, system_admin=True)


async def release(tenant: Tenant, *values: str) -> None:
    async with transaction(Scope.SYSTEM) as db:
        for value in values:
            db.add(ProxyTarget(tenant_id=tenant.id, value=proxy.normalise_rule(value)))


def publication(name: str = "wiki", **fields: Any) -> dict[str, Any]:
    return {"name": name, "target_url": "http://10.20.0.7:8080", **fields}


async def publish(client: httpx.AsyncClient, name: str = "wiki", **fields: Any) -> httpx.Response:
    body = {
        "name": fields.pop("app_name", f"App {name}"),
        "type": fields.pop("type", "external"),
        "visible_to_all": fields.pop("visible_to_all", True),
        "publication": publication(name, **fields),
    }
    return await client.post("/api/v1/admin/apps", json=body)


async def routes(world: World) -> dict[str, Any]:
    async with world.client() as client:
        response = await client.get("/internal/proxy/traefik", headers=FROM_PROXY)
    assert response.status_code == 200, response.text
    return response.json()  # type: ignore[no-any-return]


# ---------------------------------------------------------------------------------------------


class TestWhatMayBeReleased:
    @pytest.mark.parametrize(
        ("written", "stored"),
        [
            ("10.20.0.0/16", "10.20.0.0/16"),
            ("10.20.0.7/16", "10.20.0.0/16"),
            ("10.20.0.7", "10.20.0.7"),
            ("10.20.0.7:8080", "10.20.0.7:8080"),
            ("NAS.Intern", "nas.intern"),
            ("nas.intern:5000", "nas.intern:5000"),
            ("fd00::/64", "fd00::/64"),
            ("[fd00::7]:8443", "[fd00::7]:8443"),
        ],
    )
    def test_networks_addresses_and_names(self, written: str, stored: str) -> None:
        assert proxy.normalise_rule(written) == stored

    @pytest.mark.parametrize(
        "written",
        [
            "",
            "http://10.0.0.1",
            "10.0.0.1:0",
            "10.0.0.1:99999",
            "nas intern",
            "a/b",
            "1234",
            "-x.de",
            "[fd00::7",
        ],
    )
    def test_what_is_none_of_them(self, written: str) -> None:
        with pytest.raises(ApiError):
            proxy.parse_rule(written)


class TestWhereAnAppMayBePublishedFrom:
    ALLOWED = ("10.20.0.0/16", "192.168.5.9:8443", "nas.intern", "fd00::/64")

    async def check(self, settings: Settings, url: str, allowed: tuple[str, ...] = ALLOWED) -> str:
        return await proxy.check_target(settings, url, list(allowed))

    @pytest.mark.parametrize(
        ("url", "stored"),
        [
            ("http://10.20.0.7:8080", "http://10.20.0.7:8080"),
            ("https://10.20.255.1/", "https://10.20.255.1"),
            ("https://192.168.5.9:8443", "https://192.168.5.9:8443"),
            ("http://NAS.intern", "http://nas.intern"),
            ("http://[fd00::7]:3000", "http://[fd00::7]:3000"),
        ],
    )
    async def test_within_what_was_released(self, world: World, url: str, stored: str) -> None:
        assert await self.check(world.settings, url) == stored

    @pytest.mark.parametrize(
        "url",
        [
            "http://10.21.0.7",  # another network
            "https://192.168.5.9",  # released for port 8443 only
            "http://192.168.5.9:8080",
            "http://other.intern",  # a name nobody released
            "http://nas.intern.evil.example",
            "http://2130706433",  # 127.0.0.1 written as a number: just a name here, and not a released one
            "http://127.1",
            "http://0x7f.0.0.1",
        ],
    )
    async def test_outside_of_it(self, world: World, url: str) -> None:
        with pytest.raises(ApiError) as refused:
            await self.check(world.settings, url)
        assert refused.value.code == "proxy_target_not_allowed"

    @pytest.mark.parametrize(
        "url",
        [
            "http://127.0.0.1:8000",
            "http://[::1]:8000",
            "http://[::ffff:127.0.0.1]:8000",
            "http://169.254.169.254/",  # the metadata address of cloud providers
            "http://0.0.0.0",
            "http://localhost:8000",
            "http://velydock:8000",  # the installation's own services, by name
            "http://keycloak.internal:8080",
            "http://postgres:5432",
            "http://traefik:8080",
            "http://foo.localhost",
        ],
    )
    async def test_the_installation_itself_is_never_a_target_whatever_was_released(
        self, world: World, url: str
    ) -> None:
        everything = (
            "0.0.0.0/0",
            "::/0",
            "localhost",
            "velydock",
            "keycloak.internal",
            "postgres",
            "traefik",
            "foo.localhost",
        )
        with pytest.raises(ApiError) as refused:
            await self.check(world.settings, url, everything)
        assert refused.value.code == "proxy_target_not_allowed"

    @pytest.mark.parametrize(
        "url",
        [
            "ftp://10.20.0.7",
            "10.20.0.7:8080",
            "http://user:secret@10.20.0.7",
            "http://10.20.0.7/base",  # the proxy forwards the request's own path
            "http://10.20.0.7/?x=1",
            "http://",
            "http://10.20.0.7:port",
        ],
    )
    async def test_what_is_not_an_internal_address(self, world: World, url: str) -> None:
        with pytest.raises(ApiError) as refused:
            await self.check(world.settings, url)
        assert refused.value.code == "proxy_target_invalid"


class TestOptions:
    def test_what_an_organization_may_set(self) -> None:
        options = {
            "strip_prefix": False,
            "allow_embedding": True,
            "rate_limit": {"average": 20, "burst": 60},
            "request_headers": {"Authorization": "Basic abc", "X-Api-Key": "k"},
            "response_headers": {"Cache-Control": "no-store"},
        }
        assert proxy.check_options(options, by_system_admin=False) == options

    @pytest.mark.parametrize(
        "options",
        [
            {"unknown": True},
            {"strip_prefix": "yes"},
            {"rate_limit": {"average": 0, "burst": 1}},
            {"rate_limit": {"average": 10, "burst": 5}},
            {"rate_limit": {"average": 10}},
            {"request_headers": {"Host": "evil.example"}},
            {"request_headers": {"X-Forwarded-For": "1.2.3.4"}},  # the proxy's own
            {"request_headers": {"X-Velydock-User": "admin"}},  # who is signed in is not for an admin to say
            {"request_headers": {"X-Bad\r\nInjected": "1"}},
            {"request_headers": {"X-Ok": "line\r\nbreak"}},
            {"response_headers": {"Transfer-Encoding": "chunked"}},
            {"request_headers": {f"X-{n}": "v" for n in range(21)}},
        ],
    )
    def test_what_is_refused(self, options: dict[str, Any]) -> None:
        with pytest.raises(ApiError):
            proxy.check_options(options, by_system_admin=True)

    def test_traefik_in_its_own_words_is_for_system_administrators_and_only_some_of_it(self) -> None:
        own = {"custom_middlewares": {"office": {"ipAllowList": {"sourceRange": ["10.0.0.0/8"]}}}}
        assert proxy.check_options(own, by_system_admin=True) == own
        with pytest.raises(ApiError) as refused:
            proxy.check_options(own, by_system_admin=False)
        assert refused.value.status == 403
        for definition in (
            {"x": {"forwardAuth": {"address": "http://10.0.0.1/"}}},  # would replace the sign-in check
            {"x": {"plugin": {"anything": {}}}},
            {"x": {"errors": {"service": "velydock"}}},
            {"x": {"chain": {"middlewares": ["other"]}}},
            {"x": {"headers": {}, "rateLimit": {}}},  # one middleware per name
            {"Bad Name": {"headers": {}}},
            {"x": "headers"},
        ):
            with pytest.raises(ApiError):
                proxy.check_options({"custom_middlewares": definition}, by_system_admin=True)


class TestPublishing:
    async def test_an_administrator_publishes_an_app_within_what_was_released(
        self, world: World, acme: Tenant, anna: User
    ) -> None:
        await release(acme, "10.20.0.0/16")
        async with await world.login(anna) as client:
            info = (await client.get("/api/v1/admin/proxy")).json()
            assert info["enabled"] is True
            assert (info["path_base"], info["subdomain_suffix"]) == ("https://apps.test/", ".apps.test")
            assert info["targets"] == ["10.20.0.0/16"]
            assert "builtin:standard" in [template["id"] for template in info["templates"]]

            created = await publish(client, "wiki")
            assert created.status_code == 201, created.text
            app = created.json()
            # The app's address is the public one; where it comes from stays with the publication.
            assert app["url"] == "https://apps.test/wiki/"
            assert app["publication"] == {
                "name": "wiki",
                "mode": "path",
                "target_url": "http://10.20.0.7:8080",
                "access": "protected",
                "template": "builtin:standard",
                "options": {},
                "public_url": "https://apps.test/wiki/",
                "problem": None,
            }
            # By sub-domain instead, and open to everybody.
            changed = await client.patch(
                f"/api/v1/admin/apps/{app['id']}",
                json={"publication": publication("wiki", mode="subdomain", access="public")},
            )
            assert changed.status_code == 200, changed.text
            assert changed.json()["url"] == "https://wiki.apps.test/"
            listed = (await client.get("/api/v1/admin/apps")).json()
            assert [a["publication"]["mode"] for a in listed] == ["subdomain"]
            log = (await client.get("/api/v1/admin/audit")).json()["items"]
        published = [entry["details"]["publication"] for entry in log if "publication" in entry["details"]]
        assert {"name": "wiki", "mode": "subdomain", "access": "public", "target": "http://10.20.0.7:8080",
                "template": "builtin:standard"} in published  # fmt: skip

    async def test_nothing_is_released_until_a_system_administrator_does(
        self, world: World, anna: User
    ) -> None:
        async with await world.login(anna) as client:
            refused = await publish(client, "wiki")
            assert refused.status_code == 422
            assert refused.json()["error"]["code"] == "proxy_target_not_allowed"
            assert (await client.get("/api/v1/admin/apps")).json() == []

    async def test_names_are_addresses_and_addresses_are_shared_by_all_organizations(
        self, world: World, acme: Tenant, anna: User
    ) -> None:
        globex = await world.tenant("Globex")
        gina = await world.user(globex, "gina", Role.TENANT_ADMIN)
        await release(acme, "10.20.0.0/16")
        await release(globex, "10.20.0.0/16")
        async with await world.login(anna) as client:
            assert (await publish(client, "wiki")).status_code == 201
            for bad in (
                "api",
                "www",
                "velydock",
                "a",
                "Wiki Seite",
                "wiki_1",
                "-wiki",
                "wiki`)||Host(`dock.test",
                "xn--wiki",
            ):
                refused = await publish(client, bad)
                assert refused.status_code == 422, bad
        async with await world.login(gina) as client:
            taken = await publish(client, "wiki")
            assert (taken.status_code, taken.json()["error"]["code"]) == (409, "publication_name_taken")
            # Not even the other mode: "wiki" is one name, whichever address it is spelled as.
            taken = await publish(client, "wiki", mode="subdomain")
            assert taken.status_code == 409
            assert (await publish(client, "wiki-globex")).status_code == 201
            assert [a["publication"]["name"] for a in (await client.get("/api/v1/admin/apps")).json()] == [
                "wiki-globex"
            ]

    async def test_who_may_and_what_can_be_published(self, world: World, acme: Tenant, anna: User) -> None:
        await release(acme, "10.20.0.0/16")
        uwe = await world.user(acme, "uwe", Role.USER_MANAGER)
        mia = await world.user(acme, "mia")
        for user in (uwe, mia):
            async with await world.login(user) as client:
                assert (await publish(client, "wiki")).status_code == 403
                assert (await client.get("/api/v1/admin/proxy")).status_code == 403
        async with await world.login(anna) as client:
            custom = await client.post(
                "/api/v1/admin/apps",
                json={
                    "name": "Eigene",
                    "type": "custom",
                    "custom_html": "<p>x</p>",
                    "publication": publication("eigene"),
                },
            )
            assert (custom.status_code, custom.json()["error"]["code"]) == (422, "publication_type")
            for options in ({"custom_middlewares": {"x": {"headers": {}}}},):
                refused = await publish(client, "wiki", options=options)
                assert refused.status_code == 403
            refused = await publish(client, "wiki", template="builtin:nope")
            assert refused.json()["error"]["code"] == "proxy_template_unknown"
            refused = await publish(client, "wiki", access="public", options={"identity_headers": True})
            assert refused.status_code == 422
            assert (await client.get("/api/v1/admin/apps")).json() == []

    async def test_an_app_that_is_no_longer_published_needs_an_address_again(
        self, world: World, acme: Tenant, anna: User
    ) -> None:
        await release(acme, "10.20.0.0/16")
        async with await world.login(anna) as client:
            app = (await publish(client, "wiki")).json()
            refused = await client.patch(f"/api/v1/admin/apps/{app['id']}", json={"publication": None})
            assert (refused.status_code, refused.json()["error"]["code"]) == (422, "url_required")
            ended = await client.patch(
                f"/api/v1/admin/apps/{app['id']}",
                json={"publication": None, "url": "https://wiki.example.org/"},
            )
            assert ended.status_code == 200
            assert (ended.json()["url"], ended.json()["publication"]) == ("https://wiki.example.org/", None)
        assert await routes(world) == {}
        # The name is free again.
        async with await world.login(anna) as client:
            assert (await publish(client, "wiki")).status_code == 201

    async def test_the_database_itself_keeps_an_organization_from_releasing_anything(
        self, world: World, acme: Tenant, anna: User
    ) -> None:
        with pytest.raises(DBAPIError):
            async with transaction(Scope.TENANT, tenant_id=acme.id, user_id=anna.id) as db:
                await db.execute(
                    text(
                        "INSERT INTO proxy_targets (id, tenant_id, value) VALUES (:id, :tenant, '0.0.0.0/0')"
                    ),
                    {"id": uuid.uuid4(), "tenant": acme.id},
                )
        globex = await world.tenant("Globex")
        await release(globex, "10.99.0.0/16")
        async with transaction(Scope.TENANT, tenant_id=acme.id, user_id=anna.id) as db:
            assert (await db.execute(select(ProxyTarget))).scalars().all() == []  # another organization's
            assert (await db.execute(select(AppPublication))).scalars().all() == []


class TestSystemAdministration:
    async def test_releasing_addresses_for_an_organization(
        self, world: World, acme: Tenant, anna: User, root: User
    ) -> None:
        async with await world.login(anna) as client:
            assert (await client.get(f"/api/v1/system/tenants/{acme.id}/proxy-targets")).status_code == 403
            assert (
                await client.post(
                    f"/api/v1/system/tenants/{acme.id}/proxy-targets", json={"value": "0.0.0.0/0"}
                )
            ).status_code == 403
        async with await world.login(root) as client:
            base = f"/api/v1/system/tenants/{acme.id}/proxy-targets"
            added = await client.post(base, json={"value": "10.20.0.7/16", "note": "Serverraum"})
            assert added.status_code == 201 and added.json()["value"] == "10.20.0.0/16"
            assert (await client.post(base, json={"value": "10.20.0.0/16"})).status_code == 409
            for bad in ("10.20.0.0/33", "http://10.20.0.7", "velydock", "localhost", "x.localhost"):
                assert (await client.post(base, json={"value": bad})).status_code == 422, bad
            assert [t["value"] for t in (await client.get(base)).json()] == ["10.20.0.0/16"]
            other = f"/api/v1/system/tenants/{uuid.uuid4()}/proxy-targets"
            assert (await client.get(other)).status_code == 404
            assert (await client.delete(f"{base}/{added.json()['id']}")).status_code == 204
            assert (await client.get(base)).json() == []
            actions = [e["action"] for e in (await client.get("/api/v1/system/audit")).json()["items"]]
        assert actions[:2] == ["proxy.target.remove", "proxy.target.add"]

    async def test_a_release_that_is_withdrawn_takes_its_publications_off_the_proxy(
        self, world: World, acme: Tenant, anna: User, root: User
    ) -> None:
        async with await world.login(root) as client:
            base = f"/api/v1/system/tenants/{acme.id}/proxy-targets"
            target = (await client.post(base, json={"value": "10.20.0.0/16"})).json()
        async with await world.login(anna) as client:
            assert (await publish(client, "wiki")).status_code == 201
        assert list((await routes(world))["http"]["routers"]) != []
        async with await world.login(root) as client:
            assert (await client.delete(f"{base}/{target['id']}")).status_code == 204
        assert await routes(world) == {}
        async with await world.login(anna) as client:
            assert (await client.get("/api/v1/admin/apps")).json()[0]["publication"][
                "problem"
            ] == "target_not_allowed"

    async def test_templates(self, world: World, acme: Tenant, anna: User, root: User) -> None:
        await release(acme, "10.20.0.0/16")
        async with await world.login(root) as client:
            made = await client.post(
                "/api/v1/system/proxy-templates",
                json={
                    "name": "Nur aus dem Büro",
                    "options": {
                        "allow_embedding": True,
                        "custom_middlewares": {"office": {"ipAllowList": {"sourceRange": ["10.0.0.0/8"]}}},
                    },
                },
            )
            assert made.status_code == 201, made.text
            template = made.json()["id"]
            assert (
                await client.post("/api/v1/system/proxy-templates", json={"name": "nur aus dem büro"})
            ).status_code == 409
            bad = {
                "name": "Schlecht",
                "options": {"custom_middlewares": {"x": {"forwardAuth": {"address": "http://x/"}}}},
            }
            assert (await client.post("/api/v1/system/proxy-templates", json=bad)).status_code == 422
        async with await world.login(anna) as client:
            assert (
                await client.post("/api/v1/system/proxy-templates", json={"name": "Eigenes"})
            ).status_code == 403
            offered = [t["id"] for t in (await client.get("/api/v1/admin/proxy")).json()["templates"]]
            assert template in offered
            app = (await publish(client, "wiki", template=template)).json()
        built = (await routes(world))["http"]
        key = f"vd-{uuid.UUID(app['id']).hex}"
        assert built["middlewares"][f"{key}-c-office"] == {"ipAllowList": {"sourceRange": ["10.0.0.0/8"]}}
        assert built["routers"][key]["middlewares"][-1] == f"{key}-c-office"
        async with await world.login(root) as client:
            # A template in use may be what keeps a publication closed: it cannot simply go.
            in_use = await client.delete(f"/api/v1/system/proxy-templates/{template}")
            assert (in_use.status_code, in_use.json()["error"]["code"]) == (409, "template_in_use")
            changed = await client.patch(
                f"/api/v1/system/proxy-templates/{template}", json={"options": {"allow_embedding": False}}
            )
            assert changed.status_code == 200
        assert f"{key}-c-office" not in (await routes(world))["http"].get("middlewares", {})


class TestTheRoutesTheProxyGets:
    async def test_only_the_proxy_gets_them(self, world: World, acme: Tenant, anna: User) -> None:
        await release(acme, "10.20.0.0/16")
        async with await world.login(anna) as client:
            await publish(client, "wiki")
            # Through the public address the route does not exist - with or without the secret,
            # signed in or not.
            for headers in ({}, {"X-Velydock-Proxy-Secret": SECRET}):
                assert (await client.get("/internal/proxy/traefik", headers=headers)).status_code == 404
        async with world.client() as client:
            for headers in (
                INTERNAL,
                {**INTERNAL, "X-Velydock-Proxy-Secret": "wrong"},
                {"Host": "apps.test", "X-Velydock-Proxy-Secret": SECRET},
            ):
                assert (await client.get("/internal/proxy/traefik", headers=headers)).status_code == 404

    async def test_by_path_and_by_sub_domain(self, world: World, acme: Tenant, anna: User) -> None:
        await release(acme, "10.20.0.0/16", "nas.intern")
        async with await world.login(anna) as client:
            wiki = (await publish(client, "wiki")).json()
            nas = (
                await publish(
                    client,
                    "nas",
                    mode="subdomain",
                    target_url="https://nas.intern",
                    template="builtin:self-signed",
                    options={"allow_embedding": True, "rate_limit": {"average": 5, "burst": 10}},
                )
            ).json()
        built = (await routes(world))["http"]
        w, n = f"vd-{uuid.UUID(wiki['id']).hex}", f"vd-{uuid.UUID(nas['id']).hex}"

        assert built["routers"][w] == {
            "rule": "Host(`apps.test`) && (Path(`/wiki`) || PathPrefix(`/wiki/`))",
            "entryPoints": ["websecure"],
            "service": w,
            "tls": {"certResolver": "le"},
            "middlewares": [f"{w}-slash", f"{w}-auth", f"{w}-strip"],
        }
        assert built["services"][w] == {
            "loadBalancer": {"servers": [{"url": "http://10.20.0.7:8080"}], "passHostHeader": True}
        }
        assert built["middlewares"][f"{w}-strip"] == {"stripPrefix": {"prefixes": ["/wiki"]}}
        auth = built["middlewares"][f"{w}-auth"]["forwardAuth"]
        assert auth["address"] == f"http://velydock:8000/internal/proxy/auth/{wiki['id']}"
        assert auth["trustForwardHeader"] is False
        # All of them, always: what Velydock does not set the proxy removes, so nobody brings their own.
        assert auth["authResponseHeaders"] == ["X-Velydock-User", "X-Velydock-Email", "X-Velydock-Name"]

        assert built["routers"][n]["rule"] == "Host(`nas.apps.test`)"
        assert built["routers"][n]["middlewares"] == [f"{n}-auth", f"{n}-rate", f"{n}-headers"]
        assert built["middlewares"][f"{n}-rate"] == {"rateLimit": {"average": 5, "burst": 10, "period": "1s"}}
        assert built["middlewares"][f"{n}-headers"] == {
            "headers": {"customResponseHeaders": {"X-Frame-Options": ""}}
        }
        assert built["services"][n]["loadBalancer"]["serversTransport"] == n
        assert built["serversTransports"] == {n: {"insecureSkipVerify": True}}

    async def test_a_public_app_gets_no_sign_in_check_and_no_claims_about_who_is_signed_in(
        self, world: World, acme: Tenant, anna: User
    ) -> None:
        await release(acme, "10.20.0.0/16")
        async with await world.login(anna) as client:
            app = (await publish(client, "seite", access="public", mode="subdomain")).json()
        built = (await routes(world))["http"]
        key = f"vd-{uuid.UUID(app['id']).hex}"
        assert built["routers"][key]["middlewares"] == [f"{key}-headers"]
        assert built["middlewares"][f"{key}-headers"] == {
            "headers": {
                "customRequestHeaders": {"X-Velydock-User": "", "X-Velydock-Email": "", "X-Velydock-Name": ""}
            }
        }

    async def test_what_is_switched_off_is_not_routed(
        self, world: World, acme: Tenant, anna: User, root: User
    ) -> None:
        await release(acme, "10.20.0.0/16")
        async with await world.login(anna) as client:
            app = (await publish(client, "wiki")).json()
            assert len((await routes(world))["http"]["routers"]) == 1
            await client.patch(f"/api/v1/admin/apps/{app['id']}", json={"enabled": False})
            assert await routes(world) == {}
            await client.patch(f"/api/v1/admin/apps/{app['id']}", json={"enabled": True})
        async with await world.login(root) as client:
            assert (
                await client.patch(f"/api/v1/system/tenants/{acme.id}", json={"active": False})
            ).status_code == 200
        assert await routes(world) == {}

    async def test_no_route_can_name_a_host_of_velydock_itself(
        self, world: World, acme: Tenant, anna: User
    ) -> None:
        """Whatever names are accepted, every rule is for the apps host or one level below it."""
        await release(acme, "10.20.0.0/16")
        async with await world.login(anna) as client:
            for index, name in enumerate(("dock", "auth", "sandbox", "apps", "x--y", "a1", "zz-top")):
                await publish(
                    client, name, mode="subdomain" if index % 2 else "path", app_name=f"App {index}"
                )
        rules = [
            router["rule"] for router in (await routes(world)).get("http", {}).get("routers", {}).values()
        ]
        assert rules, "some of the names are ordinary and must have been accepted"
        for rule in rules:
            hosts = [part.split("`")[1] for part in rule.split("Host(")[1:]]
            assert hosts and all(host == "apps.test" or host.endswith(".apps.test") for host in hosts), rule
            assert not any(host in ("dock.test", "sandbox.test", "auth.test") for host in hosts)

    def test_the_apps_host_cannot_be_one_of_velydocks_or_above_them(self, settings: Settings) -> None:
        for apps_url in (
            "https://dock.test",
            "https://sandbox.test",
            "https://auth.test",
            "https://test",
            "https://apps.test/x",
        ):
            with pytest.raises(ValueError, match=r"APPS_URL|absolute"):
                Settings.model_validate(
                    {**settings.model_dump(), "apps_url": apps_url, "proxy_secret": SECRET}
                )
        with pytest.raises(ValueError, match="PROXY_SECRET"):  # no secret, no feature
            Settings.model_validate({**settings.model_dump(), "apps_url": "https://apps.test"})

    async def test_without_an_apps_host_there_is_nothing(self, settings: Settings, clean_db: None) -> None:
        idp, mini = FakeIdp(), MiniIdp(settings)
        http = httpx.AsyncClient(transport=mini.transport())
        plain = World(
            settings=settings,
            idp=idp,
            mini=mini,
            app=create_app(settings, idp=idp, oidc=OidcClient(settings, http)),
        )
        acme = await plain.tenant("Acme")
        anna = await plain.user(acme, "anna", Role.TENANT_ADMIN)
        await release(acme, "10.20.0.0/16")
        async with await plain.login(anna) as client:
            assert (await client.get("/api/v1/admin/proxy")).json()["enabled"] is False
            refused = await publish(client, "wiki")
            assert (refused.status_code, refused.json()["error"]["code"]) == (409, "proxy_disabled")
        await http.aclose()


class TestSignInBeforeForwarding:
    @pytest.fixture
    async def wiki(self, world: World, acme: Tenant, anna: User) -> dict[str, Any]:
        await release(acme, "10.20.0.0/16")
        async with await world.login(anna) as client:
            created = await publish(client, "wiki", mode="subdomain")
            assert created.status_code == 201
            return created.json()  # type: ignore[no-any-return]

    async def ask(
        self,
        world: World,
        app: dict[str, Any],
        uri: str = "/",
        *,
        cookie: str = "",
        page: bool = True,
        host: str = "wiki.apps.test",
    ) -> httpx.Response:
        """What the proxy asks Velydock before it forwards a request."""
        headers = {
            **INTERNAL,
            "X-Forwarded-Host": host,
            "X-Forwarded-Uri": uri,
            "X-Forwarded-Method": "GET",
            "X-Forwarded-Proto": "https",
            **({"Sec-Fetch-Mode": "navigate"} if page else {"Sec-Fetch-Mode": "cors"}),
        }
        if cookie:
            headers["Cookie"] = cookie
        async with world.client() as client:
            return await client.get(f"/internal/proxy/auth/{app['id']}", headers=headers)

    async def sign_in(
        self, world: World, app: dict[str, Any], user: User, rd: str = "/"
    ) -> tuple[httpx.Response, str]:
        """The whole round trip of a browser that has a Velydock session; returns the app cookie."""
        async with await world.login(user) as browser:
            there = await browser.get("/proxy/login", params={"p": app["id"], "rd": rd})
        assert there.status_code == 302, there.text
        callback = urlsplit(there.headers["location"])
        answer = await self.ask(world, app, f"{callback.path}?{callback.query}")
        cookie = answer.headers.get("set-cookie", "").split(";")[0]
        return answer, cookie

    async def test_a_page_is_sent_to_velydock_a_script_gets_401(
        self, world: World, wiki: dict[str, Any]
    ) -> None:
        page = await self.ask(world, wiki, "/seite?x=1")
        assert page.status_code == 302
        assert page.headers["location"] == f"https://dock.test/proxy/login?p={wiki['id']}&rd=%2Fseite%3Fx%3D1"
        assert (await self.ask(world, wiki, "/api/data", page=False)).status_code == 401
        # The way back after signing in to Velydock is accepted as a destination there.
        assert (
            safe_return_path(f"/proxy/login?p={wiki['id']}&rd=%2Fseite")
            == f"/proxy/login?p={wiki['id']}&rd=%2Fseite"
        )

    async def test_without_a_velydock_session_the_way_leads_through_its_sign_in(
        self, world: World, wiki: dict[str, Any]
    ) -> None:
        async with world.client() as browser:
            asked = await browser.get("/proxy/login", params={"p": wiki["id"], "rd": "/seite"})
        assert asked.status_code == 302
        target = urlsplit(asked.headers["location"])
        assert target.path == "/login"
        assert parse_qs(target.query)["return_to"] == [f"/proxy/login?p={wiki['id']}&rd=%2Fseite"]

    async def test_the_round_trip_ends_in_the_app_with_a_cookie_for_that_app_only(
        self, world: World, acme: Tenant, wiki: dict[str, Any]
    ) -> None:
        mia = await world.user(acme, "mia", email="mia@acme.example", first_name="Mia", last_name="Mitglied")
        answer, cookie = await self.sign_in(world, wiki, mia, "/seite?x=1")
        assert answer.status_code == 302
        assert answer.headers["location"] == "https://wiki.apps.test/seite?x=1"
        attributes = answer.headers["set-cookie"]
        assert cookie.startswith("__Host-velydock-app=")
        for attribute in ("Path=/", "HttpOnly", "Secure", "SameSite=Lax"):
            assert attribute in attributes
        # With the cookie the proxy may forward. Who is signed in is not told unless asked for.
        allowed = await self.ask(world, wiki, "/seite", cookie=cookie)
        assert allowed.status_code == 200
        assert "x-velydock-user" not in allowed.headers
        # The cookie of one app is nothing at another.
        async with await world.login(await world.user(acme, "anna2", Role.TENANT_ADMIN)) as admin:
            other = (await publish(admin, "andere", mode="subdomain")).json()
        assert (await self.ask(world, other, "/", cookie=cookie, host="andere.apps.test")).status_code == 302

    async def test_a_ticket_works_once_for_its_app_and_not_when_tampered_with(
        self, world: World, acme: Tenant, anna: User, wiki: dict[str, Any]
    ) -> None:
        async with await world.login(anna) as browser:
            there = await browser.get("/proxy/login", params={"p": wiki["id"]})
            other = (await publish(browser, "andere", mode="subdomain")).json()
        callback = urlsplit(there.headers["location"])
        uri = f"{callback.path}?{callback.query}"
        assert (await self.ask(world, other, uri, host="andere.apps.test")).status_code == 403
        assert (await self.ask(world, wiki, uri[:-3] + "abc")).status_code == 403
        assert (await self.ask(world, wiki, uri)).status_code == 302
        assert (await self.ask(world, wiki, uri)).status_code == 403  # used

    async def test_only_who_is_granted_the_app_gets_in(
        self, world: World, acme: Tenant, anna: User, wiki: dict[str, Any]
    ) -> None:
        mia = await world.user(acme, "mia")
        outsider = await world.user(await world.tenant("Globex"), "gero")
        async with await world.login(anna) as admin:  # no longer for everybody in the organization
            await admin.patch(f"/api/v1/admin/apps/{wiki['id']}", json={"visible_to_all": False})
        proxy.forget_decisions()
        # Not even its administrator: in the workspace she would not see the app either.
        for user in (mia, outsider, anna):
            async with await world.login(user) as browser:
                refused = await browser.get("/proxy/login", params={"p": wiki["id"]})
            assert refused.status_code == 403
        async with await world.login(anna) as admin:
            await admin.patch(f"/api/v1/admin/apps/{wiki['id']}", json={"user_ids": [str(mia.id)]})
        proxy.forget_decisions()
        answer, cookie = await self.sign_in(world, wiki, mia)
        assert answer.status_code == 302 and cookie
        assert (await self.ask(world, wiki, cookie=cookie)).status_code == 200
        # The grant is taken away: the cookie alone is worth nothing.
        async with await world.login(anna) as admin:
            await admin.patch(f"/api/v1/admin/apps/{wiki['id']}", json={"user_ids": []})
        proxy.forget_decisions()
        assert (await self.ask(world, wiki, cookie=cookie)).status_code == 302

    async def test_the_app_is_told_who_is_signed_in_only_when_that_is_switched_on(
        self, world: World, acme: Tenant, anna: User, wiki: dict[str, Any]
    ) -> None:
        async with await world.login(anna) as admin:
            await admin.patch(
                f"/api/v1/admin/apps/{wiki['id']}",
                json={"publication": publication("wiki", mode="subdomain", template="builtin:header-login")},
            )
        _, cookie = await self.sign_in(world, wiki, anna)
        allowed = await self.ask(world, wiki, cookie=cookie)
        assert allowed.status_code == 200
        assert allowed.headers["x-velydock-user"] == "anna"
        assert allowed.headers["x-velydock-email"] == (anna.email or "")
        assert allowed.headers["x-velydock-name"] == f"{anna.first_name} {anna.last_name}"

    async def test_when_the_velydock_session_ends_so_does_the_access(
        self, world: World, anna: User, wiki: dict[str, Any]
    ) -> None:
        async with await world.login(anna) as browser:
            there = await browser.get("/proxy/login", params={"p": wiki["id"]})
            callback = urlsplit(there.headers["location"])
            cookie = (
                (await self.ask(world, wiki, f"{callback.path}?{callback.query}"))
                .headers["set-cookie"]
                .split(";")[0]
            )
            assert (await self.ask(world, wiki, cookie=cookie)).status_code == 200
            assert (await browser.post("/api/auth/logout")).status_code == 200
        proxy.forget_decisions()  # otherwise up to half a minute later
        assert (await self.ask(world, wiki, cookie=cookie)).status_code == 302
        assert (await self.ask(world, wiki, cookie=cookie, page=False)).status_code == 401

    async def test_using_the_app_counts_as_activity_of_the_session(
        self, world: World, anna: User, wiki: dict[str, Any]
    ) -> None:
        value = await world.session(anna)
        async with world.client(value) as browser:
            there = await browser.get("/proxy/login", params={"p": wiki["id"]})
        callback = urlsplit(there.headers["location"])
        cookie = (
            (await self.ask(world, wiki, f"{callback.path}?{callback.query}"))
            .headers["set-cookie"]
            .split(";")[0]
        )
        async with transaction(Scope.SYSTEM) as db:
            await db.execute(text("UPDATE sessions SET last_seen_at = now() - interval '30 minutes'"))
        proxy.forget_decisions()
        assert (await self.ask(world, wiki, cookie=cookie)).status_code == 200
        async with transaction(Scope.SYSTEM) as db:
            session = await db.get(AuthSession, hash_token(value))
            assert session is not None
            fresh = (
                await db.execute(
                    text(
                        "SELECT now() - last_seen_at < interval '1 minute' FROM sessions WHERE id_hash = :id"
                    ),
                    {"id": hash_token(value)},
                )
            ).scalar_one()
        assert fresh is True

    async def test_the_destination_after_sign_in_is_a_page_of_this_app_and_nothing_else(
        self, world: World, acme: Tenant, anna: User
    ) -> None:
        await release(acme, "10.20.0.0/16")
        async with await world.login(anna) as admin:
            app = (await publish(admin, "wiki")).json()  # by path: https://apps.test/wiki/
        for wanted, lands in (
            ("/wiki/seite?x=1", "https://apps.test/wiki/seite?x=1"),
            ("//evil.example/", "https://apps.test/wiki/"),
            ("https://evil.example/", "https://apps.test/wiki/"),
            ("/andere-app/", "https://apps.test/wiki/"),  # another app on the same host
            ("/wiki/../andere/", "https://apps.test/wiki/"),  # a browser resolves the dots: another app
            ("/wiki/a/../seite", "https://apps.test/wiki/a/../seite"),  # stays inside
            ("/wiki\\@evil.example", "https://apps.test/wiki/"),
            ("/wiki/__velydock/callback?t=x", "https://apps.test/wiki/"),
        ):
            async with await world.login(anna) as browser:
                there = await browser.get("/proxy/login", params={"p": app["id"], "rd": wanted})
            callback = urlsplit(there.headers["location"])
            assert (callback.netloc, callback.path) == ("apps.test", "/wiki/__velydock/callback")
            answer = await self.ask(world, app, f"{callback.path}?{callback.query}", host="apps.test")
            assert answer.headers["location"] == lands, wanted
            # By path, the cookie is for this app's path and carries its name.
            assert answer.headers["set-cookie"].startswith("__Secure-velydock-app-wiki=")
            assert "Path=/wiki/;" in answer.headers["set-cookie"]

    async def test_the_check_itself_is_only_for_the_proxy(
        self, world: World, anna: User, wiki: dict[str, Any]
    ) -> None:
        async with await world.login(anna) as client:
            outside = await client.get(f"/internal/proxy/auth/{wiki['id']}", headers={"X-Forwarded-Uri": "/"})
        assert outside.status_code == 404
        async with world.client() as client:
            unknown = await client.get(f"/internal/proxy/auth/{uuid.uuid4()}", headers=INTERNAL)
        assert unknown.status_code == 404
        assert quote("/") == "/"
