"""Shared fixtures.

Tests that touch the database run against a real PostgreSQL (row-level security cannot be
tested with anything else). A fresh database is created per test session, owned by an
unprivileged role exactly as in production, and emptied between tests.

    VELYDOCK_TEST_PG_ADMIN_URL   superuser connection, default: the dev stack on 127.0.0.1:15432
"""

from __future__ import annotations

import asyncio
import os
import secrets
import uuid
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

import asyncpg
import httpx
import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.pool import NullPool
from starlette.types import ASGIApp

from tests.support.fake_idp import FakeIdp
from tests.support.mini_idp import Identity, MiniIdp
from velydock import db as database
from velydock.app import create_app
from velydock.config import Settings
from velydock.db import Scope, transaction
from velydock.models import (
    App,
    AppGroupGrant,
    AppType,
    AppUserGrant,
    Group,
    GroupMember,
    Membership,
    Role,
    Tenant,
    User,
)
from velydock.security.http import CSRF_HEADER
from velydock.security.oidc import OidcClient
from velydock.security.tokens import hash_token, random_token

ADMIN_URL = os.environ.get(
    "VELYDOCK_TEST_PG_ADMIN_URL", "postgresql://postgres:dev-postgres-password@127.0.0.1:15432/postgres"
)
TEST_ROLE = "velydock_test"
TEST_ROLE_PASSWORD = "velydock-test-password"

PUBLIC_URL = "https://dock.test"
SANDBOX_URL = "https://sandbox.test"

_TABLES = (
    "audit_log, sessions, user_settings, system_settings, app_user_grants, app_group_grants, apps, "
    "group_members, groups, memberships, users, tenants"
)


def _admin_parts() -> tuple[str, int]:
    from urllib.parse import urlsplit

    parts = urlsplit(ADMIN_URL)
    return parts.hostname or "127.0.0.1", parts.port or 5432


def unavailable(reason: str) -> NoReturn:
    """A service the tests need is missing: skip on a developer machine, fail in CI.

    A skipped suite looks like a passed one. In CI that would silently switch off the database
    and Keycloak tests - tenant isolation among them - the day someone changes a port.
    """
    if os.environ.get("CI"):
        pytest.fail(reason)
    pytest.skip(reason)


@pytest.fixture(scope="session")
def database_url() -> Iterator[str]:
    """Create a throw-away database owned by a role without superuser or BYPASSRLS rights."""
    name = f"velydock_test_{secrets.token_hex(4)}"

    async def create() -> None:
        conn = await asyncpg.connect(ADMIN_URL)
        try:
            exists = await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", TEST_ROLE)
            if not exists:
                await conn.execute(
                    f"CREATE ROLE {TEST_ROLE} LOGIN PASSWORD '{TEST_ROLE_PASSWORD}' "
                    "NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
                )
            await conn.execute(f'CREATE DATABASE "{name}" OWNER {TEST_ROLE}')
        finally:
            await conn.close()

    async def drop() -> None:
        conn = await asyncpg.connect(ADMIN_URL)
        try:
            await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        finally:
            await conn.close()

    try:
        asyncio.run(create())
    except (OSError, asyncpg.PostgresError) as exc:
        unavailable(
            f"PostgreSQL for tests not reachable ({exc}); start the dev stack or set VELYDOCK_TEST_PG_ADMIN_URL"
        )
    host, port = _admin_parts()
    url = f"postgresql+asyncpg://{TEST_ROLE}:{TEST_ROLE_PASSWORD}@{host}:{port}/{name}"
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parent.parent / "velydock" / "migrations"))
    config.set_main_option("sqlalchemy.url", url)
    command.upgrade(config, "head")
    # NullPool: every transaction gets its own connection, nothing is shared between tests.
    database.init_engine(url, poolclass=NullPool)
    yield url
    asyncio.run(database.dispose_engine())
    asyncio.run(drop())


@pytest.fixture(scope="session")
def settings(database_url: str) -> Settings:
    return Settings(
        environment="test",
        public_url=PUBLIC_URL,
        sandbox_url=SANDBOX_URL,
        database_url=database_url,
        secret_key="test-secret-key-" + "0" * 32,
        keycloak_public_url="https://auth.test",
        keycloak_internal_url="http://keycloak.internal:8080",
        oidc_client_secret="test-oidc-client-secret",
        idp_admin_client_secret="test-idp-admin-secret",
        require_admin_2fa=False,
        static_dir="/nonexistent",
    )


@pytest.fixture
async def clean_db(database_url: str) -> AsyncIterator[None]:
    async with database.get_engine().begin() as conn:
        await conn.execute(text(f"TRUNCATE {_TABLES} RESTART IDENTITY CASCADE"))
    yield


class ApiClient(httpx.AsyncClient):
    """An httpx client that may be used first and entered as a context manager afterwards."""

    async def __aenter__(self) -> ApiClient:
        if self.is_closed or getattr(self, "_entered", False):
            return self
        self._entered = True
        try:
            await super().__aenter__()
        except RuntimeError:
            # Already opened by an earlier request; closing on exit is all that matters.
            pass
        return self


