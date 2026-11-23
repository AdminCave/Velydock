"""Request dependencies: database transaction, authenticated principal, permission checks."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.exc import StaleDataError

from velydock.config import Settings
from velydock.db import NAME_ORDER, Scope, get_sessionmaker, set_rls_context
from velydock.errors import (
    ApiError,
    database_unavailable,
    forbidden,
    is_connection_failure,
    not_authenticated,
)
from velydock.idp.base import AccountState, IdentityProvider, IdpError
from velydock.models import AuditLog, AuthSession, Membership, Role, Tenant, User, UserSettings
from velydock.policy import Actor, Permission, permissions_for
from velydock.security import sessions
from velydock.security.http import verify_csrf, verify_same_origin
from velydock.security.oidc import OidcClient
from velydock.security.sessions import client_ip, resolve_session

log = logging.getLogger(__name__)


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
    """The database session of a request. It starts without any tenant context (deny by default).

    Always declare it as ``Depends(get_db, scope="function")``: the transaction must be committed
    before the response is sent. With the default scope FastAPI finishes the dependency only
    after the client already has the answer, and an immediate follow-up request (the page that
    reloads a list, the browser following the sign-in redirect) could still see the old state.

    A request is one transaction, with one exception: ``get_principal`` commits the bookkeeping
    of the session (last use, the organization it is bound to) before the request's own work
    begins. See there.
    """
    async with get_sessionmaker()() as session:
        try:
            try:
                await set_rls_context(session, scope=Scope.NONE)
            except Exception as exc:
                # The first statement is where a database that is away shows.
                if is_connection_failure(exc):
                    raise database_unavailable(exc) from None
                raise
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            raise


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
        .order_by(Tenant.name.collate(NAME_ORDER))
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
            (
                await db.execute(
                    select(Tenant).where(Tenant.active.is_(True)).order_by(Tenant.name.collate(NAME_ORDER))
                )
            )
            .scalars()
            .first()
        )
        if first is not None:
            chosen = (first, None)

    session.tenant_id = chosen[0].id if chosen else None
    return chosen if chosen else (None, None)


async def wanted_at_identity_provider(
    db: AsyncSession, idp: IdentityProvider | None, user: User, session: AuthSession
) -> bool:
    """Ask the identity provider, every few minutes, whether this session is still wanted there.

    If the account was disabled or deleted there, or the session ended there without a logout
    notification, the session ends here as well (and a disabled or deleted account is shown as
    deactivated). If the provider cannot be asked, the session stays: an outage of Keycloak
    must not sign everybody out of Velydock.
    """
    if idp is None or not sessions.idp_check_due(session):
        return True
    try:
        state = await idp.account_state(user.idp_id, session.idp_sid)
    except IdpError as exc:
        log.warning("could not check session of %s at the identity provider: %s", user.id, exc)
        sessions.idp_checked(session, successful=False)
        return True
    sessions.idp_checked(session)
    if state is AccountState.ACTIVE:
        return True
    if state is AccountState.SESSION_ENDED:
        await sessions.delete_session(db, session.id_hash)
    else:
        user.active = False
        await sessions.delete_user_sessions(db, user.id)
        db.add(
            AuditLog(
                tenant_id=user.home_tenant_id,
                actor_id=None,
                actor_name="system",
                action="user.update",
                target_type="user",
                target_id=str(user.id),
                target_label=user.username,
                details={"active": False, "reason": f"{state.value} at the identity provider"},
            )
        )
    log.info("session of %s ended: %s at the identity provider", user.id, state.value)
    return False


async def get_principal(
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    settings: Settings = Depends(get_settings),
) -> Principal:
    cookie = request.cookies.get(settings.session_cookie)
    if not cookie:
        raise not_authenticated()
    # Before the session is looked up: a request from another origin must not even count as
    # activity of this session.
    verify_same_origin(request)

    await set_rls_context(db, scope=Scope.SYSTEM)
    session = await resolve_session(db, settings, cookie)
    if session is None:
        raise not_authenticated()
    user = await db.get(User, session.user_id)
    if user is None or not user.active:
        raise not_authenticated()

    verify_csrf(request, settings)

    if not await wanted_at_identity_provider(db, request.app.state.idp, user, session):
        # What was just learned is stored even though the request itself fails.
        await db.commit()
        raise not_authenticated()

    tenant, role = await resolve_tenant(db, user, session)
    try:
        await db.flush()
    except StaleDataError:
        # The session was removed while this request was looking at it (a sign-out, an
        # administrator ending the sessions): it is over, which is not an error of ours.
        raise not_authenticated() from None
    # The bookkeeping of the session ends here, in a transaction of its own. Kept open, the
    # request would hold a lock on its own session row until it is done - and whoever wants to
    # end this session meanwhile (an administrator, a logout notification from Keycloak) would
    # wait for it, or the two would block each other for good.
    await db.commit()
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


TENANT_HEADER = "x-velydock-tenant"


def verify_expected_tenant(request: Request, principal: Principal) -> None:
    """Refuse a request that was meant for another organization than the session's active one.

    The active organization belongs to the session, not to a browser tab. If it changes in one
    tab (or on the server), another tab still shows the old organization, and a change saved
    there would silently land in the new one. The client therefore states which organization
    it is showing. The header never selects an organization - it can only make a request fail.
    """
    expected = request.headers.get(TENANT_HEADER)
    if expected is None:
        return
    actual = str(principal.tenant.id) if principal.tenant else ""
    if expected.strip().lower() != actual:
        raise ApiError(409, "tenant_changed", "The active organization of this session has changed.")


def require(*permissions: Permission) -> Callable[..., Awaitable[Principal]]:
    """Dependency: the principal must hold all given permissions in the active tenant."""

    async def dependency(request: Request, principal: Principal = Depends(get_principal)) -> Principal:
        verify_expected_tenant(request, principal)
        if any(p not in principal.permissions for p in permissions):
            raise forbidden()
        return principal

    return dependency


async def require_system_admin(principal: Principal = Depends(get_principal)) -> Principal:
    if not principal.user.is_system_admin:
        raise forbidden()
    return principal
