"""Keycloak implementation of the identity-provider port, plus realm provisioning.

All calls go to Keycloak's Admin REST API over the internal network, authenticated as the
``velydock-admin`` service account of the Velydock realm.
"""

from __future__ import annotations

import html
import logging
import time
from typing import Any
from urllib.parse import quote

import httpx

from velydock.config import Settings
from velydock.idp.base import (
    KEEP,
    AccountState,
    IdpConflict,
    IdpError,
    IdpInvalid,
    IdpMailFailed,
    IdpManaged,
    IdpNotFound,
    IdpUnavailable,
    Keep,
    SmtpConfig,
)

log = logging.getLogger(__name__)

# Realm-management roles of the service account. Deliberately without impersonation and
# identity-provider management.
SERVICE_ACCOUNT_ROLES = [
    "manage-users",
    "view-users",
    "query-users",
    "query-groups",
    "manage-realm",
    "view-realm",
    "manage-clients",
    "view-clients",
    "manage-organizations",
    "view-organizations",
    "query-organizations",
]
# Since Keycloak 26.8 the Admin API only accepts tokens that carry its own audience; this
# built-in client scope adds it.
ADMIN_API_SCOPE = "kc-admin-api"
# passwordHistory: the new password must differ from the last ones - in particular from the
# one-time password an administrator handed out and therefore still knows.
PASSWORD_POLICY = "length(12) and notUsername and notEmail and passwordHistory(3)"  # noqa: S105 - a policy
# What earlier versions of Velydock set. A realm that still has exactly one of these was never
# touched by its operator and moves on to the current policy; any other policy is theirs.
EARLIER_PASSWORD_POLICIES = ("length(12) and notUsername and notEmail",)


class _TokenSource:
    """Client-credentials tokens, cached until shortly before they expire."""

    def __init__(self, http: httpx.AsyncClient, token_url: str, client_id: str, client_secret: str) -> None:
        self._http = http
        self._url = token_url
        self._auth = (client_id, client_secret)
        self._token = ""
        self._expires = 0.0

    async def get(self) -> str:
        if self._token and time.monotonic() < self._expires:
            return self._token
        try:
            resp = await self._http.post(
                self._url, data={"grant_type": "client_credentials"}, auth=self._auth
            )
        except httpx.HTTPError as exc:
            raise IdpUnavailable(f"identity provider unreachable: {exc}") from exc
        if resp.status_code in (400, 401, 404):
            raise IdpError(
                f"identity provider rejected the service account ({resp.status_code})",
                status=resp.status_code,
            )
        if resp.status_code >= 500:
            raise IdpUnavailable(f"identity provider error {resp.status_code}", status=resp.status_code)
        data = resp.json()
        self._token = str(data["access_token"])
        self._expires = time.monotonic() + max(int(data.get("expires_in", 60)) - 20, 5)
        return self._token

    def invalidate(self) -> None:
        self._token = ""


class _AdminApi:
    def __init__(self, http: httpx.AsyncClient, base_url: str, tokens: _TokenSource) -> None:
        self._http = http
        self._base = base_url
        self._tokens = tokens

    async def request(
        self, method: str, path: str, *, ok: tuple[int, ...] = (), **kwargs: Any
    ) -> httpx.Response:
        for attempt in (1, 2):
            token = await self._tokens.get()
            try:
                resp = await self._http.request(
                    method, f"{self._base}{path}", headers={"Authorization": f"Bearer {token}"}, **kwargs
                )
            except httpx.HTTPError as exc:
                raise IdpUnavailable(f"identity provider unreachable: {exc}") from exc
            if resp.status_code == 401 and attempt == 1:
                self._tokens.invalidate()
                continue
            break
        if resp.status_code in ok or resp.is_success:
            return resp
        message = _error_message(resp)
        if resp.status_code == 404:
            raise IdpNotFound(message, status=404)
        if resp.status_code == 409:
            lowered = message.lower()
            field = "email" if "email" in lowered else "username" if "username" in lowered else "name"
            raise IdpConflict(field, message)
        if resp.status_code >= 500:
            raise IdpUnavailable(
                f"identity provider error {resp.status_code}: {message}", status=resp.status_code
            )
        refused = _invalid_field(resp)
        if refused:
            raise IdpInvalid(refused, f"identity provider refused {refused}: {message}")
        raise IdpError(
            f"identity provider rejected the request ({resp.status_code}): {message}",
            status=resp.status_code,
        )

    async def json(self, method: str, path: str, **kwargs: Any) -> Any:
        return (await self.request(method, path, **kwargs)).json()


