"""User administration inside a tenant, plus the system-wide user operations.

Identity data and credentials live in the identity provider; every change is written through to
it. The order is always: validate, call the provider, then persist – and undo the provider call
if persisting fails – so both sides stay consistent.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.api.deps import Principal
from velydock.db import system_scope
from velydock.errors import ApiError, conflict, forbidden, idp_unavailable, invalid, not_found
from velydock.idp.base import (
    IdentityProvider,
    IdpConflict,
    IdpError,
    IdpInvalid,
    IdpNotFound,
    IdpUnavailable,
)
from velydock.models import AppUserGrant, Group, GroupMember, Membership, Role, Tenant, User
from velydock.policy import (
    Permission,
    Target,
    can_assign_role,
    can_create_with_role,
    can_manage_identity,
    can_manage_membership,
    rank,
)
from velydock.schemas import (
    GroupRef,
    MembershipOut,
    SystemUserOut,
    SystemUserPage,
    TenantRef,
    UserCreate,
    UserCreated,
    UserOut,
    UserPage,
    UserUpdate,
)
from velydock.security import sessions
from velydock.security.tokens import temporary_password
from velydock.services import audit

log = logging.getLogger(__name__)


def like_pattern(term: str) -> str:
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _idp_failure(exc: IdpError) -> ApiError:
    if isinstance(exc, IdpUnavailable):
        return idp_unavailable()
    if isinstance(exc, IdpConflict):
        if exc.field == "email":
            return conflict("email_taken", "This e-mail address is already in use.")
        return conflict("username_taken", "This username is already in use.")
    if isinstance(exc, IdpInvalid):
        # A rule of the identity provider that our own validation does not know: still the
        # user's input, so it is reported against the field like any other validation error.
        return invalid(
            "The identity provider does not accept this value.",
            details={"fields": [{"field": exc.field, "message": "is not accepted by the identity provider"}]},
        )
    log.warning("identity provider rejected a request: %s", exc)
    return ApiError(
        502, "idp_error", "The identity provider rejected the request.", {"reason": str(exc)[:200]}
    )


_ELEVATED_ROLES = {Role.USER_MANAGER.value, Role.TENANT_ADMIN.value}
# Advisory lock that puts changes to the set of active system administrators in a queue.
_SYSTEM_ADMIN_LOCK = 0x56454C59


async def _require_fresh_sign_in(db: AsyncSession, user: User) -> None:
    """New administrative rights only take effect in a new session.

    The second-factor rule is enforced at sign-in. A session that began as a plain member must
    therefore not simply carry the new rights; ending it sends the account through sign-in again.
    """
    async with system_scope(db):
        await sessions.delete_user_sessions(db, user.id)


async def _ensure_a_system_admin_remains(db: AsyncSession, excluding: uuid.UUID) -> None:
    """Refuse to take the last active system administrator away.

    Counting and changing are two steps; the lock makes concurrent requests take them one after
    the other, so two administrators cannot remove each other at the same moment.
    """
    async with system_scope(db):
        await db.execute(select(func.pg_advisory_xact_lock(_SYSTEM_ADMIN_LOCK)))
        remaining = (
            await db.execute(
                select(func.count())
                .select_from(User)
                .where(User.is_system_admin.is_(True), User.active.is_(True), User.id != excluding)
            )
        ).scalar_one()
    if remaining == 0:
        raise invalid("At least one active system administrator must remain.", "last_system_admin")


def _target(user: User, membership: Membership | None) -> Target:
    return Target(
        user_id=user.id,
        is_system_admin=user.is_system_admin,
        home_tenant_id=user.home_tenant_id,
        role=Role(membership.role) if membership else None,
    )


async def _load(db: AsyncSession, tenant_id: uuid.UUID, user_id: uuid.UUID) -> tuple[User, Membership]:
    row = (
        await db.execute(
            select(User, Membership)
            .join(Membership, Membership.user_id == User.id)
            .where(User.id == user_id, Membership.tenant_id == tenant_id)
        )
    ).first()
    if row is None:
        raise not_found("User")
    return row[0], row[1]


async def _groups_of(
    db: AsyncSession, tenant_id: uuid.UUID, user_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[GroupRef]]:
    result: dict[uuid.UUID, list[GroupRef]] = {uid: [] for uid in user_ids}
    if not user_ids:
        return result
    rows = await db.execute(
        select(GroupMember.user_id, Group.id, Group.name)
        .join(Group, Group.id == GroupMember.group_id)
        .where(GroupMember.tenant_id == tenant_id, GroupMember.user_id.in_(user_ids))
        .order_by(Group.name)
    )
    for user_id, group_id, name in rows.all():
        result[user_id].append(GroupRef(id=group_id, name=name))
    return result


def _serialize(principal: Principal, user: User, membership: Membership, groups: list[GroupRef]) -> UserOut:
    tenant = principal.require_tenant()
    target = _target(user, membership)
    actor = principal.actor
    return UserOut(
        id=user.id,
        username=user.username,
        email=user.email,
        first_name=user.first_name,
        last_name=user.last_name,
        display_name=user.display_name,
        active=user.active,
        is_system_admin=user.is_system_admin,
        role=Role(membership.role),
        managed=user.home_tenant_id == tenant.id,
        home_tenant=TenantRef.model_validate(tenant) if user.home_tenant_id == tenant.id else None,
        groups=groups,
        last_login_at=user.last_login_at,
        created_at=user.created_at,
        can_edit_identity=can_manage_identity(actor, target),
        can_edit_membership=can_manage_membership(actor, target),
        can_assign_role=can_assign_role(actor, target, Role(membership.role)),
    )


async def _validated_group_ids(
    db: AsyncSession, tenant_id: uuid.UUID, group_ids: list[uuid.UUID]
) -> list[uuid.UUID]:
    unique = list(dict.fromkeys(group_ids))
    if not unique:
        return []
    found = set(
        (
            await db.execute(select(Group.id).where(Group.tenant_id == tenant_id, Group.id.in_(unique)))
        ).scalars()
    )
    if len(found) != len(unique):
        # Unknown ids and ids of other tenants look the same on purpose.
        raise invalid("One or more groups do not exist.", "unknown_group")
    return unique


async def _set_groups(
    db: AsyncSession, tenant_id: uuid.UUID, user_id: uuid.UUID, group_ids: list[uuid.UUID]
) -> None:
    await db.execute(
        delete(GroupMember).where(GroupMember.tenant_id == tenant_id, GroupMember.user_id == user_id)
    )
    db.add_all([GroupMember(group_id=gid, user_id=user_id, tenant_id=tenant_id) for gid in group_ids])
    await db.flush()


async def list_users(
    db: AsyncSession,
    principal: Principal,
    *,
    search: str = "",
    role: Role | None = None,
    active: bool | None = None,
    group_id: uuid.UUID | None = None,
    page: int = 1,
    page_size: int = 25,
) -> UserPage:
    tenant = principal.require_tenant()
    query = (
        select(User, Membership)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.tenant_id == tenant.id)
    )
    if search.strip():
        pattern = like_pattern(search.strip())
        query = query.where(
            or_(
                User.username.ilike(pattern, escape="\\"),
                User.email.ilike(pattern, escape="\\"),
                User.first_name.ilike(pattern, escape="\\"),
                User.last_name.ilike(pattern, escape="\\"),
                (User.first_name + " " + User.last_name).ilike(pattern, escape="\\"),
            )
        )
    if role is not None:
        query = query.where(Membership.role == role.value)
    if active is not None:
        query = query.where(User.active.is_(active))
    if group_id is not None:
        query = query.where(
            User.id.in_(
                select(GroupMember.user_id).where(
                    GroupMember.group_id == group_id, GroupMember.tenant_id == tenant.id
                )
            )
        )
    total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
    rows = (
        await db.execute(
            query.order_by(func.lower(User.last_name), func.lower(User.first_name), User.username)
            .limit(page_size)
            .offset((page - 1) * page_size)
        )
    ).all()
    groups = await _groups_of(db, tenant.id, [user.id for user, _ in rows])
    return UserPage(
        items=[_serialize(principal, user, membership, groups[user.id]) for user, membership in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


async def get_user(db: AsyncSession, principal: Principal, user_id: uuid.UUID) -> UserOut:
    tenant = principal.require_tenant()
    user, membership = await _load(db, tenant.id, user_id)
    groups = await _groups_of(db, tenant.id, [user.id])
    return _serialize(principal, user, membership, groups[user.id])


async def _ensure_unique(
    db: AsyncSession, *, username: str | None, email: str | None, exclude: uuid.UUID | None = None
) -> None:
    """Usernames and e-mail addresses are unique across the whole installation (shared realm)."""
    async with system_scope(db):
        if username is not None:
            query = select(User.id).where(func.lower(User.username) == username.lower())
            if exclude:
                query = query.where(User.id != exclude)
            if (await db.execute(query)).first():
                raise conflict("username_taken", "This username is already in use.")
        if email:
            query = select(User.id).where(func.lower(User.email) == email.lower())
            if exclude:
                query = query.where(User.id != exclude)
            if (await db.execute(query)).first():
                raise conflict("email_taken", "This e-mail address is already in use.")


async def create_user(
    db: AsyncSession, idp: IdentityProvider, principal: Principal, data: UserCreate, *, smtp_configured: bool
) -> UserCreated:
    tenant = principal.require_tenant()
    if not can_create_with_role(principal.actor, data.role):
        raise forbidden("You may not assign this role.")
    if data.send_email and not data.email:
        raise invalid("An e-mail address is required to send the invitation.", "email_required")
    if data.send_email and not smtp_configured:
        raise invalid("E-mail delivery is not configured.", "smtp_not_configured")
    group_ids = await _validated_group_ids(db, tenant.id, data.group_ids)
    await _ensure_unique(db, username=data.username, email=data.email)

    password = temporary_password()
    try:
        idp_id = await idp.create_user(
            username=data.username,
            email=data.email,
            first_name=data.first_name,
            last_name=data.last_name,
            temporary_password=password,
        )
    except IdpError as exc:
        raise _idp_failure(exc) from exc

    try:
        user = User(
            idp_id=idp_id,
            username=data.username,
            email=data.email,
            first_name=data.first_name,
            last_name=data.last_name,
            home_tenant_id=tenant.id,
        )
        db.add(user)
        await db.flush()
        membership = Membership(tenant_id=tenant.id, user_id=user.id, role=data.role.value)
        db.add(membership)
        await db.flush()
        await _set_groups(db, tenant.id, user.id, group_ids)
        if tenant.idp_org_id:
            await idp.add_organization_member(tenant.idp_org_id, idp_id)
        email_sent = False
        if data.send_email:
            await idp.send_password_setup_email(idp_id)
            email_sent = True
        await audit.record(
            db,
            principal,
            "user.create",
            target_type="user",
            target_id=user.id,
            target_label=user.username,
            details={"role": data.role.value, "groups": len(group_ids), "invited_by_email": email_sent},
        )
        await db.refresh(user)
        await db.refresh(membership)
        groups = await _groups_of(db, tenant.id, [user.id])
        created = UserCreated(
            user=_serialize(principal, user, membership, groups[user.id]),
            temporary_password=None if email_sent else password,
            email_sent=email_sent,
        )
    except Exception as exc:
        # Do not leave an orphaned account behind in the identity provider: its user name and
        # address would be blocked for everyone while no such user is visible anywhere.
        try:
            await idp.delete_user(idp_id)
        except IdpError:
            log.exception("could not roll back identity %s after a failed user creation", idp_id)
        if isinstance(exc, IdpError):
            raise _idp_failure(exc) from exc
        if isinstance(exc, IntegrityError):
            raise conflict("username_taken", "This username or e-mail address is already in use.") from exc
        raise
    return created


async def update_user(
    db: AsyncSession, idp: IdentityProvider, principal: Principal, user_id: uuid.UUID, data: UserUpdate
) -> UserOut:
    tenant = principal.require_tenant()
    user, membership = await _load(db, tenant.id, user_id)
    target = _target(user, membership)
    actor = principal.actor
    changes: dict[str, object] = {}

    new_email = data.email if data.email_provided else user.email
    new_first = data.first_name if data.first_name is not None else user.first_name
    new_last = data.last_name if data.last_name is not None else user.last_name
    identity_changed = (new_email, new_first, new_last) != (user.email, user.first_name, user.last_name)
    active_changed = data.active is not None and data.active != user.active

    if (identity_changed or active_changed) and not can_manage_identity(actor, target):
        raise forbidden("This account is managed by another organization or outranks you.")
    if active_changed and user.id == principal.user.id:
        raise invalid("You cannot deactivate your own account.", "self_action")

    promoted = False
    if data.role is not None and data.role.value != membership.role:
        if not can_assign_role(actor, target, data.role):
            raise forbidden("You may not assign this role.")
        promoted = data.role.value in _ELEVATED_ROLES and rank(is_system_admin=False, role=data.role) > rank(
            is_system_admin=False, role=Role(membership.role)
        )
        changes["role"] = {"from": membership.role, "to": data.role.value}
        membership.role = data.role.value

    if data.group_ids is not None:
        if not can_manage_membership(actor, target) or Permission.GROUPS_WRITE not in principal.permissions:
            raise forbidden()
        group_ids = await _validated_group_ids(db, tenant.id, data.group_ids)
        await _set_groups(db, tenant.id, user.id, group_ids)
        changes["groups"] = len(group_ids)

    if active_changed and not data.active and user.is_system_admin:
        await _ensure_a_system_admin_remains(db, user.id)

    previous = (user.email, user.first_name, user.last_name)
    if identity_changed:
        if new_email != user.email:
            await _ensure_unique(db, username=None, email=new_email, exclude=user.id)
        try:
            await idp.update_user(user.idp_id, email=new_email, first_name=new_first, last_name=new_last)
        except IdpError as exc:
            raise _idp_failure(exc) from exc
        if new_email != user.email:
            changes["email"] = True
        user.email, user.first_name, user.last_name = new_email, new_first, new_last

    if active_changed:
        assert data.active is not None
        try:
            await idp.set_enabled(user.idp_id, data.active)
        except IdpError as exc:
            if identity_changed:
                # This request fails as a whole: take the profile change back, or the identity
                # provider would keep values Velydock never stored.
                try:
                    await idp.update_user(
                        user.idp_id, email=previous[0], first_name=previous[1], last_name=previous[2]
                    )
                except IdpError:
                    log.exception("could not take back the profile change of %s", user.idp_id)
            raise _idp_failure(exc) from exc
        user.active = data.active
        changes["active"] = data.active
        if not data.active:
            # The account is locked at the identity provider from here on. Ending its sessions
            # there is the second step; if only that fails, the lock still has to be stored and
            # the Velydock sessions still have to end, instead of reporting "nothing happened".
            try:
                await idp.logout_user(user.idp_id)
            except IdpError:
                log.exception("account %s is disabled, but its provider sessions could not be ended", user.id)
            async with system_scope(db):
                await sessions.delete_user_sessions(db, user.id)

    if promoted and user.id != principal.user.id:
        await _require_fresh_sign_in(db, user)

    await db.flush()
    if changes or identity_changed:
        await audit.record(
            db,
            principal,
            "user.update",
            target_type="user",
            target_id=user.id,
            target_label=user.username,
            details=changes,
        )
    groups = await _groups_of(db, tenant.id, [user.id])
    return _serialize(principal, user, membership, groups[user.id])


async def reset_password(
    db: AsyncSession, idp: IdentityProvider, principal: Principal, user_id: uuid.UUID
) -> str:
    tenant = principal.require_tenant()
    user, membership = await _load(db, tenant.id, user_id)
    if user.id == principal.user.id:
        # The own password is changed on the account page of the identity provider.
        raise invalid("You cannot reset your own password here.", "self_action")
    if not can_manage_identity(principal.actor, _target(user, membership)):
        raise forbidden("This account is managed by another organization or outranks you.")
    password = temporary_password()
    try:
        await idp.set_temporary_password(user.idp_id, password)
        await idp.logout_user(user.idp_id)
    except IdpError as exc:
        raise _idp_failure(exc) from exc
    async with system_scope(db):
        await sessions.delete_user_sessions(db, user.id)
    await audit.record(
        db,
        principal,
        "user.reset_password",
        target_type="user",
        target_id=user.id,
        target_label=user.username,
    )
    return password


async def end_sessions(
    db: AsyncSession, idp: IdentityProvider, principal: Principal, user_id: uuid.UUID
) -> None:
    tenant = principal.require_tenant()
    user, membership = await _load(db, tenant.id, user_id)
    if user.id == principal.user.id:
        # Ending the session this very request runs in would make the identity provider's
        # logout notification wait for this request. Signing out does the same job.
        raise invalid("Sign out to end your own sessions.", "self_action")
    if not can_manage_identity(principal.actor, _target(user, membership)):
        raise forbidden("This account is managed by another organization or outranks you.")
    try:
        await idp.logout_user(user.idp_id)
    except IdpError as exc:
        raise _idp_failure(exc) from exc
    async with system_scope(db):
        await sessions.delete_user_sessions(db, user.id)
    await audit.record(
        db, principal, "user.end_sessions", target_type="user", target_id=user.id, target_label=user.username
    )


async def remove_user(
    db: AsyncSession, idp: IdentityProvider, principal: Principal, user_id: uuid.UUID
) -> bool:
    """Remove a user from the tenant. Returns True if the whole identity was deleted.

    The home tenant deletes the identity itself; any other tenant only ends the guest membership.
    """
    tenant = principal.require_tenant()
    user, membership = await _load(db, tenant.id, user_id)
    if user.id == principal.user.id:
        raise invalid("You cannot remove your own account.", "self_action")
    target = _target(user, membership)
    username = user.username

    if user.home_tenant_id == tenant.id:
        if not can_manage_identity(principal.actor, target):
            raise forbidden("This account outranks you.")
        if user.is_system_admin:
            await _ensure_a_system_admin_remains(db, user.id)
        try:
            await idp.delete_user(user.idp_id)
        except IdpError as exc:
            raise _idp_failure(exc) from exc
        await db.delete(user)
        await db.flush()
        await audit.record(
            db, principal, "user.delete", target_type="user", target_id=user_id, target_label=username
        )
        return True

    if not can_manage_membership(principal.actor, target):
        raise forbidden("This account outranks you.")
    await _drop_membership(db, idp, tenant, user, membership)
    await audit.record(
        db, principal, "user.remove_membership", target_type="user", target_id=user_id, target_label=username
    )
    return False


async def _drop_membership(
    db: AsyncSession, idp: IdentityProvider, tenant: Tenant, user: User, membership: Membership
) -> None:
    await db.execute(
        delete(GroupMember).where(GroupMember.tenant_id == tenant.id, GroupMember.user_id == user.id)
    )
    await db.execute(
        delete(AppUserGrant).where(AppUserGrant.tenant_id == tenant.id, AppUserGrant.user_id == user.id)
    )
    await db.delete(membership)
    await db.flush()
    if tenant.idp_org_id:
        try:
            await idp.remove_organization_member(tenant.idp_org_id, user.idp_id)
        except IdpNotFound:
            pass
        except IdpError as exc:
            raise _idp_failure(exc) from exc


# -- system-wide operations (system administrators only; callers enforce that) -------------------


async def list_all_users(
    db: AsyncSession, *, search: str = "", page: int = 1, page_size: int = 25
) -> SystemUserPage:
    async with system_scope(db):
        query = select(User)
        if search.strip():
            pattern = like_pattern(search.strip())
            query = query.where(
                or_(
                    User.username.ilike(pattern, escape="\\"),
                    User.email.ilike(pattern, escape="\\"),
                    (User.first_name + " " + User.last_name).ilike(pattern, escape="\\"),
                )
            )
        total = (await db.execute(select(func.count()).select_from(query.subquery()))).scalar_one()
        users = list(
            (
                await db.execute(
                    query.order_by(func.lower(User.username)).limit(page_size).offset((page - 1) * page_size)
                )
            ).scalars()
        )
        items = [await _serialize_system(db, user) for user in users]
    return SystemUserPage(items=items, total=total, page=page, page_size=page_size)


async def _serialize_system(db: AsyncSession, user: User) -> SystemUserOut:
    rows = await db.execute(
        select(Tenant, Membership.role)
        .join(Membership, Membership.tenant_id == Tenant.id)
        .where(Membership.user_id == user.id)
        .order_by(Tenant.name)
    )
    memberships = [MembershipOut(tenant=TenantRef.model_validate(t), role=Role(r)) for t, r in rows.all()]
    home = await db.get(Tenant, user.home_tenant_id) if user.home_tenant_id else None
    return SystemUserOut(
        id=user.id,
        username=user.username,
        email=user.email,
        display_name=user.display_name,
        active=user.active,
        is_system_admin=user.is_system_admin,
        home_tenant=TenantRef.model_validate(home) if home else None,
        memberships=memberships,
        last_login_at=user.last_login_at,
    )


async def add_member(
    db: AsyncSession,
    idp: IdentityProvider,
    principal: Principal,
    tenant_id: uuid.UUID,
    user_id: uuid.UUID,
    role: Role,
) -> SystemUserOut:
    """Give an existing identity access to another tenant (as a guest unless it has no home yet)."""
    async with system_scope(db):
        tenant = await db.get(Tenant, tenant_id)
        user = await db.get(User, user_id)
        if tenant is None or user is None:
            raise not_found("User or organization")
        existing = (
            await db.execute(
                select(Membership).where(Membership.tenant_id == tenant_id, Membership.user_id == user_id)
            )
        ).scalar_one_or_none()
        already = conflict("already_member", "The user already belongs to this organization.")
        if existing is not None:
            raise already
        try:
            async with db.begin_nested():
                db.add(Membership(tenant_id=tenant_id, user_id=user_id, role=role.value))
                await db.flush()
        except IntegrityError:
            # A parallel request added the same membership in the meantime.
            raise already from None
        if user.home_tenant_id is None:
            user.home_tenant_id = tenant_id
        await db.flush()
        if tenant.idp_org_id:
            try:
                await idp.add_organization_member(tenant.idp_org_id, user.idp_id)
            except IdpError as exc:
                raise _idp_failure(exc) from exc
        await audit.record(
            db,
            principal,
            "user.add_membership",
            target_type="user",
            target_id=user.id,
            target_label=user.username,
            details={"role": role.value},
            tenant_id=tenant_id,
        )
        if role.value in _ELEVATED_ROLES and user.id != principal.user.id:
            await _require_fresh_sign_in(db, user)
        return await _serialize_system(db, user)


async def set_system_admin(
    db: AsyncSession, principal: Principal, user_id: uuid.UUID, flag: bool
) -> SystemUserOut:
    async with system_scope(db):
        user = await db.get(User, user_id)
        if user is None:
            raise not_found("User")
        if not flag and user.id == principal.user.id:
            raise invalid("You cannot revoke your own system administrator role.", "self_action")
        if not flag and user.is_system_admin:
            await _ensure_a_system_admin_remains(db, user.id)
        granted = flag and not user.is_system_admin
        user.is_system_admin = flag
        await db.flush()
        await audit.record(
            db,
            principal,
            "user.set_system_admin",
            target_type="user",
            target_id=user.id,
            target_label=user.username,
            details={"is_system_admin": flag},
            tenant_id=None,
        )
        if granted and user.id != principal.user.id:
            await _require_fresh_sign_in(db, user)
        return await _serialize_system(db, user)
