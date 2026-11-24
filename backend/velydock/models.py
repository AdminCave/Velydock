"""SQLAlchemy models.

Tenant-owned tables carry ``tenant_id`` and are protected by row-level security (see the initial
migration). ``users`` holds one row per identity in the shared Keycloak realm; which tenants an
identity may enter is decided by ``memberships``.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Role(StrEnum):
    MEMBER = "member"
    USER_MANAGER = "user_manager"
    TENANT_ADMIN = "tenant_admin"


class AppType(StrEnum):
    EMBEDDED = "embedded"
    EXTERNAL = "external"
    CUSTOM = "custom"


class NavPosition(StrEnum):
    LEFT = "left"
    RIGHT = "right"
    TOP = "top"
    BOTTOM = "bottom"


class Theme(StrEnum):
    SYSTEM = "system"
    LIGHT = "light"
    DARK = "dark"


class AppBar(StrEnum):
    """Where the bar with an open app's name and actions sits."""

    TOP = "top"
    BOTTOM = "bottom"
    HIDDEN = "hidden"


class PublicationMode(StrEnum):
    """How a published app is addressed below the apps host."""

    PATH = "path"  # https://apps.example.com/<name>/
    SUBDOMAIN = "subdomain"  # https://<name>.apps.example.com/


class PublicationAccess(StrEnum):
    PROTECTED = "protected"  # only signed-in users who are granted the app
    PUBLIC = "public"  # anybody who knows the address


class EmbedStatus(StrEnum):
    UNKNOWN = "unknown"
    OK = "ok"
    BLOCKED = "blocked"


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def _created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


def _updated() -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[uuid.UUID] = _uuid_pk()
    slug: Mapped[str] = mapped_column(String(40), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    # Mirror of this tenant in Keycloak (an Organization in the shared realm).
    idp_org_id: Mapped[str | None] = mapped_column(String(64))
    # Appearance. Each setting has the organization's default (NULL: none, the next level
    # decides) and a lock: locked, the default holds for everybody; unlocked, members may choose.
    default_nav_position: Mapped[str | None] = mapped_column(String(10))
    nav_position_locked: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    default_theme: Mapped[str | None] = mapped_column(String(10))
    theme_locked: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    accent_color: Mapped[str | None] = mapped_column(String(7))
    accent_locked: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    default_app_bar: Mapped[str | None] = mapped_column(String(10))
    app_bar_locked: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    # The organization's logo. The image itself is only read when it is served: a tenant row is
    # loaded with every request, and must not drag a quarter of a megabyte along each time.
    logo_data: Mapped[bytes | None] = mapped_column(LargeBinary, deferred=True)
    logo_mime: Mapped[str | None] = mapped_column(String(40))
    # May this organization publish apps by path (apps.example.com/name/)? Apps published that
    # way share one origin in the browser - also with those of other organizations. Decided by
    # the system administrator; the database keeps the organization itself from changing it.
    proxy_path_allowed: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    __table_args__ = (Index("uq_tenants_name_lower", func.lower(name), unique=True),)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    # Keycloak user id (the OIDC ``sub``).
    idp_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    username: Mapped[str] = mapped_column(String(150), nullable=False)
    email: Mapped[str | None] = mapped_column(String(254))
    first_name: Mapped[str] = mapped_column(String(100), nullable=False, server_default="")
    last_name: Mapped[str] = mapped_column(String(100), nullable=False, server_default="")
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    is_system_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    # The tenant that owns this identity. Its admins may edit the profile, reset credentials and
    # disable the account; other tenants only hold a (guest) membership.
    home_tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="SET NULL")
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    __table_args__ = (
        Index("uq_users_username_lower", func.lower(username), unique=True),
        Index(
            "uq_users_email_lower",
            func.lower(email),
            unique=True,
            postgresql_where=text("email IS NOT NULL"),
        ),
        Index("ix_users_home_tenant", "home_tenant_id"),
    )

    @property
    def display_name(self) -> str:
        full = f"{self.first_name} {self.last_name}".strip()
        return full or self.username


