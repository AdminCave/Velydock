"""Server-side sessions.

The browser holds an opaque random value; the database stores only its SHA-256. Sessions end by
idle timeout, absolute lifetime, logout, back-channel logout or when the account is disabled.
All functions expect the caller to run in system scope.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import Request, Response
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.config import Settings
from velydock.models import AuthSession
from velydock.security.tokens import hash_token, random_token

_TOUCH_INTERVAL = timedelta(seconds=60)


def now() -> datetime:
    return datetime.now(UTC)


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


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
    db.add(
        AuthSession(
            id_hash=hash_token(value),
            user_id=user_id,
            tenant_id=tenant_id,
            idp_sid=idp_sid,
            id_token=id_token,
            auth_time=datetime.fromtimestamp(auth_time, UTC) if auth_time else None,
            expires_at=now() + timedelta(hours=settings.session_max_hours),
            user_agent=request.headers.get("user-agent", "")[:300],
            ip=client_ip(request),
        )
    )
    await db.flush()
    return value


async def resolve_session(db: AsyncSession, settings: Settings, cookie_value: str) -> AuthSession | None:
    """Return the live session for a cookie value, or ``None`` (expired sessions are removed)."""
    if not cookie_value or len(cookie_value) > 200:
        return None
    session = await db.get(AuthSession, hash_token(cookie_value))
    if session is None:
        return None
    current = now()
    idle_deadline = session.last_seen_at + timedelta(minutes=settings.session_idle_minutes)
    if current >= session.expires_at or current >= idle_deadline:
        await db.delete(session)
        await db.flush()
        return None
    if current - session.last_seen_at >= _TOUCH_INTERVAL:
        session.last_seen_at = current
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
    current = now()
    idle_cutoff = current - timedelta(minutes=settings.session_idle_minutes)
    result = await db.execute(
        delete(AuthSession).where(
            (AuthSession.expires_at <= current) | (AuthSession.last_seen_at <= idle_cutoff)
        )
    )
    return int(getattr(result, "rowcount", 0) or 0)


async def count_user_sessions(db: AsyncSession, user_id: uuid.UUID) -> int:
    rows = await db.execute(select(AuthSession.id_hash).where(AuthSession.user_id == user_id))
    return len(rows.all())


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