def _error_message(resp: httpx.Response) -> str:
    try:
        data = resp.json()
    except ValueError:
        return resp.text[:200]
    if isinstance(data, dict):
        return str(data.get("errorMessage") or data.get("error_description") or data.get("error") or data)[
            :300
        ]
    return str(data)[:300]


# Keycloak's user-profile validation names the attribute it refused.
_PROFILE_FIELDS = {
    "username": "username",
    "email": "email",
    "firstName": "first_name",
    "lastName": "last_name",
}


def _invalid_field(resp: httpx.Response) -> str | None:
    if resp.status_code != 400:
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    # One refused attribute comes as {"field": …}, several as {"errors": [{"field": …}, …]}.
    several = data.get("errors")
    problems: list[Any] = several if isinstance(several, list) else [data]
    for problem in problems:
        if isinstance(problem, dict) and str(problem.get("field", "")) in _PROFILE_FIELDS:
            return _PROFILE_FIELDS[str(problem["field"])]
    return None


def _created_id(resp: httpx.Response) -> str:
    location = str(resp.headers.get("location", ""))
    created = location.rstrip("/").rsplit("/", 1)[-1]
    if not created:
        raise IdpError("identity provider did not return the id of the created object")
    return created


class KeycloakIdp:
    def __init__(self, settings: Settings, http: httpx.AsyncClient) -> None:
        self._settings = settings
        tokens = _TokenSource(
            http,
            f"{settings.realm_internal_url}/protocol/openid-connect/token",
            settings.idp_admin_client_id,
            settings.idp_admin_client_secret,
        )
        self._api = _AdminApi(
            http, f"{settings.keycloak_internal_url}/admin/realms/{settings.keycloak_realm}", tokens
        )

    # -- users ---------------------------------------------------------------------------------

    async def create_user(
        self, *, username: str, email: str | None, first_name: str, last_name: str, temporary_password: str
    ) -> str:
        body: dict[str, Any] = {
            "username": username,
            "firstName": first_name,
            "lastName": last_name,
            "enabled": True,
            # Nobody has checked that the address belongs to this person; an administrator typed
            # it. Connected apps read this flag, and some link accounts by a verified address.
            # Keycloak sets it once the user has followed a link sent to the address.
            "emailVerified": False,
            "credentials": [{"type": "password", "value": temporary_password, "temporary": True}],
        }
        if email:
            body["email"] = email
        return _created_id(await self._api.request("POST", "/users", json=body))

    async def update_user(
        self,
        idp_id: str,
        *,
        email: str | Keep | None = KEEP,
        first_name: str | Keep = KEEP,
        last_name: str | Keep = KEEP,
    ) -> None:
        # Only the named fields are sent. Keycloak leaves the rest alone, so a change made at
        # the same moment (locking the account) or directly in Keycloak (another field) is not
        # overwritten with what was read a moment ago.
        changes: dict[str, Any] = {}
        if first_name is not KEEP:
            changes["firstName"] = first_name
        if last_name is not KEEP:
            changes["lastName"] = last_name
        if email is KEEP:
            pass
        elif email:
            changes["email"] = email
            changes["emailVerified"] = False
        else:
            current = await self._api.json("GET", f"/users/{idp_id}")
            if current.get("email"):
                await self._clear_email(idp_id, changes)
                return
            # Nothing stored, nothing to clear.
        if changes:
            await self._api.request("PUT", f"/users/{idp_id}", json=changes)

    async def _clear_email(self, idp_id: str, changes: dict[str, Any]) -> None:
        """Remove a stored e-mail address.

        Keycloak refuses to blank the address of an organization member, although members without
        one are allowed. The memberships are therefore lifted for the moment of the update and
        restored right after – also if the update fails. A membership Keycloak manages itself
        cannot be lifted (that would delete the account), so such an address stays.
        """
        organizations = await self._api.json("GET", f"/organizations/members/{idp_id}/organizations")
        org_ids = [str(org["id"]) for org in organizations]
        for org_id in org_ids:
            await self._refuse_managed(org_id, idp_id)
        for org_id in org_ids:
            await self._api.request("DELETE", f"/organizations/{org_id}/members/{idp_id}", ok=(400, 404))
        try:
            await self._api.request(
                "PUT", f"/users/{idp_id}", json={**changes, "email": "", "emailVerified": False}
            )
        finally:
            for org_id in org_ids:
                await self._api.request("POST", f"/organizations/{org_id}/members", json=idp_id, ok=(409,))

    async def set_enabled(self, idp_id: str, enabled: bool) -> None:
        await self._api.request("PUT", f"/users/{idp_id}", json={"enabled": enabled})

    async def set_temporary_password(self, idp_id: str, password: str) -> None:
        await self._api.request(
            "PUT",
            f"/users/{idp_id}/reset-password",
            json={"type": "password", "value": password, "temporary": True},
        )

    async def logout_user(self, idp_id: str) -> None:
        await self._api.request("POST", f"/users/{idp_id}/logout", ok=(404,))

    async def delete_user(self, idp_id: str) -> None:
        await self._api.request("DELETE", f"/users/{idp_id}", ok=(404,))

    async def account_state(self, idp_id: str, sid: str | None) -> AccountState:
        # A short timeout: this runs inside ordinary requests, which must not hang on it.
        account = await self._api.request("GET", f"/users/{idp_id}", ok=(404,), timeout=4.0)
        if account.status_code == 404:
            return AccountState.DELETED
        if not account.json().get("enabled", True):
            return AccountState.DISABLED
        if sid:
            sessions = await self._api.json("GET", f"/users/{idp_id}/sessions", timeout=4.0)
            if sid not in {str(session.get("id")) for session in sessions}:
                return AccountState.SESSION_ENDED
        return AccountState.ACTIVE

    async def has_second_factor(self, idp_id: str) -> bool:
        # Only what the sign-in really asks for counts. A registered security key would satisfy
        # the rule on paper while the realm's sign-in never requests it.
        credentials = await self._api.json("GET", f"/users/{idp_id}/credentials")
        return any(c.get("type") == "otp" for c in credentials)

    async def require_second_factor_setup(self, idp_id: str) -> None:
        current = await self._api.json("GET", f"/users/{idp_id}")
        actions = set(current.get("requiredActions") or [])
        if "CONFIGURE_TOTP" in actions:
            return
        await self._api.request(
            "PUT", f"/users/{idp_id}", json={"requiredActions": sorted(actions | {"CONFIGURE_TOTP"})}
        )

    async def withdraw_second_factor_setup(self, idp_id: str) -> None:
        current = await self._api.json("GET", f"/users/{idp_id}")
        actions = set(current.get("requiredActions") or [])
        if "CONFIGURE_TOTP" in actions:
            await self._api.request(
                "PUT", f"/users/{idp_id}", json={"requiredActions": sorted(actions - {"CONFIGURE_TOTP"})}
            )

    async def send_password_setup_email(self, idp_id: str) -> None:
        try:
            await self._api.request(
                "PUT",
                f"/users/{idp_id}/execute-actions-email",
                # No redirect_uri: Keycloak only accepts registered ones, and the only registered
                # address is the OIDC callback. With the client alone, the page after setting the
                # password links back to Velydock (the client's base address).
                params={"lifespan": 3 * 24 * 3600, "client_id": self._settings.oidc_client_id},
                json=["UPDATE_PASSWORD"],
            )
        except IdpUnavailable as exc:
            if exc.status is None:
                raise  # Keycloak itself did not answer
            # Keycloak answered: it could not hand the e-mail to the mail server.
            raise IdpMailFailed(str(exc), status=exc.status) from exc

    # -- organizations (one per tenant) ----------------------------------------------------------

    async def create_organization(self, *, name: str, alias: str) -> str:
        resp = await self._api.request(
            "POST", "/organizations", json={"name": name, "alias": alias, "enabled": True}
        )
        return _created_id(resp)

    async def update_organization(self, org_id: str, *, name: str, enabled: bool) -> None:
        current = await self._api.json("GET", f"/organizations/{org_id}")
        current["name"] = name
        current["enabled"] = enabled
        await self._api.request("PUT", f"/organizations/{org_id}", json=current)

    async def delete_organization(self, org_id: str) -> None:
        await self._api.request("DELETE", f"/organizations/{org_id}", ok=(404,))

    async def add_organization_member(self, org_id: str, idp_id: str) -> None:
        # The body is the bare user id as a JSON string; 409 means "already a member".
        await self._api.request("POST", f"/organizations/{org_id}/members", json=idp_id, ok=(409,))

    async def remove_organization_member(self, org_id: str, idp_id: str) -> None:
        await self._refuse_managed(org_id, idp_id)
        await self._api.request("DELETE", f"/organizations/{org_id}/members/{idp_id}", ok=(400, 404))

    async def _refuse_managed(self, org_id: str, idp_id: str) -> None:
        """Keycloak deletes the *account* when a member it manages itself leaves the organization."""
        member = await self._api.request("GET", f"/organizations/{org_id}/members/{idp_id}", ok=(400, 404))
        if member.status_code == 200 and member.json().get("membershipType") == "MANAGED":
            raise IdpManaged(
                "Keycloak manages this membership itself (identity provider or invitation of the "
                "organization); removing it would delete the account."
            )

    async def find_organization(self, alias: str) -> str | None:
        # Keycloak can only search organizations by name or domain, so page through them all;
        # there is one per tenant.
        first = 0
        while True:
            page = await self._api.json("GET", "/organizations", params={"first": first, "max": 100})
            for org in page:
                if org.get("alias") == alias:
                    return str(org["id"])
            if len(page) < 100:
                return None
            first += 100

    async def list_organization_members(self, org_id: str) -> set[str]:
        members: set[str] = set()
        first = 0
        while True:
            page = await self._api.json(
                "GET", f"/organizations/{org_id}/members", params={"first": first, "max": 200}
            )
            members.update(str(m["id"]) for m in page)
            if len(page) < 200:
                return members
            first += 200

    async def find_user_id(self, username: str) -> str | None:
        users = await self._api.json("GET", "/users", params={"username": username, "exact": "true"})
        return str(users[0]["id"]) if users else None

    # -- realm settings --------------------------------------------------------------------------

    async def get_smtp(self) -> SmtpConfig:
        realm = await self._api.json("GET", "")
        smtp = realm.get("smtpServer") or {}
        encryption = (
            "ssl" if smtp.get("ssl") == "true" else "starttls" if smtp.get("starttls") == "true" else "none"
        )
        return SmtpConfig(
            host=smtp.get("host", ""),
            port=int(smtp.get("port") or 587),
            from_address=smtp.get("from", ""),
            from_name=smtp.get("fromDisplayName", ""),
            username=smtp.get("user", ""),
            password="",
            encryption=encryption,
        )

    async def set_smtp(self, config: SmtpConfig) -> None:
        realm = await self._api.json("GET", "")
        previous = realm.get("smtpServer") or {}
        smtp: dict[str, str] = {}
        if config.configured:
            smtp = {
                "host": config.host,
                "port": str(config.port),
                "from": config.from_address,
                "fromDisplayName": config.from_name,
                "ssl": "true" if config.encryption == "ssl" else "false",
                "starttls": "true" if config.encryption == "starttls" else "false",
                "auth": "true" if config.username else "false",
            }
            if config.username:
                smtp["user"] = config.username
                # Keycloak masks the stored password as "**********"; sending the mask back keeps it.
                smtp["password"] = config.password or previous.get("password", "")
        await self._api.request("PUT", "", json={"smtpServer": smtp, "resetPasswordAllowed": bool(smtp)})

    async def set_realm_display_name(self, name: str) -> None:
        # Keycloak's pages print the HTML variant through a sanitizer that decodes character
        # references before it looks for markup. Escaping keeps the stored value well-formed,
        # but it does not keep markup out: that is the job of the rule for this name
        # (schemas.InstanceName), which refuses anything that could be read as markup.
        await self._api.request("PUT", "", json={"displayName": name, "displayNameHtml": html.escape(name)})

    async def set_default_locale(self, language: str) -> None:
        await self._api.request("PUT", "", json={"defaultLocale": language})

    async def ping(self) -> None:
        await self._api.request("GET", "")


