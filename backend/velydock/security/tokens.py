"""Small signed tokens (HMAC-SHA256) for short-lived, self-contained grants.

Used for the login-state cookie and for custom-app URLs on the sandbox host. Each purpose gets its
own derived key, so a token minted for one purpose is useless for another.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import string
import time
from typing import Any


class TokenError(Exception):
    pass


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _key(secret: str, purpose: str) -> bytes:
    return hmac.new(secret.encode(), f"velydock:{purpose}".encode(), hashlib.sha256).digest()


def sign(secret: str, purpose: str, payload: dict[str, Any], ttl_seconds: int) -> str:
    body = dict(payload)
    body["exp"] = int(time.time()) + ttl_seconds
    raw = _b64(json.dumps(body, separators=(",", ":"), sort_keys=True).encode())
    mac = hmac.new(_key(secret, purpose), raw.encode(), hashlib.sha256).digest()
    return f"{raw}.{_b64(mac)}"


def verify(secret: str, purpose: str, token: str) -> dict[str, Any]:
    try:
        raw, mac = token.split(".")
        expected = hmac.new(_key(secret, purpose), raw.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _unb64(mac)):
            raise TokenError("bad signature")
        payload = json.loads(_unb64(raw))
    except TokenError:
        raise
    except Exception as exc:
        raise TokenError("malformed token") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("exp"), int):
        raise TokenError("malformed token")
    if payload["exp"] < time.time():
        raise TokenError("expired")
    return payload


def random_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


_PASSWORD_ALPHABET = "".join(c for c in string.ascii_letters + string.digits if c not in "Il1O0o")


def temporary_password(length: int = 16) -> str:
    """A one-time password an admin hands over; Keycloak forces a change at first sign-in.

    Avoids look-alike characters and always mixes letters, digits and a separator so it passes
    common password policies.
    """
    while True:
        chars = [secrets.choice(_PASSWORD_ALPHABET) for _ in range(length)]
        pw = "".join(chars)
        if any(c.islower() for c in pw) and any(c.isupper() for c in pw) and any(c.isdigit() for c in pw):
            return f"{pw[: length // 2]}-{pw[length // 2 :]}"
