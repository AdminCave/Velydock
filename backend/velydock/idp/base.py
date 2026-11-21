"""The identity-provider port.

Velydock keeps no credentials. Everything that touches an identity (create, disable, reset the
password, end sessions) goes through this interface; ``KeycloakIdp`` is the production
implementation and tests use an in-memory one.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, StrEnum
from typing import Final, Protocol


class IdpError(Exception):
    """The identity provider rejected or failed a request."""

    def __init__(self, message: str = "", *, status: int | None = None) -> None:
        super().__init__(message)
        # The HTTP status of the provider's answer, if it gave one.
        self.status = status


class IdpUnavailable(IdpError):
    pass


class IdpConflict(IdpError):
    def __init__(self, field: str, message: str = "") -> None:
        super().__init__(message or f"{field} already exists", status=409)
        self.field = field


class IdpNotFound(IdpError):
    pass


class IdpInvalid(IdpError):
    """The provider's own validation refused a value (``field`` is our name of the field)."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message, status=400)
        self.field = field


class IdpManaged(IdpError):
    """The provider itself manages this membership of an organization.

    Such a member came in through an identity provider or an invitation of that organization.
    Taking the membership away there deletes the whole account, so Velydock never does.
    """


class IdpMailFailed(IdpError):
    """The provider took the request but could not send the e-mail (its SMTP settings)."""


class Keep(Enum):
    """Marks a field that a change leaves as it is (``None`` already means "remove")."""

    KEEP = "keep"


KEEP: Final = Keep.KEEP


class AccountState(StrEnum):
    """What the provider says about an account and one of its sessions."""

    ACTIVE = "active"
    SESSION_ENDED = "session_ended"
    DISABLED = "disabled"
    DELETED = "deleted"


@dataclass(frozen=True)
class SmtpConfig:
    host: str = ""
    port: int = 587
    from_address: str = ""
    from_name: str = ""
    username: str = ""
    # Never returned by the provider; an empty value on write keeps the stored password.
    password: str = ""
    encryption: str = "starttls"  # none | starttls | ssl

    @property
    def configured(self) -> bool:
        return bool(self.host and self.from_address)


class IdentityProvider(Protocol):
    async def create_user(
        self,
        *,
        username: str,
        email: str | None,
        first_name: str,
        last_name: str,
        temporary_password: str,
    ) -> str:
        """Create an account that must change its password at first sign-in; returns its id."""
        ...

    async def update_user(
        self,
        idp_id: str,
        *,
        email: str | Keep | None = KEEP,
        first_name: str | Keep = KEEP,
        last_name: str | Keep = KEEP,
    ) -> None:
        """Change exactly the named fields; everything else stays as the provider has it."""
        ...

    async def account_state(self, idp_id: str, sid: str | None) -> AccountState:
        """Whether the account exists and is enabled, and whether its session ``sid`` is alive."""
        ...

    async def set_enabled(self, idp_id: str, enabled: bool) -> None: ...

    async def set_temporary_password(self, idp_id: str, password: str) -> None: ...

    async def logout_user(self, idp_id: str) -> None: ...

    async def delete_user(self, idp_id: str) -> None: ...

    async def has_second_factor(self, idp_id: str) -> bool: ...

    async def require_second_factor_setup(self, idp_id: str) -> None: ...

    async def withdraw_second_factor_setup(self, idp_id: str) -> None:
        """Take back a request to enrol a second factor that has not been followed yet."""
        ...

    async def send_password_setup_email(self, idp_id: str) -> None: ...

    async def create_organization(self, *, name: str, alias: str) -> str: ...

    async def update_organization(self, org_id: str, *, name: str, enabled: bool) -> None: ...

    async def delete_organization(self, org_id: str) -> None: ...

    async def find_organization(self, alias: str) -> str | None:
        """The id of the organization with this alias, if there is one."""
        ...

    async def list_organization_members(self, org_id: str) -> set[str]: ...

    async def add_organization_member(self, org_id: str, idp_id: str) -> None: ...

    async def remove_organization_member(self, org_id: str, idp_id: str) -> None: ...

    async def get_smtp(self) -> SmtpConfig: ...

    async def set_smtp(self, config: SmtpConfig) -> None: ...

    async def set_realm_display_name(self, name: str) -> None: ...

    async def set_default_locale(self, language: str) -> None:
        """The language of the provider's pages and e-mails where the user has not chosen one."""
        ...
