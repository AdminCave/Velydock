"""Initial schema, including the row-level-security policies that isolate tenants.

Revision ID: 0001
Revises: -
Create Date: 2026-11-20 11:28:20.428806
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# ---------------------------------------------------------------------------------------------
# Row-level security
#
# The application sets three transaction-local values (see velydock/db.py). With none of them
# set, every policy below evaluates to false: deny by default.
#
#   app.scope      'tenant'  normal request, bound to one tenant
#                  'system'  trusted internal code (sign-in, system administration, CLI)
#   app.tenant_id  the tenant a request acts in
#   app.user_id    the acting user
#
# FORCE makes the policies apply to the table owner as well, which is the role the application
# connects with. That role must not be a superuser (superusers bypass row-level security).
# ---------------------------------------------------------------------------------------------

_TENANT_TABLES = ("memberships", "groups", "group_members", "apps", "app_group_grants", "app_user_grants")
_ALL_TABLES = (
    *_TENANT_TABLES,
    "tenants",
    "users",
    "user_settings",
    "system_settings",
    "sessions",
    "audit_log",
)

_IN_TENANT = "(app_scope() = 'tenant' AND {column} = app_tenant_id())"
_SYSTEM = "app_scope() = 'system'"


def _row_level_security() -> list[str]:
    statements = [
        """
        CREATE FUNCTION app_scope() RETURNS text LANGUAGE sql STABLE AS
        $$ SELECT coalesce(current_setting('app.scope', true), '') $$
        """,
        """
        CREATE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$
        """,
        """
        CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$
        """,
    ]
    for table in _ALL_TABLES:
        statements.append(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        statements.append(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")

    # Tenant-owned rows: visible and writable only inside their tenant.
    own_tenant = f"{_SYSTEM} OR {_IN_TENANT.format(column='tenant_id')}"
    for table in _TENANT_TABLES:
        statements.append(
            f"CREATE POLICY tenant_isolation ON {table} USING ({own_tenant}) WITH CHECK ({own_tenant})"
        )

    # Tenants: a request sees its own tenant; creating and deleting tenants is system-only.
    this_tenant = f"{_SYSTEM} OR {_IN_TENANT.format(column='id')}"
    statements += [
        f"CREATE POLICY tenants_read ON tenants FOR SELECT USING ({this_tenant})",
        f"CREATE POLICY tenants_update ON tenants FOR UPDATE USING ({this_tenant}) WITH CHECK ({this_tenant})",
        f"CREATE POLICY tenants_insert ON tenants FOR INSERT WITH CHECK ({_SYSTEM})",
        f"CREATE POLICY tenants_delete ON tenants FOR DELETE USING ({_SYSTEM})",
        # Tenant administrators may change their tenant's settings, never its identity or state.
        """
        CREATE FUNCTION tenants_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF app_scope() <> 'system' AND (
               NEW.slug IS DISTINCT FROM OLD.slug OR NEW.name IS DISTINCT FROM OLD.name
            OR NEW.active IS DISTINCT FROM OLD.active OR NEW.idp_org_id IS DISTINCT FROM OLD.idp_org_id
          ) THEN
            RAISE EXCEPTION 'tenant identity can only be changed in system scope' USING ERRCODE = '42501';
          END IF;
          RETURN NEW;
        END $$
        """,
        "CREATE TRIGGER tenants_guard BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION tenants_guard()",
    ]

    # Users are identities of the shared realm. A tenant sees its members and the identities it
    # owns; it may create, change and delete only identities it owns. Everyone sees themselves.
    owned = _IN_TENANT.format(column="home_tenant_id")
    member = (
        "(app_scope() = 'tenant' AND EXISTS (SELECT 1 FROM memberships m "
        "WHERE m.user_id = users.id AND m.tenant_id = app_tenant_id()))"
    )
    statements += [
        f"CREATE POLICY users_read ON users FOR SELECT USING ({_SYSTEM} OR id = app_user_id() OR {owned} OR {member})",
        f"CREATE POLICY users_insert ON users FOR INSERT WITH CHECK ({_SYSTEM} OR {owned})",
        f"""CREATE POLICY users_update ON users FOR UPDATE
            USING ({_SYSTEM} OR id = app_user_id() OR {owned})
            WITH CHECK ({_SYSTEM} OR id = app_user_id() OR {owned})""",
        f"CREATE POLICY users_delete ON users FOR DELETE USING ({_SYSTEM} OR {owned})",
        # Row-level security cannot protect single columns, so a trigger does: nobody outside
        # system scope can grant system-administrator rights or move an identity elsewhere.
        """
        CREATE FUNCTION users_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF app_scope() <> 'system' THEN
            IF TG_OP = 'INSERT' THEN
              IF NEW.is_system_admin THEN
                RAISE EXCEPTION 'system administrators can only be created in system scope' USING ERRCODE = '42501';
              END IF;
            ELSIF NEW.is_system_admin IS DISTINCT FROM OLD.is_system_admin
               OR NEW.home_tenant_id IS DISTINCT FROM OLD.home_tenant_id
               OR NEW.idp_id IS DISTINCT FROM OLD.idp_id THEN
              RAISE EXCEPTION 'protected user attribute can only be changed in system scope' USING ERRCODE = '42501';
            END IF;
          END IF;
          RETURN NEW;
        END $$
        """,
        "CREATE TRIGGER users_guard BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION users_guard()",
    ]

    own_user = f"{_SYSTEM} OR user_id = app_user_id()"
    statements += [
        f"CREATE POLICY own_settings ON user_settings USING ({own_user}) WITH CHECK ({own_user})",
        # Readable by everyone (instance name, defaults), writable in system scope only.
        "CREATE POLICY system_settings_read ON system_settings FOR SELECT USING (true)",
        f"CREATE POLICY system_settings_write ON system_settings USING ({_SYSTEM}) WITH CHECK ({_SYSTEM})",
        # Sessions are only handled by the authentication code.
        f"CREATE POLICY sessions_system ON sessions USING ({_SYSTEM}) WITH CHECK ({_SYSTEM})",
        # The audit log is append-only: there is no UPDATE or DELETE policy at all.
        f"CREATE POLICY audit_read ON audit_log FOR SELECT USING ({own_tenant})",
        f"CREATE POLICY audit_append ON audit_log FOR INSERT WITH CHECK ({own_tenant})",
    ]
    return statements


def upgrade() -> None:
    op.create_table(
        "system_settings",
        sa.Column("key", sa.String(length=60), nullable=False),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "tenants",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("slug", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("idp_org_id", sa.String(length=64), nullable=True),
        sa.Column("default_nav_position", sa.String(length=10), nullable=True),
        sa.Column("nav_position_locked", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("slug"),
    )
    op.create_index("uq_tenants_name_lower", "tenants", [sa.literal_column("lower(name)")], unique=True)
    op.create_table(
        "apps",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("description", sa.String(length=500), server_default="", nullable=False),
        sa.Column("type", sa.String(length=10), nullable=False),
        sa.Column("url", sa.String(length=2000), nullable=True),
        sa.Column("enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("visible_to_all", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("icon_name", sa.String(length=40), nullable=True),
        sa.Column("icon_data", sa.LargeBinary(), nullable=True),
        sa.Column("icon_mime", sa.String(length=40), nullable=True),
        sa.Column(
            "frame_permissions",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("embed_status", sa.String(length=10), server_default="unknown", nullable=False),
        sa.Column("embed_detail", sa.String(length=300), server_default="", nullable=False),
        sa.Column("embed_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("custom_html", sa.Text(), server_default="", nullable=False),
        sa.Column("custom_css", sa.Text(), server_default="", nullable=False),
        sa.Column("custom_js", sa.Text(), server_default="", nullable=False),
        sa.Column("custom_allow_network", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_apps_tenant", "apps", ["tenant_id", "sort_order"], unique=False)
    op.create_table(
        "audit_log",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=True),
        sa.Column("actor_id", sa.UUID(), nullable=True),
        sa.Column("actor_name", sa.String(length=150), server_default="", nullable=False),
        sa.Column("action", sa.String(length=60), nullable=False),
        sa.Column("target_type", sa.String(length=30), server_default="", nullable=False),
        sa.Column("target_id", sa.String(length=64), server_default="", nullable=False),
        sa.Column("target_label", sa.String(length=200), server_default="", nullable=False),
        sa.Column(
            "details",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("ip", sa.String(length=45), server_default="", nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_audit_tenant_created", "audit_log", ["tenant_id", "created_at"], unique=False)
    op.create_table(
        "groups",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("description", sa.String(length=500), server_default="", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_groups_tenant_name_lower", "groups", ["tenant_id", sa.literal_column("lower(name)")], unique=True
    )
    op.create_table(
        "users",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("idp_id", sa.String(length=64), nullable=False),
        sa.Column("username", sa.String(length=150), nullable=False),
        sa.Column("email", sa.String(length=254), nullable=True),
        sa.Column("first_name", sa.String(length=100), server_default="", nullable=False),
        sa.Column("last_name", sa.String(length=100), server_default="", nullable=False),
        sa.Column("active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("is_system_admin", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("home_tenant_id", sa.UUID(), nullable=True),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["home_tenant_id"], ["tenants.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("idp_id"),
    )
    op.create_index("ix_users_home_tenant", "users", ["home_tenant_id"], unique=False)
    op.create_index(
        "uq_users_email_lower",
        "users",
        [sa.literal_column("lower(email)")],
        unique=True,
        postgresql_where=sa.text("email IS NOT NULL"),
    )
    op.create_index("uq_users_username_lower", "users", [sa.literal_column("lower(username)")], unique=True)
    op.create_table(
        "app_group_grants",
        sa.Column("app_id", sa.UUID(), nullable=False),
        sa.Column("group_id", sa.UUID(), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(["app_id"], ["apps.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("app_id", "group_id"),
    )
    op.create_table(
        "app_user_grants",
        sa.Column("app_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(["app_id"], ["apps.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("app_id", "user_id"),
    )
    op.create_table(
        "group_members",
        sa.Column("group_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("group_id", "user_id"),
    )
    op.create_index("ix_group_members_user", "group_members", ["user_id"], unique=False)
    op.create_table(
        "memberships",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("role", sa.String(length=20), server_default="member", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "user_id", name="uq_memberships_tenant_user"),
    )
    op.create_index("ix_memberships_user", "memberships", ["user_id"], unique=False)
    op.create_table(
        "sessions",
        sa.Column("id_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=True),
        sa.Column("idp_sid", sa.String(length=64), nullable=True),
        sa.Column("id_token", sa.Text(), server_default="", nullable=False),
        sa.Column("auth_time", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column(
            "last_seen_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_agent", sa.String(length=300), server_default="", nullable=False),
        sa.Column("ip", sa.String(length=45), server_default="", nullable=False),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id_hash"),
    )
    op.create_index("ix_sessions_expires", "sessions", ["expires_at"], unique=False)
    op.create_index("ix_sessions_idp_sid", "sessions", ["idp_sid"], unique=False)
    op.create_index("ix_sessions_user", "sessions", ["user_id"], unique=False)
    op.create_table(
        "user_settings",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("theme", sa.String(length=10), nullable=True),
        sa.Column("nav_position", sa.String(length=10), nullable=True),
        sa.Column("language", sa.String(length=5), nullable=True),
        sa.Column("last_tenant_id", sa.UUID(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["last_tenant_id"], ["tenants.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )

    for statement in _row_level_security():
        op.execute(statement)


def downgrade() -> None:
    op.drop_table("user_settings")
    op.drop_index("ix_sessions_user", table_name="sessions")
    op.drop_index("ix_sessions_idp_sid", table_name="sessions")
    op.drop_index("ix_sessions_expires", table_name="sessions")
    op.drop_table("sessions")
    op.drop_index("ix_memberships_user", table_name="memberships")
    op.drop_table("memberships")
    op.drop_index("ix_group_members_user", table_name="group_members")
    op.drop_table("group_members")
    op.drop_table("app_user_grants")
    op.drop_table("app_group_grants")
    op.drop_index("uq_users_username_lower", table_name="users")
    op.drop_index("uq_users_email_lower", table_name="users", postgresql_where=sa.text("email IS NOT NULL"))
    op.drop_index("ix_users_home_tenant", table_name="users")
    op.drop_table("users")
    op.drop_index("uq_groups_tenant_name_lower", table_name="groups")
    op.drop_table("groups")
    op.drop_index("ix_audit_tenant_created", table_name="audit_log")
    op.drop_table("audit_log")
    op.drop_index("ix_apps_tenant", table_name="apps")
    op.drop_table("apps")
    op.drop_index("uq_tenants_name_lower", table_name="tenants")
    op.drop_table("tenants")
    op.drop_table("system_settings")
    for function in ("users_guard", "tenants_guard", "app_scope", "app_tenant_id", "app_user_id"):
        op.execute(f"DROP FUNCTION IF EXISTS {function}() CASCADE")
