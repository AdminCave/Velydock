"""Applications: administration, visibility in the workspace, launching."""

from __future__ import annotations

import base64
import binascii
import re
import uuid
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.api.deps import Principal
from velydock.config import Settings
from velydock.errors import invalid, not_found
from velydock.models import (
    App,
    AppGroupGrant,
    AppPublication,
    AppType,
    AppUserGrant,
    EmbedStatus,
    Group,
    GroupMember,
    Membership,
)
from velydock.schemas import (
    MAX_ICON_BYTES,
    AppCreate,
    AppOut,
    AppUpdate,
    IconIn,
    LaunchOut,
    PublicationOut,
    WorkspaceApp,
)
from velydock.security.tokens import sign
from velydock.services import audit, proxy
from velydock.services.embedcheck import EmbedResult, check_embeddable

SANDBOX_TOKEN_PURPOSE = "custom-app"  # noqa: S105 - a key-derivation label, not a secret
SANDBOX_TOKEN_TTL = 300

# Raster formats are identified by their magic bytes, never by the claimed type.
_MAGIC: list[tuple[bytes, str]] = [
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
]


def _detect_image(data: bytes, claimed: str, what: str = "icon") -> str:
    for magic, mime in _MAGIC:
        if data.startswith(magic):
            return mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if claimed == "image/svg+xml":
        head = data[:2000].decode("utf-8", errors="ignore").lstrip("﻿ \t\r\n").lower()
        if head.startswith("<svg") or (head.startswith("<?xml") and "<svg" in head):
            return "image/svg+xml"
    raise invalid(f"The {what} must be a PNG, JPEG, GIF, WebP or SVG image.", f"{what}_invalid")


def decode_image(data_url: str, what: str = "icon") -> tuple[bytes, str]:
    """An uploaded image (an app icon, an organization's logo) from its ``data:`` URL.

    ``what`` names it in the error ("icon_invalid", "logo_too_large", …).
    """
    if not data_url.startswith("data:") or ";base64," not in data_url:
        raise invalid(f"The {what} must be a base64 data URL.", f"{what}_invalid")
    header, _, payload = data_url.partition(";base64,")
    try:
        data = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise invalid(f"The {what} is not valid base64.", f"{what}_invalid") from exc
    if not data or len(data) > MAX_ICON_BYTES:
        raise invalid(f"The {what} must be at most {MAX_ICON_BYTES // 1024} KB.", f"{what}_too_large")
    return data, _detect_image(data, header[5:].lower(), what)


def decode_icon(data_url: str) -> tuple[bytes, str]:
    return decode_image(data_url, "icon")


# Uploaded SVGs are only ever used as images; should one be opened directly, this policy keeps
# any script in it from running.
IMAGE_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=86400",
}


# A host name in its ASCII form. Underscores are tolerated: internal names often have them.
_HOST_NAME = re.compile(
    r"[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*\.?", re.IGNORECASE
)


def validate_url(url: str | None, app_type: AppType, settings: Settings) -> str | None:
    if app_type == AppType.CUSTOM:
        return None
    if not url:
        raise invalid("An address (URL) is required.", "url_required")
    not_an_address = invalid("The address is not valid.", "url_invalid")
    if any(ch.isspace() or ord(ch) < 0x20 for ch in url):
        raise not_an_address
    try:
        parts = urlsplit(url)
        hostname = parts.hostname
        # Both raise ValueError for what is not an address: a port that is no number, an empty
        # label ("example..com"), an unclosed IPv6 bracket.
        _ = parts.port
        if hostname and ":" not in hostname and not _HOST_NAME.fullmatch(hostname.encode("idna").decode()):
            raise not_an_address
    except ValueError:
        raise not_an_address from None
    if parts.scheme not in ("http", "https") or not hostname:
        raise invalid("The address must start with https:// or http://.", "url_invalid")
    if parts.username or parts.password:
        raise invalid("The address must not contain credentials.", "url_invalid")
    if app_type == AppType.EMBEDDED and parts.scheme == "http" and settings.secure_cookies:
        # Browsers refuse to load http frames in an https page (mixed content).
        raise invalid("Embedded apps need an https:// address.", "url_needs_https")
    return url