# ---------------------------------------------------------------------------------------------
# Realm provisioning
# ---------------------------------------------------------------------------------------------


def realm_defaults() -> dict[str, Any]:
    """Starting values, set once when the realm is created.

    Operators may tighten them in Keycloak; they are not touched again, or every restart would
    silently weaken what the operator chose.
    """
    return {"failureFactor": 8, "passwordPolicy": PASSWORD_POLICY}


def realm_settings(settings: Settings) -> dict[str, Any]:
    """Realm options Velydock depends on and re-applies on every start."""
    return {
        "enabled": True,
        "organizationsEnabled": True,
        "loginTheme": "velydock",
        "emailTheme": "velydock",
        "internationalizationEnabled": True,
        "supportedLocales": ["de", "en"],
        "registrationAllowed": False,
        "loginWithEmailAllowed": True,
        "duplicateEmailsAllowed": False,
        "editUsernameAllowed": False,
        "rememberMe": False,
        "bruteForceProtected": True,
        # Keep the single-sign-on session alive as long as a Velydock session can last, so apps
        # opened later in the day still sign in silently.
        "ssoSessionIdleTimeout": settings.session_max_hours * 3600,
        "ssoSessionMaxLifespan": settings.session_max_hours * 3600,
        "eventsEnabled": True,
        "eventsExpiration": 30 * 24 * 3600,
    }


