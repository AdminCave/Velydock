"""Stand-alone backend for frontend development.

Runs the real API against a real PostgreSQL database, but with a simulated identity provider, so
no Keycloak is needed and signing in is a click on a user name. Never use this for anything but
local development: there is no authentication.

    python -m tests.support.devserver                      # serves ../frontend/dist on :8765
    python -m tests.support.devserver --public-url http://localhost:5173   # behind the Vite dev server

The database ``velydock_devui`` is recreated and seeded on every start.
"""

from __future__ import annotations

import argparse
import asyncio
import html
import os
from pathlib import Path
from urllib.parse import parse_qs

import asyncpg
import httpx
import uvicorn
from alembic import command
from alembic.config import Config
from starlette.types import ASGIApp, Receive, Scope, Send

from tests.conftest import TEST_ROLE, TEST_ROLE_PASSWORD, World
from tests.support.fake_idp import FakeIdp
from tests.support.mini_idp import MiniIdp
from velydock import db as database
from velydock.app import create_app
from velydock.config import Settings
from velydock.db import transaction
from velydock.idp.base import SmtpConfig
from velydock.models import AppType, AuthSession, NavPosition, Role, User
from velydock.security.oidc import OidcClient
from velydock.security.tokens import hash_token

ADMIN_URL = os.environ.get(
    "VELYDOCK_TEST_PG_ADMIN_URL", "postgresql://postgres:dev-postgres-password@127.0.0.1:15432/postgres"
)
DB_NAME = "velydock_devui"
BACKEND_PORT = 8765

_CUSTOM_HTML = """<main>
  <h1>Hallo aus der Sandbox</h1>
  <p>Diese App besteht aus eigenem HTML, CSS und JavaScript.</p>
  <button id="count">Geklickt: 0</button>
  <p id="probe"></p>
</main>"""
_CUSTOM_CSS = """body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem; }
html[data-theme="dark"] body { background: #17181b; color: #f4f4f5; }
button { padding: .5rem 1rem; border-radius: 999px; border: 1px solid currentColor; background: none; color: inherit; }"""
_CUSTOM_JS = """let n = 0;
document.getElementById('count').addEventListener('click', (e) => { e.target.textContent = 'Geklickt: ' + (++n); });
let cookies = 'blocked';
try { cookies = document.cookie === '' ? 'empty' : 'readable'; } catch (e) { cookies = 'blocked'; }
document.getElementById('probe').textContent = 'origin=' + location.origin + ' cookies=' + cookies;"""


async def _recreate_database() -> str:
    from urllib.parse import urlsplit

    conn = await asyncpg.connect(ADMIN_URL)
    try:
        if not await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", TEST_ROLE):
            await conn.execute(
                f"CREATE ROLE {TEST_ROLE} LOGIN PASSWORD '{TEST_ROLE_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
            )
        await conn.execute(f'DROP DATABASE IF EXISTS "{DB_NAME}" WITH (FORCE)')
        await conn.execute(f'CREATE DATABASE "{DB_NAME}" OWNER {TEST_ROLE}')
    finally:
        await conn.close()
    parts = urlsplit(ADMIN_URL)
    return f"postgresql+asyncpg://{TEST_ROLE}:{TEST_ROLE_PASSWORD}@{parts.hostname}:{parts.port or 5432}/{DB_NAME}"


