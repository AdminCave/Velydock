"""Authorization decisions: who may do what to whom."""

from __future__ import annotations

import uuid

import pytest

from velydock.models import Role
from velydock.policy import (
    Actor,
    Permission,
    Target,
    app_visible,
    can_assign_role,
    can_create_with_role,
    can_manage_identity,
    can_manage_membership,
    permissions_for,
)

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()


def actor(role: Role | None, *, system_admin: bool = False, tenant: uuid.UUID | None = TENANT) -> Actor:
    return Actor(user_id=uuid.uuid4(), is_system_admin=system_admin, tenant_id=tenant, role=role)


def target(role: Role | None, *, home: uuid.UUID | None = TENANT, system_admin: bool = False) -> Target:
    return Target(user_id=uuid.uuid4(), is_system_admin=system_admin, home_tenant_id=home, role=role)


class TestPermissions:
    def test_member_only_uses_the_workspace(self) -> None:
        assert permissions_for(is_system_admin=False, role=Role.MEMBER) == {Permission.WORKSPACE_USE}

    def test_user_manager_manages_users_and_groups_but_nothing_else(self) -> None:
        perms = permissions_for(is_system_admin=False, role=Role.USER_MANAGER)
        assert {Permission.USERS_WRITE, Permission.GROUPS_WRITE} <= perms
        assert (
            not {
                Permission.APPS_MANAGE,
                Permission.ROLES_ASSIGN,
                Permission.TENANT_SETTINGS,
                Permission.AUDIT_READ,
                Permission.SYSTEM_ADMIN,
            }
            & perms
        )

    def test_tenant_admin_has_all_tenant_permissions_but_not_system(self) -> None:
        perms = permissions_for(is_system_admin=False, role=Role.TENANT_ADMIN)
        assert perms == set(Permission) - {Permission.SYSTEM_ADMIN}

    def test_system_admin_has_everything_inside_a_tenant(self) -> None:
        assert permissions_for(is_system_admin=True, role=None) == set(Permission)

    def test_system_admin_without_tenant_keeps_only_system_rights(self) -> None:
        assert permissions_for(is_system_admin=True, role=None, has_tenant=False) == {Permission.SYSTEM_ADMIN}

    def test_no_membership_means_no_permissions(self) -> None:
        assert permissions_for(is_system_admin=False, role=None) == frozenset()
        assert permissions_for(is_system_admin=False, role=Role.TENANT_ADMIN, has_tenant=False) == frozenset()


class TestIdentityManagement:
    """Editing the profile, resetting the password, disabling, deleting."""

    def test_admin_manages_identities_owned_by_the_tenant(self) -> None:
        assert can_manage_identity(actor(Role.TENANT_ADMIN), target(Role.MEMBER))
        assert can_manage_identity(actor(Role.TENANT_ADMIN), target(Role.TENANT_ADMIN))

    def test_guest_identities_are_out_of_reach(self) -> None:
        guest = target(Role.MEMBER, home=OTHER_TENANT)
        assert not can_manage_identity(actor(Role.TENANT_ADMIN), guest)
        assert not can_manage_identity(actor(Role.TENANT_ADMIN), target(Role.MEMBER, home=None))

    def test_user_manager_cannot_take_over_an_admin(self) -> None:
        assert can_manage_identity(actor(Role.USER_MANAGER), target(Role.MEMBER))
        assert can_manage_identity(actor(Role.USER_MANAGER), target(Role.USER_MANAGER))
        assert not can_manage_identity(actor(Role.USER_MANAGER), target(Role.TENANT_ADMIN))

    def test_nobody_in_a_tenant_can_touch_a_system_admin(self) -> None:
        sysadmin = target(Role.MEMBER, system_admin=True)
        assert not can_manage_identity(actor(Role.TENANT_ADMIN), sysadmin)
        assert can_manage_identity(actor(None, system_admin=True), sysadmin)

    def test_members_manage_nobody(self) -> None:
        assert not can_manage_identity(actor(Role.MEMBER), target(Role.MEMBER))
        assert not can_manage_membership(actor(Role.MEMBER), target(Role.MEMBER))

    def test_system_admin_manages_guests_too(self) -> None:
        assert can_manage_identity(actor(None, system_admin=True), target(Role.MEMBER, home=OTHER_TENANT))