def web_client(settings: Settings) -> dict[str, Any]:
    return {
        "clientId": settings.oidc_client_id,
        "name": "Velydock",
        "enabled": True,
        "publicClient": False,
        "secret": settings.oidc_client_secret,
        "standardFlowEnabled": True,
        "implicitFlowEnabled": False,
        "directAccessGrantsEnabled": False,
        "serviceAccountsEnabled": False,
        "frontchannelLogout": False,
        "fullScopeAllowed": False,
        "rootUrl": settings.public_url,
        "baseUrl": "/",
        "redirectUris": [f"{settings.public_url}/api/auth/callback"],
        "webOrigins": [],
        "attributes": {
            "pkce.code.challenge.method": "S256",
            "backchannel.logout.url": f"{settings.backchannel_base_url}/api/auth/backchannel-logout",
            "backchannel.logout.session.required": "true",
            "post.logout.redirect.uris": f"{settings.public_url}/*",
        },
    }


def admin_client(settings: Settings) -> dict[str, Any]:
    return {
        "clientId": settings.idp_admin_client_id,
        "name": "Velydock backend (service account)",
        "enabled": True,
        "publicClient": False,
        "secret": settings.idp_admin_client_secret,
        "standardFlowEnabled": False,
        "implicitFlowEnabled": False,
        "directAccessGrantsEnabled": False,
        "serviceAccountsEnabled": True,
        "fullScopeAllowed": False,
    }


