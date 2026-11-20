"""Command line: ``velydock <command>``.

``run`` is what the container starts: migrate the database, make sure the Keycloak realm is set
up, then serve. The other commands are for installation and maintenance.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import logging
import os
import shutil
import sys
import time
from pathlib import Path

import httpx
from sqlalchemy import func, select

from velydock import __version__
from velydock.config import Settings, get_settings
from velydock.db import Scope, dispose_engine, transaction
from velydock.idp.base import IdpError, IdpUnavailable
from velydock.idp.keycloak import KeycloakIdp, ensure_realm, set_console_access
from velydock.models import Membership, Role, Tenant, User
from velydock.schemas import TenantCreate, UserCreate
from velydock.security.tokens import temporary_password
from velydock.services import tenants as tenants_service

log = logging.getLogger("velydock")


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)


def _http() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0), trust_env=False)


def migrate(settings: Settings) -> None:
    from alembic import command
    from alembic.config import Config

    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parent / "migrations"))
    config.set_main_option("sqlalchemy.url", settings.database_url.replace("%", "%%"))
    command.upgrade(config, "head")
    log.info("database is up to date")


async def bootstrap(settings: Settings, *, wait_seconds: int = 180) -> None:
    """Create or update the Keycloak realm. Waits for Keycloak, which starts slower than we do."""
    deadline = time.monotonic() + wait_seconds
    async with _http() as http:
        while True:
            try:
                await ensure_realm(settings, http)
                break
            except IdpUnavailable as exc:
                if time.monotonic() >= deadline:
                    raise
                log.info("waiting for Keycloak (%s)", exc)
                await asyncio.sleep(3)
        await reconcile(settings, http)


async def reconcile(settings: Settings, http: httpx.AsyncClient) -> None:
    """Make Keycloak's organizations match the tenants (e.g. after restoring only one database)."""
    idp = KeycloakIdp(settings, http)
    async with transaction(Scope.SYSTEM) as db:
        tenants = list((await db.execute(select(Tenant))).scalars())
        for tenant in tenants:
            org_id = await idp.find_organization(tenant.slug)
            if org_id is None:
                org_id = await idp.create_organization(name=tenant.name, alias=tenant.slug)
                log.info("created missing organization for tenant %s", tenant.slug)
            if tenant.idp_org_id != org_id:
                tenant.idp_org_id = org_id
            members = await idp.list_organization_members(org_id)
            rows = await db.execute(
                select(User.idp_id)
                .join(Membership, Membership.user_id == User.id)
                .where(Membership.tenant_id == tenant.id)
            )
            for idp_id in rows.scalars():
                if idp_id not in members:
                    try:
                        await idp.add_organization_member(org_id, idp_id)
                    except IdpError as exc:
                        log.warning("could not add %s to organization %s: %s", idp_id, tenant.slug, exc)


