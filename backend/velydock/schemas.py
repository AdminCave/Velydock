"""Request and response models of the REST API."""

from __future__ import annotations

import html
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

from velydock.models import (
    AppBar,
    AppType,
    EmbedStatus,
    NavPosition,
    PublicationAccess,
    PublicationMode,
    Role,
    Theme,
)

# Three characters at least: Keycloak's user profile refuses shorter names.
_USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$")
_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,255}\.[^@\s.]{2,}$")
_SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")
RESERVED_SLUGS = {"admin", "api", "system", "master", "velydock", "www"}


def _one_space(value: str) -> str:
    """Runs of blanks, tabs and line breaks become one blank.

    Two names that differ only in such runs look the same on screen; they must also be the same
    to the uniqueness checks.
    """
    return " ".join(value.split())


Name = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100), AfterValidator(_one_space)
]
# Keycloak refuses these characters in first and last names (its "person name" rule keeps
# markup out of e-mails and pages). Checked here, the user gets told which field is wrong.
_PERSON_NAME_FORBIDDEN = re.compile(r'[<>&"$%!#?§;*~/\\|^=\[\]{}()\x00-\x1f\x7f\x85\u2028\u2029]')


def _person_name(value: str) -> str:
    if _PERSON_NAME_FORBIDDEN.search(value):
        raise ValueError('must not contain any of < > & " $ % ! # ? § ; * ~ / \\ | ^ = [ ] { } ( )')
    return value


PersonName = Annotated[Name, AfterValidator(_person_name)]


def _plain_text_for_keycloak(value: str) -> str:
    """The name of the installation appears on Keycloak's pages and in its e-mails.

    Keycloak prints it there through an HTML sanitizer that first decodes character references
    (repeatedly) and then lets harmless markup pass: links, images, formatting. Escaping the
    name therefore achieves nothing - an escaped link arrives as a link. Only a name that
    cannot be read as markup is shown as it was typed. A plain "&" is fine ("Müller & Söhne").
    """
    if "<" in value or ">" in value or html.unescape(value) != value:
        raise ValueError("must not contain < or > or character references such as &lt;")
    return value


InstanceName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=60),
    AfterValidator(_one_space),
    AfterValidator(_plain_text_for_keycloak),
]
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
    # Without recursion: the depth of a JSON document is the client's choice.
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, str):
            if "\x00" in item:
                return True
        elif isinstance(item, dict):
            pending.extend(item.keys())
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
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


class ActiveTenant(TenantRef):
    """The organization the session works in, with what its interface needs to show it."""

    logo_url: str | None = None


class MembershipOut(Model):
    tenant: TenantRef
    role: Role | None


# An accent colour as "#rrggbb". The interface derives the shades it needs from it and keeps
# text readable in both themes, so any colour is acceptable here.
AccentColor = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^#[0-9a-fA-F]{6}$"), AfterValidator(str.lower)
]


class EffectiveSettings(Model):
    """What applies to this user in the active organization, and what the organization fixed."""

    theme: Theme
    nav_position: NavPosition
    accent_color: str | None
    app_bar: AppBar
    language: Language
    theme_locked: bool
    nav_position_locked: bool
    accent_locked: bool
    app_bar_locked: bool


class OwnSettings(Model):
    theme: Theme | None = None
    nav_position: NavPosition | None = None
    accent_color: str | None = None
    app_bar: AppBar | None = None
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
    active_tenant: ActiveTenant | None
    role: Role | None
    permissions: list[str]
    memberships: list[MembershipOut]
    # Organizations the user belongs to that are deactivated at the moment. Someone with none
    # active is not "without organization" - theirs is switched off.
    inactive_memberships: int = 0
    settings: EffectiveSettings
    own_settings: OwnSettings
    instance_name: str
    account_url: str
    version: str


class SettingsUpdate(Model):
    theme: Theme | None = None
    nav_position: NavPosition | None = None
    accent_color: AccentColor | None = None
    app_bar: AppBar | None = None
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


class AdminCapabilities(Model):
    email_invitations: bool


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