async def _seed(world: World) -> None:
    world.idp.smtp = SmtpConfig()
    main = await world.tenant("Admin Cave", "main")
    acme = await world.tenant("Acme GmbH", "acme", default_nav_position=NavPosition.TOP.value)
    await world.tenant("Leere Organisation", "leer")

    root = await world.user(
        main,
        "root",
        Role.TENANT_ADMIN,
        system_admin=True,
        email="root@admincave.example",
        first_name="Ronja",
        last_name="Root",
    )
    anna = await world.user(
        acme, "anna", Role.TENANT_ADMIN, email="anna@acme.example", first_name="Anna", last_name="Admin"
    )
    uwe = await world.user(
        acme, "uwe", Role.USER_MANAGER, email="uwe@acme.example", first_name="Uwe", last_name="Verwalter"
    )
    mia = await world.user(
        acme, "mia", Role.MEMBER, email="mia@acme.example", first_name="Mia", last_name="Mitglied"
    )
    ben = await world.user(acme, "ben", Role.MEMBER, first_name="Ben", last_name="Ohnemail")
    await world.user(acme, "ina", Role.MEMBER, active=False, first_name="Ina", last_name="Inaktiv")
    # A guest: the identity belongs to "main", "acme" only holds a membership.
    gast = await world.user(
        main, "gast", Role.MEMBER, email="gast@admincave.example", first_name="Gustav", last_name="Gast"
    )
    await world.member(acme, gast)
    await world.user(None, "neu", None, home=None, first_name="Nora", last_name="Neu")
    for index in range(1, 31):
        await world.user(
            acme, f"user{index:02d}", Role.MEMBER, first_name=f"Test{index:02d}", last_name="Person"
        )

    office = await world.group(acme, "Büro", [anna, mia, ben])
    it = await world.group(acme, "IT", [anna, uwe])

    await world.app_(
        acme,
        "Wiki",
        type=AppType.EMBEDDED,
        url="https://example.org/",
        visible_to_all=True,
        icon_name="book-open",
        description="Eingebettete Beispielseite",
        embed_status="ok",
        sort_order=10,
    )
    await world.app_(
        acme,
        "Nextcloud",
        type=AppType.EMBEDDED,
        url="https://nextcloud.com/",
        groups=[office],
        icon_name="cloud",
        description="Dateien und Kalender (Einbettung blockiert)",
        embed_status="blocked",
        embed_detail="xfo_sameorigin",
        sort_order=20,
    )
    await world.app_(
        acme,
        "Tickets",
        type=AppType.EXTERNAL,
        url="https://example.com/",
        groups=[it],
        icon_name="ticket",
        description="Öffnet in einem neuen Tab",
        sort_order=30,
    )
    await world.app_(
        acme,
        "Sandbox-Demo",
        type=AppType.CUSTOM,
        visible_to_all=True,
        icon_name="flask-conical",
        description="Eigene App",
        custom_html=_CUSTOM_HTML,
        custom_css=_CUSTOM_CSS,
        custom_js=_CUSTOM_JS,
        sort_order=40,
    )
    await world.app_(
        acme,
        "Abgeschaltet",
        type=AppType.EXTERNAL,
        url="https://example.net/",
        visible_to_all=True,
        enabled=False,
        icon_name="power-off",
        sort_order=50,
    )
    await world.app_(
        main,
        "Status",
        type=AppType.EXTERNAL,
        url="https://example.org/status",
        visible_to_all=True,
        icon_name="activity",
        sort_order=10,
    )
    del root, mia


