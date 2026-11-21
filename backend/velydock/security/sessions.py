"""Server-side sessions.

The browser holds an opaque random value; the database stores only its SHA-256. Sessions end by
idle timeout, absolute lifetime, logout, back-channel logout or when the account is disabled.
All functions expect the caller to run in system scope.
"""

from __future__ import annotations

import ipaddress
import time
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import Request, Response
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.config import Settings
from velydock.models import AuthSession
from velydock.security.tokens import hash_token, random_token

_TOUCH_INTERVAL = timedelta(seconds=60)

# How often a session in use is checked against the identity provider (see ``idp_check_due``),
# and how soon a check that could not be made is tried again.
IDP_RECHECK_SECONDS = 300.0
IDP_RETRY_SECONDS = 60.0
# When each session was last checked. In memory on purpose: one process serves Velydock, and
# after a restart every session is simply checked once more.
_idp_checked: dict[str, float] = {}


def idp_check_due(session: AuthSession) -> bool:
    """Is it time to ask the identity provider whether this session is still wanted there?

    Keycloak tells Velydock about most endings (back-channel logout), but not about all: an
    account disabled or deleted in its console, "sign out all sessions" for the whole realm, or
    a session that simply ran out there. Without asking, such a session would stay usable here
    until its own lifetime ends.
    """
    return time.monotonic() >= _idp_checked.get(session.id_hash, 0.0)


def idp_checked(session: AuthSession, *, successful: bool = True) -> None:
    if len(_idp_checked) > 50_000:
        # Forget sessions that are long gone; the others are merely checked again.
        cutoff = time.monotonic() - IDP_RECHECK_SECONDS
        for key in [k for k, due in _idp_checked.items() if due < cutoff]:
            del _idp_checked[key]
    _idp_checked[session.id_hash] = time.monotonic() + (
        IDP_RECHECK_SECONDS if successful else IDP_RETRY_SECONDS
    )


def now() -> datetime:
    return datetime.now(UTC)


def client_ip(request: Request) -> str:
    """The client address for the audit log and the session list, or "" if it is not an address.

    Behind a proxy the value comes from ``X-Forwarded-For``; whatever arrives there must not
    reach a database column unchecked.
    """
    host = request.client.host if request.client else ""
    # An IPv6 zone id ("fe80::1%eth0") may be any length and says nothing outside its host.
    if "%" in host or len(host) > 45:
        return ""
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        return ""


async def create_session(
    db: AsyncSession,
    settings: Settings,
    *,
    user_id: uuid.UUID,
    tenant_id: uuid.UUID | None,
    idp_sid: str | None,
    id_token: str,
    auth_time: int | None,
    request: Request,
) -> str:
    value = random_token(32)
    current = now()
    lifetime = timedelta(hours=settings.session_max_hours)
    authenticated_at = datetime.fromtimestamp(auth_time, UTC) if auth_time else None
    expires_at = current + lifetime
    if authenticated_at is not None:
        # A sign-in that needed no password (the identity provider still knew the user) does
        # not start a new day: the lifetime counts from the moment the user really signed in,
        # like the session at the identity provider does.
        expires_at = max(min(expires_at, authenticated_at + lifetime), current + timedelta(minutes=1))
    row = AuthSession(
        id_hash=hash_token(value),
        user_id=user_id,
        tenant_id=tenant_id,
        idp_sid=idp_sid,
        id_token=id_token,
        auth_time=authenticated_at,
        expires_at=expires_at,
        user_agent=request.headers.get("user-agent", "")[:300],
        ip=client_ip(request),
    )
    db.add(row)
    await db.flush()
    idp_checked(row)  # the identity provider has vouched for it this very moment
    return value


async def resolve_session(db: AsyncSession, settings: Settings, cookie_value: str) -> AuthSession | None:
    """Return the live session for a cookie value, or ``None``.

    An expired row is left where it is: signing out still needs the token stored in it to end
    the session at the identity provider. Rows are removed once their absolute lifetime is over
    (``purge_expired``).
    """
    if not cookie_value or len(cookie_value) > 200:
        return None
    session = await db.get(AuthSession, hash_token(cookie_value))
    if session is None:
        return None
    current = now()
    idle_deadline = session.last_seen_at + timedelta(minutes=settings.session_idle_minutes)
    if current >= session.expires_at or current >= idle_deadline:
        return None
    if current - session.last_seen_at >= _TOUCH_INTERVAL:
        # A plain UPDATE on purpose: if a sign-out removed the row a moment ago, it matches
        # nothing - and that is the answer: the session is over.
        touched = await db.execute(
            update(AuthSession)
            .where(AuthSession.id_hash == session.id_hash)
            .values(last_seen_at=current)
            .execution_options(synchronize_session=False)
        )
        if not getattr(touched, "rowcount", 1):
            return None
    return session


async def delete_session(db: AsyncSession, id_hash: str) -> None:
    await db.execute(delete(AuthSession).where(AuthSession.id_hash == id_hash))


async def delete_user_sessions(db: AsyncSession, user_id: uuid.UUID) -> int:
    result = await db.execute(delete(AuthSession).where(AuthSession.user_id == user_id))
    return int(getattr(result, "rowcount", 0) or 0)


async def delete_sessions_by_sid(db: AsyncSession, idp_sid: str) -> int:
    result = await db.execute(delete(AuthSession).where(AuthSession.idp_sid == idp_sid))
    return int(getattr(result, "rowcount", 0) or 0)


async def purge_expired(db: AsyncSession, settings: Settings) -> int:
    """Remove sessions whose absolute lifetime is over.

    Sessions that merely idled out stay until then: their row holds the token with which
    "sign out" ends the session at the identity provider, and that must keep working however
    long the tab was left alone and whoever signed in meanwhile.
    """
    result = await db.execute(delete(AuthSession).where(AuthSession.expires_at <= now()))
    return int(getattr(result, "rowcount", 0) or 0)


def set_session_cookie(response: Response, settings: Settings, value: str) -> None:
    response.set_cookie(
        settings.session_cookie,
        value,
        max_age=settings.session_max_hours * 3600,
        path="/",
        secure=settings.secure_cookies,
        httponly=True,
        samesite="lax",
    )


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(
        settings.session_cookie, path="/", secure=settings.secure_cookies, httponly=True, samesite="lax"
    )
