"""OpenID Connect relying party: authorization-code flow with PKCE, ID-token and logout-token validation.

Velydock is a confidential client. Tokens never reach the browser: the code is exchanged here and
only a session cookie is handed out.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt

from velydock.config import Settings

# Asymmetric algorithms only: with a symmetric one, the public key could be abused as the secret.
ALLOWED_ALGORITHMS = [
    "RS256",
    "RS384",
    "RS512",
    "PS256",
    "PS384",
    "PS512",
    "ES256",
    "ES384",
    "ES512",
    "EdDSA",
]
BACKCHANNEL_LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout"
_METADATA_TTL = 600
_JWKS_MIN_REFRESH = 30
_CLOCK_LEEWAY = 30


class OidcError(Exception):
    pass


@dataclass(frozen=True)
class ProviderMetadata:
    issuer: str
    authorization_endpoint: str
    token_endpoint: str
    jwks_uri: str
    end_session_endpoint: str


@dataclass(frozen=True)
class IdTokenClaims:
    sub: str
    sid: str | None
    auth_time: int | None
    username: str
    email: str | None
    first_name: str
    last_name: str
    raw: dict[str, Any] = field(repr=False, default_factory=dict)


@dataclass(frozen=True)
class LogoutClaims:
    sub: str | None
    sid: str | None


def new_pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


class OidcClient:
    def __init__(self, settings: Settings, http: httpx.AsyncClient) -> None:
        self._settings = settings
        self._http = http
        self._metadata: ProviderMetadata | None = None
        self._metadata_at = 0.0
        self._keys: dict[str, Any] = {}
        self._keys_at = 0.0

    async def metadata(self) -> ProviderMetadata:
        if self._metadata and time.monotonic() - self._metadata_at < _METADATA_TTL:
            return self._metadata
        url = f"{self._settings.realm_internal_url}/.well-known/openid-configuration"
        try:
            resp = await self._http.get(url)
            resp.raise_for_status()
            doc = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise OidcError(f"cannot load provider metadata: {exc}") from exc
        if doc.get("issuer") != self._settings.issuer:
            raise OidcError(
                f"issuer mismatch: provider says {doc.get('issuer')!r}, "
                f"configured is {self._settings.issuer!r}"
            )
        try:
            meta = ProviderMetadata(
                issuer=doc["issuer"],
                authorization_endpoint=doc["authorization_endpoint"],
                token_endpoint=doc["token_endpoint"],
                jwks_uri=doc["jwks_uri"],
                end_session_endpoint=doc["end_session_endpoint"],
            )
        except KeyError as exc:
            raise OidcError(f"provider metadata lacks {exc}") from exc
        self._metadata, self._metadata_at = meta, time.monotonic()
        return meta

    async def _signing_key(self, kid: str | None) -> Any:
        if kid is None:
            raise OidcError("token has no key id")
        if kid not in self._keys and time.monotonic() - self._keys_at >= _JWKS_MIN_REFRESH:
            meta = await self.metadata()
            try:
                resp = await self._http.get(meta.jwks_uri)
                resp.raise_for_status()
                jwks = resp.json()
            except (httpx.HTTPError, ValueError) as exc:
                raise OidcError(f"cannot load signing keys: {exc}") from exc
            keys: dict[str, Any] = {}
            for entry in jwks.get("keys", []):
                if entry.get("use", "sig") != "sig" or "kid" not in entry:
                    continue
                try:
                    keys[entry["kid"]] = jwt.PyJWK(entry).key
                except jwt.PyJWTError:
                    continue
            self._keys, self._keys_at = keys, time.monotonic()
        if kid not in self._keys:
            raise OidcError("token signed with an unknown key")
        return self._keys[kid]

    async def authorization_url(
        self, *, state: str, nonce: str, code_challenge: str, redirect_uri: str
    ) -> str:
        meta = await self.metadata()
        query = urlencode(
            {
                "client_id": self._settings.oidc_client_id,
                "response_type": "code",
                "scope": "openid profile email",
                "redirect_uri": redirect_uri,
                "state": state,
                "nonce": nonce,
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
            }
        )
        return f"{meta.authorization_endpoint}?{query}"

    async def exchange_code(self, *, code: str, code_verifier: str, redirect_uri: str) -> str:
        """Trade the authorization code for tokens and return the raw ID token."""
        meta = await self.metadata()
        try:
            resp = await self._http.post(
                meta.token_endpoint,
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": redirect_uri,
                    "code_verifier": code_verifier,
                },
                auth=(self._settings.oidc_client_id, self._settings.oidc_client_secret),
            )
        except httpx.HTTPError as exc:
            raise OidcError(f"token endpoint unreachable: {exc}") from exc
        if resp.status_code != 200:
            raise OidcError(f"code exchange rejected ({resp.status_code})")
        id_token = resp.json().get("id_token")
        if not isinstance(id_token, str):
            raise OidcError("token response has no id_token")
        return id_token

    async def _decode(self, token: str, required: list[str]) -> dict[str, Any]:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError as exc:
            raise OidcError("malformed token") from exc
        if header.get("alg") not in ALLOWED_ALGORITHMS:
            raise OidcError("token uses a disallowed algorithm")
        key = await self._signing_key(header.get("kid"))
        try:
            claims: dict[str, Any] = jwt.decode(
                token,
                key=key,
                algorithms=ALLOWED_ALGORITHMS,
                audience=self._settings.oidc_client_id,
                issuer=self._settings.issuer,
                leeway=_CLOCK_LEEWAY,
                options={"require": required},
            )
        except jwt.PyJWTError as exc:
            raise OidcError(f"token rejected: {exc}") from exc
        aud = claims.get("aud")
        if isinstance(aud, list) and len(aud) > 1 and claims.get("azp") != self._settings.oidc_client_id:
            raise OidcError("token was issued to another party")
        return claims

    async def validate_id_token(self, id_token: str, *, nonce: str) -> IdTokenClaims:
        claims = await self._decode(id_token, ["exp", "iat", "iss", "aud", "sub"])
        if not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
            raise OidcError("nonce mismatch")
        username = claims.get("preferred_username")
        if not isinstance(username, str) or not username:
            raise OidcError("id token has no preferred_username")
        email = claims.get("email")
        auth_time = claims.get("auth_time")
        return IdTokenClaims(
            sub=str(claims["sub"]),
            sid=claims.get("sid") if isinstance(claims.get("sid"), str) else None,
            auth_time=auth_time if isinstance(auth_time, int) else None,
            username=username,
            email=email.strip() if isinstance(email, str) and email.strip() else None,
            first_name=str(claims.get("given_name") or ""),
            last_name=str(claims.get("family_name") or ""),
            raw=claims,
        )

    async def validate_logout_token(self, token: str) -> LogoutClaims:
        """Validate an OIDC Back-Channel Logout token (signature, issuer, audience, event, no nonce)."""
        claims = await self._decode(token, ["exp", "iat", "iss", "aud"])
        events = claims.get("events")
        if not isinstance(events, dict) or BACKCHANNEL_LOGOUT_EVENT not in events:
            raise OidcError("not a logout token")
        if "nonce" in claims:
            raise OidcError("logout token must not carry a nonce")
        sub = claims.get("sub") if isinstance(claims.get("sub"), str) else None
        sid = claims.get("sid") if isinstance(claims.get("sid"), str) else None
        if not sub and not sid:
            raise OidcError("logout token names neither subject nor session")
        return LogoutClaims(sub=sub, sid=sid)

    async def end_session_url(self, *, id_token_hint: str, post_logout_redirect_uri: str) -> str:
        meta = await self.metadata()
        params = {
            "client_id": self._settings.oidc_client_id,
            "post_logout_redirect_uri": post_logout_redirect_uri,
        }
        if id_token_hint:
            params["id_token_hint"] = id_token_hint
        return f"{meta.end_session_endpoint}?{urlencode(params)}"
