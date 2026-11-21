"""Tenants (organizations). Managed by system administrators; callers enforce that.

Each tenant is mirrored as an Organization in the shared Keycloak realm, so connected apps can
tell from a token which organization a user belongs to.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.api.deps import Principal
from velydock.db import NAME_ORDER, Lock, advisory_lock, system_scope
from velydock.errors import ApiError, conflict, idp_unavailable, invalid, not_found
from velydock.idp.base import (
    IdentityProvider,
    IdpConflict,
    IdpError,
    IdpManaged,
    IdpNotFound,
    IdpUnavailable,
)
from velydock.models import App, Membership, Tenant, User
from velydock.schemas import TenantCreate, TenantOut, TenantUpdate
from velydock.security import sessions
from velydock.services import audit

log = logging.getLogger(__name__)


def _idp_failure(exc: IdpError) -> ApiError:
    if isinstance(exc, IdpManaged):
        return conflict(
            "managed_by_idp",
            "The identity provider manages a membership of this organization itself; change it there.",
        )
    if isinstance(exc, IdpUnavailable):
        return idp_unavailable()
    if isinstance(exc, IdpConflict):
        return conflict("tenant_exists", "An organization with this name or short name already exists.")
    return ApiError(
        502, "idp_error", "The identity provider rejected the request.", {"reason": str(exc)[:200]}
    )


async def _out(db: AsyncSession, tenant: Tenant) -> TenantOut:
    members = (
        await db.execute(
            select(func.count()).select_from(Membership).where(Membership.tenant_id == tenant.id)
        )
    ).scalar_one()
    apps = (
        await db.execute(select(func.count()).select_from(App).where(App.tenant_id == tenant.id))
    ).scalar_one()
    out = TenantOut.model_validate(tenant)
    out.member_count, out.app_count = members, apps
    out.protected = await _home_of_system_admin(db, tenant.id)
    return out


async def list_tenants(db: AsyncSession) -> list[TenantOut]:
    async with system_scope(db):
        tenants = list((await db.execute(select(Tenant).order_by(Tenant.name.collate(NAME_ORDER)))).scalars())
        return [await _out(db, t) for t in tenants]


async def _ensure_free(
    db: AsyncSession, *, slug: str | None, name: str | None, exclude: uuid.UUID | None = None
) -> None:
    if slug is not None:
        query = select(Tenant.id).where(Tenant.slug == slug)
        if (await db.execute(query)).first():
            raise conflict("tenant_slug_taken", "This short name is already in use.")
    if name is not None:
        query = select(Tenant.id).where(func.lower(Tenant.name) == name.lower())
        if exclude:
            query = query.where(Tenant.id != exclude)
        if (await db.execute(query)).first():
            raise conflict("tenant_name_taken", "An organization with this name already exists.")


async def create_tenant(
    db: AsyncSession, idp: IdentityProvider, principal: Principal | None, data: TenantCreate
) -> TenantOut:
    async with system_scope(db):
        await _ensure_free(db, slug=data.slug, name=data.name)
        created_here = True
        try:
            try:
                org_id = await idp.create_organization(name=data.name, alias=data.slug)
            except IdpConflict:
                # No tenant uses this short name (checked above), so an organization with this
                # alias is left over from an attempt that failed halfway. Take it over instead
                # of blocking the name forever - without the members it may still have.
                leftover = await idp.find_organization(data.slug)
                if leftover is None:
                    raise
                for member in await idp.list_organization_members(leftover):
                    await idp.remove_organization_member(leftover, member)
                await idp.update_organization(leftover, name=data.name, enabled=True)
                org_id, created_here = leftover, False
        except IdpError as exc:
            raise _idp_failure(exc) from exc
        try:
            tenant = Tenant(slug=data.slug, name=data.name, idp_org_id=org_id)
            db.add(tenant)
            await db.flush()
            await audit.record(
                db,
                principal,
                "tenant.create",
                target_type="tenant",
                target_id=tenant.id,
                target_label=tenant.name,
                tenant_id=None,
            )
            await db.refresh(tenant)
            out = await _out(db, tenant)
        except Exception:
            if created_here:
                try:
                    await idp.delete_organization(org_id)
                except IdpError:
                    log.exception("could not roll back organization %s", org_id)
            raise
        return out


async def sync_organization(db: AsyncSession, idp: IdentityProvider, tenant: Tenant) -> None:
    """Make the provider's organization of a tenant what it should be. Runs in system scope.

    It exists (found by its alias, the tenant's short name), carries the tenant's name and state,
    and has every member of the tenant. Used at start-up for all tenants, and when a change finds
    the organization gone. What it does not do: remove members that were added by hand in
    Keycloak, or touch the accounts themselves.
    """
    org_id = await idp.find_organization(tenant.slug)
    if org_id is None:
        org_id = await idp.create_organization(name=tenant.name, alias=tenant.slug)
        log.info("created the missing organization for tenant %s", tenant.slug)
    if tenant.idp_org_id != org_id:
        tenant.idp_org_id = org_id
        await db.flush()
    await idp.update_organization(org_id, name=tenant.name, enabled=tenant.active)
    members = await idp.list_organization_members(org_id)
    rows = await db.execute(
        select(User.idp_id)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.tenant_id == tenant.id)
    )
    for idp_id in rows.scalars():
        if idp_id in members:
            continue
        try:
            await idp.add_organization_member(org_id, idp_id)
        except IdpError as exc:
            log.warning("could not add %s to organization %s: %s", idp_id, tenant.slug, exc)


async def _home_of_system_admin(db: AsyncSession, tenant_id: uuid.UUID) -> bool:
    return bool(
        (
            await db.execute(
                select(User.id)
                .where(User.home_tenant_id == tenant_id, User.is_system_admin.is_(True))
                .limit(1)
            )
        ).first()
    )


async def update_tenant(
    db: AsyncSession, idp: IdentityProvider, principal: Principal, tenant_id: uuid.UUID, data: TenantUpdate
) -> TenantOut:
    async with system_scope(db):
        # Changes to one organization take turns, and it is read after waiting for the turn.
        await advisory_lock(db, Lock.TENANT, tenant_id)
        tenant = await db.get(Tenant, tenant_id, populate_existing=True)
        if tenant is None:
            raise not_found("Organization")
        name = data.name if data.name is not None else tenant.name
        active = data.active if data.active is not None else tenant.active
        if not active and tenant.active and await _home_of_system_admin(db, tenant.id):
            raise invalid(
                "The organization of a system administrator cannot be deactivated.", "tenant_protected"
            )
        if name != tenant.name:
            await _ensure_free(db, slug=None, name=name, exclude=tenant.id)
        changed = {
            field: value
            for field, value, before in (("name", name, tenant.name), ("active", active, tenant.active))
            if value != before
        }
        tenant.name, tenant.active = name, active
        await db.flush()
        if changed:
            # Only what really changed is in the log; saving without a change is not an event.
            await audit.record(
                db,
                principal,
                "tenant.update",
                target_type="tenant",
                target_id=tenant.id,
                target_label=tenant.name,
                details=changed,
                tenant_id=None,
            )
        await db.refresh(tenant)
        out = await _out(db, tenant)
        # The identity provider last: the database has accepted everything by now. Sent also
        # when nothing changed here, so the request repairs an organization that was renamed
        # or disabled directly in Keycloak.
        try:
            try:
                if tenant.idp_org_id is None:
                    raise IdpNotFound("no organization recorded")
                await idp.update_organization(tenant.idp_org_id, name=name, enabled=active)
            except IdpNotFound:
                # Deleted in Keycloak behind our back: put it back as it should be.
                await sync_organization(db, idp, tenant)
                out = await _out(db, tenant)
        except IdpError as exc:
            raise _idp_failure(exc) from exc
        return out


async def delete_tenant(
    db: AsyncSession, idp: IdentityProvider, principal: Principal, tenant_id: uuid.UUID, confirm_slug: str
) -> None:
    """Delete a tenant with everything in it, including the identities it owns."""
    async with system_scope(db):
        # Exclusive: creating a user or adding a member in this organization holds the same
        # lock shared, so none of them can slip in between reading the accounts and deleting.
        await advisory_lock(db, Lock.TENANT, tenant_id)
        tenant = await db.get(Tenant, tenant_id, populate_existing=True)
        if tenant is None:
            raise not_found("Organization")
        if confirm_slug != tenant.slug:
            raise invalid("The short name does not match.", "confirmation_mismatch")
        if await _home_of_system_admin(db, tenant.id):
            raise invalid("The organization of a system administrator cannot be deleted.", "tenant_protected")
        owned = list((await db.execute(select(User).where(User.home_tenant_id == tenant.id))).scalars())
        try:
            for user in owned:
                await idp.delete_user(user.idp_id)
            if tenant.idp_org_id:
                await idp.delete_organization(tenant.idp_org_id)
        except IdpError as exc:
            raise _idp_failure(exc) from exc
        for user in owned:
            await sessions.delete_user_sessions(db, user.id)
            await db.delete(user)
        name, slug = tenant.name, tenant.slug
        await db.delete(tenant)
        await db.flush()
        await audit.record(
            db,
            principal,
            "tenant.delete",
            target_type="tenant",
            target_id=tenant_id,
            target_label=name,
            details={"slug": slug, "deleted_users": len(owned)},
            tenant_id=None,
        )
