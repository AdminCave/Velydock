"""System, tenant and personal settings, and how they combine.

Navigation position: the user's own choice wins unless the tenant locks it; otherwise the tenant
default applies, and without one the system default.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.api.deps import Principal
from velydock.config import Settings
from velydock.db import system_scope
from velydock.errors import ApiError, invalid
from velydock.idp.base import IdentityProvider, IdpError, SmtpConfig
from velydock.models import (
    AppBar,
    Membership,
    NavPosition,
    Role,
    SystemSetting,
    Tenant,
    Theme,
    User,
    UserSettings,
)
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
from velydock.services.apps import decode_image

log = logging.getLogger(__name__)

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
        before = await load_system(db, settings)
        row = await db.get(SystemSetting, _KEY)
        values = dict(row.value) if row else {}
        # An explicit null means "leave as it is", like a field that was not sent: none of
        # these settings can be empty.
        changed = data.model_dump(exclude_unset=True, exclude_none=True, exclude={"smtp"}, mode="json")
        values.update(changed)
        if row is None:
            db.add(SystemSetting(key=_KEY, value=values))
        else:
            row.value = values
        await db.flush()
        try:
            if "instance_name" in changed:
                await idp.set_realm_display_name(changed["instance_name"])
            if "default_language" in changed:
                # The language of the sign-in pages and e-mails for everyone without a choice.
                await idp.set_default_locale(changed["default_language"])
            if data.smtp is not None:
                if data.smtp.host and data.smtp.username and not data.smtp.password:
                    # An empty password field means "keep the stored one". Keycloak only keeps
                    # it while the connection is the same; otherwise it would silently drop it
                    # and mail delivery would fail from then on.
                    stored = await idp.get_smtp()
                    if (
                        stored.host,
                        stored.port,
                        stored.encryption,
                        stored.from_address,
                        stored.username,
                    ) != (
                        data.smtp.host,
                        data.smtp.port,
                        data.smtp.encryption,
                        data.smtp.from_address,
                        data.smtp.username,
                    ):
                        raise invalid(
                            "Enter the SMTP password again: the connection settings have changed.",
                            "smtp_password_required",
                            {"fields": [{"field": "smtp.password", "message": "is required again"}]},
                        )
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
        if changed.get("require_admin_2fa") is False and before["require_admin_2fa"]:
            await _withdraw_pending_enrolments(db, idp)
        await audit.record(
            db,
            principal,
            "system.settings",
            target_type="system",
            details={
                "fields": sorted([*changed, *(["smtp"] if data.smtp is not None else [])]),
                # The new values, so the log says "switched off", not only "changed".
                "values": changed,
            },
            tenant_id=None,
        )
    return await system_settings(db, settings, idp)


async def _withdraw_pending_enrolments(db: AsyncSession, idp: IdentityProvider) -> None:
    """The second-factor requirement was switched off: nobody is to be held to it any more.

    Administrators who were asked to enrol and have not done so yet would otherwise still be
    stopped at their next sign-in. Best effort - one account that fails does not stop the rest.
    """
    rows = await db.execute(
        select(User.idp_id)
        .outerjoin(Membership, Membership.user_id == User.id)
        .where(
            (User.is_system_admin.is_(True))
            | (Membership.role.in_([Role.TENANT_ADMIN.value, Role.USER_MANAGER.value]))
        )
        .distinct()
    )
    for idp_id in rows.scalars():
        try:
            await idp.withdraw_second_factor_setup(idp_id)
        except IdpError:
            log.exception("could not withdraw the pending second-factor enrolment of %s", idp_id)


def logo_url(tenant: Tenant) -> str | None:
    """Where the interface loads the logo of the active organization, or None without one.

    The version changes with every change to the organization, so a new logo is never hidden
    behind a cached old one - in milliseconds: two uploads within one second are still two.
    """
    if tenant.logo_mime is None:
        return None
    return f"/api/v1/tenant/logo?v={int(tenant.updated_at.timestamp() * 1000)}"


def tenant_settings(tenant: Tenant) -> TenantSettingsOut:
    return TenantSettingsOut(
        id=tenant.id,
        slug=tenant.slug,
        name=tenant.name,
        default_theme=tenant.default_theme,
        theme_locked=tenant.theme_locked,
        accent_color=tenant.accent_color,
        accent_locked=tenant.accent_locked,
        default_nav_position=tenant.default_nav_position,
        nav_position_locked=tenant.nav_position_locked,
        default_app_bar=tenant.default_app_bar,
        app_bar_locked=tenant.app_bar_locked,
        logo_url=logo_url(tenant),
    )


# Appearance settings of an organization: a default that may be empty, and its lock.
_TENANT_DEFAULTS = ("default_theme", "accent_color", "default_nav_position", "default_app_bar")
_TENANT_LOCKS = ("theme_locked", "accent_locked", "nav_position_locked", "app_bar_locked")


async def update_tenant_settings(
    db: AsyncSession, principal: Principal, data: TenantSettingsUpdate
) -> TenantSettingsOut:
    tenant = principal.require_tenant()
    sent = data.model_fields_set
    changed: dict[str, Any] = {}
    for name in _TENANT_DEFAULTS:
        if name in sent:
            value = getattr(data, name)
            value = getattr(value, "value", value)  # an enumeration or a plain string
            if value != getattr(tenant, name):
                setattr(tenant, name, value)
                changed[name] = value
    for name in _TENANT_LOCKS:
        value = getattr(data, name)
        if value is not None and value != getattr(tenant, name):
            setattr(tenant, name, value)
            changed[name] = value
    if "logo" in sent:
        if data.logo is None:
            if tenant.logo_mime is not None:
                tenant.logo_data, tenant.logo_mime = None, None
                changed["logo"] = "removed"
        else:
            tenant.logo_data, tenant.logo_mime = decode_image(data.logo.data_url, "logo")
            # The image itself does not belong into the log, only that it changed.
            changed["logo"] = "changed"
    if not changed:
        return tenant_settings(tenant)
    await db.flush()
    await db.refresh(tenant, ["updated_at"])
    await audit.record(
        db,
        principal,
        "tenant.settings",
        target_type="tenant",
        target_id=tenant.id,
        target_label=tenant.name,
        details=changed,
    )
    return tenant_settings(tenant)


async def tenant_logo(db: AsyncSession, tenant: Tenant) -> tuple[bytes, str] | None:
    row = (
        await db.execute(select(Tenant.logo_data, Tenant.logo_mime).where(Tenant.id == tenant.id))
    ).one_or_none()
    if row is None or row[0] is None:
        return None
    return bytes(row[0]), row[1] or "application/octet-stream"


async def own_settings(db: AsyncSession, principal: Principal) -> UserSettings | None:
    return await db.get(UserSettings, principal.user.id)


def _resolve(own: Any, tenant_default: Any, locked: bool, fallback: Any) -> Any:
    """One appearance setting: the user's choice, unless the organization fixed its own.

    Locked, the organization's default holds for everybody (and without one, what comes after
    it). Unlocked, the user's choice wins; without one the organization's default applies, and
    without that the system's.
    """
    base = tenant_default if tenant_default is not None else fallback
    return base if locked or own is None else own


def effective(system: dict[str, Any], tenant: Tenant | None, own: UserSettings | None) -> EffectiveSettings:
    def lock(name: str) -> bool:
        return bool(tenant and getattr(tenant, name))

    def default(name: str) -> Any:
        return getattr(tenant, name) if tenant else None

    def chosen(name: str) -> Any:
        return (getattr(own, name) or None) if own else None

    return EffectiveSettings(
        theme=_resolve(
            chosen("theme"), default("default_theme"), lock("theme_locked"), system["default_theme"]
        ),
        nav_position=_resolve(
            chosen("nav_position"),
            default("default_nav_position"),
            lock("nav_position_locked"),
            system["default_nav_position"],
        ),
        accent_color=_resolve(chosen("accent_color"), default("accent_color"), lock("accent_locked"), None),
        app_bar=_resolve(
            chosen("app_bar"), default("default_app_bar"), lock("app_bar_locked"), AppBar.TOP.value
        ),
        language=(own.language if own and own.language else system["default_language"]),
        theme_locked=lock("theme_locked"),
        nav_position_locked=lock("nav_position_locked"),
        accent_locked=lock("accent_locked"),
        app_bar_locked=lock("app_bar_locked"),
    )


def own_view(own: UserSettings | None) -> OwnSettings:
    if own is None:
        return OwnSettings()
    return OwnSettings(
        theme=own.theme,
        nav_position=own.nav_position,
        accent_color=own.accent_color,
        app_bar=own.app_bar,
        language=own.language,
    )


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
    if "accent_color" in fields:
        own.accent_color = data.accent_color
    if "app_bar" in fields:
        own.app_bar = data.app_bar.value if data.app_bar else None
    if "language" in fields:
        own.language = data.language
    await db.flush()
    return own
