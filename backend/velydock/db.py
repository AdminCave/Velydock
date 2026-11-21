"""Database access and the row-level-security context.

Every transaction carries three transaction-local settings that the RLS policies read:

* ``app.scope``     – ``tenant`` (normal requests), ``system`` (trusted internal code) or ``none``
* ``app.tenant_id`` – the tenant the request acts in
* ``app.user_id``   – the acting user

They are set with ``set_config(..., is_local => true)``, so they vanish at commit/rollback and can
never leak to another request through the connection pool. With nothing set, the policies deny.
"""

from __future__ import annotations

import uuid
import zlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from enum import IntEnum, StrEnum
from typing import Any

from sqlalchemy import Integer, cast, func, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from velydock.config import get_settings


class Scope(StrEnum):
    NONE = "none"
    TENANT = "tenant"
    SYSTEM = "system"


_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def init_engine(database_url: str, **engine_options: Any) -> AsyncEngine:
    """Create the engine explicitly (the application factory and tests do this)."""
    global _engine, _sessionmaker
    engine_options.setdefault("pool_pre_ping", True)
    _engine = create_async_engine(database_url, **engine_options)
    _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def get_engine() -> AsyncEngine:
    if _engine is None:
        return init_engine(get_settings().database_url)
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    if _sessionmaker is None:
        get_engine()
    assert _sessionmaker is not None
    return _sessionmaker


def engine_initialized() -> bool:
    return _engine is not None


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


# Names are sorted the way a reader expects ("Äcme" next to "Acme", not after "Zeta"): by
# language-neutral Unicode rules, not by byte values.
NAME_ORDER = "und-x-icu"


class Lock(IntEnum):
    """What an advisory lock stands for. Related changes wait for each other instead of racing.

    Several of them are always taken in this order (system administrators, tenant, user), so
    two requests can never wait for each other in a circle.
    """

    SYSTEM_ADMINS = 1
    TENANT = 2
    USER = 3


async def advisory_lock(
    session: AsyncSession, what: Lock, key: uuid.UUID | None = None, *, shared: bool = False
) -> None:
    """Hold a lock until the end of the transaction.

    Velydock changes an identity in two places, one after the other: at the identity provider and
    in its own database. Two such changes to the same account at the same time could interleave
    and leave the two sides telling different stories; the lock makes them take turns. It is not
    tied to a table row, so row-level security has no say in it.
    """
    # 32 bits of the id are enough: a collision only makes two unrelated changes take turns.
    number = (zlib.crc32(key.bytes) if key is not None else 0) - 2**31
    function = func.pg_advisory_xact_lock_shared if shared else func.pg_advisory_xact_lock
    await session.execute(select(function(cast(int(what), Integer), cast(number, Integer))))


_SET_CONTEXT = text(
    "SELECT set_config('app.scope', :scope, true), "
    "set_config('app.tenant_id', :tenant, true), "
    "set_config('app.user_id', :user, true)"
)


async def set_rls_context(
    session: AsyncSession,
    *,
    scope: Scope,
    tenant_id: uuid.UUID | None = None,
    user_id: uuid.UUID | None = None,
) -> None:
    await session.execute(
        _SET_CONTEXT,
        {
            "scope": scope.value,
            "tenant": str(tenant_id) if tenant_id else "",
            "user": str(user_id) if user_id else "",
        },
    )
    session.info["rls"] = (scope, tenant_id, user_id)


def current_context(session: AsyncSession) -> tuple[Scope, uuid.UUID | None, uuid.UUID | None]:
    ctx: tuple[Scope, uuid.UUID | None, uuid.UUID | None] = session.info.get("rls", (Scope.NONE, None, None))
    return ctx


@asynccontextmanager
async def system_scope(session: AsyncSession) -> AsyncIterator[None]:
    """Temporarily lift tenant isolation for trusted code (authentication, system administration).

    Each use is a deliberate, reviewable exception to the tenant boundary. On an error the
    surrounding transaction is rolled back anyway, so the previous context is only restored on
    success.
    """
    scope, tenant_id, user_id = current_context(session)
    await session.flush()
    await set_rls_context(session, scope=Scope.SYSTEM, tenant_id=tenant_id, user_id=user_id)
    yield
    await session.flush()
    await set_rls_context(session, scope=scope, tenant_id=tenant_id, user_id=user_id)


@asynccontextmanager
async def transaction(
    scope: Scope = Scope.SYSTEM,
    tenant_id: uuid.UUID | None = None,
    user_id: uuid.UUID | None = None,
) -> AsyncIterator[AsyncSession]:
    """One transaction with an RLS context, for code outside the request cycle (CLI, startup)."""
    async with get_sessionmaker()() as session, session.begin():
        await set_rls_context(session, scope=scope, tenant_id=tenant_id, user_id=user_id)
        yield session
