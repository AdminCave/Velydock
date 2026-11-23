"""Appearance per organization and per user: theme, accent colour, app bar, logo.

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-23 09:00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Settings of an organization, not its identity: tenant administrators may change them
    # (policy tenants_update), and the trigger tenants_guard does not watch these columns.
    for name in ("default_theme", "default_app_bar"):
        op.add_column("tenants", sa.Column(name, sa.String(10), nullable=True))
    op.add_column("tenants", sa.Column("accent_color", sa.String(7), nullable=True))
    for name in ("theme_locked", "accent_locked", "app_bar_locked"):
        op.add_column(
            "tenants", sa.Column(name, sa.Boolean(), nullable=False, server_default=sa.text("false"))
        )
    op.add_column("tenants", sa.Column("logo_data", sa.LargeBinary(), nullable=True))
    op.add_column("tenants", sa.Column("logo_mime", sa.String(40), nullable=True))
    op.add_column("user_settings", sa.Column("accent_color", sa.String(7), nullable=True))
    op.add_column("user_settings", sa.Column("app_bar", sa.String(10), nullable=True))


def downgrade() -> None:
    for name in ("app_bar", "accent_color"):
        op.drop_column("user_settings", name)
    for name in (
        "logo_mime",
        "logo_data",
        "app_bar_locked",
        "accent_locked",
        "theme_locked",
        "accent_color",
        "default_app_bar",
        "default_theme",
    ):
        op.drop_column("tenants", name)
