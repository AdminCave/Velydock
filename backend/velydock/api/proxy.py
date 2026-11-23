"""The reverse proxy's side of publishing apps, and the sign-in round trip for them.

Two routes are for the proxy alone (``/internal/…``): it fetches its routes and asks before it
forwards a request to a protected app. They answer only when addressed the way services inside
the stack address Velydock; through the public address they do not exist.

``/proxy/login`` is where a browser lands that wants a protected app and has no sign-in for it
yet: Velydock recognises its own session (or asks for a sign-in) and sends the browser back with
a ticket.
"""

from __future__ import annotations

import hmac
import uuid
from urllib.parse import quote

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.api.deps import get_db, get_settings
from velydock.config import Settings
from velydock.db import Scope, set_rls_context
from velydock.errors import not_found
from velydock.models import AppPublication, PublicationAccess, User
from velydock.security.sessions import resolve_session
from velydock.services import proxy as proxy_service

router = APIRouter()

SECRET_HEADER = "x-velydock-proxy-secret"  # noqa: S105 - the name of a header


def _internal_only(request: Request, settings: Settings) -> None:
    """Refuse everything that did not come from inside the stack.

    The reverse proxy passes the host name of a request on unchanged, so whatever arrives
    through the public address carries that name - never the internal one.
    """
    if request.headers.get("host", "").lower() != settings.internal_host:
        raise not_found("Page")


@router.get("/internal/proxy/traefik", include_in_schema=False)
async def traefik_configuration(
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    settings: Settings = Depends(get_settings),
) -> Response:
    _internal_only(request, settings)
    if not settings.apps_url:
        # The feature is off: the proxy asks all the same, and "no routes" is the true answer.
        return JSONResponse({}, headers={"Cache-Control": "no-store"})
    given = request.headers.get(SECRET_HEADER, "")
    if not settings.proxy_secret or not hmac.compare_digest(given.encode(), settings.proxy_secret.encode()):
        raise not_found("Page")
    await set_rls_context(db, scope=Scope.SYSTEM)
    return JSONResponse(
        await proxy_service.traefik_configuration(db, settings), headers={"Cache-Control": "no-store"}
    )


@router.api_route(
    "/internal/proxy/auth/{app_id}",
    methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    include_in_schema=False,
)
async def authorize(
    app_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    settings: Settings = Depends(get_settings),
) -> Response:
    _internal_only(request, settings)
    await set_rls_context(db, scope=Scope.SYSTEM)
    publication = await db.get(AppPublication, app_id)
    if (
        publication is None
        or publication.access != PublicationAccess.PROTECTED.value
        or not settings.apps_url
    ):
        return PlainTextResponse("Not found.", status_code=404)
    mode = request.headers.get("sec-fetch-mode")
    accept = request.headers.get("accept", "")
    method = request.headers.get("x-forwarded-method", "GET").upper()
    # A page being opened (as opposed to a request a page makes): only that can be sent to the
    # sign-in and come back.
    navigation = method == "GET" and (mode == "navigate" if mode else "text/html" in accept)
    answer = await proxy_service.authorize(
        db,
        settings,
        request.app.state.idp,
        publication,
        uri=request.headers.get("x-forwarded-uri", "/"),
        cookies=dict(request.cookies),
        navigation=navigation,
    )
    response = Response(content=answer.body, status_code=answer.status, headers=answer.headers)
    for cookie in answer.cookies:
        response.headers.append("set-cookie", cookie)
    return response


@router.get("/proxy/login", include_in_schema=False)
async def login(
    request: Request,
    p: uuid.UUID,
    rd: str = "",
    st: str = "",
    db: AsyncSession = Depends(get_db, scope="function"),
    settings: Settings = Depends(get_settings),
) -> Response:
    """A browser wants a protected app. Recognise the user, or ask for a sign-in first."""
    if (
        request.headers.get("host", "").lower() == settings.internal_host
        and settings.internal_host != settings.public_host
    ):
        raise not_found("Page")
    await set_rls_context(db, scope=Scope.SYSTEM)
    publication = await db.get(AppPublication, p)
    if publication is None or not settings.apps_url:
        return PlainTextResponse(
            "Diese App gibt es nicht (mehr). / This app does not exist (any more).", status_code=404
        )
    cookie = request.cookies.get(settings.session_cookie, "")
    session = await resolve_session(db, settings, cookie) if cookie else None
    user = await db.get(User, session.user_id) if session is not None else None
    if session is None or user is None or not user.active:
        # Not signed in: through Velydock's own sign-in, and then here again.
        state = proxy_service.clean_state(st)
        back = f"/proxy/login?p={publication.app_id}&rd={quote(rd, safe='')}&st={state}"
        return RedirectResponse(f"/login?return_to={quote(back, safe='')}", status_code=302)
    if not await proxy_service.granted(db, publication, user):
        return PlainTextResponse(
            "Du hast keinen Zugriff auf diese App. / You are not allowed to use this app.", status_code=403
        )
    response = RedirectResponse(
        proxy_service.ticket_for(settings, publication, session, rd, st), status_code=302
    )
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response
