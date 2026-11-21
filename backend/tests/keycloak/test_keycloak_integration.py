"""Integration with a real Keycloak.

These tests provision their own realm in a running Keycloak, exercise the Admin API adapter and
walk through the browser sign-in exactly as a user would (HTML forms and redirects), ending in
Velydock's real callback handler. The realm is deleted afterwards.

The rule for this suite: whatever depends on how Keycloak behaves is tested here, against
Keycloak, and by its outcome - the page it serves, the redirect it answers with - not by the
value that was stored. The stand-ins used elsewhere (tests/support/fake_idp.py, mini_idp.py)
accept everything; two fixes that were only tested against them did nothing at the real thing
(a return address Keycloak refuses, an escaped name Keycloak decodes again).

    VELYDOCK_TEST_KEYCLOAK_URL          default http://127.0.0.1:18080 (the dev stack)
    VELYDOCK_TEST_KEYCLOAK_PUBLIC_URL   the KC_HOSTNAME of that Keycloak
    VELYDOCK_TEST_KEYCLOAK_BOOTSTRAP_SECRET
"""

from __future__ import annotations

import argparse
import asyncio
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
from pydantic import ValidationError
from sqlalchemy import select

from tests.conftest import World, unavailable
from tests.support.fake_idp import FakeIdp
from tests.support.mini_idp import MiniIdp
from velydock.app import create_app
from velydock.config import Settings
from velydock.db import Scope, transaction
from velydock.idp.base import AccountState, IdpConflict, IdpInvalid, IdpNotFound, SmtpConfig
from velydock.idp.keycloak import (
    EARLIER_PASSWORD_POLICIES,
    PASSWORD_POLICY,
    SERVICE_ACCOUNT_ROLES,
    KeycloakIdp,
    ensure_realm,
)
from velydock.models import AuditLog, Role, Tenant, User
from velydock.schemas import SystemSettingsUpdate
from velydock.security.oidc import OidcClient

pytestmark = pytest.mark.keycloak

INTERNAL = os.environ.get("VELYDOCK_TEST_KEYCLOAK_URL", "http://127.0.0.1:18080")
PUBLIC = os.environ.get("VELYDOCK_TEST_KEYCLOAK_PUBLIC_URL", "https://auth.velydock.localhost:8443")
BOOTSTRAP_SECRET = os.environ.get("VELYDOCK_TEST_KEYCLOAK_BOOTSTRAP_SECRET", "dev-keycloak-bootstrap-secret")
PASSWORD = "Correct-Horse-Battery-42"
# What an administrator hands out. The permanent password has to differ from it (password history).
ONE_TIME_PASSWORD = "Einmal-Passwort-zum-Start-7"
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
            unavailable(f"Keycloak not reachable at {INTERNAL} ({exc})")
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
        """Velydock itself no longer needs the master-realm bootstrap secret after the first start."""
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

    async def test_every_email_transition_is_accepted(
        self, kc_settings: Settings, http: httpx.AsyncClient, idp: KeycloakIdp
    ) -> None:
        """Without, with, changed and removed address – including editing an account that never had one.

        The account is a member of an organization, as every Velydock user is: for members
        Keycloak validates the address more strictly and rejects an empty one.
        """
        name = unique("mail")
        user_id = await idp.create_user(
            username=name, email=None, first_name="A", last_name="B", temporary_password=PASSWORD
        )
        alias = unique("org")
        org_id = await idp.create_organization(name=f"Org {alias}", alias=alias)
        await idp.add_organization_member(org_id, user_id)

        async def stored() -> tuple[str | None, str]:
            user = (await admin_get(kc_settings, http, f"/users/{user_id}")).json()
            return user.get("email"), user["lastName"]

        await idp.update_user(user_id, email=None, first_name="A", last_name="Ohne")
        assert await stored() == (None, "Ohne")
        await idp.update_user(user_id, email=f"{name}@acme.example", first_name="A", last_name="Mit")
        assert await stored() == (f"{name}@acme.example", "Mit")
        await idp.update_user(user_id, email=f"{name}@neu.example", first_name="A", last_name="Neu")
        assert await stored() == (f"{name}@neu.example", "Neu")
        await idp.update_user(user_id, email=None, first_name="A", last_name="Wieder ohne")
        assert await stored() == (None, "Wieder ohne")
        assert await idp.list_organization_members(org_id) == {user_id}, "still a member after clearing"
        await idp.update_user(user_id, email=None, first_name="A", last_name="Immer noch ohne")
        assert await stored() == (None, "Immer noch ohne")
        await idp.delete_user(user_id)
        await idp.delete_organization(org_id)

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
async def stack(
    kc_settings: Settings, http: httpx.AsyncClient, clean_db: None, monkeypatch: pytest.MonkeyPatch
) -> World:
    """The Velydock application wired to the real Keycloak (identity provider and relying party)."""
    from velydock.security import sessions

    # Tests that put a session straight into the database have no session at Keycloak for it.
    # The periodic check against Keycloak would end those at once; ``TestWhatKeycloakKnows``
    # covers the check itself, with real sign-ins.
    if not getattr(stack, "check_sessions", False):
        monkeypatch.setattr(sessions, "idp_check_due", lambda session: False)
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
        temporary_password=ONE_TIME_PASSWORD,
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