class PublicationIn(Model):
    """Publish the app through the bundled reverse proxy: where from, and under which address."""

    name: Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, min_length=2, max_length=40)]
    mode: PublicationMode = PublicationMode.PATH
    target_url: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    access: PublicationAccess = PublicationAccess.PROTECTED
    template: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)] = (
        "builtin:standard"
    )
    # What differs from the template; see services/proxy.py for the keys.
    options: dict[str, Any] = Field(default_factory=dict)


class PublicationOut(Model):
    name: str
    mode: PublicationMode
    target_url: str
    access: PublicationAccess
    template: str
    options: dict[str, Any]
    public_url: str
    # Why the proxy does not serve it at the moment, or None: "target_not_allowed" (the release
    # was withdrawn), "template_missing".
    problem: str | None = None


class AppBase(Model):
    name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80), AfterValidator(_one_space)
    ]
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
    publication: PublicationIn | None = None


class AppUpdate(Model):
    name: (
        Annotated[
            str,
            StringConstraints(strip_whitespace=True, min_length=1, max_length=80),
            AfterValidator(_one_space),
        ]
        | None
    ) = None
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
    # Sent as null, the app is no longer published; a new address must then come along.
    publication: PublicationIn | None = None


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
    publication: PublicationOut | None = None


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
TenantName = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=2, max_length=120), AfterValidator(_one_space)
]


class TenantOut(Model):
    id: uuid.UUID
    slug: str
    name: str
    active: bool
    default_nav_position: NavPosition | None
    nav_position_locked: bool
    member_count: int = 0
    app_count: int = 0
    # Home of a system administrator: cannot be deactivated or deleted.
    protected: bool = False
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
    default_theme: Theme | None
    theme_locked: bool
    accent_color: str | None
    accent_locked: bool
    default_nav_position: NavPosition | None
    nav_position_locked: bool
    default_app_bar: AppBar | None
    app_bar_locked: bool
    logo_url: str | None


class LogoIn(Model):
    """An uploaded image as a ``data:`` URL (the same formats and size as app icons)."""

    data_url: str = Field(max_length=MAX_ICON_BYTES * 2)


class TenantSettingsUpdate(Model):
    """Only what is sent changes. A default sent as null is removed; ``logo: null`` removes the logo."""

    default_theme: Theme | None = None
    theme_locked: bool | None = None
    accent_color: AccentColor | None = None
    accent_locked: bool | None = None
    default_nav_position: NavPosition | None = None
    nav_position_locked: bool | None = None
    default_app_bar: AppBar | None = None
    app_bar_locked: bool | None = None
    logo: LogoIn | None = None


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
    instance_name: InstanceName | None = None
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


# -- publishing through the reverse proxy ---------------------------------------------------------


class ProxyTemplateOut(Model):
    id: str
    name: str
    description: str
    options: dict[str, Any]
    builtin: bool


class ProxyTemplateIn(Model):
    name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80), AfterValidator(_one_space)
    ]
    description: Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)] = ""
    options: dict[str, Any] = Field(default_factory=dict)


class ProxyTemplateUpdate(Model):
    name: (
        Annotated[
            str,
            StringConstraints(strip_whitespace=True, min_length=1, max_length=80),
            AfterValidator(_one_space),
        ]
        | None
    ) = None
    description: Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)] | None = None
    options: dict[str, Any] | None = None


class ProxyTargetIn(Model):
    value: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] = ""


class ProxyTargetOut(Model):
    id: uuid.UUID
    value: str
    note: str


class ProxyInfo(Model):
    """What an organization's administrator needs to publish an app."""

    enabled: bool
    # "https://apps.example.com/" and ".apps.example.com": the name goes after the first and
    # before the second.
    path_base: str | None = None
    subdomain_suffix: str | None = None
    subdomain_scheme: str | None = None
    targets: list[str] = Field(default_factory=list)
    templates: list[ProxyTemplateOut] = Field(default_factory=list)
    defaults: dict[str, Any] = Field(default_factory=dict)
