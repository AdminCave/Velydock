"""Integration with a real Keycloak.

These tests provision their own realm in a running Keycloak, exercise the Admin API adapter and
walk through the browser sign-in exactly as a user would (HTML forms and redirects), ending in
Velydock's real callback handler. The realm is deleted afterwards.

    VELYDOCK_TEST_KEYCLOAK_URL          default http://127.0.0.1:18080 (the dev stack)
    VELYDOCK_TEST_KEYCLOAK_PUBLIC_URL   the KC_HOSTNAME of that Keycloak
    VELYDOCK_TEST_KEYCLOAK_BOOTSTRAP_SECRET
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import html
import os
import re
import secrets
import struct
import time
from collections.abc import AsyncIterator
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx
import jwt
import pytest

from tests.conftest import World
from tests.support.fake_idp import FakeIdp
from tests.support.mini_idp import MiniIdp
from velydock.app import create_app
from velydock.config import Settings
from velydock.db import Scope, transaction
from velydock.idp.base import IdpConflict, IdpNotFound, SmtpConfig
from velydock.idp.keycloak import PASSWORD_POLICY, SERVICE_ACCOUNT_ROLES, KeycloakIdp, ensure_realm
from velydock.models import Role, User
from velydock.security.oidc import OidcClient

pytestmark = pytest.mark.keycloak

INTERNAL = os.environ.get("VELYDOCK_TEST_KEYCLOAK_URL", "http://127.0.0.1:18080")
PUBLIC = os.environ.get("VELYDOCK_TEST_KEYCLOAK_PUBLIC_URL", "https://auth.velydock.localhost:8443")
BOOTSTRAP_SECRET = os.environ.get("VELYDOCK_TEST_KEYCLOAK_BOOTSTRAP_SECRET", "dev-keycloak-bootstrap-secret")
PASSWORD = "Correct-Horse-Battery-42"
# With organizations enabled Keycloak asks for the user name first; the second page carries the
# password field (and, depending on the flow, the pre-filled user name).
PASSWORD_PAGES = ("login-login", "login-login-password")


@pytest.fixture(scope="module")
async def kc_settings(database_url: str) -> AsyncIterator[Settings]:
    realm = f"velydock-it-{secrets.token_hex(4)}"
    settings = Settings(
        environment="test",
        public_url="https://dock.test",
        sandbox_url="https://sandbox.test",
        database_url=database_url,
        secret_key="k" * 40,
        keycloak_public_url=PUBLIC,
        keycloak_internal_url=INTERNAL,
        keycloak_realm=realm,
        oidc_client_secret="it-oidc-secret-" + secrets.token_hex(8),
        idp_admin_client_secret="it-admin-secret-" + secrets.token_hex(8),
        idp_bootstrap_client_id="velydock-bootstrap",
        idp_bootstrap_client_secret=BOOTSTRAP_SECRET,
        require_admin_2fa=False,
        static_dir="/nonexistent",
    )
    async with httpx.AsyncClient(timeout=30, trust_env=False) as http:
        try:
            await http.get(f"{INTERNAL}/realms/master/.well-known/openid-configuration")
        except httpx.HTTPError as exc:
            pytest.skip(f"Keycloak not reachable at {INTERNAL} ({exc})")
        await ensure_realm(settings, http)
        yield settings
        token = (
            await http.post(
                f"{INTERNAL}/realms/master/protocol/openid-connect/token",
                data={"grant_type": "client_credentials"},
                auth=("velydock-bootstrap", BOOTSTRAP_SECRET),
            )
        ).json()["access_token"]
        await http.delete(f"{INTERNAL}/admin/realms/{realm}", headers={"Authorization": f"Bearer {token}"})


@pytest.fixture
async def http() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        yield client


@pytest.fixture
def idp(kc_settings: Settings, http: httpx.AsyncClient) -> KeycloakIdp:
    return KeycloakIdp(kc_settings, http)


async def service_token(settings: Settings, http: httpx.AsyncClient) -> str:
    response = await http.post(
        f"{settings.realm_internal_url}/protocol/openid-connect/token",
        data={"grant_type": "client_credentials"},
        auth=(settings.idp_admin_client_id, settings.idp_admin_client_secret),
    )
    response.raise_for_status()
    return str(response.json()["access_token"])


async def admin_get(settings: Settings, http: httpx.AsyncClient, path: str) -> httpx.Response:
    token = await service_token(settings, http)
    return await http.get(
        f"{INTERNAL}/admin/realms/{settings.keycloak_realm}{path}",
        headers={"Authorization": f"Bearer {token}"},
    )


def unique(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(3)}"


class TestRealmProvisioning:
    async def test_realm_is_configured_as_velydock_needs_it(
        self, kc_settings: Settings, http: httpx.AsyncClient
    ) -> None:
        realm = (await admin_get(kc_settings, http, "")).json()
        assert realm["enabled"] and realm["organizationsEnabled"]
        assert realm["registrationAllowed"] is False
        assert realm["bruteForceProtected"] is True
        assert realm["duplicateEmailsAllowed"] is False and realm["editUsernameAllowed"] is False
        assert realm["passwordPolicy"] == PASSWORD_POLICY
        assert realm["loginTheme"] == "velydock"
        assert set(realm["supportedLocales"]) == {"de", "en"}
        assert realm["ssoSessionMaxLifespan"] == kc_settings.session_max_hours * 3600

    async def test_provisioning_is_idempotent(self, kc_settings: Settings, http: httpx.AsyncClient) -> None:
        await ensure_realm(kc_settings, http)
        await ensure_realm(kc_settings, http)
        clients = (await admin_get(kc_settings, http, "/clients?clientId=velydock")).json()
        assert len(clients) == 1

    async def test_works_without_bootstrap_credentials_once_set_up(
        self, kc_settings: Settings, http: httpx.AsyncClient
    ) -> None:
        """The master-realm bootstrap secret may be removed from the environment after the first start."""
        without = kc_settings.model_copy(
            update={"idp_bootstrap_client_id": None, "idp_bootstrap_client_secret": None}
        )
        await ensure_realm(without, http)

    async def test_web_client_is_confidential_with_pkce_and_backchannel_logout(
        self, kc_settings: Settings, http: httpx.AsyncClient
    ) -> None:
        client = (await admin_get(kc_settings, http, "/clients?clientId=velydock")).json()[0]
        assert client["publicClient"] is False
        assert client["standardFlowEnabled"] is True
        assert client["implicitFlowEnabled"] is False and client["directAccessGrantsEnabled"] is False
        assert client["redirectUris"] == ["https://dock.test/api/auth/callback"]
        attributes = client["attributes"]
        assert attributes["pkce.code.challenge.method"] == "S256"
        assert attributes["backchannel.logout.url"].endswith("/api/auth/backchannel-logout")
        assert attributes["backchannel.logout.session.required"] == "true"

    async def test_service_account_has_only_the_roles_it_needs(
        self, kc_settings: Settings, http: httpx.AsyncClient
    ) -> None:
        claims = jwt.decode(await service_token(kc_settings, http), options={"verify_signature": False})
        roles = set(claims["resource_access"]["realm-management"]["roles"])
        assert set(SERVICE_ACCOUNT_ROLES) <= roles
        assert not {"realm-admin", "impersonation", "manage-identity-providers"} & roles
        audiences = claims["aud"] if isinstance(claims["aud"], list) else [claims["aud"]]
        assert f"{PUBLIC}/admin/realms/{kc_settings.keycloak_realm}" in audiences

    async def test_email_is_optional_and_only_admins_may_change_it(
        self, kc_settings: Settings, http: httpx.AsyncClient
    ) -> None:
        profile = (await admin_get(kc_settings, http, "/users/profile")).json()
        email = next(a for a in profile["attributes"] if a["name"] == "email")
        assert "required" not in email
        assert email["permissions"]["edit"] == ["admin"]

    async def test_issuer_is_the_public_address_while_tokens_are_fetched_internally(
        self, kc_settings: Settings, http: httpx.AsyncClient
    ) -> None:
        metadata = await OidcClient(kc_settings, http).metadata()
        assert metadata.issuer == f"{PUBLIC}/realms/{kc_settings.keycloak_realm}"
        assert metadata.authorization_endpoint.startswith(PUBLIC)
        assert metadata.token_endpoint.startswith(INTERNAL) and metadata.jwks_uri.startswith(INTERNAL)


class TestUserLifecycle:
    async def test_create_update_disable_delete(
        self, kc_settings: Settings, http: httpx.AsyncClient, idp: KeycloakIdp
    ) -> None:
        name = unique("mia")
        user_id = await idp.create_user(
            username=name,
            email=f"{name}@acme.example",
            first_name="Mia",
            last_name="M",
            temporary_password=PASSWORD,
        )
        created = (await admin_get(kc_settings, http, f"/users/{user_id}")).json()
        assert (created["username"], created["email"], created["enabled"]) == (
            name,
            f"{name}@acme.example",
            True,
        )
        assert created["requiredActions"] == ["UPDATE_PASSWORD"], "the one-time password must be changed"

        await idp.update_user(user_id, email=None, first_name="Maria", last_name="Neu")
        updated = (await admin_get(kc_settings, http, f"/users/{user_id}")).json()
        assert (updated["firstName"], updated["lastName"], updated.get("email")) == ("Maria", "Neu", None)

        await idp.set_enabled(user_id, False)
        assert (await admin_get(kc_settings, http, f"/users/{user_id}")).json()["enabled"] is False
        await idp.set_enabled(user_id, True)
        await idp.set_temporary_password(user_id, PASSWORD + "x")
        await idp.logout_user(user_id)

        assert await idp.has_second_factor(user_id) is False
        await idp.require_second_factor_setup(user_id)
        await idp.require_second_factor_setup(user_id)
        actions = (await admin_get(kc_settings, http, f"/users/{user_id}")).json()["requiredActions"]
        assert sorted(actions) == ["CONFIGURE_TOTP", "UPDATE_PASSWORD"]

        await idp.delete_user(user_id)
        assert (await admin_get(kc_settings, http, f"/users/{user_id}")).status_code == 404
        await idp.delete_user(user_id)  # deleting twice is not an error
        with pytest.raises(IdpNotFound):
            await idp.set_enabled(user_id, True)

    async def test_account_without_email(self, idp: KeycloakIdp) -> None:
        user_id = await idp.create_user(
            username=unique("ben"), email=None, first_name="Ben", last_name="B", temporary_password=PASSWORD
        )
        await idp.delete_user(user_id)

    async def test_duplicates_are_reported_by_field(self, idp: KeycloakIdp) -> None:
        name = unique("dup")
        user_id = await idp.create_user(
            username=name,
            email=f"{name}@acme.example",
            first_name="A",
            last_name="B",
            temporary_password=PASSWORD,
        )
        with pytest.raises(IdpConflict) as by_name:
            await idp.create_user(
                username=name, email=None, first_name="A", last_name="B", temporary_password=PASSWORD
            )
        assert by_name.value.field == "username"
        with pytest.raises(IdpConflict) as by_mail:
            await idp.create_user(
                username=unique("other"),
                email=f"{name}@ACME.example",
                first_name="A",
                last_name="B",
                temporary_password=PASSWORD,
            )
        assert by_mail.value.field == "email"
        await idp.delete_user(user_id)

    async def test_weak_passwords_are_refused_by_the_policy(
        self, kc_settings: Settings, http: httpx.AsyncClient, idp: KeycloakIdp
    ) -> None:
        user_id = await idp.create_user(
            username=unique("weak"), email=None, first_name="A", last_name="B", temporary_password=PASSWORD
        )
        token = await service_token(kc_settings, http)
        response = await http.put(
            f"{INTERNAL}/admin/realms/{kc_settings.keycloak_realm}/users/{user_id}/reset-password",
            headers={"Authorization": f"Bearer {token}"},
            json={"type": "password", "value": "short", "temporary": False},
        )
        assert response.status_code == 400
        await idp.delete_user(user_id)


class TestOrganizations:
    async def test_tenant_mirror(self, idp: KeycloakIdp) -> None:
        alias = unique("acme")
        org_id = await idp.create_organization(name=f"Acme {alias}", alias=alias)
        assert await idp.find_organization(alias) == org_id
        with pytest.raises(IdpConflict):
            await idp.create_organization(name=f"Acme {alias}", alias=unique("other"))

        user_id = await idp.create_user(
            username=unique("member"), email=None, first_name="A", last_name="B", temporary_password=PASSWORD
        )
        await idp.add_organization_member(org_id, user_id)
        await idp.add_organization_member(org_id, user_id)  # idempotent
        assert await idp.list_organization_members(org_id) == {user_id}
        await idp.remove_organization_member(org_id, user_id)
        await idp.remove_organization_member(org_id, user_id)
        assert await idp.list_organization_members(org_id) == set()

        await idp.update_organization(org_id, name=f"Acme AG {alias}", enabled=False)
        await idp.delete_organization(org_id)
        await idp.delete_organization(org_id)
        assert await idp.find_organization(alias) is None
        await idp.delete_user(user_id)

    async def test_smtp_settings_round_trip_without_revealing_the_password(self, idp: KeycloakIdp) -> None:
        assert (await idp.get_smtp()).configured is False
        await idp.set_smtp(
            SmtpConfig(
                host="mail.example.org",
                port=465,
                from_address="dock@example.org",
                from_name="Dock",
                username="dock",
                password="smtp-secret",
                encryption="ssl",
            )
        )
        stored = await idp.get_smtp()
        assert (stored.host, stored.port, stored.encryption, stored.username) == (
            "mail.example.org",
            465,
            "ssl",
            "dock",
        )
        assert stored.password == "" and stored.configured
        await idp.set_smtp(SmtpConfig())
        assert (await idp.get_smtp()).configured is False


# -- browser sign-in against the real login pages ------------------------------------------------


class Browser:
    """Just enough of a browser to click through Keycloak's login pages.

    Keycloak is addressed on its internal port while it believes to be at its public HTTPS
    address, so URLs are rewritten and cookies are kept by hand (they are flagged Secure).
    """

    def __init__(self, http: httpx.AsyncClient) -> None:
        self.http = http
        self.cookies: dict[str, str] = {}
        self.page = ""

    def _internal(self, url: str) -> str:
        return url.replace(PUBLIC, INTERNAL)

    async def request(self, method: str, url: str, data: dict[str, str] | None = None) -> httpx.Response:
        response = await self.http.request(
            method,
            self._internal(url),
            data=data,
            headers={
                "Cookie": "; ".join(f"{k}={v}" for k, v in self.cookies.items()),
                "Accept-Language": "en",
            },
            follow_redirects=False,
        )
        for cookie in response.headers.get_list("set-cookie"):
            name, _, value = cookie.split(";", 1)[0].partition("=")
            if "Max-Age=0" in cookie or value in ("", '""'):
                self.cookies.pop(name, None)
            else:
                self.cookies[name] = value
        self.page = response.text
        return response

    async def follow(self, response: httpx.Response, *, stop_at: str) -> httpx.Response:
        """Follow redirects until one leaves Keycloak for ``stop_at`` (the relying party)."""
        for _ in range(10):
            if response.status_code not in (301, 302, 303, 307):
                return response
            location = response.headers["location"]
            if location.startswith(stop_at):
                return response
            response = await self.request("GET", urljoin(PUBLIC, location))
        raise AssertionError("too many redirects")

    def form_action(self) -> str:
        match = re.search(r'<form[^>]*\baction="([^"]+)"', self.page)
        assert match, f"no form on page:\n{self.page[:1500]}"
        return html.unescape(match.group(1))

    def page_id(self) -> str:
        match = re.search(r'data-page-id="([^"]+)"', self.page)
        return match.group(1) if match else ""

    async def submit(self, fields: dict[str, str], *, stop_at: str) -> httpx.Response:
        return await self.follow(await self.request("POST", self.form_action(), data=fields), stop_at=stop_at)


def totp(secret_base32: str, at: float | None = None) -> str:
    key = base64.b32decode(
        secret_base32.replace(" ", "").upper() + "=" * (-len(secret_base32.replace(" ", "")) % 8)
    )
    counter = struct.pack(">Q", int((at or time.time()) // 30))
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    return f"{(struct.unpack('>I', digest[offset : offset + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


@pytest.fixture
async def stack(kc_settings: Settings, http: httpx.AsyncClient, clean_db: None) -> World:
    """The Velydock application wired to the real Keycloak (identity provider and relying party)."""
    idp = KeycloakIdp(kc_settings, http)
    app = create_app(kc_settings, idp=idp, oidc=OidcClient(kc_settings, http))
    return World(settings=kc_settings, idp=FakeIdp(), mini=MiniIdp(kc_settings), app=app)


async def make_account(
    stack: World,
    idp: KeycloakIdp,
    http: httpx.AsyncClient,
    username: str,
    role: Role | None,
    *,
    system_admin: bool = False,
) -> User:
    """A Keycloak account with a known permanent password, and the matching Velydock user."""
    settings = stack.settings
    idp_id = await idp.create_user(
        username=username,
        email=f"{username}@acme.example",
        first_name="Test",
        last_name="User",
        temporary_password=PASSWORD,
    )
    token = await service_token(settings, http)
    reset = await http.put(
        f"{INTERNAL}/admin/realms/{settings.keycloak_realm}/users/{idp_id}/reset-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"type": "password", "value": PASSWORD, "temporary": False},
    )
    assert reset.status_code == 204, reset.text
    from velydock.models import Membership, Tenant

    # As in production: the tenant exists as an organization in Keycloak and the user is a member.
    slug = unique("t")
    org_id = await idp.create_organization(name=f"Tenant {slug}", alias=slug)
    await idp.add_organization_member(org_id, idp_id)
    async with transaction(Scope.SYSTEM) as db:
        tenant = Tenant(slug=slug, name=f"Tenant {slug}", idp_org_id=org_id)
        db.add(tenant)
        await db.flush()
        user = User(
            idp_id=idp_id,
            username=username,
            email=f"{username}@acme.example",
            first_name="Test",
            last_name="User",
            home_tenant_id=tenant.id,
            is_system_admin=system_admin,
        )
        db.add(user)
        await db.flush()
        if role is not None:
            db.add(Membership(tenant_id=tenant.id, user_id=user.id, role=role.value))
        await db.flush()
        await db.refresh(user)
    return user


async def sign_in_through_keycloak(
    stack: World, browser: Browser, client: httpx.AsyncClient, username: str
) -> httpx.Response:
    callback = "https://dock.test/api/auth/callback"
    start = await client.get("/api/auth/login", params={"return_to": "/"})
    assert start.status_code == 302
    await browser.follow(await browser.request("GET", start.headers["location"]), stop_at=callback)
    assert browser.page_id() == "login-login-username", "organizations enabled: user name first"
    await browser.submit({"username": username}, stop_at=callback)
    assert browser.page_id() in PASSWORD_PAGES, browser.page[:800]
    return await browser.submit({"password": PASSWORD}, stop_at=callback)


class TestBrowserSignIn:
    async def test_complete_sign_in_and_sign_out(
        self, stack: World, idp: KeycloakIdp, http: httpx.AsyncClient
    ) -> None:
        name = unique("anna")
        await make_account(stack, idp, http, name, Role.MEMBER)
        browser = Browser(http)
        async with stack.client() as client:
            redirect = await sign_in_through_keycloak(stack, browser, client, name)
            assert redirect.status_code == 302, browser.page[:1000]
            location = redirect.headers["location"]
            assert location.startswith("https://dock.test/api/auth/callback?")
            assert {"code", "state", "iss"} <= set(parse_qs(urlsplit(location).query))

            done = await client.get(location)
            assert done.headers["location"] == "/"
            me = (await client.get("/api/v1/me")).json()
            assert me["user"]["username"] == name
            assert me["user"]["email"] == f"{name}@acme.example"

            # The callback URL is single-use.
            assert (await client.get(location)).headers["location"].startswith("/login?error=")

            out = await client.post("/api/auth/logout")
            end_session = out.json()["redirect_url"]
            assert end_session.startswith(
                f"{PUBLIC}/realms/{stack.settings.keycloak_realm}/protocol/openid-connect/logout?"
            )
            assert (await client.get("/api/v1/me")).status_code == 401
            # Following it ends the Keycloak session and returns to Velydock without a confirmation page.
            ended = await browser.request("GET", end_session)
            assert ended.status_code == 302
            assert ended.headers["location"] == "https://dock.test/login?signed_out=1"

    async def test_wrong_password_does_not_sign_in(
        self, stack: World, idp: KeycloakIdp, http: httpx.AsyncClient
    ) -> None:
        name = unique("anna")
        await make_account(stack, idp, http, name, Role.MEMBER)
        browser = Browser(http)
        async with stack.client() as client:
            start = await client.get("/api/auth/login")
            callback = "https://dock.test/api/auth/callback"
            await browser.follow(await browser.request("GET", start.headers["location"]), stop_at=callback)
            assert browser.page_id() == "login-login-username"
            await browser.submit({"username": name}, stop_at=callback)
            assert browser.page_id() in PASSWORD_PAGES
            response = await browser.submit({"password": "wrong-password"}, stop_at=callback)
            assert response.status_code == 200 and browser.page_id() in PASSWORD_PAGES
            assert "Invalid" in browser.page
            assert (await client.get("/api/v1/me")).status_code == 401

    async def test_disabled_account_is_refused_by_keycloak(
        self, stack: World, idp: KeycloakIdp, http: httpx.AsyncClient
    ) -> None:
        name = unique("ina")
        user = await make_account(stack, idp, http, name, Role.MEMBER)
        await idp.set_enabled(user.idp_id, False)
        browser = Browser(http)
        async with stack.client() as client:
            start = await client.get("/api/auth/login")
            callback = "https://dock.test/api/auth/callback"
            await browser.follow(await browser.request("GET", start.headers["location"]), stop_at=callback)
            await browser.submit({"username": name}, stop_at=callback)
            if browser.page_id() in PASSWORD_PAGES:
                response = await browser.submit({"password": PASSWORD}, stop_at=callback)
            else:
                response = await browser.request(
                    "GET", f"{PUBLIC}/realms/{stack.settings.keycloak_realm}/account"
                )
            assert "code=" not in response.headers.get("location", "")
            assert (await client.get("/api/v1/me")).status_code == 401

    async def test_one_time_password_must_be_changed_before_first_use(
        self, stack: World, idp: KeycloakIdp, http: httpx.AsyncClient
    ) -> None:
        """An account created by an administrator cannot reach Velydock with the handed-over password."""
        name = unique("neu")
        idp_id = await idp.create_user(
            username=name, email=None, first_name="Neu", last_name="N", temporary_password=PASSWORD
        )
        browser = Browser(http)
        async with stack.client() as client:
            start = await client.get("/api/auth/login")
            callback = "https://dock.test/api/auth/callback"
            await browser.follow(await browser.request("GET", start.headers["location"]), stop_at=callback)
            await browser.submit({"username": name}, stop_at=callback)
            response = await browser.submit({"password": PASSWORD}, stop_at=callback)
            assert response.status_code == 200
            assert browser.page_id() == "login-login-update-password"
            changed = await browser.submit(
                {"password-new": PASSWORD + "-new", "password-confirm": PASSWORD + "-new"}, stop_at=callback
            )
            assert changed.status_code == 302 and "code=" in changed.headers["location"]
        await idp.delete_user(idp_id)

    async def test_administrators_must_enrol_a_second_factor(
        self, stack: World, idp: KeycloakIdp, http: httpx.AsyncClient
    ) -> None:
        name = unique("admin")
        user = await make_account(stack, idp, http, name, Role.TENANT_ADMIN)
        root = await make_account(stack, idp, http, unique("root"), Role.TENANT_ADMIN, system_admin=True)
        async with await stack.login(root) as as_root:
            assert (
                await as_root.patch("/api/v1/system/settings", json={"require_admin_2fa": True})
            ).status_code == 200

        browser = Browser(http)
        callback = "https://dock.test/api/auth/callback"
        async with stack.client() as client:
            first = await client.get(
                (await sign_in_through_keycloak(stack, browser, client, name)).headers["location"]
            )
            # Velydock does not open a session; it sends the browser back to Keycloak …
            assert first.status_code == 302 and first.headers["location"].startswith(PUBLIC)
            assert (await client.get("/api/v1/me")).status_code == 401
            # … which now insists on setting up an authenticator app.
            await browser.follow(await browser.request("GET", first.headers["location"]), stop_at=callback)
            assert browser.page_id() == "login-login-config-totp", browser.page[:600]

            manual = re.search(r'href="([^"]+mode=manual[^"]*)"', browser.page)
            assert manual, "link to show the secret key"
            await browser.request("GET", urljoin(PUBLIC, html.unescape(manual.group(1))))
            secret = re.search(r'id="kc-totp-secret-key"[^>]*>([^<]+)<', browser.page)
            assert secret, browser.page[:3000]
            hidden = re.search(
                r'name="totpSecret"\s+value="([^"]+)"|value="([^"]+)"\s+name="totpSecret"', browser.page
            )
            assert hidden
            enrolled = await browser.submit(
                {
                    "totp": totp(secret.group(1)),
                    "totpSecret": hidden.group(1) or hidden.group(2),
                    "userLabel": "test",
                },
                stop_at=callback,
            )
            assert enrolled.status_code == 302 and "code=" in enrolled.headers["location"], browser.page[
                :1500
            ]
            final = await client.get(enrolled.headers["location"])
            assert final.headers["location"] == "/"
            assert (await client.get("/api/v1/me")).json()["user"]["username"] == name
        assert await idp.has_second_factor(user.idp_id) is True


class TestOrganizationClaim:
    """Why tenants are mirrored as organizations: connected apps can tell them apart."""

    async def test_tokens_for_connected_apps_can_carry_the_users_organization(
        self, kc_settings: Settings, http: httpx.AsyncClient, idp: KeycloakIdp
    ) -> None:
        realm_api = f"{INTERNAL}/admin/realms/{kc_settings.keycloak_realm}"
        headers = {"Authorization": f"Bearer {await service_token(kc_settings, http)}"}
        acme, globex = unique("acme"), unique("globex")
        acme_org = await idp.create_organization(name=f"Org {acme}", alias=acme)
        await idp.create_organization(name=f"Org {globex}", alias=globex)

        name = unique("member")
        user_id = await idp.create_user(
            username=name, email=None, first_name="A", last_name="B", temporary_password=PASSWORD
        )
        await http.put(
            f"{realm_api}/users/{user_id}/reset-password",
            headers=headers,
            json={"type": "password", "value": PASSWORD, "temporary": False},
        )
        await idp.add_organization_member(acme_org, user_id)

        # A stand-in for a connected app (e.g. a customer's Nextcloud) that asks for the organization.
        client_id = unique("app")
        created = await http.post(
            f"{realm_api}/clients",
            headers=headers,
            json={
                "clientId": client_id,
                "publicClient": True,
                "directAccessGrantsEnabled": True,
                "standardFlowEnabled": False,
                "optionalClientScopes": ["organization"],
            },
        )
        assert created.status_code == 201, created.text

        async def organizations(scope: str) -> object:
            response = await http.post(
                f"{kc_settings.realm_internal_url}/protocol/openid-connect/token",
                data={
                    "grant_type": "password",
                    "client_id": client_id,
                    "username": name,
                    "password": PASSWORD,
                    "scope": scope,
                },
            )
            assert response.status_code == 200, response.text
            return jwt.decode(response.json()["access_token"], options={"verify_signature": False}).get(
                "organization"
            )

        assert organizations is not None
        claim = await organizations("openid organization")
        assert claim == [acme] or (isinstance(claim, dict) and list(claim) == [acme]), claim
        # Asking for an organization the user does not belong to yields no such claim.
        foreign = await organizations(f"openid organization:{globex}")
        assert not foreign, foreign
        assert await organizations("openid") is None