async def enrol_authenticator(browser: Browser, *, stop_at: str) -> tuple[httpx.Response, str]:
    """On Keycloak's "set up authenticator" page: read the secret, answer with a valid code."""
    manual = re.search(r'href="([^"]+mode=manual[^"]*)"', browser.page)
    assert manual, "link to show the secret key"
    await browser.request("GET", urljoin(PUBLIC, html.unescape(manual.group(1))))
    secret = re.search(r'id="kc-totp-secret-key"[^>]*>([^<]+)<', browser.page)
    assert secret, browser.page[:3000]
    hidden = re.search(
        r'name="totpSecret"\s+value="([^"]+)"|value="([^"]+)"\s+name="totpSecret"', browser.page
    )
    assert hidden
    response = await browser.submit(
        {
            "totp": totp(secret.group(1)),
            "totpSecret": hidden.group(1) or hidden.group(2),
            "userLabel": "test",
        },
        stop_at=stop_at,
    )
    return response, secret.group(1)


MAIL_API = os.environ.get("VELYDOCK_TEST_MAIL_URL", "http://127.0.0.1:18025")
# How Keycloak reaches the mail catcher of the development stack.
MAIL_SMTP_HOST = os.environ.get("VELYDOCK_TEST_MAIL_SMTP_HOST", "mail")


@pytest.fixture
async def mail(idp: KeycloakIdp, http: httpx.AsyncClient) -> AsyncIterator[None]:
    """Keycloak sends its e-mail to the mail catcher of the development stack."""
    try:
        (await http.get(f"{MAIL_API}/api/v1/info")).raise_for_status()
    except httpx.HTTPError as exc:
        unavailable(f"mail catcher not reachable at {MAIL_API} ({exc}); start the dev stack's 'mail' service")
    await idp.set_smtp(
        SmtpConfig(
            host=MAIL_SMTP_HOST,
            port=1025,
            from_address="velydock@velydock.test",
            from_name="Velydock",
            encryption="none",
        )
    )
    yield
    await idp.set_smtp(SmtpConfig())