async def _upsert_client(api: _AdminApi, representation: dict[str, Any]) -> str:
    found = await api.json("GET", "/clients", params={"clientId": representation["clientId"]})
    if found:
        client_id = str(found[0]["id"])
        await api.request("PUT", f"/clients/{client_id}", json={**found[0], **representation})
        return client_id
    return _created_id(await api.request("POST", "/clients", json=representation))


async def _configure_user_profile(api: _AdminApi) -> None:
    """E-mail is optional (accounts without a mailbox exist) and only admins may change it.

    A self-service e-mail change would let a user claim someone else's address, which connected
    apps often use to link accounts.
    """
    profile = await api.json("GET", "/users/profile")
    changed = False
    for attribute in profile.get("attributes", []):
        if attribute.get("name") != "email":
            continue
        if "required" in attribute:
            del attribute["required"]
            changed = True
        permissions = attribute.setdefault("permissions", {})
        if permissions.get("edit") != ["admin"]:
            permissions["edit"] = ["admin"]
            permissions["view"] = ["admin", "user"]
            changed = True
    if changed:
        await api.request("PUT", "/users/profile", json=profile)


async def _close_password_grant(api: _AdminApi) -> None:
    """Switch off the password grant of the built-in ``admin-cli`` client of this realm.

    It is a public client: anyone on the internet could post user name and password guesses
    straight to the token endpoint - without the sign-in page, and enough wrong ones lock the
    account for a while (brute-force protection). Velydock and its users never need that grant.
    """
    found = await api.json("GET", "/clients", params={"clientId": "admin-cli"})
    if found and found[0].get("directAccessGrantsEnabled"):
        await api.request(
            "PUT", f"/clients/{found[0]['id']}", json={**found[0], "directAccessGrantsEnabled": False}
        )