class Membership(Base):
    __tablename__ = "memberships"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(20), nullable=False, server_default=Role.MEMBER.value)
    created_at: Mapped[datetime] = _created()

    __table_args__ = (
        UniqueConstraint("tenant_id", "user_id", name="uq_memberships_tenant_user"),
        Index("ix_memberships_user", "user_id"),
    )


class Group(Base):
    __tablename__ = "groups"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False, server_default="")
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    __table_args__ = (Index("uq_groups_tenant_name_lower", "tenant_id", func.lower(name), unique=True),)


class GroupMember(Base):
    __tablename__ = "group_members"

    group_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )

    __table_args__ = (Index("ix_group_members_user", "user_id"),)


class App(Base):
    __tablename__ = "apps"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False, server_default="")
    type: Mapped[str] = mapped_column(String(10), nullable=False)
    url: Mapped[str | None] = mapped_column(String(2000))
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    # Either everyone in the tenant sees the app, or only the granted groups and users.
    visible_to_all: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))

    # Icon: a built-in glyph name, or an uploaded image kept in the database (simple backups).
    icon_name: Mapped[str | None] = mapped_column(String(40))
    icon_data: Mapped[bytes | None] = mapped_column(LargeBinary)
    icon_mime: Mapped[str | None] = mapped_column(String(40))

    # Embedded apps: browser features delegated to the frame, and the last embeddability check.
    frame_permissions: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    embed_status: Mapped[str] = mapped_column(
        String(10), nullable=False, server_default=EmbedStatus.UNKNOWN.value
    )
    embed_detail: Mapped[str] = mapped_column(String(300), nullable=False, server_default="")
    embed_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Custom apps: author-supplied content, only ever served from the sandbox origin.
    custom_html: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    custom_css: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    custom_js: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    custom_allow_network: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))

    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    __table_args__ = (Index("ix_apps_tenant", "tenant_id", "sort_order"),)


class AppPublication(Base):
    """An app that the bundled reverse proxy serves from an internal address.

    The public address follows from ``mode`` and ``name``; ``name`` is unique across all
    organizations because the addresses are.
    """

    __tablename__ = "app_publications"

    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("apps.id", ondelete="CASCADE"), primary_key=True
    )
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(40), unique=True, nullable=False)
    mode: Mapped[str] = mapped_column(String(10), nullable=False)
    # Where the proxy sends the requests: an address the system administrator released.
    target_url: Mapped[str] = mapped_column(String(500), nullable=False)
    access: Mapped[str] = mapped_column(
        String(10), nullable=False, server_default=PublicationAccess.PROTECTED.value
    )
    # A built-in template ("builtin:standard") or the id of one the system administrator made.
    template: Mapped[str] = mapped_column(String(60), nullable=False, server_default="builtin:standard")
    # What this publication sets differently from its template.
    options: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    __table_args__ = (Index("ix_app_publications_tenant", "tenant_id"),)


class ProxyTarget(Base):
    """An address range or host an organization may publish apps from. Set by system administrators."""

    __tablename__ = "proxy_targets"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    # A network ("10.20.0.0/16"), an address ("10.20.0.7") or a host name ("nas.intern"),
    # optionally with a port (":8080", "[fd00::7]:8080").
    value: Mapped[str] = mapped_column(String(255), nullable=False)
    note: Mapped[str] = mapped_column(String(200), nullable=False, server_default="")
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("uq_proxy_targets", "tenant_id", "value", unique=True),)


class ProxyTemplate(Base):
    """Proxy settings under a name, made by system administrators for all organizations."""

    __tablename__ = "proxy_templates"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str] = mapped_column(String(300), nullable=False, server_default="")
    options: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    __table_args__ = (Index("uq_proxy_templates_name_lower", func.lower(name), unique=True),)