@dataclass
class World:
    """Builds test data directly in the database and hands out signed-in HTTP clients."""

    settings: Settings
    idp: FakeIdp
    mini: MiniIdp
    app: ASGIApp

    async def tenant(self, name: str = "Acme", slug: str | None = None, **fields: Any) -> Tenant:
        slug = slug or name.lower().replace(" ", "-")
        org_id = await self.idp.create_organization(name=name, alias=slug)
        async with transaction(Scope.SYSTEM) as db:
            tenant = Tenant(name=name, slug=slug, idp_org_id=org_id, **fields)
            db.add(tenant)
            await db.flush()
            await db.refresh(tenant)
        return tenant

    async def user(
        self,
        tenant: Tenant | None,
        username: str,
        role: Role | None = Role.MEMBER,
        *,
        system_admin: bool = False,
        home: Tenant | str | None = "same",
        active: bool = True,
        email: str | None = None,
        first_name: str = "",
        last_name: str = "",
    ) -> User:
        idp_id = self.idp.seed_user(username, email, first_name, last_name)
        home_tenant = tenant if home == "same" else home
        async with transaction(Scope.SYSTEM) as db:
            user = User(
                idp_id=idp_id,
                username=username,
                email=email,
                first_name=first_name or username.capitalize(),
                last_name=last_name or "Test",
                active=active,
                is_system_admin=system_admin,
                home_tenant_id=home_tenant.id if isinstance(home_tenant, Tenant) else None,
            )
            db.add(user)
            await db.flush()
            if tenant is not None and role is not None:
                db.add(Membership(tenant_id=tenant.id, user_id=user.id, role=role.value))
                if tenant.idp_org_id:
                    await self.idp.add_organization_member(tenant.idp_org_id, idp_id)
            await db.flush()
            await db.refresh(user)
        return user

    async def member(self, tenant: Tenant, user: User, role: Role = Role.MEMBER) -> None:
        async with transaction(Scope.SYSTEM) as db:
            db.add(Membership(tenant_id=tenant.id, user_id=user.id, role=role.value))

    async def group(self, tenant: Tenant, name: str, members: list[User] | None = None) -> Group:
        async with transaction(Scope.SYSTEM) as db:
            group = Group(tenant_id=tenant.id, name=name)
            db.add(group)
            await db.flush()
            for user in members or []:
                db.add(GroupMember(group_id=group.id, user_id=user.id, tenant_id=tenant.id))
            await db.flush()
            await db.refresh(group)
        return group

    async def app_(
        self,
        tenant: Tenant,
        name: str,
        *,
        type: AppType = AppType.EXTERNAL,
        url: str | None = "https://example.org/",
        groups: list[Group] | None = None,
        users: list[User] | None = None,
        **fields: Any,
    ) -> App:
        async with transaction(Scope.SYSTEM) as db:
            app = App(
                tenant_id=tenant.id,
                name=name,
                type=type.value,
                url=None if type == AppType.CUSTOM else url,
                **fields,
            )
            db.add(app)
            await db.flush()
            for group in groups or []:
                db.add(AppGroupGrant(app_id=app.id, group_id=group.id, tenant_id=tenant.id))
            for user in users or []:
                db.add(AppUserGrant(app_id=app.id, user_id=user.id, tenant_id=tenant.id))
            await db.flush()
            await db.refresh(app)
        return app

    async def session(self, user: User, tenant: Tenant | None = None, *, sid: str | None = None) -> str:
        """Create a server-side session and return the cookie value."""
        from datetime import UTC, datetime, timedelta

        from velydock.models import AuthSession

        value = random_token(32)
        async with transaction(Scope.SYSTEM) as db:
            db.add(
                AuthSession(
                    id_hash=hash_token(value),
                    user_id=user.id,
                    tenant_id=tenant.id if tenant else None,
                    idp_sid=sid or f"sid-{uuid.uuid4().hex[:8]}",
                    id_token="id-token",
                    expires_at=datetime.now(UTC) + timedelta(hours=self.settings.session_max_hours),
                )
            )
        return value

    def client(
        self, cookie: str | None = None, *, csrf: bool = True, base_url: str = PUBLIC_URL
    ) -> httpx.AsyncClient:
        headers = {CSRF_HEADER: "1"} if csrf else {}
        client = ApiClient(
            transport=httpx.ASGITransport(app=self.app),
            base_url=base_url,
            headers=headers,
            follow_redirects=False,
        )
        if cookie:
            client.cookies.set(self.settings.session_cookie, cookie)
        return client

    async def login(self, user: User, tenant: Tenant | None = None, **kwargs: Any) -> httpx.AsyncClient:
        return self.client(await self.session(user, tenant), **kwargs)

    def identity(self, user: User) -> Identity:
        return Identity(user.idp_id, user.username, user.email, user.first_name, user.last_name)


@pytest.fixture
async def world(settings: Settings, clean_db: None) -> AsyncIterator[World]:
    idp = FakeIdp()
    mini = MiniIdp(settings)
    http = httpx.AsyncClient(transport=mini.transport())
    app = create_app(settings, idp=idp, oidc=OidcClient(settings, http))
    yield World(settings=settings, idp=idp, mini=mini, app=app)
    await http.aclose()