class TestMembershipManagement:
    def test_admin_may_remove_guests(self) -> None:
        assert can_manage_membership(actor(Role.TENANT_ADMIN), target(Role.MEMBER, home=OTHER_TENANT))

    def test_user_manager_cannot_remove_an_admin(self) -> None:
        assert not can_manage_membership(actor(Role.USER_MANAGER), target(Role.TENANT_ADMIN))


class TestRoleAssignment:
    def test_only_admins_assign_roles(self) -> None:
        assert can_assign_role(actor(Role.TENANT_ADMIN), target(Role.MEMBER), Role.USER_MANAGER)
        assert can_assign_role(actor(Role.TENANT_ADMIN), target(Role.MEMBER), Role.TENANT_ADMIN)
        assert not can_assign_role(actor(Role.USER_MANAGER), target(Role.MEMBER), Role.USER_MANAGER)
        assert not can_assign_role(actor(Role.MEMBER), target(Role.MEMBER), Role.MEMBER)

    def test_nobody_changes_their_own_role(self) -> None:
        me = actor(Role.TENANT_ADMIN)
        myself = Target(
            user_id=me.user_id, is_system_admin=False, home_tenant_id=TENANT, role=Role.TENANT_ADMIN
        )
        assert not can_assign_role(me, myself, Role.MEMBER)

    def test_tenant_admin_cannot_demote_a_system_admin(self) -> None:
        assert not can_assign_role(
            actor(Role.TENANT_ADMIN), target(Role.TENANT_ADMIN, system_admin=True), Role.MEMBER
        )

    @pytest.mark.parametrize("role", list(Role))
    def test_system_admin_assigns_any_role(self, role: Role) -> None:
        assert can_assign_role(actor(None, system_admin=True), target(Role.MEMBER), role)

    def test_creating_users_with_elevated_roles_needs_the_right_to_assign_roles(self) -> None:
        assert can_create_with_role(actor(Role.USER_MANAGER), Role.MEMBER)
        assert not can_create_with_role(actor(Role.USER_MANAGER), Role.USER_MANAGER)
        assert not can_create_with_role(actor(Role.USER_MANAGER), Role.TENANT_ADMIN)
        assert can_create_with_role(actor(Role.TENANT_ADMIN), Role.TENANT_ADMIN)
        assert not can_create_with_role(actor(Role.MEMBER), Role.MEMBER)


class TestAppVisibility:
    user = uuid.uuid4()
    group_a, group_b = uuid.uuid4(), uuid.uuid4()

    def visible(self, **overrides: object) -> bool:
        facts: dict[str, object] = {
            "enabled": True,
            "visible_to_all": False,
            "granted_group_ids": [],
            "granted_user_ids": [],
            "user_id": self.user,
            "user_group_ids": [],
        }
        facts.update(overrides)
        return app_visible(**facts)  # type: ignore[arg-type]

    def test_hidden_without_any_grant(self) -> None:
        assert not self.visible()

    def test_visible_to_all(self) -> None:
        assert self.visible(visible_to_all=True)

    def test_visible_through_a_group(self) -> None:
        assert self.visible(granted_group_ids=[self.group_a], user_group_ids=[self.group_a, self.group_b])
        assert not self.visible(granted_group_ids=[self.group_a], user_group_ids=[self.group_b])

    def test_visible_through_a_direct_grant(self) -> None:
        assert self.visible(granted_user_ids=[self.user])
        assert not self.visible(granted_user_ids=[uuid.uuid4()])

    def test_disabled_apps_are_never_visible(self) -> None:
        assert not self.visible(enabled=False, visible_to_all=True, granted_user_ids=[self.user])
