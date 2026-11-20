"""System, tenant and personal settings, and how they combine.

Navigation position: the user's own choice wins unless the tenant locks it; otherwise the tenant
default applies, and without one the system default.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from velydock.api.deps import Principal
from velydock.config import Settings
from velydock.db import system_scope
from velydock.errors import ApiError
from velydock.idp.base import IdentityProvider, IdpError, SmtpConfig
from velydock.models import NavPosition, SystemSetting, Tenant, Theme, UserSettings
from velydock.schemas import (
    EffectiveSettings,
    OwnSettings,
    SettingsUpdate,
    SmtpSettings,
    SystemSettingsOut,
    SystemSettingsUpdate,
    TenantSettingsOut,
    TenantSettingsUpdate,
)
from velydock.services import audit

_KEY = "general"
_DEFAULTS: dict[str, Any] = {
    "instance_name": "Velydock",
    "default_nav_position": NavPosition.LEFT.value,
    "default_theme": Theme.SYSTEM.value,
    "default_language": "de",
    "require_admin_2fa": None,  # None: follow VELYDOCK_REQUIRE_ADMIN_2FA
}


async def load_system(db: AsyncSession, settings: Settings) -> dict[str, Any]:
    row = await db.get(SystemSetting, _KEY)
    values = {**_DEFAULTS, **(row.value if row else {})}
    if values["require_admin_2fa"] is None:
        values["require_admin_2fa"] = settings.require_admin_2fa
    return values


async def system_settings(db: AsyncSession, settings: Settings, idp: IdentityProvider) -> SystemSettingsOut:
    values = await load_system(db, settings)
    try:
        smtp = await idp.get_smtp()
    except IdpError:
        smtp = SmtpConfig()
    return SystemSettingsOut(
        instance_name=values["instance_name"],
        default_nav_position=values["default_nav_position"],
        default_theme=values["default_theme"],
        default_language=values["default_language"],
        require_admin_2fa=values["require_admin_2fa"],
        smtp=SmtpSettings(
            host=smtp.host,
            port=smtp.port,
            from_address=smtp.from_address,
            from_name=smtp.from_name,
            username=smtp.username,
            password="",
            encryption=smtp.encryption,
        ),
        smtp_configured=smtp.configured,
    )


async def update_system(
    db: AsyncSession,
    settings: Settings,
    idp: IdentityProvider,
    principal: Principal,
    data: SystemSettingsUpdate,
) -> SystemSettingsOut:
    async with system_scope(db):
        row = await db.get(SystemSetting, _KEY)
        values = dict(row.value) if row else {}
        changed = data.model_dump(exclude_unset=True, exclude={"smtp"}, mode="json")
        values.update(changed)
        if row is None:
            db.add(SystemSetting(key=_KEY, value=values))
        else:
            row.value = values
        await db.flush()
        try:
            if "instance_name" in changed:
                await idp.set_realm_display_name(changed["instance_name"])
            if data.smtp is not None:
                await idp.set_smtp(
                    SmtpConfig(
                        host=data.smtp.host,
                        port=data.smtp.port,
                        from_address=data.smtp.from_address,
                        from_name=data.smtp.from_name,
                        username=data.smtp.username,
                        password=data.smtp.password,
                        encryption=data.smtp.encryption,
                    )
                )
        except IdpError as exc:
            raise ApiError(
                502, "idp_error", "The identity provider rejected the settings.", {"reason": str(exc)[:200]}
            ) from exc
        await audit.record(
            db,
            principal,
            "system.settings",
            target_type="system",
            details={"fields": sorted([*changed, *(["smtp"] if data.smtp is not None else [])])},
            tenant_id=None,
        )
    return await system_settings(db, settings, idp)


def tenant_settings(tenant: Tenant) -> TenantSettingsOut:
    return TenantSettingsOut.model_validate(tenant)


async def update_tenant_settings(
    db: AsyncSession, principal: Principal, data: TenantSettingsUpdate
) -> TenantSettingsOut:
    tenant = principal.require_tenant()
    if data.nav_position_provided:
        tenant.default_nav_position = data.default_nav_position.value if data.default_nav_position else None
    if data.nav_position_locked is not None:
        tenant.nav_position_locked = data.nav_position_locked
    await db.flush()
    await audit.record(
        db,
        principal,
        "tenant.settings",
        target_type="tenant",
        target_id=tenant.id,
        target_label=tenant.name,
        details=data.model_dump(exclude_unset=True, mode="json"),
    )
    return tenant_settings(tenant)


async def own_settings(db: AsyncSession, principal: Principal) -> UserSettings | None:
    return await db.get(UserSettings, principal.user.id)


def effective(system: dict[str, Any], tenant: Tenant | None, own: UserSettings | None) -> EffectiveSettings:
    locked = bool(tenant and tenant.nav_position_locked)
    base_position = (tenant.default_nav_position if tenant else None) or system["default_nav_position"]
    position = base_position if locked or not (own and own.nav_position) else own.nav_position
    return EffectiveSettings(
        theme=(own.theme if own and own.theme else system["default_theme"]),
        nav_position=position,
        language=(own.language if own and own.language else system["default_language"]),
        nav_position_locked=locked,
    )


def own_view(own: UserSettings | None) -> OwnSettings:
    if own is None:
        return OwnSettings()
    return OwnSettings(theme=own.theme, nav_position=own.nav_position, language=own.language)


async def update_own(db: AsyncSession, principal: Principal, data: SettingsUpdate) -> UserSettings:
    """Store personal preferences. A field sent as null resets it to the default."""
    own = await db.get(UserSettings, principal.user.id)
    if own is None:
        own = UserSettings(user_id=principal.user.id)
        db.add(own)
    fields = data.model_fields_set
    if "theme" in fields:
        own.theme = data.theme.value if data.theme else None
    if "nav_position" in fields:
        own.nav_position = data.nav_position.value if data.nav_position else None
    if "language" in fields:
        own.language = data.language
    await db.flush()
    return own
