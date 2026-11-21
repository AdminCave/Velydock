"""Application factory.

Two ASGI applications share one process: the main application (UI, API, sign-in) and the sandbox
application for custom apps. Requests are routed by host name, so custom code is always served
from a different origin than Velydock itself.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from starlette.types import ASGIApp, Receive, Scope, Send

from velydock import __version__
from velydock.api import admin, auth, me, system
from velydock.config import Settings, get_settings
from velydock.db import dispose_engine, engine_initialized, get_engine, init_engine
from velydock.errors import install_error_handlers
from velydock.idp.base import IdentityProvider
from velydock.idp.keycloak import KeycloakIdp
from velydock.sandbox import create_sandbox_app
from velydock.security.http import RequestGuardMiddleware, SecurityHeadersMiddleware
from velydock.security.oidc import OidcClient

log = logging.getLogger(__name__)


class HostDispatch:
    """Send requests for the sandbox host to the sandbox app, everything else to the main app."""

    def __init__(self, main: ASGIApp, sandbox: ASGIApp, settings: Settings) -> None:
        self.main = main
        self.sandbox = sandbox
        public = urlsplit(settings.public_url)
        sandbox_url = urlsplit(settings.sandbox_url)
        # Compare host names only when they differ; otherwise the port is what tells them apart.
        self._by_port = public.hostname == sandbox_url.hostname
        self._sandbox = (sandbox_url.netloc if self._by_port else (sandbox_url.hostname or "")).lower()

    def _is_sandbox(self, scope: Scope) -> bool:
        host = ""
        for name, value in scope.get("headers", []):
            if name == b"host":
                host = value.decode("latin-1").lower()
                break
        if not self._by_port:
            host = host.rsplit(":", 1)[0] if not host.endswith("]") else host
            # "sandbox.example.com." is the same host; a proxy matching it must not get the
            # main application under the sandbox name.
            host = host.rstrip(".")
        return host == self._sandbox

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and self._is_sandbox(scope):
            await self.sandbox(scope, receive, send)
            return
        await self.main(scope, receive, send)


def create_main_app(
    settings: Settings,
    *,
    idp: IdentityProvider | None = None,
    oidc: OidcClient | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        http = httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0), trust_env=False)
        app.state.http = http
        app.state.idp = idp or KeycloakIdp(settings, http)
        app.state.oidc = oidc or OidcClient(settings, http)
        yield
        await http.aclose()
        await dispose_engine()

    app = FastAPI(
        title="Velydock API",
        version=__version__,
        lifespan=lifespan,
        # No interactive documentation page: it would need scripts from a CDN, which the
        # Content Security Policy rightly blocks. The description itself is available as JSON.
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.settings = settings
    # Available before the lifespan runs (tests may call the app without it).
    app.state.idp = idp
    app.state.oidc = oidc
    install_error_handlers(app)

    @app.api_route("/api/health", methods=["GET", "HEAD"], include_in_schema=False)
    async def health() -> Response:
        """Up means: this process answers *and* reaches its database.

        A health check that stays green while every request fails helps nobody.
        """
        if engine_initialized():
            try:
                async with asyncio.timeout(3):
                    async with get_engine().connect() as connection:
                        await connection.execute(text("SELECT 1"))
            except Exception as exc:
                log.error("health check: database unreachable (%s)", type(exc).__name__)
                return JSONResponse(
                    {"status": "unavailable", "version": __version__, "database": False}, status_code=503
                )
        return JSONResponse({"status": "ok", "version": __version__})

    app.include_router(auth.router)
    app.include_router(me.router)
    app.include_router(admin.router)
    app.include_router(system.router)

    @app.api_route(
        "/api/{path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
        include_in_schema=False,
    )
    async def api_not_found(path: str) -> Response:
        return JSONResponse(
            {"error": {"code": "not_found", "message": "Unknown API route.", "details": {}}}, status_code=404
        )

    static = Path(settings.static_dir)
    index = static / "index.html"
    if index.is_file():
        if (static / "assets").is_dir():
            app.mount("/assets", StaticFiles(directory=static / "assets"), name="assets")

        root = static.resolve()

        @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
        def spa(path: str) -> Response:
            # Runs in the thread pool (plain def): it touches the file system.
            # Real files (favicon, theme bootstrap script) are served as they are; every other
            # path is a client-side route and gets the application shell.
            try:
                candidate = (static / path).resolve()
                is_file = bool(path) and candidate.is_file() and root in candidate.parents
            except (OSError, ValueError):
                # Over-long or otherwise impossible file names are simply not files.
                is_file = False
            if is_file:
                return FileResponse(candidate)
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
    else:
        log.warning("no frontend found in %s; serving the API only", static)

    return app


def create_app(
    settings: Settings | None = None,
    *,
    idp: IdentityProvider | None = None,
    oidc: OidcClient | None = None,
) -> ASGIApp:
    settings = settings or get_settings()
    if not engine_initialized():
        init_engine(settings.database_url)
    # The security headers wrap the whole main application, so they are also on the answer to
    # an unexpected error. The request guard comes first for both applications.
    main = SecurityHeadersMiddleware(create_main_app(settings, idp=idp, oidc=oidc), settings)
    return RequestGuardMiddleware(HostDispatch(main, create_sandbox_app(settings), settings))
