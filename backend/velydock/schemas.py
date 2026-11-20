"""Request and response models of the REST API."""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from velydock.models import AppType, EmbedStatus, NavPosition, Role, Theme

# Three characters at least: Keycloak's user profile refuses shorter names.
_USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$")
_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s.]{2,}$")
_SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")
RESERVED_SLUGS = {"admin", "api", "system", "master", "velydock", "www"}

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
# Keycloak refuses these characters in first and last names (its "person name" rule keeps
# markup out of e-mails and pages). Checked here, the user gets told which field is wrong.
_PERSON_NAME_FORBIDDEN = re.compile(r'[<>&"$%!#?§;*~/\\|^=\[\]{}()\x00-\x1f\x7f]')


def _person_name(value: str) -> str:
    if _PERSON_NAME_FORBIDDEN.search(value):
        raise ValueError('must not contain any of < > & " $ % ! # ? § ; * ~ / \\ | ^ = [ ] { } ( )')
    return value


PersonName = Annotated[Name, AfterValidator(_person_name)]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
Language = Literal["de", "en"]


def _username(value: str) -> str:
    value = value.strip().lower()
    if not _USERNAME_RE.fullmatch(value):
        raise ValueError(
            "must be 3-64 characters: lowercase letters, digits, dot, dash or underscore, "
            "starting and ending with a letter or digit"
        )
    return value