RESET_FLOW = "velydock reset credentials"


async def _ensure_reset_flow(api: _AdminApi) -> None:
    """Make "forgot password" no way around an enrolled second factor.

    Keycloak's own flow lets someone who can read the mailbox set a new password *and* enrol a
    new authenticator, without ever being asked for the existing one. Velydock's copy of the flow
    asks for the existing second factor instead (accounts without one are not affected).
    """
    flows = await api.json("GET", "/authentication/flows")
    if not any(flow.get("alias") == RESET_FLOW for flow in flows):
        await api.request(
            "POST", "/authentication/flows/reset%20credentials/copy", json={"newName": RESET_FLOW}
        )
    path = f"/authentication/flows/{quote(RESET_FLOW)}/executions"
    executions = await api.json("GET", path)
    for index, execution in enumerate(executions):
        if execution.get("providerId") != "reset-otp":
            continue
        # The step sits in a conditional sub-flow ("only if the user has a second factor").
        parent = next(
            (
                e
                for e in reversed(executions[:index])
                if e.get("authenticationFlow") and e.get("level", 0) < execution.get("level", 0)
            ),
            None,
        )
        if parent is None:
            log.warning("unexpected shape of Keycloak's reset-credentials flow; left as it is")
            break
        await api.request("DELETE", f"/authentication/executions/{execution['id']}")
        await api.request(
            "POST",
            f"/authentication/flows/{quote(str(parent['displayName']))}/executions/execution",
            json={"provider": "auth-otp-form"},
        )
        added = next(e for e in await api.json("GET", path) if e.get("providerId") == "auth-otp-form")
        await api.request("PUT", path, json={**added, "requirement": "REQUIRED"})
        break
    await api.request("PUT", "", json={"resetCredentialsFlow": RESET_FLOW})


async def _grant_service_account(api: _AdminApi, client_uuid: str) -> None:
    management = await api.json("GET", "/clients", params={"clientId": "realm-management"})
    management_id = management[0]["id"]
    roles = [
        await api.json("GET", f"/clients/{management_id}/roles/{name}") for name in SERVICE_ACCOUNT_ROLES
    ]
    account = await api.json("GET", f"/clients/{client_uuid}/service-account-user")
    await api.request("POST", f"/users/{account['id']}/role-mappings/clients/{management_id}", json=roles)
    # fullScopeAllowed is off, so the roles must also be in the client's scope to reach the token.
    await api.request("POST", f"/clients/{client_uuid}/scope-mappings/clients/{management_id}", json=roles)
    scopes = await api.json("GET", "/client-scopes")
    scope_id = next((s["id"] for s in scopes if s["name"] == ADMIN_API_SCOPE), None)
    if scope_id:
        await api.request("PUT", f"/clients/{client_uuid}/default-client-scopes/{scope_id}")
    else:
        log.warning("Keycloak has no %s client scope; Admin API calls may be rejected", ADMIN_API_SCOPE)


