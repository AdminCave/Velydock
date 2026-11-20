"""System administration: tenants, all users, system settings. System administrators only."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.api.deps import Principal, get_db, get_idp, get_settings, require_system_admin
from velydock.config import Settings
from velydock.db import system_scope
from velydock.idp.base import IdentityProvider
from velydock.schemas import (
    AuditPage,
    MemberAdd,
    SystemSettingsOut,
    SystemSettingsUpdate,
    SystemUserOut,
    SystemUserPage,
    SystemUserUpdate,
    TenantCreate,
    TenantDelete,
    TenantOut,
    TenantUpdate,
)
from velydock.services import audit as audit_service
from velydock.services import settings as settings_service
from velydock.services import tenants as tenants_service
from velydock.services import users as users_service

router = APIRouter(prefix="/api/v1/system", tags=["system"])

Page = Annotated[int, Query(ge=1, le=100_000)]
PageSize = Annotated[int, Query(ge=1, le=200)]


@router.get("/tenants", response_model=list[TenantOut])
async def list_tenants(
    _: Principal = Depends(require_system_admin), db: AsyncSession = Depends(get_db)
) -> list[TenantOut]:
    return await tenants_service.list_tenants(db)


@router.post("/tenants", response_model=TenantOut, status_code=201)
async def create_tenant(
    data: TenantCreate,
    principal: Principal = Depends(require_system_admin),
    db: AsyncSession = Depends(get_db),
    idp: IdentityProvider = Depends(get_idp),
) -> TenantOut:
    return await tenants_service.create_tenant(db, idp, principal, data)


@router.patch("/tenants/{tenant_id}", response_model=TenantOut)
async def update_tenant(
    tenant_id: uuid.UUID,
    data: TenantUpdate,
    principal: Principal = Depends(require_system_admin),
    db: AsyncSession = Depends(get_db),
    idp: IdentityProvider = Depends(get_idp),
) -> TenantOut:
    return await tenants_service.update_tenant(db, idp, principal, tenant_id, data)


@router.post("/tenants/{tenant_id}/delete", status_code=204)
async def delete_tenant(
    tenant_id: uuid.UUID,
    data: TenantDelete,
    principal: Principal = Depends(require_system_admin),
    db: AsyncSession = Depends(get_db),
    idp: IdentityProvider = Depends(get_idp),
) -> Response:
    """Deleting needs the short name typed out, hence a POST with a body rather than DELETE."""
    await tenants_service.delete_tenant(db, idp, principal, tenant_id, data.confirm_slug)
    return Response(status_code=204)


@router.post("/tenants/{tenant_id}/members", response_model=SystemUserOut, status_code=201)
async def add_member(
    tenant_id: uuid.UUID,
    data: MemberAdd,
    principal: Principal = Depends(require_system_admin),
    db: AsyncSession = Depends(get_db),
    idp: IdentityProvider = Depends(get_idp),
) -> SystemUserOut:
    return await users_service.add_member(db, idp, principal, tenant_id, data.user_id, data.role)


@router.get("/users", response_model=SystemUserPage)
async def list_users(
    search: Annotated[str, Query(max_length=100)] = "",
    page: Page = 1,
    page_size: PageSize = 25,
    _: Principal = Depends(require_system_admin),
    db: AsyncSession = Depends(get_db),
) -> SystemUserPage:
    return await users_service.list_all_users(db, search=search, page=page, page_size=page_size)


@router.patch("/users/{user_id}", response_model=SystemUserOut)
async def update_user(
    user_id: uuid.UUID,
    data: SystemUserUpdate,
    principal: Principal = Depends(require_system_admin),
    db: AsyncSession = Depends(get_db),
) -> SystemUserOut:
    return await users_service.set_system_admin(db, principal, user_id, data.is_system_admin)


@router.get("/settings", response_model=SystemSettingsOut)
async def get_system_settings(
    _: Principal = Depends(require_system_admin),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
    idp: IdentityProvider = Depends(get_idp),
) -> SystemSettingsOut:
    return await settings_service.system_settings(db, settings, idp)


@router.patch("/settings", response_model=SystemSettingsOut)
async def update_system_settings(
    data: SystemSettingsUpdate,
    principal: Principal = Depends(require_system_admin),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
    idp: IdentityProvider = Depends(get_idp),
) -> SystemSettingsOut:
    return await settings_service.update_system(db, settings, idp, principal, data)


@router.get("/audit", response_model=AuditPage)
async def system_audit(
    page: Page = 1,
    page_size: PageSize = 50,
    _: Principal = Depends(require_system_admin),
    db: AsyncSession = Depends(get_db),
) -> AuditPage:
    """Entries that belong to no tenant: tenant lifecycle, system settings, administrator rights."""
    async with system_scope(db):
        return await audit_service.list_entries(db, None, page=page, page_size=page_size)