async def received_mail(http: httpx.AsyncClient, address: str) -> str:
    """The text of the newest e-mail sent to ``address`` (waits for it)."""
    for _ in range(40):
        found = (await http.get(f"{MAIL_API}/api/v1/search", params={"query": f"to:{address}"})).json()
        if found["messages"]:
            message = await http.get(f"{MAIL_API}/api/v1/message/{found['messages'][0]['ID']}")
            return str(message.json()["Text"])
        await asyncio.sleep(0.25)
    raise AssertionError(f"no e-mail for {address} arrived")


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
            # "A password of one's own" - not the handed-over one again: the administrator who
            # gave it out still knows it.
            kept = await browser.submit(
                {"password-new": PASSWORD, "password-confirm": PASSWORD}, stop_at=callback
            )
            assert kept.status_code == 200 and browser.page_id() == "login-login-update-password", (
                "the one-time password was accepted as the permanent one"
            )
            changed = await browser.submit(
                {"password-new": PASSWORD + "-new", "password-confirm": PASSWORD + "-new"}, stop_at=callback
            )
            assert changed.status_code == 302 and "code=" in changed.headers["location"]
        await idp.delete_user(idp_id)

    async def test_a_refused_sign_in_ends_keycloaks_session_and_returns_to_the_login_page(
        self, stack: World, idp: KeycloakIdp, http: httpx.AsyncClient
    ) -> None:
        """Keycloak accepts the sign-in, Velydock does not (here: the account is deactivated in
        Velydock only). The way back leads through Keycloak's end-session address - and Keycloak
        is particular about return addresses: one with a parameter named "error" it refuses."""
        name = unique("refused")
        user = await make_account(stack, idp, http, name, Role.MEMBER)
        async with transaction(Scope.SYSTEM) as db:
            (await db.execute(select(User).where(User.id == user.id))).scalar_one().active = False
        browser = Browser(http)
        async with stack.client() as client:
            redirect = await sign_in_through_keycloak(stack, browser, client, name)
            answer = await client.get(redirect.headers["location"])
            assert (
                answer.status_code == 302 and "/protocol/openid-connect/logout?" in answer.headers["location"]
            )
            # Keycloak ends its session without asking and sends the browser back to Velydock …
            back = await browser.request("GET", answer.headers["location"])
            assert back.status_code == 302, f"Keycloak refused the way back:\n{browser.page[:600]}"
            assert back.headers["location"] == "https://dock.test/api/auth/refused/disabled"
            assert await idp.account_state(user.idp_id, None) is not AccountState.DISABLED
            # … which shows the login page with the reason.
            shown = await client.get("/api/auth/refused/disabled")
            assert (shown.status_code, shown.headers["location"]) == (302, "/login?error=disabled")
            assert (await client.get("/api/v1/me")).status_code == 401
            # The session at Keycloak is gone: the next attempt asks for the user name again
            # instead of running silently into the same refusal.
            again = Browser(http)
            again.cookies = dict(browser.cookies)
            start = await client.get("/api/auth/login")
            await again.follow(
                await again.request("GET", start.headers["location"]),
                stop_at="https://dock.test/api/auth/callback",
            )
            assert again.page_id() == "login-login-username"
        await idp.delete_user(user.idp_id)

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
            enrolled, _secret = await enrol_authenticator(browser, stop_at=callback)
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
            username=name, email=None, first_name="A", last_name="B", temporary_password=ONE_TIME_PASSWORD
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


async def admin_put(settings: Settings, http: httpx.AsyncClient, path: str, body: dict[str, object]) -> None:
    token = await service_token(settings, http)
    response = await http.put(
        f"{INTERNAL}/admin/realms/{settings.keycloak_realm}{path}",
        headers={"Authorization": f"Bearer {token}"},
        json=body,
    )
    response.raise_for_status()


class TestWhatOperatorsChangeInKeycloak:
    async def test_a_stricter_password_policy_survives_the_next_start(
        self, kc_settings: Settings, http: httpx.AsyncClient
    ) -> None:
        """The documentation tells operators to raise the policy in Keycloak. Provisioning runs
        at every start of Velydock and must leave their choice alone."""
        stricter = "length(16) and upperCase(1) and digits(1) and notUsername and notEmail"
        await admin_put(kc_settings, http, "", {"passwordPolicy": stricter, "failureFactor": 3})
        try:
            await ensure_realm(kc_settings, http)
            realm = (await admin_get(kc_settings, http, "")).json()
            assert realm["passwordPolicy"] == stricter
            assert realm["failureFactor"] == 3
            # What Velydock depends on is still enforced.
            assert realm["bruteForceProtected"] is True and realm["registrationAllowed"] is False
        finally:
            await admin_put(kc_settings, http, "", {"passwordPolicy": PASSWORD_POLICY, "failureFactor": 8})

    async def test_a_policy_nobody_changed_moves_on_with_velydock(
        self, kc_settings: Settings, http: httpx.AsyncClient
    ) -> None:
        """An installation of an earlier version still has that version's policy, under which the
        one-time password could be kept as the permanent one. Untouched, it is brought up to date."""
        for earlier in EARLIER_PASSWORD_POLICIES:
            await admin_put(kc_settings, http, "", {"passwordPolicy": earlier})
            try:
                await ensure_realm(kc_settings, http)
                assert (await admin_get(kc_settings, http, "")).json()["passwordPolicy"] == PASSWORD_POLICY
            finally:
                await admin_put(kc_settings, http, "", {"passwordPolicy": PASSWORD_POLICY})