def _icon_url(app: App) -> str | None:
    if app.icon_data is None:
        return None
    # In milliseconds: an icon replaced twice within one second must not stay hidden behind
    # the cached first one.
    return f"/api/v1/apps/{app.id}/icon?v={int(app.updated_at.timestamp() * 1000)}"


async def _grants(
    db: AsyncSession, tenant_id: uuid.UUID, app_ids: list[uuid.UUID]
) -> tuple[dict[uuid.UUID, list[uuid.UUID]], dict[uuid.UUID, list[uuid.UUID]]]:
    groups: dict[uuid.UUID, list[uuid.UUID]] = {a: [] for a in app_ids}
    users: dict[uuid.UUID, list[uuid.UUID]] = {a: [] for a in app_ids}
    if app_ids:
        for app_id, group_id in (
            await db.execute(
                select(AppGroupGrant.app_id, AppGroupGrant.group_id).where(
                    AppGroupGrant.tenant_id == tenant_id, AppGroupGrant.app_id.in_(app_ids)
                )
            )
        ).all():
            groups[app_id].append(group_id)
        for app_id, user_id in (
            await db.execute(
                select(AppUserGrant.app_id, AppUserGrant.user_id).where(
                    AppUserGrant.tenant_id == tenant_id, AppUserGrant.app_id.in_(app_ids)
                )
            )
        ).all():
            users[app_id].append(user_id)
    return groups, users


def _out(
    app: App,
    group_ids: list[uuid.UUID],
    user_ids: list[uuid.UUID],
    publication: PublicationOut | None = None,
) -> AppOut:
    return AppOut(
        id=app.id,
        name=app.name,
        description=app.description,
        type=AppType(app.type),
        url=app.url,
        enabled=app.enabled,
        sort_order=app.sort_order,
        visible_to_all=app.visible_to_all,
        group_ids=group_ids,
        user_ids=user_ids,
        icon_name=app.icon_name,
        icon_url=_icon_url(app),
        frame_permissions=list(app.frame_permissions or []),
        embed_status=EmbedStatus(app.embed_status),
        embed_detail=app.embed_detail,
        embed_checked_at=app.embed_checked_at,
        custom_html=app.custom_html,
        custom_css=app.custom_css,
        custom_js=app.custom_js,
        custom_allow_network=app.custom_allow_network,
        created_at=app.created_at,
        updated_at=app.updated_at,
        publication=publication,
    )


async def _load(db: AsyncSession, tenant_id: uuid.UUID, app_id: uuid.UUID) -> App:
    app = (
        await db.execute(select(App).where(App.id == app_id, App.tenant_id == tenant_id))
    ).scalar_one_or_none()
    if app is None:
        raise not_found("App")
    return app


async def _validated_grants(
    db: AsyncSession, tenant_id: uuid.UUID, group_ids: list[uuid.UUID], user_ids: list[uuid.UUID]
) -> tuple[list[uuid.UUID], list[uuid.UUID]]:
    group_ids = list(dict.fromkeys(group_ids))
    user_ids = list(dict.fromkeys(user_ids))
    if group_ids:
        found = set(
            (
                await db.execute(
                    select(Group.id).where(Group.tenant_id == tenant_id, Group.id.in_(group_ids))
                )
            ).scalars()
        )
        if len(found) != len(group_ids):
            raise invalid("One or more groups do not exist.", "unknown_group")
    if user_ids:
        found = set(
            (
                await db.execute(
                    select(Membership.user_id).where(
                        Membership.tenant_id == tenant_id, Membership.user_id.in_(user_ids)
                    )
                )
            ).scalars()
        )
        if len(found) != len(user_ids):
            raise invalid("One or more users do not belong to this organization.", "unknown_user")
    return group_ids, user_ids


async def _set_grants(
    db: AsyncSession, app: App, group_ids: list[uuid.UUID] | None, user_ids: list[uuid.UUID] | None
) -> None:
    if group_ids is not None:
        await db.execute(
            delete(AppGroupGrant).where(
                AppGroupGrant.app_id == app.id, AppGroupGrant.tenant_id == app.tenant_id
            )
        )
        db.add_all([AppGroupGrant(app_id=app.id, group_id=g, tenant_id=app.tenant_id) for g in group_ids])
    if user_ids is not None:
        await db.execute(
            delete(AppUserGrant).where(AppUserGrant.app_id == app.id, AppUserGrant.tenant_id == app.tenant_id)
        )
        db.add_all([AppUserGrant(app_id=app.id, user_id=u, tenant_id=app.tenant_id) for u in user_ids])
    await db.flush()