class Certificate(Base):
    """A TLS certificate with its private key, uploaded for the bundled proxy to serve.

    System scope only, for every operation (see migration 0004): no request of an organization
    can read a private key, whatever the query. The key never leaves through the API either.
    """

    __tablename__ = "certificates"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    # PEM: the certificate itself first, then the certificates that lead to its issuer.
    certificate: Mapped[str] = mapped_column(Text, nullable=False)
    # PEM, PKCS#8, without a passphrase: the proxy must be able to read it unattended.
    private_key: Mapped[str] = mapped_column(Text, nullable=False)
    # SHA-256 of the certificate (DER), hex. Also the name of its files for the proxy.
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    # The names it is valid for (DNS names in lower case, "*." for wildcards; addresses as text).
    names: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    subject: Mapped[str] = mapped_column(String(500), nullable=False, server_default="")
    issuer: Mapped[str] = mapped_column(String(500), nullable=False, server_default="")
    # Subjects of the certificates stored with it, the certificate itself first.
    chain: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    # The key the proxy files this certificate under: by it, it decides which of two certificates
    # for the same name it serves (see services/certificates.py, `proxy_key`).
    proxy_key: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    # What was noticed about the upload that the administrator should know (see the service).
    warnings: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    serial: Mapped[str] = mapped_column(String(80), nullable=False, server_default="")
    key_type: Mapped[str] = mapped_column(String(20), nullable=False, server_default="")
    not_before: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    not_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    __table_args__ = (Index("uq_certificates_name_lower", func.lower(name), unique=True),)


class AppGroupGrant(Base):
    __tablename__ = "app_group_grants"

    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("apps.id", ondelete="CASCADE"), primary_key=True
    )
    group_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True
    )
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )


class AppUserGrant(Base):
    __tablename__ = "app_user_grants"

    app_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("apps.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )


class UserSettings(Base):
    __tablename__ = "user_settings"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    theme: Mapped[str | None] = mapped_column(String(10))
    nav_position: Mapped[str | None] = mapped_column(String(10))
    accent_color: Mapped[str | None] = mapped_column(String(7))
    app_bar: Mapped[str | None] = mapped_column(String(10))
    language: Mapped[str | None] = mapped_column(String(5))
    last_tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="SET NULL")
    )
    updated_at: Mapped[datetime] = _updated()


class SystemSetting(Base):
    __tablename__ = "system_settings"

    key: Mapped[str] = mapped_column(String(60), primary_key=True)
    value: Mapped[Any] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = _updated()


class AuthSession(Base):
    __tablename__ = "sessions"

    # SHA-256 of the cookie value; the cookie itself is never stored.
    id_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="SET NULL")
    )
    # Keycloak session id, used to end this session on back-channel logout.
    idp_sid: Mapped[str | None] = mapped_column(String(64))
    id_token: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    auth_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()
    last_seen_at: Mapped[datetime] = _created()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    user_agent: Mapped[str] = mapped_column(String(300), nullable=False, server_default="")
    ip: Mapped[str] = mapped_column(String(45), nullable=False, server_default="")

    __table_args__ = (
        Index("ix_sessions_user", "user_id"),
        Index("ix_sessions_idp_sid", "idp_sid"),
        Index("ix_sessions_expires", "expires_at"),
    )


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    created_at: Mapped[datetime] = _created()
    tenant_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE")
    )
    actor_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    actor_name: Mapped[str] = mapped_column(String(150), nullable=False, server_default="")
    action: Mapped[str] = mapped_column(String(60), nullable=False)
    target_type: Mapped[str] = mapped_column(String(30), nullable=False, server_default="")
    target_id: Mapped[str] = mapped_column(String(64), nullable=False, server_default="")
    target_label: Mapped[str] = mapped_column(String(200), nullable=False, server_default="")
    details: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    ip: Mapped[str] = mapped_column(String(45), nullable=False, server_default="")

    __table_args__ = (Index("ix_audit_tenant_created", "tenant_id", "created_at"),)