class TestRulesVelydockMirrors:
    """Velydock validates input before it calls Keycloak. Where Keycloak is stricter, the user
    would get "the identity provider rejected the request" instead of a marked field."""

    async def test_the_rule_for_names_is_keycloaks_rule(self, idp: KeycloakIdp) -> None:
        import string

        from velydock.schemas import UserCreate

        disagreements: list[str] = []
        for char in [*string.punctuation, "§", "ä", "é", " "]:
            name = f"A{char}b"
            try:
                UserCreate(username="probe", first_name=name, last_name=name)
                ours = True
            except ValidationError:
                ours = False
            try:
                created = await idp.create_user(
                    username=unique("name"),
                    email=None,
                    first_name=name,
                    last_name=name,
                    temporary_password=PASSWORD + secrets.token_hex(2),
                )
                await idp.delete_user(created)
                theirs = True
            except IdpInvalid:
                theirs = False
            if ours != theirs:
                disagreements.append(
                    f"{char!r}: Velydock {'accepts' if ours else 'refuses'}, Keycloak does not"
                )
        assert disagreements == []

    async def test_user_names_need_three_characters(self, idp: KeycloakIdp) -> None:
        from velydock.schemas import UserCreate

        short = "z" + secrets.choice("abcdefghijkmnpqrstuvwxyz")
        with pytest.raises(IdpInvalid) as refused:
            await idp.create_user(
                username=short, email=None, first_name="Zoe", last_name="Q", temporary_password=PASSWORD
            )
        assert refused.value.field == "username"
        with pytest.raises(ValidationError):
            UserCreate(username=short, first_name="Zoe", last_name="Q")
        three = "z" + secrets.token_hex(1)
        created = await idp.create_user(
            username=three, email=None, first_name="Zoe", last_name="Q", temporary_password=PASSWORD
        )
        await idp.delete_user(created)
        assert UserCreate(username=three, first_name="Zoe", last_name="Q").username == three


class TestSetupAdmin:
    """``velydock setup-admin`` against the real identity provider."""

    @pytest.fixture
    def arguments(self, monkeypatch: pytest.MonkeyPatch) -> argparse.Namespace:
        from velydock import cli

        async def keep_engine() -> None:
            return None

        # The command closes the database engine when it is done; the tests share one.
        monkeypatch.setattr(cli, "dispose_engine", keep_engine)
        slug = unique("main")
        return argparse.Namespace(
            username=unique("admin"),
            email=None,
            first_name="System",
            last_name="Administrator",
            tenant_name=f"Haupt {slug}",
            tenant_slug=slug,
        )

    async def state(self) -> tuple[list[Tenant], list[User], list[AuditLog]]:
        async with transaction(Scope.SYSTEM) as db:
            return (
                list((await db.execute(select(Tenant))).scalars()),
                list((await db.execute(select(User))).scalars()),
                list((await db.execute(select(AuditLog).order_by(AuditLog.id))).scalars()),
            )

    async def test_creates_the_first_administrator_and_records_it(
        self, kc_settings: Settings, idp: KeycloakIdp, clean_db: None, arguments: argparse.Namespace
    ) -> None:
        from velydock import cli

        assert await cli.setup_admin(kc_settings, arguments) == 0
        tenants, users, audit = await self.state()
        assert [t.slug for t in tenants] == [arguments.tenant_slug]
        assert [(u.username, u.is_system_admin) for u in users] == [(arguments.username, True)]
        assert await idp.list_organization_members(str(tenants[0].idp_org_id)) == {users[0].idp_id}
        granted = [a for a in audit if a.action == "user.set_system_admin"]
        assert len(granted) == 1 and granted[0].target_label == arguments.username
        assert granted[0].tenant_id is None, "it belongs in the system log"

        # Run again for the same account: access is restored, and that is recorded too.
        assert await cli.setup_admin(kc_settings, arguments) == 0
        _, users, audit = await self.state()
        assert len(users) == 1
        assert len([a for a in audit if a.action == "user.set_system_admin"]) == 2

    async def test_a_failed_first_attempt_does_not_block_the_next_one(
        self,
        kc_settings: Settings,
        idp: KeycloakIdp,
        clean_db: None,
        arguments: argparse.Namespace,
    ) -> None:
        """A failed run used to leave the organization behind in Keycloak while the database
        rolled back - and every later run then failed on the existing organization."""
        from velydock import cli

        # What a half-failed run leaves behind: the organization exists, the tenant does not.
        leftover = await idp.create_organization(name=arguments.tenant_name, alias=arguments.tenant_slug)
        assert await cli.setup_admin(kc_settings, arguments) == 0
        tenants, users, _ = await self.state()
        assert [t.idp_org_id for t in tenants] == [leftover]
        assert [u.username for u in users] == [arguments.username]


