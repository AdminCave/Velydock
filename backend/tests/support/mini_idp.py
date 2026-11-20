"""A tiny OpenID Connect provider for tests.

It answers the three endpoints Velydock's relying party calls (discovery, JWKS, token) through an
httpx mock transport and signs real RS256 tokens, so the production validation code runs
unchanged. ``authorize`` plays the part of the browser round-trip to the login page.
"""

from __future__ import annotations

import base64
import functools
import hashlib
import json
import secrets
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from velydock.config import Settings
from velydock.security.oidc import BACKCHANNEL_LOGOUT_EVENT


@functools.cache
def _shared_key() -> rsa.RSAPrivateKey:
    # Generating an RSA key takes a moment; one per test run is enough.
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@dataclass
class Identity:
    sub: str
    username: str
    email: str | None = None
    first_name: str = ""
    last_name: str = ""


@dataclass
class MiniIdp:
    settings: Settings
    kid: str = "test-key-1"
    key: rsa.RSAPrivateKey = field(default_factory=_shared_key)
    codes: dict[str, dict[str, Any]] = field(default_factory=dict)
    token_requests: int = 0
    # Knobs for negative tests.
    issuer_override: str | None = None
    serve_keys: bool = True

    @property
    def issuer(self) -> str:
        return self.issuer_override or self.settings.issuer

    # -- token construction ----------------------------------------------------------------------

    def jwk(self) -> dict[str, Any]:
        data = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key()))
        data.update(kid=self.kid, use="sig", alg="RS256")
        return data  # type: ignore[no-any-return]

    def sign(
        self, claims: dict[str, Any], *, key: Any = None, algorithm: str = "RS256", kid: str | None = None
    ) -> str:
        return jwt.encode(claims, key or self.key, algorithm=algorithm, headers={"kid": kid or self.kid})

    def id_token_claims(
        self, identity: Identity, *, nonce: str, sid: str = "sid-1", **overrides: Any
    ) -> dict[str, Any]:
        now = int(time.time())
        claims: dict[str, Any] = {
            "iss": self.issuer,
            "aud": self.settings.oidc_client_id,
            "sub": identity.sub,
            "iat": now,
            "exp": now + 300,
            "auth_time": now,
            "nonce": nonce,
            "sid": sid,
            "preferred_username": identity.username,
            "given_name": identity.first_name,
            "family_name": identity.last_name,
        }
        if identity.email:
            claims["email"] = identity.email
        claims.update(overrides)
        return {k: v for k, v in claims.items() if v is not None}

    def logout_token(self, *, sub: str | None = None, sid: str | None = None, **overrides: Any) -> str:
        now = int(time.time())
        claims: dict[str, Any] = {
            "iss": self.issuer,
            "aud": self.settings.oidc_client_id,
            "iat": now,
            "exp": now + 120,
            "jti": secrets.token_hex(8),
            "events": {BACKCHANNEL_LOGOUT_EVENT: {}},
            "sub": sub,
            "sid": sid,
        }
        claims.update(overrides)
        return self.sign({k: v for k, v in claims.items() if v is not None})

    # -- the "browser" part ----------------------------------------------------------------------

    def authorize(
        self, authorization_url: str, identity: Identity, *, sid: str = "sid-1", **claim_overrides: Any
    ) -> str:
        """Simulate a successful sign-in and return the callback URL the browser is sent to."""
        query = {k: v[0] for k, v in parse_qs(urlsplit(authorization_url).query).items()}
        assert query["response_type"] == "code"
        assert query["code_challenge_method"] == "S256"
        code = secrets.token_urlsafe(16)
        nonce = claim_overrides.pop("nonce", query["nonce"])
        self.codes[code] = {
            "challenge": query["code_challenge"],
            "redirect_uri": query["redirect_uri"],
            "claims": self.id_token_claims(identity, nonce=nonce, sid=sid, **claim_overrides),
        }
        return f"{query['redirect_uri']}?{urlencode({'code': code, 'state': query['state']})}"

    # -- the endpoints Velydock's backend calls --------------------------------------------------

    def _handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        base = self.settings.realm_internal_url
        if path.endswith("/.well-known/openid-configuration"):
            return httpx.Response(
                200,
                json={
                    "issuer": self.issuer,
                    "authorization_endpoint": f"{self.settings.issuer}/protocol/openid-connect/auth",
                    "token_endpoint": f"{base}/protocol/openid-connect/token",
                    "jwks_uri": f"{base}/protocol/openid-connect/certs",
                    "end_session_endpoint": f"{self.settings.issuer}/protocol/openid-connect/logout",
                },
            )
        if path.endswith("/protocol/openid-connect/certs"):
            return httpx.Response(200, json={"keys": [self.jwk()] if self.serve_keys else []})
        if path.endswith("/protocol/openid-connect/token"):
            self.token_requests += 1
            expected = base64.b64encode(
                f"{self.settings.oidc_client_id}:{self.settings.oidc_client_secret}".encode()
            ).decode()
            if request.headers.get("authorization") != f"Basic {expected}":
                return httpx.Response(401, json={"error": "invalid_client"})
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            grant = self.codes.pop(form.get("code", ""), None)  # codes are single-use
            if grant is None or grant["redirect_uri"] != form.get("redirect_uri"):
                return httpx.Response(400, json={"error": "invalid_grant"})
            challenge = (
                base64.urlsafe_b64encode(hashlib.sha256(form.get("code_verifier", "").encode()).digest())
                .rstrip(b"=")
                .decode()
            )
            if challenge != grant["challenge"]:
                return httpx.Response(400, json={"error": "invalid_grant", "error_description": "PKCE"})
            return httpx.Response(
                200, json={"id_token": self.sign(grant["claims"]), "access_token": "unused"}
            )
        return httpx.Response(404)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)