async def setup_admin(settings: Settings, args: argparse.Namespace) -> int:
    """Create the first system administrator, or restore access to an existing account.

    There is no default password: a random one-time password is printed once and must be
    changed at first sign-in.
    """
    data = UserCreate(
        username=args.username,
        email=args.email,
        first_name=args.first_name,
        last_name=args.last_name,
        role=Role.TENANT_ADMIN,
    )
    password = temporary_password(20)
    async with _http() as http:
        idp = KeycloakIdp(settings, http)
        async with transaction(Scope.SYSTEM) as db:
            existing = (
                await db.execute(select(User).where(func.lower(User.username) == data.username))
            ).scalar_one_or_none()
            if existing is not None:
                await idp.set_enabled(existing.idp_id, True)
                await idp.set_temporary_password(existing.idp_id, password)
                existing.active = True
                existing.is_system_admin = True
                action = "System administrator access restored for"
            else:
                tenant = (await db.execute(select(Tenant).order_by(Tenant.created_at))).scalars().first()
                if tenant is None:
                    created = await tenants_service.create_tenant(
                        db, idp, None, TenantCreate(slug=args.tenant_slug, name=args.tenant_name)
                    )
                    tenant = await db.get(Tenant, created.id)
                    assert tenant is not None
                idp_id = await idp.find_user_id(data.username)
                if idp_id is None:
                    idp_id = await idp.create_user(
                        username=data.username,
                        email=data.email,
                        first_name=data.first_name,
                        last_name=data.last_name,
                        temporary_password=password,
                    )
                else:
                    await idp.set_temporary_password(idp_id, password)
                user = User(
                    idp_id=idp_id,
                    username=data.username,
                    email=data.email,
                    first_name=data.first_name,
                    last_name=data.last_name,
                    is_system_admin=True,
                    home_tenant_id=tenant.id,
                )
                db.add(user)
                await db.flush()
                db.add(Membership(tenant_id=tenant.id, user_id=user.id, role=Role.TENANT_ADMIN.value))
                if tenant.idp_org_id:
                    await idp.add_organization_member(tenant.idp_org_id, idp_id)
                action = "System administrator created:"
    await dispose_engine()
    print()
    print(f"  {action} {data.username}")
    print(f"  Sign in at:         {settings.public_url}")
    print(f"  One-time password:  {password}")
    print()
    print("  The password is shown only now and must be changed at first sign-in.")
    print()
    return 0


async def keycloak_admin(settings: Settings, username: str, revoke: bool) -> int:
    """Let a Velydock user into Keycloak's own administration console (or take that right away).

    The console is only reachable after opening it with docker-compose.keycloak-admin.yml.
    """
    async with _http() as http:
        await set_console_access(settings, http, username, grant=not revoke)
    if revoke:
        print(f"{username} can no longer use the Keycloak administration console.")
    else:
        print(
            f"{username} can now sign in to the Keycloak administration console with the usual credentials."
        )
        print("This right covers everything in the Velydock realm; take it away again with --revoke.")
    return 0


def install_theme(target: str) -> None:
    """Copy the Keycloak login theme into ``target`` (the directory Keycloak loads themes from).

    Keycloak tells browsers to cache theme files for 30 days and keeps its own compressed copies,
    both keyed by path only. The files are therefore installed under a directory named after a
    hash of their content: a changed theme gets new addresses, an unchanged one keeps its caches.
    """
    # Works without the full configuration, so the one-shot "theme" container needs no secrets.
    source = Path(os.environ.get("VELYDOCK_THEME_SOURCE_DIR", "/opt/velydock/keycloak-theme"))
    if not source.is_dir():
        raise SystemExit(f"theme source {source} not found")
    destination = Path(target)
    destination.mkdir(parents=True, exist_ok=True)
    for theme in sorted(entry for entry in source.iterdir() if entry.is_dir()):
        installed = destination / theme.name
        if installed.exists():
            shutil.rmtree(installed)
        shutil.copytree(theme, installed)
        for kind in sorted(entry for entry in installed.iterdir() if entry.is_dir()):
            _version_theme_resources(kind)
    for path in [destination, *destination.rglob("*")]:
        path.chmod(0o755 if path.is_dir() else 0o644)
    log.info("installed Keycloak theme into %s", destination)


def _version_theme_resources(theme_type_dir: Path) -> None:
    resources = theme_type_dir / "resources"
    properties = theme_type_dir / "theme.properties"
    if not resources.is_dir() or not properties.is_file():
        return
    files = sorted(path for path in resources.rglob("*") if path.is_file() and path.name != ".gitkeep")
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(resources).as_posix().encode())
        digest.update(path.read_bytes())
    versioned = resources / f"v-{digest.hexdigest()[:12]}"
    versioned.mkdir()
    for entry in list(resources.iterdir()):
        if entry != versioned:
            entry.rename(versioned / entry.name)
    own_styles = {path.relative_to(versioned).as_posix() for path in versioned.rglob("*.css")}
    lines = []
    for line in properties.read_text().splitlines():
        if line.startswith("styles="):
            # Our own style sheets move; those inherited from the parent theme stay where they are.
            styles = [
                f"{versioned.name}/{s}" if s in own_styles else s for s in line[len("styles=") :].split()
            ]
            line = "styles=" + " ".join(styles)
        lines.append(line)
    properties.write_text("\n".join(lines) + "\n")