def _apply_icon(app: App, icon: IconIn | None) -> None:
    if icon is None:
        return
    if icon.data_url:
        app.icon_data, app.icon_mime = decode_icon(icon.data_url)
        app.icon_name = None
    else:
        app.icon_name = icon.name
        app.icon_data = None
        app.icon_mime = None


def _apply_embed_result(app: App, result: EmbedResult | None) -> None:
    if result is None:
        app.embed_status, app.embed_detail, app.embed_checked_at = EmbedStatus.UNKNOWN.value, "", None
        return
    app.embed_status = result.status.value
    app.embed_detail = result.detail[:300]
    app.embed_checked_at = datetime.now(UTC)


async def run_embed_check(url: str, settings: Settings) -> EmbedResult:
    return await check_embeddable(
        url, embedder_origin=settings.public_origin, allow_private=settings.embed_check_allow_private
    )


async def list_apps(db: AsyncSession, principal: Principal, settings: Settings) -> list[AppOut]:
    tenant = principal.require_tenant()
    apps = list(
        (
            await db.execute(
                select(App).where(App.tenant_id == tenant.id).order_by(App.sort_order, func.lower(App.name))
            )
        ).scalars()
    )
    groups, users = await _grants(db, tenant.id, [a.id for a in apps])
    published = await proxy.publications_of(db, settings, tenant.id, [a.id for a in apps])
    return [_out(a, groups[a.id], users[a.id], published.get(a.id)) for a in apps]


async def get_app(db: AsyncSession, principal: Principal, settings: Settings, app_id: uuid.UUID) -> AppOut:
    tenant = principal.require_tenant()
    app = await _load(db, tenant.id, app_id)
    groups, users = await _grants(db, tenant.id, [app.id])
    published = await proxy.publications_of(db, settings, tenant.id, [app.id])
    return _out(app, groups[app.id], users[app.id], published.get(app.id))


async def create_app(db: AsyncSession, principal: Principal, settings: Settings, data: AppCreate) -> AppOut:
    tenant = principal.require_tenant()
    if data.publication is not None:
        # The address of a published app is the public one the proxy serves; it is set below,
        # once the publication is accepted.
        proxy.require_enabled(settings)
        url = None
    else:
        url = validate_url(data.url, data.type, settings)
    if data.type == AppType.CUSTOM and not data.custom_html.strip():
        raise invalid("A custom app needs HTML content.", "content_required")
    group_ids, user_ids = await _validated_grants(db, tenant.id, data.group_ids, data.user_ids)
    next_order = (
        await db.execute(
            select(func.coalesce(func.max(App.sort_order), 0) + 10).where(App.tenant_id == tenant.id)
        )
    ).scalar_one()
    app = App(
        tenant_id=tenant.id,
        name=data.name,
        description=data.description,
        type=data.type.value,
        url=url,
        enabled=data.enabled,
        visible_to_all=data.visible_to_all,
        sort_order=next_order,
        frame_permissions=list(data.frame_permissions) if data.type == AppType.EMBEDDED else [],
        custom_html=data.custom_html if data.type == AppType.CUSTOM else "",
        custom_css=data.custom_css if data.type == AppType.CUSTOM else "",
        custom_js=data.custom_js if data.type == AppType.CUSTOM else "",
        custom_allow_network=data.custom_allow_network if data.type == AppType.CUSTOM else False,
    )
    _apply_icon(app, data.icon)
    if data.type == AppType.EMBEDDED and url:
        _apply_embed_result(app, await run_embed_check(url, settings))
    db.add(app)
    await db.flush()
    details: dict[str, Any] = {"type": app.type}
    if data.publication is not None:
        publication = await proxy.publish(
            db, settings, app, data.publication, by_system_admin=principal.user.is_system_admin
        )
        details["publication"] = _publication_details(publication)
    await _set_grants(db, app, group_ids, user_ids)
    await audit.record(
        db,
        principal,
        "app.create",
        target_type="app",
        target_id=app.id,
        target_label=app.name,
        details=details,
    )
    await db.flush()
    await db.refresh(app)
    return await get_app(db, principal, settings, app.id)


