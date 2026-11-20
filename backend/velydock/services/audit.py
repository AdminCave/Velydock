"""Audit trail of administrative actions."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.models import AuditLog
from velydock.schemas import AuditEntry, AuditPage

if TYPE_CHECKING:
    from velydock.api.deps import Principal

_SYSTEM = object()


async def record(
    db: AsyncSession,
    principal: Principal | None,
    action: str,
    *,
    target_type: str = "",
    target_id: uuid.UUID | str | None = None,
    target_label: str = "",
    details: dict[str, Any] | None = None,
    tenant_id: uuid.UUID | object | None = _SYSTEM,
) -> None:
    """Append an entry. By default it belongs to the principal's active tenant."""
    if tenant_id is _SYSTEM:
        tenant_id = principal.tenant.id if principal and principal.tenant else None
    db.add(
        AuditLog(
            tenant_id=tenant_id,
            actor_id=principal.user.id if principal else None,
            actor_name=principal.user.username if principal else "system",
            action=action,
            target_type=target_type,
            target_id=str(target_id) if target_id is not None else "",
            target_label=target_label[:200],
            details=details or {},
            ip=principal.ip if principal else "",
        )
    )
    await db.flush()


async def list_entries(
    db: AsyncSession, tenant_id: uuid.UUID | None, *, page: int, page_size: int
) -> AuditPage:
    condition = AuditLog.tenant_id == tenant_id if tenant_id is not None else AuditLog.tenant_id.is_(None)
    total = (await db.execute(select(func.count()).select_from(AuditLog).where(condition))).scalar_one()
    rows = await db.execute(
        select(AuditLog)
        .where(condition)
        .order_by(AuditLog.id.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    return AuditPage(
        items=[AuditEntry.model_validate(row) for row in rows.scalars()],
        total=total,
        page=page,
        page_size=page_size,
    )