async def ensure_realm(settings: Settings, http: httpx.AsyncClient) -> None:
    """Create or update the Velydock realm, its two clients and the realm options. Idempotent.

    Uses the service account when it already works. Otherwise – on first start – falls back to
    the bootstrap credentials of the Keycloak ``master`` realm.
    """
    realm = settings.keycloak_realm
    realm_api = f"{settings.keycloak_internal_url}/admin/realms/{realm}"

    service_tokens = _TokenSource(
        http,
        f"{settings.realm_internal_url}/protocol/openid-connect/token",
        settings.idp_admin_client_id,
        settings.idp_admin_client_secret,
    )
    api = _AdminApi(http, realm_api, service_tokens)
    try:
        await api.request("GET", "")
        service_account_works = True
    except IdpUnavailable:
        raise
    except IdpError:
        service_account_works = False

    if not service_account_works:
        if not (settings.idp_bootstrap_client_id and settings.idp_bootstrap_client_secret):
            raise IdpError(
                "The Velydock realm is not set up and no bootstrap credentials are configured "
                "(VELYDOCK_IDP_BOOTSTRAP_CLIENT_ID / VELYDOCK_IDP_BOOTSTRAP_CLIENT_SECRET)."
            )
        master_tokens = _TokenSource(
            http,
            f"{settings.keycloak_internal_url}/realms/master/protocol/openid-connect/token",
            settings.idp_bootstrap_client_id,
            settings.idp_bootstrap_client_secret,
        )
        master = _AdminApi(http, f"{settings.keycloak_internal_url}/admin/realms", master_tokens)
        resp = await master.request("GET", f"/{realm}", ok=(404,))
        if resp.status_code == 404:
            log.info("creating Keycloak realm %s", realm)
            await master.request(
                "POST",
                "",
                json={
                    "realm": realm,
                    "displayName": "Velydock",
                    "displayNameHtml": "Velydock",
                    **realm_defaults(),
                    **realm_settings(settings),
                },
            )
        bootstrap_api = _AdminApi(http, realm_api, master_tokens)
        client_uuid = await _upsert_client(bootstrap_api, admin_client(settings))
        await _grant_service_account(bootstrap_api, client_uuid)
        service_tokens.invalidate()

    await api.request("PUT", "", json=realm_settings(settings))
    await _move_on_from_an_earlier_password_policy(api)
    await _upsert_client(api, web_client(settings))
    await _configure_user_profile(api)
    await _ensure_reset_flow(api)
    await _close_password_grant(api)
    log.info("Keycloak realm %s is configured", realm)


async def _move_on_from_an_earlier_password_policy(api: _AdminApi) -> None:
    """The password policy is the operator's to change, so it is only set when the realm is
    created - with one exception: a policy that still is an earlier default of Velydock's."""
    realm = await api.json("GET", "")
    if realm.get("passwordPolicy") in EARLIER_PASSWORD_POLICIES:
        await api.request("PUT", "", json={"passwordPolicy": PASSWORD_POLICY})
        log.info("password policy of the realm brought up to date: %s", PASSWORD_POLICY)


async def set_console_access(
    settings: Settings, http: httpx.AsyncClient, username: str, *, grant: bool
) -> None:
    """Allow (or forbid) a user of the Velydock realm to use Keycloak's own administration console.

    Grants the ``realm-admin`` role of the realm. Keycloak only lets an administrator hand out
    roles they hold themselves, so this goes through the bootstrap account of the ``master``
    realm rather than Velydock's narrower service account.
    """
    if not (settings.idp_bootstrap_client_id and settings.idp_bootstrap_client_secret):
        raise IdpError(
            "Bootstrap credentials are not configured "
            "(VELYDOCK_IDP_BOOTSTRAP_CLIENT_ID / VELYDOCK_IDP_BOOTSTRAP_CLIENT_SECRET)."
        )
    tokens = _TokenSource(
        http,
        f"{settings.keycloak_internal_url}/realms/master/protocol/openid-connect/token",
        settings.idp_bootstrap_client_id,
        settings.idp_bootstrap_client_secret,
    )
    api = _AdminApi(http, f"{settings.keycloak_internal_url}/admin/realms/{settings.keycloak_realm}", tokens)
    found = await api.json("GET", "/users", params={"username": username, "exact": "true"})
    if not found:
        raise IdpNotFound(f"There is no user {username!r}. Create the account in Velydock first.")
    user_id = found[0]["id"]
    management = (await api.json("GET", "/clients", params={"clientId": "realm-management"}))[0]["id"]
    role = await api.json("GET", f"/clients/{management}/roles/realm-admin")
    await api.request(
        "POST" if grant else "DELETE", f"/users/{user_id}/role-mappings/clients/{management}", json=[role]
    )