async def update_app(
    db: AsyncSession, principal: Principal, settings: Settings, app_id: uuid.UUID, data: AppUpdate
) -> AppOut:
    tenant = principal.require_tenant()
    app = await _load(db, tenant.id, app_id)
    fields = data.model_fields_set
    new_type = data.type if data.type is not None else AppType(app.type)
    existing = await db.get(AppPublication, app.id)
    # Published after this change? Then the address is the proxy's, not the one in the request.
    if "publication" in fields:
        published = data.publication is not None
    else:
        published = existing is not None and new_type in (AppType.EMBEDDED, AppType.EXTERNAL)
    if published:
        url = app.url
        url_changed = False
    else:
        if existing is not None and "url" not in fields and new_type != AppType.CUSTOM:
            # The public address stops working with the publication; keeping it would leave an
            # app that leads nowhere.
            raise invalid("Enter the address the app has from now on.", "url_required")
        new_url = data.url if "url" in fields else app.url
        url = validate_url(new_url, new_type, settings)
        url_changed = url != app.url or new_type.value != app.type

    if data.name is not None:
        app.name = data.name
    if data.description is not None:
        app.description = data.description
    if data.enabled is not None:
        app.enabled = data.enabled
    if data.visible_to_all is not None:
        app.visible_to_all = data.visible_to_all
    app.type = new_type.value
    app.url = url

    publication_change: Any = None
    if published and data.publication is not None:
        publication = await proxy.publish(
            db, settings, app, data.publication, by_system_admin=principal.user.is_system_admin
        )
        publication_change = _publication_details(publication)
    elif not published and existing is not None:
        await proxy.unpublish(db, app)
        publication_change = "removed"

    if new_type == AppType.EMBEDDED:
        if data.frame_permissions is not None:
            app.frame_permissions = list(data.frame_permissions)
        if published:
            # The check would be sent to Velydock's own sign-in; what the app answers behind
            # the proxy is not known from here.
            _apply_embed_result(app, None)
        elif url and (url_changed or app.embed_checked_at is None):
            _apply_embed_result(app, await run_embed_check(url, settings))
    else:
        app.frame_permissions = []
        _apply_embed_result(app, None)

    if new_type == AppType.CUSTOM:
        if data.custom_html is not None:
            app.custom_html = data.custom_html
        if data.custom_css is not None:
            app.custom_css = data.custom_css
        if data.custom_js is not None:
            app.custom_js = data.custom_js
        if data.custom_allow_network is not None:
            app.custom_allow_network = data.custom_allow_network
        if not app.custom_html.strip():
            raise invalid("A custom app needs HTML content.", "content_required")
    else:
        app.custom_html = app.custom_css = app.custom_js = ""
        app.custom_allow_network = False

    if "icon" in fields:
        if data.icon is None:
            app.icon_name, app.icon_data, app.icon_mime = None, None, None
        else:
            _apply_icon(app, data.icon)

    group_ids = user_ids = None
    if data.group_ids is not None or data.user_ids is not None:
        group_ids, user_ids = await _validated_grants(
            db, tenant.id, data.group_ids or [], data.user_ids or []
        )
        await _set_grants(
            db,
            app,
            group_ids if data.group_ids is not None else None,
            user_ids if data.user_ids is not None else None,
        )
    # Bump the timestamp even if only grants changed, so cached icon URLs and sandbox tokens rotate.
    app.updated_at = datetime.now(UTC)
    await db.flush()
    await audit.record(
        db,
        principal,
        "app.update",
        target_type="app",
        target_id=app.id,
        target_label=app.name,
        details={
            "fields": sorted(fields),
            **({"publication": publication_change} if publication_change is not None else {}),
        },
    )
    await db.refresh(app)
    return await get_app(db, principal, settings, app.id)


def _publication_details(publication: AppPublication) -> dict[str, Any]:
    """What the log keeps about a publication: enough to see what was opened to whom."""
    return {
        "name": publication.name,
        "mode": publication.mode,
        "access": publication.access,
        "target": publication.target_url,
        "template": publication.template,
    }