class DevLogin:
    """Replaces the redirect to the identity provider by a page of clickable user names."""

    def __init__(self, inner: ASGIApp, settings: Settings) -> None:
        self.inner = inner
        self.settings = settings

    async def _respond(
        self,
        send: Send,
        status: int,
        body: str,
        headers: dict[str, str] | None = None,
        content_type: str = "text/html; charset=utf-8",
    ) -> None:
        raw = body.encode()
        all_headers = {"content-type": content_type, "content-length": str(len(raw)), **(headers or {})}
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [(k.encode(), v.encode()) for k, v in all_headers.items()],
            }
        )
        await send({"type": "http.response.body", "body": raw})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.inner(scope, receive, send)
            return
        path, method = scope["path"], scope["method"]
        query = {k: v[0] for k, v in parse_qs(scope.get("query_string", b"").decode()).items()}

        if path == "/api/auth/login" and method == "GET":
            async with transaction() as db:
                from sqlalchemy import select

                users = list((await db.execute(select(User).order_by(User.username))).scalars())
            return_to = html.escape(query.get("return_to", "/"), quote=True)
            items = "".join(
                f'<li><a data-testid="dev-login-{u.username}" href="/api/dev/login?user={u.username}&return_to={return_to}">'
                f"{html.escape(u.username)}</a> – {html.escape(u.display_name)}"
                f"{' (Systemadmin)' if u.is_system_admin else ''}{'' if u.active else ' (deaktiviert)'}</li>"
                for u in users
            )
            await self._respond(
                send,
                200,
                f"<!doctype html><meta charset=utf-8><title>Dev-Login</title>"
                f"<body style='font:15px system-ui;margin:2rem'><h1>Dev-Login</h1><ul>{items}</ul>",
            )
            return

        if path == "/api/dev/login" and method == "GET":
            async with transaction() as db:
                from sqlalchemy import select

                user = (
                    await db.execute(select(User).where(User.username == query.get("user", "")))
                ).scalar_one_or_none()
            if user is None or not user.active:
                await self._respond(send, 302, "", {"location": "/login?error=disabled"})
                return
            world = World(self.settings, FakeIdp(), MiniIdp(self.settings), self.inner)
            value = await world.session(user)
            cookie = f"{self.settings.session_cookie}={value}; Path=/; HttpOnly; SameSite=Lax"
            target = query.get("return_to", "/")
            await self._respond(
                send, 302, "", {"location": target if target.startswith("/") else "/", "set-cookie": cookie}
            )
            return

        if path == "/api/auth/logout" and method == "POST":
            cookies = dict(
                part.strip().split("=", 1)
                for name, value in scope["headers"]
                if name == b"cookie"
                for part in value.decode().split(";")
                if "=" in part
            )
            value = cookies.get(self.settings.session_cookie, "")
            async with transaction() as db:
                session = await db.get(AuthSession, hash_token(value))
                if session is not None:
                    await db.delete(session)
            await self._respond(
                send,
                200,
                '{"redirect_url": "/login?signed_out=1"}',
                {"set-cookie": f"{self.settings.session_cookie}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"},
                content_type="application/json",
            )
            return

        await self.inner(scope, receive, send)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--public-url", default=f"http://localhost:{BACKEND_PORT}")
    parser.add_argument(
        "--static-dir", default=str(Path(__file__).resolve().parents[3] / "frontend" / "dist")
    )
    args = parser.parse_args()

    url = asyncio.run(_recreate_database())
    config = Config()
    config.set_main_option(
        "script_location", str(Path(__file__).resolve().parents[2] / "velydock" / "migrations")
    )
    config.set_main_option("sqlalchemy.url", url)
    command.upgrade(config, "head")

    settings = Settings(
        environment="development",
        public_url=args.public_url,
        # A different host name than the UI (localhost vs. 127.0.0.1): custom apps get their own origin.
        sandbox_url=f"http://127.0.0.1:{BACKEND_PORT}",
        database_url=url,
        secret_key="dev-ui-secret-key-" + "0" * 32,
        keycloak_public_url="http://idp.invalid",
        keycloak_internal_url="http://idp.invalid",
        oidc_client_secret="dev-oidc-client-secret",
        idp_admin_client_secret="dev-idp-admin-secret",
        require_admin_2fa=False,
        static_dir=args.static_dir,
    )

    async def build() -> ASGIApp:
        database.init_engine(url)
        idp, mini = FakeIdp(), MiniIdp(settings)
        app = create_app(
            settings, idp=idp, oidc=OidcClient(settings, httpx.AsyncClient(transport=mini.transport()))
        )
        await _seed(World(settings, idp, mini, app))
        await database.dispose_engine()
        database.init_engine(url)
        return DevLogin(app, settings)

    app = asyncio.run(build())
    print(
        f"\n  Velydock dev backend: {settings.public_url}  (sandbox: {settings.sandbox_url})\n"
        f"  Sign in via {settings.public_url}/api/auth/login – users: root (system admin), anna (tenant admin),\n"
        f"  uwe (user manager), mia/ben (members), gast (guest), neu (no organization)\n"
    )
    uvicorn.run(app, host="127.0.0.1", port=BACKEND_PORT, log_level="warning")


if __name__ == "__main__":
    main()