class TestInvitationEmail:
    """The link with which a new user sets the first password - sent through a real SMTP server
    (the mail catcher of the development stack) and followed like the recipient would."""

    async def test_the_invited_user_sets_a_password_through_the_link_and_signs_in(
        self, stack: World, idp: KeycloakIdp, http: httpx.AsyncClient, mail: None
    ) -> None:
        from velydock.models import Membership, Tenant

        slug = unique("mailtenant")
        org_id = await idp.create_organization(name=f"Tenant {slug}", alias=slug)
        async with transaction(Scope.SYSTEM) as db:
            tenant = Tenant(slug=slug, name=f"Tenant {slug}", idp_org_id=org_id)
            db.add(tenant)
            await db.flush()
            admin = User(
                idp_id=unique("admin-not-in-keycloak"), username=unique("chef"), home_tenant_id=tenant.id
            )
            db.add(admin)
            await db.flush()
            db.add(Membership(tenant_id=tenant.id, user_id=admin.id, role=Role.TENANT_ADMIN.value))
            await db.flush()
            await db.refresh(admin)

        name = unique("neu")
        address = f"{name}@acme.example"
        async with await stack.login(admin) as client:
            created = await client.post(
                "/api/v1/admin/users",
                json={
                    "username": name,
                    "first_name": "Nora",
                    "last_name": "Neuling",
                    "email": address,
                    "send_email": True,
                },
            )
        assert created.status_code == 201, created.text
        assert created.json()["email_sent"] is True and created.json()["temporary_password"] is None

        text = await received_mail(http, address)
        link = re.search(r"https?://\S+/login-actions/action-token\?\S+", text)
        assert link, text
        # The recipient opens the link: Keycloak names what is about to happen, then asks for
        # the new password.
        browser = Browser(http)
        await browser.follow(await browser.request("GET", link.group(0)), stop_at="https://dock.test")
        assert browser.page_id() == "login-info", browser.page[:800]
        proceed = re.search(r'<a[^>]*href="([^"]+)"', browser.page.split("<main", 1)[-1])
        assert proceed, "the page offers a link to go on"
        target = urljoin(PUBLIC, html.unescape(proceed.group(1)))
        await browser.follow(await browser.request("GET", target), stop_at="https://dock.test")
        assert browser.page_id() == "login-login-update-password", browser.page[:800]
        done = await browser.submit(
            {"password-new": PASSWORD, "password-confirm": PASSWORD}, stop_at="https://dock.test"
        )
        assert done.status_code == 200 and browser.page_id() == "login-info", browser.page[:800]
        # From there a link leads back to Velydock (the address registered for the client).
        assert 'href="https://dock.test/"' in browser.page

        # The password works, and the one-time password of a plain creation was never needed.
        async with stack.client() as client:
            redirect = await sign_in_through_keycloak(stack, Browser(http), client, name)
            assert redirect.status_code == 302, "signed in without any further required action"
            assert redirect.headers["location"].startswith("https://dock.test/api/auth/callback")
            assert (await client.get(redirect.headers["location"])).headers["location"] == "/"
            me = (await client.get("/api/v1/me")).json()
        assert me["user"]["username"] == name and me["user"]["email"] == address


