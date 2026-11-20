"""The identity-provider port.

Velydock keeps no credentials. Everything that touches an identity (create, disable, reset the
password, end sessions) goes through this interface; ``KeycloakIdp`` is the production
implementation and tests use an in-memory one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class IdpError(Exception):
    """The identity provider rejected or failed a request."""


class IdpUnavailable(IdpError):
    pass


class IdpConflict(IdpError):
    def __init__(self, field: str, message: str = "") -> None:
        super().__init__(message or f"{field} already exists")
        self.field = field


class IdpNotFound(IdpError):
    pass


class IdpInvalid(IdpError):
    """The provider's own validation refused a value (``field`` is our name of the field)."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field


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
        self, idp_id: str, *, email: str | None, first_name: str, last_name: str
    ) -> None: ...

    async def set_enabled(self, idp_id: str, enabled: bool) -> None: ...

    async def set_temporary_password(self, idp_id: str, password: str) -> None: ...

    async def logout_user(self, idp_id: str) -> None: ...

    async def delete_user(self, idp_id: str) -> None: ...

    async def has_second_factor(self, idp_id: str) -> bool: ...

    async def require_second_factor_setup(self, idp_id: str) -> None: ...

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