def _email(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip().lower()
    if not value:
        return None
    if len(value) > 254 or not _EMAIL_RE.fullmatch(value):
        raise ValueError("is not a valid e-mail address")
    return value


Username = Annotated[str, AfterValidator(_username)]
Email = Annotated[str | None, AfterValidator(_email)]


def _has_nul(value: Any) -> bool:
    if isinstance(value, str):
        return "\x00" in value
    if isinstance(value, dict):
        return any(_has_nul(k) or _has_nul(v) for k, v in value.items())
    if isinstance(value, list):
        return any(_has_nul(item) for item in value)
    return False


class Model(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _no_nul_characters(cls, data: Any) -> Any:
        # PostgreSQL cannot store NUL in text. Refused here, it is a validation error for the
        # client instead of a failed statement.
        if isinstance(data, dict) and _has_nul(data):
            raise ValueError("must not contain NUL characters")
        return data


# -- session / profile ---------------------------------------------------------------------------


class TenantRef(Model):
    id: uuid.UUID
    slug: str
    name: str


class MembershipOut(Model):
    tenant: TenantRef
    role: Role | None


class EffectiveSettings(Model):
    theme: Theme
    nav_position: NavPosition
    language: Language
    nav_position_locked: bool


class OwnSettings(Model):
    theme: Theme | None = None
    nav_position: NavPosition | None = None
    language: Language | None = None


class MeUser(Model):
    id: uuid.UUID
    username: str
    email: str | None
    first_name: str
    last_name: str
    display_name: str
    is_system_admin: bool


class MeOut(Model):
    user: MeUser
    active_tenant: TenantRef | None
    role: Role | None
    permissions: list[str]
    memberships: list[MembershipOut]
    settings: EffectiveSettings
    own_settings: OwnSettings
    instance_name: str
    account_url: str
    version: str


class SettingsUpdate(Model):
    theme: Theme | None = None
    nav_position: NavPosition | None = None
    language: Language | None = None


class ProfileUpdate(Model):
    first_name: PersonName
    last_name: PersonName


class ActiveTenantUpdate(Model):
    tenant_id: uuid.UUID


class LogoutOut(Model):
    redirect_url: str = Field(description="Navigate here to end the identity provider's session as well.")


class PublicInfo(Model):
    instance_name: str
    default_language: Language
    default_theme: Theme
    version: str


# -- users ---------------------------------------------------------------------------------------


class GroupRef(Model):
    id: uuid.UUID
    name: str


class UserOut(Model):
    id: uuid.UUID
    username: str
    email: str | None
    first_name: str
    last_name: str
    display_name: str
    active: bool
    is_system_admin: bool
    role: Role | None
    managed: bool = Field(description="True if this tenant owns the identity (profile and credentials).")
    home_tenant: TenantRef | None = None
    groups: list[GroupRef] = []
    last_login_at: datetime | None = None
    created_at: datetime
    # What the current administrator may do with this user.
    can_edit_identity: bool = False
    can_edit_membership: bool = False
    can_assign_role: bool = False


class UserPage(Model):
    items: list[UserOut]
    total: int
    page: int
    page_size: int


class UserCreate(Model):
    username: Username
    email: Email = None
    first_name: PersonName
    last_name: PersonName
    role: Role = Role.MEMBER
    group_ids: list[uuid.UUID] = Field(default_factory=list, max_length=200)
    send_email: bool = Field(
        default=False, description="Send a set-password e-mail instead of returning a temporary password."
    )


class UserCreated(Model):
    user: UserOut
    temporary_password: str | None = Field(
        description="Shown exactly once. The user must change it at first sign-in."
    )
    email_sent: bool


class UserUpdate(Model):
    email: Email = None
    first_name: PersonName | None = None
    last_name: PersonName | None = None
    role: Role | None = None
    group_ids: list[uuid.UUID] | None = Field(default=None, max_length=200)
    active: bool | None = None

    # Distinguishes "clear the e-mail" from "leave it alone".
    @property
    def email_provided(self) -> bool:
        return "email" in self.model_fields_set


class PasswordReset(Model):
    temporary_password: str


class UserRemoved(Model):
    deleted_identity: bool


class MemberAdd(Model):
    user_id: uuid.UUID
    role: Role = Role.MEMBER


class SystemUserOut(Model):
    id: uuid.UUID
    username: str
    email: str | None
    display_name: str
    active: bool
    is_system_admin: bool
    home_tenant: TenantRef | None
    memberships: list[MembershipOut]
    last_login_at: datetime | None


class SystemUserPage(Model):
    items: list[SystemUserOut]
    total: int
    page: int
    page_size: int


class SystemUserUpdate(Model):
    is_system_admin: bool


# -- groups --------------------------------------------------------------------------------------


class GroupOut(Model):
    id: uuid.UUID
    name: str
    description: str
    member_count: int
    app_count: int
    created_at: datetime


class GroupDetail(GroupOut):
    member_ids: list[uuid.UUID]


class GroupCreate(Model):
    name: Name
    description: ShortText = ""
    member_ids: list[uuid.UUID] = Field(default_factory=list, max_length=2000)


class GroupUpdate(Model):
    name: Name | None = None
    description: ShortText | None = None
    member_ids: list[uuid.UUID] | None = Field(default=None, max_length=2000)


# -- apps ----------------------------------------------------------------------------------------

FRAME_PERMISSIONS = (
    "camera",
    "microphone",
    "clipboard-read",
    "clipboard-write",
    "fullscreen",
    "display-capture",
)
FramePermission = Literal[
    "camera", "microphone", "clipboard-read", "clipboard-write", "fullscreen", "display-capture"
]
MAX_ICON_BYTES = 256 * 1024
MAX_HTML = 300_000
MAX_CSS = 150_000
MAX_JS = 300_000


class IconIn(Model):
    """Either a built-in glyph (``name``) or an uploaded image as a ``data:`` URL."""

    name: str | None = Field(default=None, max_length=40, pattern=r"^[a-z0-9-]+$")
    data_url: str | None = Field(default=None, max_length=MAX_ICON_BYTES * 2)


class AppBase(Model):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    description: ShortText = ""
    type: AppType
    url: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] | None = None
    enabled: bool = True
    visible_to_all: bool = False
    group_ids: list[uuid.UUID] = Field(default_factory=list, max_length=500)
    user_ids: list[uuid.UUID] = Field(default_factory=list, max_length=500)
    frame_permissions: list[FramePermission] = Field(default_factory=list)
    custom_html: str = Field(default="", max_length=MAX_HTML)
    custom_css: str = Field(default="", max_length=MAX_CSS)
    custom_js: str = Field(default="", max_length=MAX_JS)
    custom_allow_network: bool = False

    @field_validator("frame_permissions")
    @classmethod
    def _unique_permissions(cls, value: list[str]) -> list[str]:
        return sorted(set(value))


class AppCreate(AppBase):
    icon: IconIn | None = None


class AppUpdate(Model):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)] | None = None
    description: ShortText | None = None
    type: AppType | None = None
    url: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] | None = None
    enabled: bool | None = None
    visible_to_all: bool | None = None
    group_ids: list[uuid.UUID] | None = Field(default=None, max_length=500)
    user_ids: list[uuid.UUID] | None = Field(default=None, max_length=500)
    frame_permissions: list[FramePermission] | None = None
    custom_html: str | None = Field(default=None, max_length=MAX_HTML)
    custom_css: str | None = Field(default=None, max_length=MAX_CSS)
    custom_js: str | None = Field(default=None, max_length=MAX_JS)
    custom_allow_network: bool | None = None
    icon: IconIn | None = None