class TestConcurrentChangesAtKeycloak:
    async def test_a_lock_is_never_undone_by_a_change_made_at_the_same_moment(
        self, stack: World, idp: KeycloakIdp, http: httpx.AsyncClient
    ) -> None:
        """Keycloak does not merge two changes to one account that arrive together: the later
        one writes the whole account back, including the "enabled" it read before. A locked-out
        user could keep the account open by saving the own profile in a loop. Velydock therefore
        lets changes to one account take turns."""
        admin = await make_account(stack, idp, http, unique("chef"), Role.TENANT_ADMIN)
        async with await stack.login(admin) as boss, await stack.login(admin) as colleague:
            for attempt in range(5):
                name = unique("race")
                created = await boss.post(
                    "/api/v1/admin/users", json={"username": name, "first_name": "Alt", "last_name": "Alt"}
                )
                assert created.status_code == 201, created.text
                user_id = created.json()["user"]["id"]
                async with transaction(Scope.SYSTEM) as db:
                    target = (await db.execute(select(User).where(User.username == name))).scalar_one()
                async with await stack.login(target) as own:
                    # Many writers around the lock, as a user saving in a loop would produce.
                    writers = [
                        own.patch("/api/v1/me/profile", json={"first_name": f"Selbst{n}", "last_name": "Alt"})
                        for n in range(8)
                    ]
                    writers += [
                        colleague.patch(f"/api/v1/admin/users/{user_id}", json={"last_name": f"Neu{n}"})
                        for n in range(6)
                    ]
                    results = await asyncio.gather(
                        *writers[:7],
                        boss.patch(f"/api/v1/admin/users/{user_id}", json={"active": False}),
                        *writers[7:],
                    )
                assert results[7].status_code == 200, results[7].text
                account = await idp._api.json("GET", f"/users/{target.idp_id}")
                async with transaction(Scope.SYSTEM) as db:
                    row = (await db.execute(select(User).where(User.username == name))).scalar_one()
                assert account["enabled"] is False and row.active is False, (
                    f"attempt {attempt}: the lock was lost"
                )
                assert (account["firstName"], account["lastName"]) == (row.first_name, row.last_name)

    async def test_an_address_typed_by_an_administrator_is_not_asserted_as_verified(
        self, idp: KeycloakIdp
    ) -> None:
        name = unique("mail")
        user_id = await idp.create_user(
            username=name,
            email=f"{name}@acme.example",
            first_name="A",
            last_name="B",
            temporary_password=PASSWORD,
        )
        assert (await idp._api.json("GET", f"/users/{user_id}"))["emailVerified"] is False
        await idp.update_user(user_id, email=f"{name}-2@acme.example")
        account = await idp._api.json("GET", f"/users/{user_id}")
        assert (account["email"], account["emailVerified"]) == (f"{name}-2@acme.example", False)
        await idp.delete_user(user_id)


