"""Sign-in, sign-out and back-channel logout (OpenID Connect)."""

from __future__ import annotations

import logging
import secrets
from datetime import UTC, datetime
from urllib.parse import parse_qs, quote

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.api.deps import Principal, get_db, get_idp, get_oidc, get_principal, get_settings
from velydock.config import Settings
from velydock.db import Scope, set_rls_context, system_scope, transaction
from velydock.idp.base import IdentityProvider, IdpError
from velydock.models import Membership, Role, User
from velydock.security import sessions
from velydock.security.oidc import IdTokenClaims, OidcClient, OidcError, new_pkce_pair
from velydock.security.tokens import TokenError, random_token, sign, verify
from velydock.services import settings as settings_service

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["auth"])

_LOGIN_PURPOSE = "login-state"
_LOGIN_TTL = 600
_MAX_LOGOUT_BODY = 64 * 1024


def safe_return_path(value: str | None) -> str:
    """Only local paths are accepted as a post-login destination (no open redirect)."""
    if not value or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return "/"
    if any(ord(ch) < 0x20 for ch in value) or value.startswith("/api/"):
        return "/"
    return value[:500]


def _callback_url(settings: Settings) -> str:
    return f"{settings.public_url}/api/auth/callback"


def _login_failed(settings: Settings, reason: str) -> RedirectResponse:
    response = RedirectResponse(f"/login?error={quote(reason)}", status_code=302)
    response.delete_cookie(
        settings.login_cookie, path="/", secure=settings.secure_cookies, httponly=True, samesite="lax"
    )
    return response


async def _start_login(
    settings: Settings, oidc: OidcClient, return_to: str, *, second_factor_round: bool = False
) -> Response:
    state, nonce = random_token(24), random_token(24)
    verifier, challenge = new_pkce_pair()
    try:
        url = await oidc.authorization_url(
            state=state, nonce=nonce, code_challenge=challenge, redirect_uri=_callback_url(settings)
        )
    except OidcError:
        log.exception("cannot start sign-in")
        return _login_failed(settings, "idp_unavailable")
    cookie = sign(
        settings.secret_key,
        _LOGIN_PURPOSE,
        {
            "state": state,
            "nonce": nonce,
            "verifier": verifier,
            "return_to": return_to,
            "mfa": second_factor_round,
        },
        _LOGIN_TTL,
    )
    response = RedirectResponse(url, status_code=302)
    response.set_cookie(
        settings.login_cookie,
        cookie,
        max_age=_LOGIN_TTL,
        path="/",
        secure=settings.secure_cookies,
        httponly=True,
        samesite="lax",
    )
    return response


@router.get("/login", include_in_schema=False)
async def login(
    return_to: str = "/",
    settings: Settings = Depends(get_settings),
    oidc: OidcClient = Depends(get_oidc),
) -> Response:
    return await _start_login(settings, oidc, safe_return_path(return_to))


async def _find_or_provision(db: AsyncSession, claims: IdTokenClaims) -> User | None:
    """Map the authenticated identity to a Velydock user. Runs in system scope.

    Unknown identities (created directly in Keycloak or coming from a directory) are added on
    first sign-in without any organization; an administrator assigns them afterwards.
    """
    user = (await db.execute(select(User).where(User.idp_id == claims.sub))).scalar_one_or_none()
    if user is None:
        clash = await db.execute(
            select(User.id).where(
                (func.lower(User.username) == claims.username.lower())
                | ((User.email.is_not(None)) & (func.lower(User.email) == (claims.email or "\x00").lower()))
            )
        )
        if clash.first():
            # Same name, different identity: never link silently, that would hand over the
            # existing account's access.
            return None
        user = User(
            idp_id=claims.sub,
            username=claims.username,
            email=claims.email,
            first_name=claims.first_name,
            last_name=claims.last_name,
        )
        db.add(user)
        await db.flush()
        return user
    user.username = claims.username
    user.first_name = claims.first_name or user.first_name
    user.last_name = claims.last_name or user.last_name
    if claims.email != user.email:
        taken = await db.execute(
            select(User.id).where(
                func.lower(User.email) == (claims.email or "\x00").lower(), User.id != user.id
            )
        )
        if not taken.first():
            user.email = claims.email
    await db.flush()
    return user


async def _needs_second_factor(
    db: AsyncSession, settings: Settings, idp: IdentityProvider, user: User
) -> bool:
    system = await settings_service.load_system(db, settings)
    if not system["require_admin_2fa"]:
        return False
    elevated = user.is_system_admin or bool(
        (
            await db.execute(
                select(Membership.id)
                .where(
                    Membership.user_id == user.id,
                    Membership.role.in_([Role.TENANT_ADMIN.value, Role.USER_MANAGER.value]),
                )
                .limit(1)
            )
        ).first()
    )
    if not elevated:
        return False
    return not await idp.has_second_factor(user.idp_id)


