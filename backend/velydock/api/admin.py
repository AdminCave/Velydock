"""Tenant administration: users, groups, apps, tenant settings, audit log.

Every route acts on the tenant the session is bound to. A tenant id is never taken from the
request, so there is nothing a client could tamper with to reach another tenant.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.api.deps import Principal, get_db, get_idp, get_settings, require
from velydock.config import Settings
from velydock.idp.base import IdentityProvider, IdpError
from velydock.models import Role
from velydock.policy import Permission
from velydock.schemas import (
    AdminCapabilities,
    AppCreate,
    AppOrder,
    AppOut,
    AppUpdate,
    AuditPage,
    EmbedCheckIn,
    EmbedCheckOut,
    GroupCreate,
    GroupDetail,
    GroupOut,
    GroupUpdate,
    PasswordReset,
    TenantSettingsOut,
    TenantSettingsUpdate,
    UserCreate,
    UserCreated,
    UserOut,
    UserPage,
    UserRemoved,
    UserUpdate,
)
from velydock.services import apps as apps_service
from velydock.services import audit as audit_service
from velydock.services import groups as groups_service
from velydock.services import settings as settings_service
from velydock.services import users as users_service

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])

Page = Annotated[int, Query(ge=1, le=100_000)]
PageSize = Annotated[int, Query(ge=1, le=200)]

# -- users ---------------------------------------------------------------------------------------


@router.get("/users", response_model=UserPage)
async def list_users(
    search: Annotated[str, Query(max_length=100)] = "",
    role: Role | None = None,
    active: bool | None = None,
    group_id: uuid.UUID | None = None,
    page: Page = 1,
    page_size: PageSize = 25,
    principal: Principal = Depends(require(Permission.USERS_READ)),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> UserPage:
    return await users_service.list_users(
        db,
        principal,
        search=search,
        role=role,
        active=active,
        group_id=group_id,
        page=page,
        page_size=page_size,
    )


@router.get("/capabilities", response_model=AdminCapabilities)
async def capabilities(
    principal: Principal = Depends(require(Permission.USERS_READ)),
    idp: IdentityProvider = Depends(get_idp),
) -> AdminCapabilities:
    """What depends on the installation rather than on the role - so the user interface does not
    offer what cannot work (the e-mail invitation without a mail server)."""
    try:
        email = (await idp.get_smtp()).configured
    except IdpError:
        email = False
    return AdminCapabilities(email_invitations=email)


@router.post("/users", response_model=UserCreated, status_code=201)
async def create_user(
    data: UserCreate,
    principal: Principal = Depends(require(Permission.USERS_WRITE)),
    db: AsyncSession = Depends(get_db, scope="function"),
    idp: IdentityProvider = Depends(get_idp),
) -> UserCreated:
    smtp_configured = False
    if data.send_email:
        try:
            smtp_configured = (await idp.get_smtp()).configured
        except IdpError:
            smtp_configured = False
    return await users_service.create_user(db, idp, principal, data, smtp_configured=smtp_configured)


@router.get("/users/{user_id}", response_model=UserOut)
async def get_user(
    user_id: uuid.UUID,
    principal: Principal = Depends(require(Permission.USERS_READ)),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> UserOut:
    return await users_service.get_user(db, principal, user_id)


@router.patch("/users/{user_id}", response_model=UserOut)
async def update_user(
    user_id: uuid.UUID,
    data: UserUpdate,
    principal: Principal = Depends(require(Permission.USERS_WRITE)),
    db: AsyncSession = Depends(get_db, scope="function"),
    idp: IdentityProvider = Depends(get_idp),
) -> UserOut:
    return await users_service.update_user(db, idp, principal, user_id, data)


@router.post("/users/{user_id}/reset-password", response_model=PasswordReset)
async def reset_password(
    user_id: uuid.UUID,
    principal: Principal = Depends(require(Permission.USERS_WRITE)),
    db: AsyncSession = Depends(get_db, scope="function"),
    idp: IdentityProvider = Depends(get_idp),
) -> PasswordReset:
    return PasswordReset(temporary_password=await users_service.reset_password(db, idp, principal, user_id))


@router.post("/users/{user_id}/end-sessions", status_code=204)
async def end_sessions(
    user_id: uuid.UUID,
    principal: Principal = Depends(require(Permission.USERS_WRITE)),
    db: AsyncSession = Depends(get_db, scope="function"),
    idp: IdentityProvider = Depends(get_idp),
) -> Response:
    await users_service.end_sessions(db, idp, principal, user_id)
    return Response(status_code=204)


@router.delete("/users/{user_id}", response_model=UserRemoved)
async def remove_user(
    user_id: uuid.UUID,
    principal: Principal = Depends(require(Permission.USERS_WRITE)),
    db: AsyncSession = Depends(get_db, scope="function"),
    idp: IdentityProvider = Depends(get_idp),
) -> UserRemoved:
    return UserRemoved(deleted_identity=await users_service.remove_user(db, idp, principal, user_id))


# -- groups --------------------------------------------------------------------------------------


@router.get("/groups", response_model=list[GroupOut])
async def list_groups(
    principal: Principal = Depends(require(Permission.GROUPS_READ)),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> list[GroupOut]:
    return await groups_service.list_groups(db, principal)


@router.post("/groups", response_model=GroupDetail, status_code=201)
async def create_group(
    data: GroupCreate,
    principal: Principal = Depends(require(Permission.GROUPS_WRITE)),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> GroupDetail:
    return await groups_service.create_group(db, principal, data)


@router.get("/groups/{group_id}", response_model=GroupDetail)
async def get_group(
    group_id: uuid.UUID,
    principal: Principal = Depends(require(Permission.GROUPS_READ)),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> GroupDetail:
    return await groups_service.get_group(db, principal, group_id)


@router.patch("/groups/{group_id}", response_model=GroupDetail)
async def update_group(
    group_id: uuid.UUID,
    data: GroupUpdate,
    principal: Principal = Depends(require(Permission.GROUPS_WRITE)),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> GroupDetail:
    return await groups_service.update_group(db, principal, group_id, data)


@router.delete("/groups/{group_id}", status_code=204)
async def delete_group(
    group_id: uuid.UUID,
    principal: Principal = Depends(require(Permission.GROUPS_WRITE)),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> Response:
    await groups_service.delete_group(db, principal, group_id)
    return Response(status_code=204)


# -- apps ----------------------------------------------------------------------------------------


@router.get("/apps", response_model=list[AppOut])
async def list_apps(
    principal: Principal = Depends(require(Permission.APPS_MANAGE)),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> list[AppOut]:
    return await apps_service.list_apps(db, principal)


@router.post("/apps", response_model=AppOut, status_code=201)
async def create_app(
    data: AppCreate,
    principal: Principal = Depends(require(Permission.APPS_MANAGE)),
    db: AsyncSession = Depends(get_db, scope="function"),
    settings: Settings = Depends(get_settings),
) -> AppOut:
    return await apps_service.create_app(db, principal, settings, data)


@router.post("/apps/check-embed", response_model=EmbedCheckOut)
async def check_embed(
    data: EmbedCheckIn,
    principal: Principal = Depends(require(Permission.APPS_MANAGE)),
    settings: Settings = Depends(get_settings),
) -> EmbedCheckOut:
    result = await apps_service.run_embed_check(data.url, settings)
    return EmbedCheckOut(status=result.status, detail=result.detail, http_status=result.http_status)


@router.put("/apps/order", response_model=list[AppOut])
async def reorder_apps(
    data: AppOrder,
    principal: Principal = Depends(require(Permission.APPS_MANAGE)),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> list[AppOut]:
    return await apps_service.reorder_apps(db, principal, data.app_ids)


@router.get("/apps/{app_id}", response_model=AppOut)
async def get_app(
    app_id: uuid.UUID,
    principal: Principal = Depends(require(Permission.APPS_MANAGE)),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> AppOut:
    return await apps_service.get_app(db, principal, app_id)


@router.patch("/apps/{app_id}", response_model=AppOut)
async def update_app(
    app_id: uuid.UUID,
    data: AppUpdate,
    principal: Principal = Depends(require(Permission.APPS_MANAGE)),
    db: AsyncSession = Depends(get_db, scope="function"),
    settings: Settings = Depends(get_settings),
) -> AppOut:
    return await apps_service.update_app(db, principal, settings, app_id, data)


@router.post("/apps/{app_id}/recheck", response_model=AppOut)
async def recheck_app(
    app_id: uuid.UUID,
    principal: Principal = Depends(require(Permission.APPS_MANAGE)),
    db: AsyncSession = Depends(get_db, scope="function"),
    settings: Settings = Depends(get_settings),
) -> AppOut:
    return await apps_service.recheck_app(db, principal, settings, app_id)


@router.delete("/apps/{app_id}", status_code=204)
async def delete_app(
    app_id: uuid.UUID,
    principal: Principal = Depends(require(Permission.APPS_MANAGE)),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> Response:
    await apps_service.delete_app(db, principal, app_id)
    return Response(status_code=204)


# -- tenant settings and audit -------------------------------------------------------------------


@router.get("/tenant", response_model=TenantSettingsOut)
async def get_tenant_settings(
    principal: Principal = Depends(require(Permission.TENANT_SETTINGS)),
) -> TenantSettingsOut:
    return settings_service.tenant_settings(principal.require_tenant())


@router.patch("/tenant", response_model=TenantSettingsOut)
async def update_tenant_settings(
    data: TenantSettingsUpdate,
    principal: Principal = Depends(require(Permission.TENANT_SETTINGS)),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> TenantSettingsOut:
    return await settings_service.update_tenant_settings(db, principal, data)


@router.get("/audit", response_model=AuditPage)
async def audit_log(
    page: Page = 1,
    page_size: PageSize = 50,
    principal: Principal = Depends(require(Permission.AUDIT_READ)),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> AuditPage:
    return await audit_service.list_entries(db, principal.require_tenant().id, page=page, page_size=page_size)