class TestWhatKeycloakKnows:
    """The periodic question to Keycloak whether an account and its session still stand."""

    async def test_account_and_session_states(
        self, stack: World, idp: KeycloakIdp, http: httpx.AsyncClient, kc_settings: Settings
    ) -> None:
        name = unique("state")
        user = await make_account(stack, idp, http, name, Role.MEMBER)
        browser = Browser(http)
        async with stack.client() as client:
            redirect = await sign_in_through_keycloak(stack, browser, client, name)
            assert (await client.get(redirect.headers["location"])).headers["location"] == "/"
        async with transaction(Scope.SYSTEM) as db:
            from velydock.models import AuthSession

            sid = (await db.execute(select(AuthSession.idp_sid))).scalar_one()
        assert sid, "the sign-in recorded Keycloak's session id"

        assert await idp.account_state(user.idp_id, sid) is AccountState.ACTIVE
        assert await idp.account_state(user.idp_id, "no-such-session") is AccountState.SESSION_ENDED
        # What an operator does in the console, none of which sends a logout notification:
        token = await service_token(kc_settings, http)
        realm_api = f"{INTERNAL}/admin/realms/{kc_settings.keycloak_realm}"
        ended = await http.delete(f"{realm_api}/sessions/{sid}", headers={"Authorization": f"Bearer {token}"})
        assert ended.status_code == 204, ended.text
        assert await idp.account_state(user.idp_id, sid) is AccountState.SESSION_ENDED
        await idp.set_enabled(user.idp_id, False)
        assert await idp.account_state(user.idp_id, sid) is AccountState.DISABLED
        await idp.delete_user(user.idp_id)
        assert await idp.account_state(user.idp_id, sid) is AccountState.DELETED

    async def test_velydock_ends_the_session_of_an_account_disabled_in_keycloak(
        self, stack: World, idp: KeycloakIdp, http: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from velydock.security import sessions

        name = unique("gone")
        user = await make_account(stack, idp, http, name, Role.MEMBER)
        browser = Browser(http)
        async with stack.client() as client:
            redirect = await sign_in_through_keycloak(stack, browser, client, name)
            await client.get(redirect.headers["location"])
            assert (await client.get("/api/v1/me")).status_code == 200
            await idp.set_enabled(user.idp_id, False)  # in Keycloak only; Velydock is not told
            # The next periodic check (here: at once) notices.
            monkeypatch.setattr(sessions, "idp_check_due", lambda session: True)
            assert (await client.get("/api/v1/me")).status_code == 401
        async with transaction(Scope.SYSTEM) as db:
            row = (await db.execute(select(User).where(User.id == user.id))).scalar_one()
        assert row.active is False


class TestRealmHardening:
    async def test_the_password_grant_of_the_built_in_public_client_is_closed(
        self, stack: World, idp: KeycloakIdp, http: httpx.AsyncClient, kc_settings: Settings
    ) -> None:
        """Otherwise anyone could post password guesses straight to the token endpoint - and lock
        any account with a handful of wrong ones."""
        name = unique("grant")
        await make_account(stack, idp, http, name, Role.MEMBER)
        response = await http.post(
            f"{kc_settings.realm_internal_url}/protocol/openid-connect/token",
            data={"grant_type": "password", "client_id": "admin-cli", "username": name, "password": PASSWORD},
        )
        assert response.status_code in (400, 401), response.text
        assert response.json()["error"] in ("unauthorized_client", "invalid_client"), response.text

    async def test_forgot_password_asks_for_the_existing_second_factor(
        self, kc_settings: Settings, http: httpx.AsyncClient
    ) -> None:
        """Keycloak's own flow would let someone with the mailbox enrol a new authenticator."""
        realm = (await admin_get(kc_settings, http, "")).json()
        assert realm["resetCredentialsFlow"] == "velydock reset credentials"
        executions = (
            await admin_get(
                kc_settings, http, "/authentication/flows/velydock%20reset%20credentials/executions"
            )
        ).json()
        steps = [(e.get("providerId"), e.get("requirement")) for e in executions if e.get("providerId")]
        assert ("auth-otp-form", "REQUIRED") in steps
        assert "reset-otp" not in [provider for provider, _ in steps]
        # The step is inside the "only if the user has a second factor" part, after the others.
        assert steps.index(("conditional-user-configured", "REQUIRED")) < steps.index(
            ("auth-otp-form", "REQUIRED")
        )
        # Setting it up again changes nothing.
        await ensure_realm(kc_settings, http)
        again = (
            await admin_get(
                kc_settings, http, "/authentication/flows/velydock%20reset%20credentials/executions"
            )
        ).json()
        assert [(e.get("providerId"), e.get("requirement")) for e in again if e.get("providerId")] == steps

    async def test_a_mailbox_alone_does_not_get_into_an_account_with_a_second_factor(
        self, stack: World, idp: KeycloakIdp, http: httpx.AsyncClient, mail: None
    ) -> None:
        name = unique("otp")
        user = await make_account(stack, idp, http, name, Role.TENANT_ADMIN)
        callback = "https://dock.test/api/auth/callback"
        # The owner enrols an authenticator.
        await idp.require_second_factor_setup(user.idp_id)
        owner = Browser(http)
        async with stack.client() as client:
            await sign_in_through_keycloak(stack, owner, client, name)
            assert owner.page_id() == "login-login-config-totp", owner.page[:600]
            enrolled, _ = await enrol_authenticator(owner, stop_at=callback)
            assert enrolled.status_code == 302
        assert await idp.has_second_factor(user.idp_id) is True

        # Someone who can read the mailbox, without password and without the authenticator.
        intruder = Browser(http)
        async with stack.client() as client:
            start = await client.get("/api/auth/login")
            await intruder.follow(await intruder.request("GET", start.headers["location"]), stop_at=callback)
            await intruder.submit({"username": name}, stop_at=callback)
            forgot = re.search(r'href="([^"]*reset-credentials[^"]*)"', intruder.page)
            assert forgot, "the sign-in page offers 'forgot password' once mail is configured"
            await intruder.follow(
                await intruder.request("GET", urljoin(PUBLIC, html.unescape(forgot.group(1)))),
                stop_at=callback,
            )
            await intruder.submit({"username": name}, stop_at=callback)
            text = await received_mail(http, f"{name}@acme.example")
            link = re.search(r"https?://\S+", text)
            assert link, text
            await intruder.follow(await intruder.request("GET", link.group(0)), stop_at=callback)
            proceed = re.search(r'<a[^>]*href="([^"]+)"', intruder.page.split("<main", 1)[-1])
            if intruder.page_id() == "login-info" and proceed:
                await intruder.follow(
                    await intruder.request("GET", urljoin(PUBLIC, html.unescape(proceed.group(1)))),
                    stop_at=callback,
                )
            # Keycloak now wants the code of the existing authenticator - not a new enrolment,
            # and not yet a new password.
            assert intruder.page_id() == "login-login-otp", (intruder.page_id(), intruder.page[:800])
            assert 'name="totpSecret"' not in intruder.page and 'name="password-new"' not in intruder.page
            assert (await client.get("/api/v1/me")).status_code == 401
        credentials = await idp._api.json("GET", f"/users/{user.idp_id}/credentials")
        assert [c["type"] for c in credentials].count("otp") == 1, "no second authenticator was enrolled"

    async def test_the_instance_name_appears_on_keycloaks_pages_as_it_was_typed(
        self, stack: World, http: httpx.AsyncClient, idp: KeycloakIdp
    ) -> None:
        """Every name Velydock accepts is shown literally in the header of the sign-in page."""

        async def header_of_the_sign_in_page() -> str:
            browser = Browser(http)
            async with stack.client() as client:
                start = await client.get("/api/auth/login")
                await browser.follow(
                    await browser.request("GET", start.headers["location"]),
                    stop_at="https://dock.test/api/auth/callback",
                )
            header = re.search(r'id="kc-header-wrapper"[^>]*>(.*?)</div>', browser.page, re.DOTALL)
            assert header, browser.page[:2000]
            return header.group(1).strip()

        try:
            for name in ('Müller & Söhne "Intranet"', "AT&T R&D - Tom's Dock", "a&b &c; 100% & mehr"):
                assert SystemSettingsUpdate(instance_name=name).instance_name == name
                await idp.set_realm_display_name(name)
                shown = await header_of_the_sign_in_page()
                assert "<" not in shown, shown
                assert html.unescape(shown) == name

            # Why the rule for this name exists (schemas.InstanceName): Keycloak decodes character
            # references before it looks for markup, so an escaped link arrives as a link. Should
            # this assertion ever fail, Keycloak has changed and the rule can be relaxed.
            await idp.set_realm_display_name('<a href="https://elsewhere.example/">Weiter</a>')
            assert '<a href="https://elsewhere.example/"' in await header_of_the_sign_in_page()
            for markup in (
                '<a href="https://elsewhere.example/">Weiter</a>',
                "&lt;b&gt;fett",
                "x &#60;img src=y&#62;",
            ):
                with pytest.raises(ValidationError):
                    SystemSettingsUpdate(instance_name=markup)
        finally:
            await idp.set_realm_display_name("Velydock")

    async def test_a_request_to_enrol_a_second_factor_can_be_taken_back(self, idp: KeycloakIdp) -> None:
        user_id = await idp.create_user(
            username=unique("totp"), email=None, first_name="T", last_name="P", temporary_password=PASSWORD
        )
        await idp.require_second_factor_setup(user_id)
        assert "CONFIGURE_TOTP" in (await idp._api.json("GET", f"/users/{user_id}"))["requiredActions"]
        await idp.withdraw_second_factor_setup(user_id)
        # Only that one: the forced password change of the new account stays.
        assert (await idp._api.json("GET", f"/users/{user_id}"))["requiredActions"] == ["UPDATE_PASSWORD"]
        await idp.withdraw_second_factor_setup(user_id)  # nothing to withdraw is fine
        await idp.delete_user(user_id)

    async def test_the_language_of_keycloaks_pages_and_mails_follows_velydocks_default(
        self, kc_settings: Settings, http: httpx.AsyncClient, idp: KeycloakIdp
    ) -> None:
        await idp.set_default_locale("en")
        assert (await admin_get(kc_settings, http, "")).json()["defaultLocale"] == "en"
        await idp.set_default_locale("de")
        assert (await admin_get(kc_settings, http, "")).json()["defaultLocale"] == "de"

    async def test_a_mail_server_that_cannot_be_reached_is_reported_as_such(self, idp: KeycloakIdp) -> None:
        from velydock.idp.base import IdpMailFailed

        name = unique("nomail")
        user_id = await idp.create_user(
            username=name,
            email=f"{name}@acme.example",
            first_name="A",
            last_name="B",
            temporary_password=PASSWORD,
        )
        await idp.set_smtp(
            SmtpConfig(host="127.0.0.1", port=9, from_address="x@velydock.test", encryption="none")
        )
        try:
            with pytest.raises(IdpMailFailed):
                await idp.send_password_setup_email(user_id)
        finally:
            await idp.set_smtp(SmtpConfig())
            await idp.delete_user(user_id)
