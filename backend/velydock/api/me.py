"""The signed-in user: profile, preferences, tenant switch, workspace apps."""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from velydock import __version__
from velydock.api.deps import Principal, get_db, get_idp, get_principal, get_settings, require
from velydock.config import Settings
from velydock.db import Scope, set_rls_context, system_scope
from velydock.errors import ApiError, forbidden, idp_unavailable, not_found
from velydock.idp.base import IdentityProvider, IdpError, IdpUnavailable
from velydock.models import App, Membership, Role, Tenant, UserSettings
from velydock.policy import Permission, permissions_for
from velydock.schemas import (
    ActiveTenantUpdate,
    LaunchOut,
    MembershipOut,
    MeOut,
    MeUser,
    ProfileUpdate,
    PublicInfo,
    SettingsUpdate,
    TenantRef,
    WorkspaceApp,
)
from velydock.services import apps as apps_service
from velydock.services import settings as settings_service

router = APIRouter(prefix="/api/v1", tags=["me"])


@router.get("/public", response_model=PublicInfo)
async def public_info(
    db: AsyncSession = Depends(get_db), settings: Settings = Depends(get_settings)
) -> PublicInfo:
    """What the sign-in page needs before anyone is authenticated."""
    system = await settings_service.load_system(db, settings)
    return PublicInfo(
        instance_name=system["instance_name"],
        default_language=system["default_language"],
        default_theme=system["default_theme"],
        version=__version__,
    )


async def _memberships(db: AsyncSession, principal: Principal) -> list[MembershipOut]:
    """Tenants the user can switch to: own memberships, for system administrators all active ones."""
    async with system_scope(db):
        rows = await db.execute(
            select(Tenant, Membership.role)
            .join(Membership, Membership.tenant_id == Tenant.id)
            .where(Membership.user_id == principal.user.id, Tenant.active.is_(True))
            .order_by(Tenant.name)
        )
        result = {
            t.id: MembershipOut(tenant=TenantRef.model_validate(t), role=Role(r)) for t, r in rows.all()
        }
        if principal.user.is_system_admin:
            tenants = await db.execute(select(Tenant).where(Tenant.active.is_(True)).order_by(Tenant.name))
            for tenant in tenants.scalars():
                result.setdefault(
                    tenant.id, MembershipOut(tenant=TenantRef.model_validate(tenant), role=None)
                )
    return sorted(result.values(), key=lambda m: m.tenant.name.lower())


async def _me(db: AsyncSession, principal: Principal, settings: Settings) -> MeOut:
    system = await settings_service.load_system(db, settings)
    own = await settings_service.own_settings(db, principal)
    user = principal.user
    return MeOut(
        user=MeUser(
            id=user.id,
            username=user.username,
            email=user.email,
            first_name=user.first_name,
            last_name=user.last_name,
            display_name=user.display_name,
            is_system_admin=user.is_system_admin,
        ),
        active_tenant=TenantRef.model_validate(principal.tenant) if principal.tenant else None,
        role=principal.role,
        permissions=sorted(p.value for p in principal.permissions),
        memberships=await _memberships(db, principal),
        settings=settings_service.effective(system, principal.tenant, own),
        own_settings=settings_service.own_view(own),
        instance_name=system["instance_name"],
        account_url=settings.account_url,
        version=__version__,
    )


@router.get("/me", response_model=MeOut)
async def me(
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> MeOut:
    return await _me(db, principal, settings)


@router.patch("/me/settings", response_model=MeOut)
async def update_settings(
    data: SettingsUpdate,
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> MeOut:
    await settings_service.update_own(db, principal, data)
    return await _me(db, principal, settings)


@router.patch("/me/profile", response_model=MeOut)
async def update_profile(
    data: ProfileUpdate,
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
    idp: IdentityProvider = Depends(get_idp),
) -> MeOut:
    """Users may change their own name. The e-mail address is managed by administrators."""
    user = principal.user
    try:
        await idp.update_user(
            user.idp_id, email=user.email, first_name=data.first_name, last_name=data.last_name
        )
    except IdpUnavailable as exc:
        raise idp_unavailable() from exc
    except IdpError as exc:
        raise ApiError(502, "idp_error", "The identity provider rejected the request.") from exc
    user.first_name, user.last_name = data.first_name, data.last_name
    await db.flush()
    return await _me(db, principal, settings)


@router.post("/me/active-tenant", response_model=MeOut)
async def switch_tenant(
    data: ActiveTenantUpdate,
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> MeOut:
    """Enter another organization. Members may only enter organizations they belong to."""
    async with system_scope(db):
        tenant = await db.get(Tenant, data.tenant_id)
        membership = (
            await db.execute(
                select(Membership).where(
                    Membership.tenant_id == data.tenant_id, Membership.user_id == principal.user.id
                )
            )
        ).scalar_one_or_none()
        if tenant is None or not tenant.active or (membership is None and not principal.user.is_system_admin):
            # Same answer for "does not exist" and "not yours".
            raise not_found("Organization")
        principal.session.tenant_id = tenant.id
        prefs = await db.get(UserSettings, principal.user.id)
        if prefs is None:
            prefs = UserSettings(user_id=principal.user.id)
            db.add(prefs)
        prefs.last_tenant_id = tenant.id
        await db.flush()
    # The response describes the new context; the next request is bound to it by the session.
    role = Role(membership.role) if membership else None
    await set_rls_context(db, scope=Scope.TENANT, tenant_id=tenant.id, user_id=principal.user.id)
    switched = Principal(
        user=principal.user,
        session=principal.session,
        tenant=tenant,
        role=role,
        permissions=permissions_for(is_system_admin=principal.user.is_system_admin, role=role),
        ip=principal.ip,
    )
    return await _me(db, switched, settings)


# -- workspace -----------------------------------------------------------------------------------


@router.get("/workspace/apps", response_model=list[WorkspaceApp])
async def workspace_apps(
    principal: Principal = Depends(require(Permission.WORKSPACE_USE)),
    db: AsyncSession = Depends(get_db),
) -> list[WorkspaceApp]:
    return [apps_service.workspace_view(app) for app in await apps_service.visible_apps(db, principal)]


class LaunchIn(BaseModel):
    theme: Literal["light", "dark"] = "light"
    language: Literal["de", "en"] = "de"


@router.post("/workspace/apps/{app_id}/launch", response_model=LaunchOut)
async def launch_app(
    app_id: uuid.UUID,
    data: LaunchIn,
    principal: Principal = Depends(require(Permission.WORKSPACE_USE)),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> LaunchOut:
    return await apps_service.launch(
        db, principal, settings, app_id, theme=data.theme, language=data.language
    )


@router.get("/apps/{app_id}/icon", include_in_schema=False)
async def app_icon(
    app_id: uuid.UUID,
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> Response:
    tenant = principal.tenant
    if tenant is None:
        raise not_found("Icon")
    if Permission.APPS_MANAGE in principal.permissions:
        app = (
            await db.execute(select(App).where(App.id == app_id, App.tenant_id == tenant.id))
        ).scalar_one_or_none()
    elif Permission.WORKSPACE_USE in principal.permissions:
        app = await apps_service.visible_app(db, principal, app_id)
    else:
        raise forbidden()
    if app is None or app.icon_data is None:
        raise not_found("Icon")
    return Response(
        content=app.icon_data,
        media_type=app.icon_mime or "application/octet-stream",
        headers={
            # Uploaded SVGs are only ever used as images; should one be opened directly, this
            # policy keeps any script in it from running.
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=86400",
        },
    )
