"""Groups: per-tenant collections of members that apps are granted to."""

from __future__ import annotations

import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.api.deps import Principal
from velydock.db import NAME_ORDER
from velydock.errors import conflict, forbidden, invalid, not_found
from velydock.models import AppGroupGrant, Group, GroupMember, Membership, Role, User
from velydock.policy import Target, can_manage_membership
from velydock.schemas import GroupCreate, GroupDetail, GroupOut, GroupUpdate
from velydock.services import audit


async def _load(db: AsyncSession, tenant_id: uuid.UUID, group_id: uuid.UUID) -> Group:
    group = (
        await db.execute(select(Group).where(Group.id == group_id, Group.tenant_id == tenant_id))
    ).scalar_one_or_none()
    if group is None:
        raise not_found("Group")
    return group


async def _counts(
    db: AsyncSession, tenant_id: uuid.UUID
) -> tuple[dict[uuid.UUID, int], dict[uuid.UUID, int]]:
    members = await db.execute(
        select(GroupMember.group_id, func.count())
        .where(GroupMember.tenant_id == tenant_id)
        .group_by(GroupMember.group_id)
    )
    apps = await db.execute(
        select(AppGroupGrant.group_id, func.count())
        .where(AppGroupGrant.tenant_id == tenant_id)
        .group_by(AppGroupGrant.group_id)
    )
    return {row[0]: row[1] for row in members.all()}, {row[0]: row[1] for row in apps.all()}


def _out(group: Group, members: int, apps: int) -> GroupOut:
    return GroupOut(
        id=group.id,
        name=group.name,
        description=group.description,
        member_count=members,
        app_count=apps,
        created_at=group.created_at,
    )


async def _member_ids(db: AsyncSession, group: Group) -> list[uuid.UUID]:
    rows = await db.execute(
        select(GroupMember.user_id).where(
            GroupMember.group_id == group.id, GroupMember.tenant_id == group.tenant_id
        )
    )
    return list(rows.scalars())


async def _validated_member_ids(
    db: AsyncSession, tenant_id: uuid.UUID, user_ids: list[uuid.UUID]
) -> list[uuid.UUID]:
    unique = list(dict.fromkeys(user_ids))
    if not unique:
        return []
    found = set(
        (
            await db.execute(
                select(Membership.user_id).where(
                    Membership.tenant_id == tenant_id, Membership.user_id.in_(unique)
                )
            )
        ).scalars()
    )
    if len(found) != len(unique):
        raise invalid("One or more users do not belong to this organization.", "unknown_user")
    return unique


async def _check_member_changes(
    db: AsyncSession, principal: Principal, tenant_id: uuid.UUID, changed: set[uuid.UUID]
) -> None:
    """Group assignments are part of managing an account, so the rank rule applies here too.

    Without it a user manager could change through a group what user administration refuses:
    the groups of an administrator.
    """
    if not changed or principal.actor.is_system_admin:
        return
    rows = await db.execute(
        select(User.id, User.is_system_admin, User.home_tenant_id, Membership.role)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.tenant_id == tenant_id, User.id.in_(changed))
    )
    for user_id, is_system_admin, home_tenant_id, role in rows.all():
        target = Target(
            user_id=user_id, is_system_admin=is_system_admin, home_tenant_id=home_tenant_id, role=Role(role)
        )
        if not can_manage_membership(principal.actor, target):
            raise forbidden("You may not change the groups of an account that outranks you.")


async def _set_members(db: AsyncSession, group: Group, user_ids: list[uuid.UUID]) -> None:
    await db.execute(
        delete(GroupMember).where(GroupMember.group_id == group.id, GroupMember.tenant_id == group.tenant_id)
    )
    db.add_all([GroupMember(group_id=group.id, user_id=uid, tenant_id=group.tenant_id) for uid in user_ids])
    await db.flush()


async def list_groups(db: AsyncSession, principal: Principal) -> list[GroupOut]:
    tenant = principal.require_tenant()
    groups = (
        await db.execute(
            select(Group).where(Group.tenant_id == tenant.id).order_by(Group.name.collate(NAME_ORDER))
        )
    ).scalars()
    members, apps = await _counts(db, tenant.id)
    return [_out(g, members.get(g.id, 0), apps.get(g.id, 0)) for g in groups]


async def get_group(db: AsyncSession, principal: Principal, group_id: uuid.UUID) -> GroupDetail:
    tenant = principal.require_tenant()
    group = await _load(db, tenant.id, group_id)
    members, apps = await _counts(db, tenant.id)
    base = _out(group, members.get(group.id, 0), apps.get(group.id, 0))
    return GroupDetail(**base.model_dump(), member_ids=await _member_ids(db, group))


async def create_group(db: AsyncSession, principal: Principal, data: GroupCreate) -> GroupDetail:
    tenant = principal.require_tenant()
    member_ids = await _validated_member_ids(db, tenant.id, data.member_ids)
    await _check_member_changes(db, principal, tenant.id, set(member_ids))
    group = Group(tenant_id=tenant.id, name=data.name, description=data.description)
    db.add(group)
    try:
        async with db.begin_nested():
            await db.flush()
    except IntegrityError as exc:
        raise conflict("group_name_taken", "A group with this name already exists.") from exc
    await _set_members(db, group, member_ids)
    await audit.record(
        db,
        principal,
        "group.create",
        target_type="group",
        target_id=group.id,
        target_label=group.name,
        details={"members": len(member_ids)},
    )
    return await get_group(db, principal, group.id)


async def update_group(
    db: AsyncSession, principal: Principal, group_id: uuid.UUID, data: GroupUpdate
) -> GroupDetail:
    tenant = principal.require_tenant()
    group = await _load(db, tenant.id, group_id)
    details: dict[str, object] = {}
    if data.name is not None and data.name != group.name:
        details["renamed_from"] = group.name
        group.name = data.name
    if data.description is not None:
        group.description = data.description
    try:
        async with db.begin_nested():
            await db.flush()
    except IntegrityError as exc:
        raise conflict("group_name_taken", "A group with this name already exists.") from exc
    if data.member_ids is not None:
        member_ids = await _validated_member_ids(db, tenant.id, data.member_ids)
        current = set(await _member_ids(db, group))
        await _check_member_changes(db, principal, tenant.id, current ^ set(member_ids))
        await _set_members(db, group, member_ids)
        details["members"] = len(member_ids)
    await audit.record(
        db,
        principal,
        "group.update",
        target_type="group",
        target_id=group.id,
        target_label=group.name,
        details=details,
    )
    return await get_group(db, principal, group.id)


async def delete_group(db: AsyncSession, principal: Principal, group_id: uuid.UUID) -> None:
    tenant = principal.require_tenant()
    group = await _load(db, tenant.id, group_id)
    # Deleting the group takes every member out of it - the rank rule applies as for removing
    # them one by one.
    await _check_member_changes(db, principal, tenant.id, set(await _member_ids(db, group)))
    name = group.name
    await db.delete(group)
    await db.flush()
    await audit.record(
        db, principal, "group.delete", target_type="group", target_id=group_id, target_label=name
    )
