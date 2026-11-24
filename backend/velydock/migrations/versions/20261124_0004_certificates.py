"""Own TLS certificates for the bundled proxy.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-24 14:00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_SYSTEM = "app_scope() = 'system'"


def upgrade() -> None:
    op.create_table(
        "certificates",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("certificate", sa.Text(), nullable=False),
        sa.Column("private_key", sa.Text(), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False, unique=True),
        sa.Column("names", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("subject", sa.String(500), nullable=False, server_default=""),
        sa.Column("issuer", sa.String(500), nullable=False, server_default=""),
        sa.Column("chain", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("proxy_key", sa.Text(), nullable=False, server_default=""),
        sa.Column("warnings", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("serial", sa.String(80), nullable=False, server_default=""),
        sa.Column("key_type", sa.String(20), nullable=False, server_default=""),
        sa.Column("not_before", sa.DateTime(timezone=True), nullable=False),
        sa.Column("not_after", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("uq_certificates_name_lower", "certificates", [sa.text("lower(name)")], unique=True)
    op.execute("ALTER TABLE certificates ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE certificates FORCE ROW LEVEL SECURITY")
    # Private keys: the system scope only, also for reading. A request of an organization sees
    # no row of this table, whatever it asks for.
    op.execute(f"CREATE POLICY certificates_system ON certificates USING ({_SYSTEM}) WITH CHECK ({_SYSTEM})")


def downgrade() -> None:
    op.drop_table("certificates")
