"""Publishing apps through the bundled reverse proxy.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-23 11:00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_IN_TENANT = "(app_scope() = 'tenant' AND tenant_id = app_tenant_id())"
_SYSTEM = "app_scope() = 'system'"
_SIGNED_IN = "app_scope() IN ('tenant', 'system')"


def upgrade() -> None:
    op.create_table(
        "app_publications",
        sa.Column(
            "app_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("apps.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "tenant_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(40), nullable=False, unique=True),
        sa.Column("mode", sa.String(10), nullable=False),
        sa.Column("target_url", sa.String(500), nullable=False),
        sa.Column("access", sa.String(10), nullable=False, server_default="protected"),
        sa.Column("template", sa.String(60), nullable=False, server_default="builtin:standard"),
        sa.Column("options", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_app_publications_tenant", "app_publications", ["tenant_id"])
    op.create_table(
        "proxy_targets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "tenant_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("value", sa.String(255), nullable=False),
        sa.Column("note", sa.String(200), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("uq_proxy_targets", "proxy_targets", ["tenant_id", "value"], unique=True)
    op.create_table(
        "proxy_templates",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("description", sa.String(300), nullable=False, server_default=""),
        sa.Column("options", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("uq_proxy_templates_name_lower", "proxy_templates", [sa.text("lower(name)")], unique=True)

    for table in ("app_publications", "proxy_targets", "proxy_templates"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
    # A publication belongs to its organization like the app it publishes.
    op.execute(
        f"CREATE POLICY tenant_isolation ON app_publications USING ({_SYSTEM} OR {_IN_TENANT}) "
        f"WITH CHECK ({_SYSTEM} OR {_IN_TENANT})"
    )
    # What an organization may reach is decided for it, not by it: it reads, the system writes.
    op.execute(
        f"CREATE POLICY proxy_targets_read ON proxy_targets FOR SELECT USING ({_SYSTEM} OR {_IN_TENANT})"
    )
    op.execute(f"CREATE POLICY proxy_targets_insert ON proxy_targets FOR INSERT WITH CHECK ({_SYSTEM})")
    op.execute(
        f"CREATE POLICY proxy_targets_update ON proxy_targets FOR UPDATE USING ({_SYSTEM}) WITH CHECK ({_SYSTEM})"
    )
    op.execute(f"CREATE POLICY proxy_targets_delete ON proxy_targets FOR DELETE USING ({_SYSTEM})")
    # Templates are the same for everybody: every organization reads them, the system writes.
    op.execute(f"CREATE POLICY proxy_templates_read ON proxy_templates FOR SELECT USING ({_SIGNED_IN})")
    op.execute(f"CREATE POLICY proxy_templates_insert ON proxy_templates FOR INSERT WITH CHECK ({_SYSTEM})")
    op.execute(
        f"CREATE POLICY proxy_templates_update ON proxy_templates FOR UPDATE USING ({_SYSTEM}) WITH CHECK ({_SYSTEM})"
    )
    op.execute(f"CREATE POLICY proxy_templates_delete ON proxy_templates FOR DELETE USING ({_SYSTEM})")


def downgrade() -> None:
    op.drop_table("proxy_templates")
    op.drop_table("proxy_targets")
    op.drop_table("app_publications")
