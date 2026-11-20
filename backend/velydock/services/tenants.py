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
from velydock.db import system_scope
from velydock.errors import ApiError, conflict, idp_unavailable, invalid, not_found
from velydock.idp.base import IdentityProvider, IdpConflict, IdpError, IdpUnavailable
from velydock.models import App, Membership, Tenant, User
from velydock.schemas import TenantCreate, TenantOut, TenantUpdate
from velydock.security import sessions
from velydock.services import audit

log = logging.getLogger(__name__)


def _idp_failure(exc: IdpError) -> ApiError:
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
    return out


async def list_tenants(db: AsyncSession) -> list[TenantOut]:
    async with system_scope(db):
        tenants = list((await db.execute(select(Tenant).order_by(func.lower(Tenant.name)))).scalars())
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
        try:
            org_id = await idp.create_organization(name=data.name, alias=data.slug)
        except IdpError as exc:
            raise _idp_failure(exc) from exc
        try:
            tenant = Tenant(slug=data.slug, name=data.name, idp_org_id=org_id)
            db.add(tenant)
            await db.flush()
        except Exception:
            try:
                await idp.delete_organization(org_id)
            except IdpError:
                log.exception("could not roll back organization %s", org_id)
            raise
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
        return await _out(db, tenant)


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
        tenant = await db.get(Tenant, tenant_id)
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
        if tenant.idp_org_id and (name, active) != (tenant.name, tenant.active):
            try:
                await idp.update_organization(tenant.idp_org_id, name=name, enabled=active)
            except IdpError as exc:
                raise _idp_failure(exc) from exc
        tenant.name, tenant.active = name, active
        await db.flush()
        await audit.record(
            db,
            principal,
            "tenant.update",
            target_type="tenant",
            target_id=tenant.id,
            target_label=tenant.name,
            details=data.model_dump(exclude_unset=True),
            tenant_id=None,
        )
        await db.refresh(tenant)
        return await _out(db, tenant)


async def delete_tenant(
    db: AsyncSession, idp: IdentityProvider, principal: Principal, tenant_id: uuid.UUID, confirm_slug: str
) -> None:
    """Delete a tenant with everything in it, including the identities it owns."""
    async with system_scope(db):
        tenant = await db.get(Tenant, tenant_id)
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
