"""Request dependencies: database transaction, authenticated principal, permission checks."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.config import Settings
from velydock.db import Scope, get_sessionmaker, set_rls_context
from velydock.errors import ApiError, forbidden, not_authenticated
from velydock.idp.base import IdentityProvider
from velydock.models import AuthSession, Membership, Role, Tenant, User, UserSettings
from velydock.policy import Actor, Permission, permissions_for
from velydock.security.http import verify_csrf
from velydock.security.oidc import OidcClient
from velydock.security.sessions import client_ip, resolve_session


@dataclass
class Principal:
    """The authenticated user of a request, already bound to one tenant."""

    user: User
    session: AuthSession
    tenant: Tenant | None
    role: Role | None
    permissions: frozenset[Permission]
    ip: str

    @property
    def actor(self) -> Actor:
        return Actor(
            user_id=self.user.id,
            is_system_admin=self.user.is_system_admin,
            tenant_id=self.tenant.id if self.tenant else None,
            role=self.role,
        )

    def require_tenant(self) -> Tenant:
        if self.tenant is None:
            raise ApiError(409, "no_tenant", "No organization is selected.")
        return self.tenant


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_idp(request: Request) -> IdentityProvider:
    idp: IdentityProvider = request.app.state.idp
    return idp


def get_oidc(request: Request) -> OidcClient:
    oidc: OidcClient = request.app.state.oidc
    return oidc


async def get_db() -> AsyncIterator[AsyncSession]:
    """One transaction per request. It starts without any tenant context (deny by default).

    Always declare it as ``Depends(get_db, scope="function")``: the transaction must be committed
    before the response is sent. With the default scope FastAPI finishes the dependency only
    after the client already has the answer, and an immediate follow-up request (the page that
    reloads a list, the browser following the sign-in redirect) could still see the old state.
    """
    async with get_sessionmaker()() as session, session.begin():
        await set_rls_context(session, scope=Scope.NONE)
        yield session


async def resolve_tenant(
    db: AsyncSession, user: User, session: AuthSession
) -> tuple[Tenant | None, Role | None]:
    """Pick the tenant this session acts in. Must run in system scope.

    Members may only enter tenants they belong to; system administrators may enter any active
    tenant. The choice is stored on the session and survives until the user switches.
    """
    rows = await db.execute(
        select(Tenant, Membership.role)
        .join(Membership, Membership.tenant_id == Tenant.id)
        .where(Membership.user_id == user.id, Tenant.active.is_(True))
        .order_by(Tenant.name)
    )
    memberships = {tenant.id: (tenant, Role(role)) for tenant, role in rows.all()}

    if session.tenant_id is not None:
        if session.tenant_id in memberships:
            return memberships[session.tenant_id]
        if user.is_system_admin:
            tenant = await db.get(Tenant, session.tenant_id)
            if tenant is not None and tenant.active:
                return tenant, None

    chosen: tuple[Tenant, Role | None] | None = None
    prefs = await db.get(UserSettings, user.id)
    if prefs and prefs.last_tenant_id in memberships:
        chosen = memberships[prefs.last_tenant_id]
    elif memberships:
        chosen = next(iter(memberships.values()))
    elif user.is_system_admin:
        first = (
            (await db.execute(select(Tenant).where(Tenant.active.is_(True)).order_by(Tenant.name)))
            .scalars()
            .first()
        )
        if first is not None:
            chosen = (first, None)

    session.tenant_id = chosen[0].id if chosen else None
    return chosen if chosen else (None, None)


async def get_principal(
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    settings: Settings = Depends(get_settings),
) -> Principal:
    cookie = request.cookies.get(settings.session_cookie)
    if not cookie:
        raise not_authenticated()

    await set_rls_context(db, scope=Scope.SYSTEM)
    session = await resolve_session(db, settings, cookie)
    if session is None:
        raise not_authenticated()
    user = await db.get(User, session.user_id)
    if user is None or not user.active:
        raise not_authenticated()

    verify_csrf(request, settings)

    tenant, role = await resolve_tenant(db, user, session)
    await db.flush()
    # From here on the request sees only its own tenant.
    await set_rls_context(
        db,
        scope=Scope.TENANT if tenant else Scope.NONE,
        tenant_id=tenant.id if tenant else None,
        user_id=user.id,
    )
    return Principal(
        user=user,
        session=session,
        tenant=tenant,
        role=role,
        permissions=permissions_for(
            is_system_admin=user.is_system_admin, role=role, has_tenant=tenant is not None
        ),
        ip=client_ip(request),
    )


def require(*permissions: Permission) -> Callable[..., Awaitable[Principal]]:
    """Dependency: the principal must hold all given permissions in the active tenant."""

    async def dependency(principal: Principal = Depends(get_principal)) -> Principal:
        if any(p not in principal.permissions for p in permissions):
            raise forbidden()
        return principal

    return dependency


async def require_system_admin(principal: Principal = Depends(get_principal)) -> Principal:
    if not principal.user.is_system_admin:
        raise forbidden()
    return principal