def openapi_json() -> str:
    """The API description, independent of any deployment (used to generate the frontend types)."""
    import json

    from velydock.app import create_main_app

    placeholder = Settings(
        environment="test",
        public_url="https://velydock.invalid",
        sandbox_url="https://sandbox.velydock.invalid",
        database_url="postgresql+asyncpg://unused@localhost/unused",
        secret_key="-" * 32,
        keycloak_public_url="https://auth.velydock.invalid",
        keycloak_internal_url="http://keycloak:8080",
        oidc_client_secret="-" * 16,
        idp_admin_client_secret="-" * 16,
        static_dir="/nonexistent",
    )
    return json.dumps(create_main_app(placeholder).openapi(), indent=2, sort_keys=True) + "\n"


def serve(settings: Settings) -> None:
    import uvicorn

    uvicorn.run(
        "velydock.main:app",
        host="0.0.0.0",  # noqa: S104 - inside the container; only the reverse proxy reaches it
        port=8000,
        proxy_headers=True,
        forwarded_allow_ips="*",
        log_level=settings.log_level.lower(),
        access_log=settings.environment != "production",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="velydock", description=f"Velydock {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("run", help="migrate, set up the identity provider, then serve (container default)")
    sub.add_parser("serve", help="serve only")
    sub.add_parser("migrate", help="apply database migrations")
    sub.add_parser("bootstrap", help="create or update the Keycloak realm and its clients")
    admin = sub.add_parser("setup-admin", help="create the first system administrator or restore access")
    admin.add_argument("--username", required=True)
    admin.add_argument("--email", default=None)
    admin.add_argument("--first-name", default="System")
    admin.add_argument("--last-name", default="Administrator")
    admin.add_argument("--tenant-name", default="Hauptorganisation", help="name of the first organization")
    admin.add_argument("--tenant-slug", default="main", help="short name of the first organization")
    console = sub.add_parser(
        "keycloak-admin", help="let a Velydock user into Keycloak's own administration console"
    )
    console.add_argument("--username", required=True)
    console.add_argument("--revoke", action="store_true", help="take the right away again")
    theme = sub.add_parser("install-theme", help="copy the Keycloak login theme into a directory")
    theme.add_argument("target")
    sub.add_parser("version", help="print the version")
    sub.add_parser("openapi", help="print the OpenAPI description of the REST API")
    args = parser.parse_args(argv)

    if args.command == "version":
        print(__version__)
        return 0

    if args.command == "openapi":
        print(openapi_json())
        return 0
    if args.command == "install-theme":
        _configure_logging("INFO")
        install_theme(args.target)
        return 0

    settings = get_settings()
    _configure_logging(settings.log_level)

    if args.command == "migrate":
        migrate(settings)
        return 0
    if args.command == "bootstrap":
        asyncio.run(_bootstrap_and_close(settings))
        return 0
    if args.command == "setup-admin":
        try:
            return asyncio.run(setup_admin(settings, args))
        except IdpError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
    if args.command == "keycloak-admin":
        try:
            return asyncio.run(keycloak_admin(settings, args.username, args.revoke))
        except IdpError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
    if args.command == "run":
        migrate(settings)
        asyncio.run(_bootstrap_and_close(settings))
        serve(settings)
        return 0
    if args.command == "serve":
        serve(settings)
        return 0
    return 2


async def _bootstrap_and_close(settings: Settings) -> None:
    try:
        await bootstrap(settings)
    finally:
        await dispose_engine()


if __name__ == "__main__":
    raise SystemExit(main())
