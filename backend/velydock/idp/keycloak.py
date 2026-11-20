"""Keycloak implementation of the identity-provider port, plus realm provisioning.

All calls go to Keycloak's Admin REST API over the internal network, authenticated as the
``velydock-admin`` service account of the Velydock realm.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from velydock.config import Settings
from velydock.idp.base import IdpConflict, IdpError, IdpNotFound, IdpUnavailable, SmtpConfig

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
PASSWORD_POLICY = "length(12) and notUsername and notEmail"  # noqa: S105 - a policy, not a password


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
            raise IdpError(f"identity provider rejected the service account ({resp.status_code})")
        if resp.status_code >= 500:
            raise IdpUnavailable(f"identity provider error {resp.status_code}")
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
            raise IdpNotFound(message)
        if resp.status_code == 409:
            lowered = message.lower()
            field = "email" if "email" in lowered else "username" if "username" in lowered else "name"
            raise IdpConflict(field, message)
        if resp.status_code >= 500:
            raise IdpUnavailable(f"identity provider error {resp.status_code}: {message}")
        raise IdpError(f"identity provider rejected the request ({resp.status_code}): {message}")

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
            "emailVerified": bool(email),
            "credentials": [{"type": "password", "value": temporary_password, "temporary": True}],
        }
        if email:
            body["email"] = email
        return _created_id(await self._api.request("POST", "/users", json=body))

    async def update_user(self, idp_id: str, *, email: str | None, first_name: str, last_name: str) -> None:
        current = await self._api.json("GET", f"/users/{idp_id}")
        current["firstName"] = first_name
        current["lastName"] = last_name
        current["emailVerified"] = bool(email)
        if email:
            current["email"] = email
        elif not current.get("email"):
            # Nothing stored, nothing to clear: leave the field out. Keycloak rejects an empty
            # address for members of an organization ("Email not set").
            current.pop("email", None)
        else:
            await self._clear_email(idp_id, current)
            return
        await self._api.request("PUT", f"/users/{idp_id}", json=current)

    async def _clear_email(self, idp_id: str, representation: dict[str, Any]) -> None:
        """Remove a stored e-mail address.

        Keycloak refuses to blank the address of an organization member, although members without
        one are allowed. The memberships are therefore lifted for the moment of the update and
        restored right after – also if the update fails.
        """
        organizations = await self._api.json("GET", f"/organizations/members/{idp_id}/organizations")
        org_ids = [str(org["id"]) for org in organizations]
        for org_id in org_ids:
            await self._api.request("DELETE", f"/organizations/{org_id}/members/{idp_id}", ok=(400, 404))
        try:
            representation["email"] = ""
            await self._api.request("PUT", f"/users/{idp_id}", json=representation)
        finally:
            for org_id in org_ids:
                await self._api.request("POST", f"/organizations/{org_id}/members", json=idp_id, ok=(409,))

    async def set_enabled(self, idp_id: str, enabled: bool) -> None:
        current = await self._api.json("GET", f"/users/{idp_id}")
        current["enabled"] = enabled
        await self._api.request("PUT", f"/users/{idp_id}", json=current)

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

    async def has_second_factor(self, idp_id: str) -> bool:
        credentials = await self._api.json("GET", f"/users/{idp_id}/credentials")
        return any(c.get("type") in ("otp", "webauthn", "webauthn-passwordless") for c in credentials)

    async def require_second_factor_setup(self, idp_id: str) -> None:
        current = await self._api.json("GET", f"/users/{idp_id}")
        actions = set(current.get("requiredActions") or [])
        if "CONFIGURE_TOTP" in actions:
            return
        current["requiredActions"] = sorted(actions | {"CONFIGURE_TOTP"})
        await self._api.request("PUT", f"/users/{idp_id}", json=current)

    async def send_password_setup_email(self, idp_id: str) -> None:
        await self._api.request(
            "PUT",
            f"/users/{idp_id}/execute-actions-email",
            params={
                "lifespan": 3 * 24 * 3600,
                "client_id": self._settings.oidc_client_id,
                "redirect_uri": f"{self._settings.public_url}/",
            },
            json=["UPDATE_PASSWORD"],
        )

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
        await self._api.request("DELETE", f"/organizations/{org_id}/members/{idp_id}", ok=(400, 404))

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
        await self._api.request("PUT", "", json={"displayName": name})

    async def ping(self) -> None:
        await self._api.request("GET", "")


# ---------------------------------------------------------------------------------------------
# Realm provisioning
# ---------------------------------------------------------------------------------------------


def realm_settings(settings: Settings) -> dict[str, Any]:
    """Realm options Velydock owns and re-applies on every start."""
    return {
        "enabled": True,
        "organizationsEnabled": True,
        "loginTheme": "velydock",
        "internationalizationEnabled": True,
        "supportedLocales": ["de", "en"],
        "registrationAllowed": False,
        "loginWithEmailAllowed": True,
        "duplicateEmailsAllowed": False,
        "editUsernameAllowed": False,
        "rememberMe": False,
        "bruteForceProtected": True,
        "failureFactor": 8,
        "passwordPolicy": PASSWORD_POLICY,
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
                "POST", "", json={"realm": realm, "displayName": "Velydock", **realm_settings(settings)}
            )
        bootstrap_api = _AdminApi(http, realm_api, master_tokens)
        client_uuid = await _upsert_client(bootstrap_api, admin_client(settings))
        await _grant_service_account(bootstrap_api, client_uuid)
        service_tokens.invalidate()

    await api.request("PUT", "", json=realm_settings(settings))
    await _upsert_client(api, web_client(settings))
    await _configure_user_profile(api)
    log.info("Keycloak realm %s is configured", realm)


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