@router.get("/callback", include_in_schema=False)
async def callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
    oidc: OidcClient = Depends(get_oidc),
    idp: IdentityProvider = Depends(get_idp),
) -> Response:
    try:
        pending = verify(settings.secret_key, _LOGIN_PURPOSE, request.cookies.get(settings.login_cookie, ""))
    except TokenError:
        return _login_failed(settings, "expired")
    if error or not code or not state:
        return _login_failed(settings, "cancelled")
    if not secrets.compare_digest(state, str(pending.get("state", ""))):
        return _login_failed(settings, "state")

    try:
        id_token = await oidc.exchange_code(
            code=code, code_verifier=str(pending["verifier"]), redirect_uri=_callback_url(settings)
        )
        claims = await oidc.validate_id_token(id_token, nonce=str(pending["nonce"]))
    except OidcError as exc:
        log.warning("sign-in rejected: %s", exc)
        return _login_failed(settings, "invalid")

    return_to = safe_return_path(str(pending.get("return_to", "/")))
    await set_rls_context(db, scope=Scope.SYSTEM)
    user = await _find_or_provision(db, claims)
    if user is None:
        log.warning("sign-in of %s refused: conflicts with an existing account", claims.username)
        return _login_failed(settings, "account_conflict")
    if not user.active:
        return _login_failed(settings, "disabled")

    try:
        if await _needs_second_factor(db, settings, idp, user):
            if pending.get("mfa"):
                return _login_failed(settings, "second_factor_required")
            # Ask Keycloak to enrol a second factor, then run the sign-in once more.
            await idp.require_second_factor_setup(user.idp_id)
            return await _start_login(settings, oidc, return_to, second_factor_round=True)
    except IdpError:
        log.exception("second-factor check failed")
        return _login_failed(settings, "idp_unavailable")

    user.last_login_at = datetime.now(UTC)
    await sessions.purge_expired(db, settings)
    value = await sessions.create_session(
        db,
        settings,
        user_id=user.id,
        tenant_id=None,
        idp_sid=claims.sid,
        id_token=id_token,
        auth_time=claims.auth_time,
        request=request,
    )
    response = RedirectResponse(return_to, status_code=302)
    sessions.set_session_cookie(response, settings, value)
    response.delete_cookie(
        settings.login_cookie, path="/", secure=settings.secure_cookies, httponly=True, samesite="lax"
    )
    return response


@router.post("/logout")
async def logout(
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
    oidc: OidcClient = Depends(get_oidc),
) -> Response:
    """End the Velydock session and return the address that also ends the Keycloak session."""
    id_token = principal.session.id_token
    async with system_scope(db):
        await sessions.delete_session(db, principal.session.id_hash)
    try:
        redirect_url = await oidc.end_session_url(
            id_token_hint=id_token, post_logout_redirect_uri=f"{settings.public_url}/login?signed_out=1"
        )
    except OidcError:
        redirect_url = "/login?signed_out=1"
    response = JSONResponse({"redirect_url": redirect_url})
    sessions.clear_session_cookie(response, settings)
    return response


@router.post("/backchannel-logout", include_in_schema=False)
async def backchannel_logout(request: Request, oidc: OidcClient = Depends(get_oidc)) -> Response:
    """OIDC Back-Channel Logout: Keycloak tells us a user or session has been signed out.

    Called server-to-server without cookies; the signed logout token is the only credential.
    """
    body = await request.body()
    if len(body) > _MAX_LOGOUT_BODY:
        return JSONResponse({"error": "invalid_request"}, status_code=400)
    token = (parse_qs(body.decode("utf-8", errors="replace")).get("logout_token") or [""])[0]
    try:
        claims = await oidc.validate_logout_token(token)
    except OidcError as exc:
        log.warning("back-channel logout rejected: %s", exc)
        return JSONResponse(
            {"error": "invalid_request"}, status_code=400, headers={"Cache-Control": "no-store"}
        )
    async with transaction(Scope.SYSTEM) as db:
        if claims.sid:
            ended = await sessions.delete_sessions_by_sid(db, claims.sid)
        else:
            user = (await db.execute(select(User).where(User.idp_id == claims.sub))).scalar_one_or_none()
            ended = await sessions.delete_user_sessions(db, user.id) if user else 0
    log.info("back-channel logout ended %d session(s)", ended)
    return Response(status_code=200, headers={"Cache-Control": "no-store"})
