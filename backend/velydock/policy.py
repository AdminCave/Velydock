"""Authorization rules.

Pure functions without I/O, so every decision can be unit-tested. Callers load the facts
(``Actor``, ``Target``) and ask here; anything not explicitly allowed is denied.
"""

from __future__ import annotations

import uuid
from collections.abc import Collection
from dataclasses import dataclass
from enum import StrEnum

from velydock.models import Role


class Permission(StrEnum):
    WORKSPACE_USE = "workspace:use"
    USERS_READ = "users:read"
    USERS_WRITE = "users:write"
    GROUPS_READ = "groups:read"
    GROUPS_WRITE = "groups:write"
    ROLES_ASSIGN = "roles:assign"
    APPS_MANAGE = "apps:manage"
    TENANT_SETTINGS = "tenant:settings"
    AUDIT_READ = "audit:read"
    SYSTEM_ADMIN = "system:admin"


_MEMBER = frozenset({Permission.WORKSPACE_USE})
_USER_MANAGER = _MEMBER | {
    Permission.USERS_READ,
    Permission.USERS_WRITE,
    Permission.GROUPS_READ,
    Permission.GROUPS_WRITE,
}
_TENANT_ADMIN = _USER_MANAGER | {
    Permission.ROLES_ASSIGN,
    Permission.APPS_MANAGE,
    Permission.TENANT_SETTINGS,
    Permission.AUDIT_READ,
}

ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.MEMBER: _MEMBER,
    Role.USER_MANAGER: _USER_MANAGER,
    Role.TENANT_ADMIN: _TENANT_ADMIN,
}

_ROLE_RANK: dict[Role, int] = {Role.MEMBER: 1, Role.USER_MANAGER: 2, Role.TENANT_ADMIN: 3}
_SYSTEM_RANK = 4


@dataclass(frozen=True)
class Actor:
    user_id: uuid.UUID
    is_system_admin: bool
    tenant_id: uuid.UUID | None
    role: Role | None


@dataclass(frozen=True)
class Target:
    """A user as seen from the actor's tenant (``role`` is the membership role there)."""

    user_id: uuid.UUID
    is_system_admin: bool
    home_tenant_id: uuid.UUID | None
    role: Role | None


def permissions_for(
    *, is_system_admin: bool, role: Role | None, has_tenant: bool = True
) -> frozenset[Permission]:
    if is_system_admin:
        perms = set(Permission) if has_tenant else {Permission.SYSTEM_ADMIN}
        return frozenset(perms)
    if role is None or not has_tenant:
        return frozenset()
    return ROLE_PERMISSIONS[role]


def rank(*, is_system_admin: bool, role: Role | None) -> int:
    if is_system_admin:
        return _SYSTEM_RANK
    return _ROLE_RANK[role] if role is not None else 0


def _actor_perms(actor: Actor) -> frozenset[Permission]:
    return permissions_for(
        is_system_admin=actor.is_system_admin, role=actor.role, has_tenant=actor.tenant_id is not None
    )


def _outranks_or_equals(actor: Actor, target: Target) -> bool:
    return rank(is_system_admin=actor.is_system_admin, role=actor.role) >= rank(
        is_system_admin=target.is_system_admin, role=target.role
    )


def can_manage_membership(actor: Actor, target: Target) -> bool:
    """Change group assignments of a member or remove the membership."""
    if actor.is_system_admin:
        return True
    return Permission.USERS_WRITE in _actor_perms(actor) and _outranks_or_equals(actor, target)


def can_manage_identity(actor: Actor, target: Target) -> bool:
    """Edit the profile, reset the password, disable or delete the account.

    Only the home tenant owns an identity. Guests from other tenants keep their credentials out
    of reach of this tenant's administrators, and nobody below a target's rank may touch it –
    otherwise a user manager could take over an administrator by resetting the password.
    """
    if actor.is_system_admin:
        return True
    if Permission.USERS_WRITE not in _actor_perms(actor):
        return False
    if target.is_system_admin:
        return False
    if actor.tenant_id is None or target.home_tenant_id != actor.tenant_id:
        return False
    return _outranks_or_equals(actor, target)


def can_assign_role(actor: Actor, target: Target, new_role: Role) -> bool:
    """Grant or change a membership role. Nobody raises anyone above their own rank."""
    if actor.is_system_admin:
        return True
    if Permission.ROLES_ASSIGN not in _actor_perms(actor):
        return False
    if actor.user_id == target.user_id:
        return False
    if not _outranks_or_equals(actor, target):
        return False
    return _ROLE_RANK[new_role] <= rank(is_system_admin=False, role=actor.role)


def can_create_with_role(actor: Actor, new_role: Role) -> bool:
    if actor.is_system_admin:
        return True
    perms = _actor_perms(actor)
    if Permission.USERS_WRITE not in perms:
        return False
    if new_role == Role.MEMBER:
        return True
    return Permission.ROLES_ASSIGN in perms and _ROLE_RANK[new_role] <= rank(
        is_system_admin=False, role=actor.role
    )


def app_visible(
    *,
    enabled: bool,
    visible_to_all: bool,
    granted_group_ids: Collection[uuid.UUID],
    granted_user_ids: Collection[uuid.UUID],
    user_id: uuid.UUID,
    user_group_ids: Collection[uuid.UUID],
) -> bool:
    """Whether a member sees an app in the workspace."""
    if not enabled:
        return False
    if visible_to_all or user_id in granted_user_ids:
        return True
    return bool(set(granted_group_ids) & set(user_group_ids))
