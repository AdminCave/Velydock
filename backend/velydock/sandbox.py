"""The sandbox host: serves custom apps and nothing else.

A separate ASGI application answers requests for the sandbox host name. It has no session, sets
no cookie and ignores any cookie it is sent. A signed, short-lived token in the URL is the only
grant; it is minted by the main application for users who may see the app.
"""

from __future__ import annotations

import uuid

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, Response
from starlette.routing import Route

from velydock.config import Settings
from velydock.db import Scope, transaction
from velydock.models import App, AppType
from velydock.security.tokens import TokenError, verify
from velydock.services.apps import SANDBOX_TOKEN_PURPOSE
from velydock.services.custom_apps import (
    render_document,
    response_headers,
    wrapper_document,
    wrapper_headers,
)

_LOCKED_DOWN = {
    "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
}

_NOTICE = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Velydock</title>'
    "<style>body{{font:15px/1.5 system-ui,sans-serif;margin:3rem;color:#6b7280}}</style></head>"
    "<body><p>{message}</p></body></html>"
)


def _notice(settings: Settings, status: int, message: str) -> Response:
    headers = dict(_LOCKED_DOWN)
    # The notice may appear inside the workspace frame, so the embedding page stays allowed.
    headers["Content-Security-Policy"] = (
        f"default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors {settings.public_origin}"
    )
    return HTMLResponse(_NOTICE.format(message=message), status_code=status, headers=headers)


def create_sandbox_app(settings: Settings) -> Starlette:
    async def serve(request: Request) -> Response:
        token = request.path_params["token"]
        try:
            grant = verify(settings.secret_key, SANDBOX_TOKEN_PURPOSE, token)
            app_id = uuid.UUID(str(grant["app"]))
        except (TokenError, KeyError, ValueError):
            return _notice(settings, 403, "This link has expired. Open the app again from Velydock.")
        async with transaction(Scope.SYSTEM) as db:
            app = await db.get(App, app_id)
            if (
                app is None
                or app.type != AppType.CUSTOM.value
                or not app.enabled
                or int(app.updated_at.timestamp()) != grant.get("ver")
            ):
                return _notice(settings, 404, "This app is not available. Open it again from Velydock.")
            # A network-off app is delivered inside a wrapper: it runs one frame level down, inside
            # a script-less document whose frame-src confines every navigation it makes to the
            # sandbox host, so it cannot carry data out by navigating itself. The "d" marker asks
            # for that inner app document. Apps with network access keep the direct delivery.
            if not app.custom_allow_network and request.query_params.get("d") != "1":
                return HTMLResponse(
                    wrapper_document(inner_path=f"/c/{token}?d=1"),
                    headers=wrapper_headers(
                        embedder_origin=settings.public_origin, sandbox_origin=settings.sandbox_origin
                    ),
                )
            document = render_document(
                app, theme=str(grant.get("theme", "light")), language=str(grant.get("lang", "en"))
            )
            headers = response_headers(
                allow_network=app.custom_allow_network, embedder_origin=settings.public_origin
            )
        return HTMLResponse(document, headers=headers)

    async def fallback(_: Request) -> Response:
        return Response(status_code=404, headers=_LOCKED_DOWN)

    return Starlette(
        routes=[
            Route("/c/{token}", serve, methods=["GET"]),
            Route(
                "/{path:path}", fallback, methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
            ),
        ]
    )