class AppOut(Model):
    id: uuid.UUID
    name: str
    description: str
    type: AppType
    url: str | None
    enabled: bool
    sort_order: int
    visible_to_all: bool
    group_ids: list[uuid.UUID]
    user_ids: list[uuid.UUID]
    icon_name: str | None
    icon_url: str | None
    frame_permissions: list[str]
    embed_status: EmbedStatus
    embed_detail: str
    embed_checked_at: datetime | None
    custom_html: str
    custom_css: str
    custom_js: str
    custom_allow_network: bool
    created_at: datetime
    updated_at: datetime


class AppOrder(Model):
    app_ids: list[uuid.UUID] = Field(max_length=1000)


class WorkspaceApp(Model):
    id: uuid.UUID
    name: str
    description: str
    type: AppType
    url: str | None
    icon_name: str | None
    icon_url: str | None
    frame_permissions: list[str]
    embed_status: EmbedStatus


class LaunchOut(Model):
    url: str
    expires_in: int | None = None


class EmbedCheckIn(Model):
    url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]


class EmbedCheckOut(Model):
    status: EmbedStatus
    detail: str
    http_status: int | None = None


# -- tenants / settings --------------------------------------------------------------------------


def _slug(value: str) -> str:
    value = value.strip().lower()
    if not _SLUG_RE.fullmatch(value) or len(value) < 2:
        raise ValueError("must be 2-40 characters: lowercase letters, digits and dashes")
    if value in RESERVED_SLUGS:
        raise ValueError("is a reserved name")
    return value


Slug = Annotated[str, AfterValidator(_slug)]
TenantName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=120)]


class TenantOut(Model):
    id: uuid.UUID
    slug: str
    name: str
    active: bool
    default_nav_position: NavPosition | None
    nav_position_locked: bool
    member_count: int = 0
    app_count: int = 0
    created_at: datetime


class TenantCreate(Model):
    slug: Slug
    name: TenantName


class TenantUpdate(Model):
    name: TenantName | None = None
    active: bool | None = None


class TenantDelete(Model):
    confirm_slug: str


class TenantSettingsOut(Model):
    id: uuid.UUID
    slug: str
    name: str
    default_nav_position: NavPosition | None
    nav_position_locked: bool


class TenantSettingsUpdate(Model):
    default_nav_position: NavPosition | None = None
    nav_position_locked: bool | None = None

    @property
    def nav_position_provided(self) -> bool:
        return "default_nav_position" in self.model_fields_set


class SmtpSettings(Model):
    host: Annotated[str, StringConstraints(strip_whitespace=True, max_length=255)] = ""
    port: int = Field(default=587, ge=1, le=65535)
    from_address: Annotated[str, StringConstraints(strip_whitespace=True, max_length=254)] = ""
    from_name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)] = ""
    username: Annotated[str, StringConstraints(strip_whitespace=True, max_length=255)] = ""
    password: str = Field(default="", max_length=500, description="Write-only; empty keeps the stored one.")
    encryption: Literal["none", "starttls", "ssl"] = "starttls"


class SystemSettingsOut(Model):
    instance_name: str
    default_nav_position: NavPosition
    default_theme: Theme
    default_language: Language
    require_admin_2fa: bool
    smtp: SmtpSettings
    smtp_configured: bool


class SystemSettingsUpdate(Model):
    instance_name: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)] | None
    ) = None
    default_nav_position: NavPosition | None = None
    default_theme: Theme | None = None
    default_language: Language | None = None
    require_admin_2fa: bool | None = None
    smtp: SmtpSettings | None = None


# -- audit ---------------------------------------------------------------------------------------


class AuditEntry(Model):
    id: int
    created_at: datetime
    actor_name: str
    action: str
    target_type: str
    target_id: str
    target_label: str
    details: dict[str, Any]


class AuditPage(Model):
    items: list[AuditEntry]
    total: int
    page: int
    page_size: int