async def recheck_app(
    db: AsyncSession, principal: Principal, settings: Settings, app_id: uuid.UUID
) -> AppOut:
    tenant = principal.require_tenant()
    app = await _load(db, tenant.id, app_id)
    if app.type != AppType.EMBEDDED.value or not app.url:
        raise invalid("Only embedded apps can be checked.", "not_embedded")
    if await db.get(AppPublication, app.id) is not None:
        raise invalid("A published app cannot be checked from here.", "not_embedded")
    _apply_embed_result(app, await run_embed_check(app.url, settings))
    await db.flush()
    return await get_app(db, principal, settings, app.id)


async def delete_app(db: AsyncSession, principal: Principal, app_id: uuid.UUID) -> None:
    tenant = principal.require_tenant()
    app = await _load(db, tenant.id, app_id)
    name = app.name
    await db.delete(app)
    await db.flush()
    await audit.record(db, principal, "app.delete", target_type="app", target_id=app_id, target_label=name)


async def reorder_apps(
    db: AsyncSession, principal: Principal, settings: Settings, app_ids: list[uuid.UUID]
) -> list[AppOut]:
    tenant = principal.require_tenant()
    apps = {a.id: a for a in (await db.execute(select(App).where(App.tenant_id == tenant.id))).scalars()}
    if set(app_ids) != set(apps) or len(app_ids) != len(apps):
        raise invalid("The order must list every app of this organization exactly once.", "order_mismatch")
    for position, app_id in enumerate(app_ids, start=1):
        apps[app_id].sort_order = position * 10
    await db.flush()
    await audit.record(db, principal, "app.reorder", target_type="app", details={"count": len(app_ids)})
    return await list_apps(db, principal, settings)


# -- workspace -----------------------------------------------------------------------------------


async def visible_apps(db: AsyncSession, principal: Principal) -> list[App]:
    """The enabled apps of the active tenant that this user has been granted.

    System administrators who entered a tenant without being a member see all of its apps.
    """
    tenant = principal.tenant
    if tenant is None:
        return []
    query = select(App).where(App.tenant_id == tenant.id, App.enabled.is_(True))
    if principal.role is None and principal.user.is_system_admin:
        pass
    elif principal.role is None:
        return []
    else:
        user_id = principal.user.id
        group_grant = (
            select(AppGroupGrant.app_id)
            .join(GroupMember, GroupMember.group_id == AppGroupGrant.group_id)
            .where(
                AppGroupGrant.tenant_id == tenant.id,
                GroupMember.tenant_id == tenant.id,
                GroupMember.user_id == user_id,
            )
        )
        user_grant = select(AppUserGrant.app_id).where(
            AppUserGrant.tenant_id == tenant.id, AppUserGrant.user_id == user_id
        )
        query = query.where(
            or_(App.visible_to_all.is_(True), App.id.in_(group_grant), App.id.in_(user_grant))
        )
    return list((await db.execute(query.order_by(App.sort_order, func.lower(App.name)))).scalars())


def workspace_view(app: App) -> WorkspaceApp:
    return WorkspaceApp(
        id=app.id,
        name=app.name,
        description=app.description,
        type=AppType(app.type),
        url=app.url if app.type != AppType.CUSTOM.value else None,
        icon_name=app.icon_name,
        icon_url=_icon_url(app),
        frame_permissions=list(app.frame_permissions or []),
        embed_status=EmbedStatus(app.embed_status),
    )


async def visible_app(db: AsyncSession, principal: Principal, app_id: uuid.UUID) -> App:
    for app in await visible_apps(db, principal):
        if app.id == app_id:
            return app
    raise not_found("App")


async def launch(
    db: AsyncSession,
    principal: Principal,
    settings: Settings,
    app_id: uuid.UUID,
    *,
    theme: str,
    language: str,
) -> LaunchOut:
    app = await visible_app(db, principal, app_id)
    if app.type != AppType.CUSTOM.value:
        return LaunchOut(url=app.url or "")
    token = sign(
        settings.secret_key,
        SANDBOX_TOKEN_PURPOSE,
        {
            "app": str(app.id),
            "ver": int(app.updated_at.timestamp()),
            "theme": theme if theme in ("light", "dark") else "light",
            "lang": language if language in ("de", "en") else "en",
        },
        SANDBOX_TOKEN_TTL,
    )
    return LaunchOut(url=f"{settings.sandbox_url}/c/{token}", expires_in=SANDBOX_TOKEN_TTL)
