"""In-memory identity provider for tests. Records what Velydock asked it to do."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from velydock.idp.base import (
    KEEP,
    AccountState,
    IdpConflict,
    IdpError,
    IdpManaged,
    IdpNotFound,
    Keep,
    SmtpConfig,
)


@dataclass
class FakeUser:
    id: str
    username: str
    email: str | None
    first_name: str
    last_name: str
    enabled: bool = True
    password: str = ""
    must_change_password: bool = True


@dataclass
class FakeIdp:
    users: dict[str, FakeUser] = field(default_factory=dict)
    organizations: dict[str, dict[str, object]] = field(default_factory=dict)
    members: dict[str, set[str]] = field(default_factory=dict)
    second_factors: set[str] = field(default_factory=set)
    second_factor_required: set[str] = field(default_factory=set)
    logged_out: list[str] = field(default_factory=list)
    setup_emails: list[str] = field(default_factory=list)
    smtp: SmtpConfig = field(default_factory=SmtpConfig)
    display_name: str = "Velydock"
    default_locale: str = ""
    # Every profile change as it was sent: only the fields that were named.
    updates: list[dict[str, object]] = field(default_factory=list)
    # Accounts asked about, sessions the provider has ended without telling, and memberships
    # the provider manages itself (organization id, account id).
    state_checks: list[str] = field(default_factory=list)
    ended_sessions: set[str] = field(default_factory=set)
    managed: set[tuple[str, str]] = field(default_factory=set)
    # Set to an exception to make the next call fail (then it is cleared).
    fail_next: Exception | None = None
    fail_on: str | None = None

    def _maybe_fail(self, operation: str) -> None:
        if self.fail_next is not None and self.fail_on in (None, operation):
            exc, self.fail_next, self.fail_on = self.fail_next, None, None
            raise exc

    def _user(self, idp_id: str) -> FakeUser:
        if idp_id not in self.users:
            raise IdpNotFound(f"user {idp_id}")
        return self.users[idp_id]

    def seed_user(
        self, username: str, email: str | None = None, first_name: str = "", last_name: str = ""
    ) -> str:
        idp_id = str(uuid.uuid4())
        self.users[idp_id] = FakeUser(
            idp_id, username, email, first_name, last_name, must_change_password=False
        )
        return idp_id

    async def create_user(
        self, *, username: str, email: str | None, first_name: str, last_name: str, temporary_password: str
    ) -> str:
        self._maybe_fail("create_user")
        for user in self.users.values():
            if user.username.lower() == username.lower():
                raise IdpConflict("username", "User exists with same username")
            if email and user.email and user.email.lower() == email.lower():
                raise IdpConflict("email", "User exists with same email")
        idp_id = str(uuid.uuid4())
        self.users[idp_id] = FakeUser(
            idp_id, username, email, first_name, last_name, password=temporary_password
        )
        return idp_id

    async def update_user(
        self,
        idp_id: str,
        *,
        email: str | Keep | None = KEEP,
        first_name: str | Keep = KEEP,
        last_name: str | Keep = KEEP,
    ) -> None:
        self._maybe_fail("update_user")
        user = self._user(idp_id)
        self.updates.append(
            {
                name: value
                for name, value in (("email", email), ("first_name", first_name), ("last_name", last_name))
                if value is not KEEP
            }
        )
        if email is None and any(account == idp_id for _, account in self.managed):
            # Clearing the address lifts the memberships for a moment; a managed one cannot be.
            raise IdpManaged("managed member")
        if email is not KEEP:
            for other in self.users.values():
                if other.id != idp_id and email and other.email and other.email.lower() == email.lower():
                    raise IdpConflict("email", "User exists with same email")
            user.email = email
        if first_name is not KEEP:
            user.first_name = first_name
        if last_name is not KEEP:
            user.last_name = last_name

    async def account_state(self, idp_id: str, sid: str | None) -> AccountState:
        self._maybe_fail("account_state")
        self.state_checks.append(idp_id)
        user = self.users.get(idp_id)
        if user is None:
            return AccountState.DELETED
        if not user.enabled:
            return AccountState.DISABLED
        if sid is not None and sid in self.ended_sessions:
            return AccountState.SESSION_ENDED
        return AccountState.ACTIVE

    async def set_enabled(self, idp_id: str, enabled: bool) -> None:
        self._maybe_fail("set_enabled")
        self._user(idp_id).enabled = enabled

    async def set_temporary_password(self, idp_id: str, password: str) -> None:
        self._maybe_fail("set_temporary_password")
        user = self._user(idp_id)
        user.password, user.must_change_password = password, True

    async def logout_user(self, idp_id: str) -> None:
        self._maybe_fail("logout_user")
        self.logged_out.append(idp_id)

    async def delete_user(self, idp_id: str) -> None:
        self._maybe_fail("delete_user")
        self.users.pop(idp_id, None)
        for members in self.members.values():
            members.discard(idp_id)

    async def has_second_factor(self, idp_id: str) -> bool:
        self._maybe_fail("has_second_factor")
        return idp_id in self.second_factors

    async def require_second_factor_setup(self, idp_id: str) -> None:
        self.second_factor_required.add(idp_id)

    async def withdraw_second_factor_setup(self, idp_id: str) -> None:
        self._maybe_fail("withdraw_second_factor_setup")
        self.second_factor_required.discard(idp_id)

    async def send_password_setup_email(self, idp_id: str) -> None:
        self._maybe_fail("send_password_setup_email")
        if not self.smtp.configured:
            raise IdpError("no SMTP server configured")
        self.setup_emails.append(idp_id)

    async def create_organization(self, *, name: str, alias: str) -> str:
        self._maybe_fail("create_organization")
        for org in self.organizations.values():
            if org["alias"] == alias or str(org["name"]).lower() == name.lower():
                raise IdpConflict("name", "A organization with the same name already exists.")
        org_id = str(uuid.uuid4())
        self.organizations[org_id] = {"name": name, "alias": alias, "enabled": True}
        self.members[org_id] = set()
        return org_id

    async def update_organization(self, org_id: str, *, name: str, enabled: bool) -> None:
        self._maybe_fail("update_organization")
        if org_id not in self.organizations:
            raise IdpNotFound(f"organization {org_id}")
        self.organizations[org_id].update(name=name, enabled=enabled)

    async def delete_organization(self, org_id: str) -> None:
        self._maybe_fail("delete_organization")
        self.organizations.pop(org_id, None)
        self.members.pop(org_id, None)

    async def find_organization(self, alias: str) -> str | None:
        return next((org_id for org_id, org in self.organizations.items() if org["alias"] == alias), None)

    async def list_organization_members(self, org_id: str) -> set[str]:
        return set(self.members.get(org_id, set()))

    async def add_organization_member(self, org_id: str, idp_id: str) -> None:
        self._maybe_fail("add_organization_member")
        self.members.setdefault(org_id, set()).add(idp_id)

    async def remove_organization_member(self, org_id: str, idp_id: str) -> None:
        self._maybe_fail("remove_organization_member")
        if (org_id, idp_id) in self.managed:
            raise IdpManaged("managed member")
        self.members.get(org_id, set()).discard(idp_id)

    async def get_smtp(self) -> SmtpConfig:
        return self.smtp

    async def set_smtp(self, config: SmtpConfig) -> None:
        self._maybe_fail("set_smtp")
        self.smtp = config

    async def set_realm_display_name(self, name: str) -> None:
        self.display_name = name

    async def set_default_locale(self, language: str) -> None:
        self._maybe_fail("set_default_locale")
        self.default_locale = language
