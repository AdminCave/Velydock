"""Sign-in, sign-out and back-channel logout (OpenID Connect)."""

from __future__ import annotations

import logging
import re
import secrets
from datetime import UTC, datetime
from urllib.parse import parse_qs, quote

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.api.deps import get_db, get_idp, get_oidc, get_settings
from velydock.config import Settings
from velydock.db import Lock, Scope, advisory_lock, set_rls_context, transaction
from velydock.idp.base import IdentityProvider, IdpError
from velydock.models import AuthSession, Membership, Role, User
from velydock.schemas import LogoutOut
from velydock.security import sessions
from velydock.security.http import verify_csrf
from velydock.security.oidc import IdTokenClaims, OidcClient, OidcError, new_pkce_pair
from velydock.security.tokens import TokenError, hash_token, random_token, sign, verify
from velydock.services import settings as settings_service

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["auth"])

_LOGIN_PURPOSE = "login-state"
_LOGIN_TTL = 600
_MAX_LOGOUT_BODY = 64 * 1024
# Column sizes of the users table.
_USERNAME_MAX = 150
_EMAIL_MAX = 254
_NAME_MAX = 100
# Languages the sign-in pages exist in (the login theme carries the same two).
_LANGUAGES = ("de", "en")


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
    settings: Settings,
    oidc: OidcClient,
    return_to: str,
    *,
    second_factor_round: bool = False,
    language: str | None = None,
) -> Response:
    state, nonce = random_token(24), random_token(24)
    verifier, challenge = new_pkce_pair()
    try:
        url = await oidc.authorization_url(
            state=state,
            nonce=nonce,
            code_challenge=challenge,
            redirect_uri=_callback_url(settings),
            language=language,
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
            "lang": language or "",
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
    lang: str | None = None,
    settings: Settings = Depends(get_settings),
    oidc: OidcClient = Depends(get_oidc),
) -> Response:
    language = lang if lang in _LANGUAGES else None
    return await _start_login(settings, oidc, safe_return_path(return_to), language=language)


def _fit(value: str | None, limit: int) -> str:
    """Token claims are not bound by our column sizes; cut instead of failing the sign-in."""
    return (value or "").replace("\x00", "")[:limit]


class _Refused(Exception):
    """The identity provider accepted the sign-in, Velydock does not (``reason`` for the login page)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


async def _find_or_provision(db: AsyncSession, claims: IdTokenClaims) -> User:
    """Map the authenticated identity to a Velydock user. Runs in system scope.

    Unknown identities (created directly in Keycloak or coming from a directory) are added on
    first sign-in without any organization; an administrator assigns them afterwards.
    Raises ``_Refused`` when the identity cannot be mapped without touching another account.
    """
    username = claims.username.replace("\x00", "")
    if not username or len(username) > _USERNAME_MAX:
        raise _Refused("account_unsupported")
    # An account without an e-mail address is normal (directories, accounts made in Keycloak).
    email = _fit(claims.email, _EMAIL_MAX + 1) or None
    if email is not None and len(email) > _EMAIL_MAX:
        email = None
    first_name = _fit(claims.first_name, _NAME_MAX)
    last_name = _fit(claims.last_name, _NAME_MAX)

    user = (await db.execute(select(User).where(User.idp_id == claims.sub))).scalar_one_or_none()
    if user is None:
        same_name = func.lower(User.username) == username.lower()
        same = same_name if email is None else or_(same_name, func.lower(User.email) == email.lower())
        if (await db.execute(select(User.id).where(same).limit(1))).first():
            # Same name, different identity: never link silently, that would hand over the
            # existing account's access.
            raise _Refused("account_conflict")
        user = User(
            idp_id=claims.sub, username=username, email=email, first_name=first_name, last_name=last_name
        )
        try:
            async with db.begin_nested():
                db.add(user)
                await db.flush()
        except IntegrityError:
            # A parallel first sign-in of the same identity won the race: use its row. Anything
            # else that collides is a conflict like the one above.
            winner = (await db.execute(select(User).where(User.idp_id == claims.sub))).scalar_one_or_none()
            if winner is None:
                raise _Refused("account_conflict") from None
            return winner
        return user

    # A known identity: take over what Keycloak says, but never at the price of a failed
    # sign-in. A name or address still held by another (stale) row stays as it was here.
    new_username = user.username
    if username.lower() == user.username.lower():
        new_username = username
    else:
        taken = await db.execute(
            select(User.id).where(func.lower(User.username) == username.lower(), User.id != user.id).limit(1)
        )
        if taken.first():
            log.warning("user name of %s not updated: another account still holds it", user.id)
        else:
            new_username = username
    new_email = user.email
    if email is None:
        new_email = None
    elif email != user.email:
        taken = await db.execute(
            select(User.id).where(func.lower(User.email) == email.lower(), User.id != user.id).limit(1)
        )
        if not taken.first():
            new_email = email
    user_id = user.id
    try:
        # Assigned inside the savepoint: the session writes pending changes before it opens
        # one, so anything assigned earlier would fail outside of it and take the whole
        # transaction down.
        async with db.begin_nested():
            user.username = new_username
            user.first_name = first_name or user.first_name
            user.last_name = last_name or user.last_name
            user.email = new_email
            await db.flush()
    except IntegrityError:
        # Lost a race for the new name or address; keep the stored profile for this sign-in.
        # (The rolled-back object must be read anew before any of its fields is touched.)
        log.warning("profile of %s not updated from the token: conflict", user_id)
        await db.refresh(user)
    return user


async def _refuse(settings: Settings, oidc: OidcClient, id_token: str, reason: str) -> Response:
    """Refuse a sign-in the identity provider accepted, and end the session there.

    Left alive, the next click on "sign in" would run silently into the same refusal, and
    nobody could sign in with another account from this browser.
    """
    try:
        url = await oidc.end_session_url(
            id_token_hint=id_token,
            # Not "/login?error=…" directly: Keycloak refuses a return address that carries a
            # parameter named "error" ("Invalid redirect uri"). The reason travels in the path
            # of a route of ours, which sends the browser on to the login page.
            post_logout_redirect_uri=f"{settings.public_url}/api/auth/refused/{quote(reason, safe='')}",
        )
    except OidcError:
        return _login_failed(settings, reason)
    response = RedirectResponse(url, status_code=302)
    response.delete_cookie(
        settings.login_cookie, path="/", secure=settings.secure_cookies, httponly=True, samesite="lax"
    )
    return response


@router.get("/refused/{reason}", include_in_schema=False)
async def refused(reason: str, settings: Settings = Depends(get_settings)) -> Response:
    """Where the identity provider sends the browser after ending the session of a refused
    sign-in (see ``_refuse``): on to the login page, which explains the reason.

    Anybody can open this address. It leads to the login page and nowhere else, and the reason
    is a plain code the page looks up; one it does not know gets the general text.
    """
    return _login_failed(settings, reason if re.fullmatch(r"[a-z_]{1,40}", reason) else "invalid")


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
    db: AsyncSession = Depends(get_db, scope="function"),
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
    # Compared as bytes: compare_digest refuses non-ASCII text, and ``state`` is client input.
    if not secrets.compare_digest(state.encode(), str(pending.get("state", "")).encode()):
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
    try:
        user = await _find_or_provision(db, claims)
    except _Refused as refusal:
        log.warning("sign-in of %s refused: %s", claims.sub, refusal.reason)
        return await _refuse(settings, oidc, id_token, refusal.reason)
    if not user.active:
        return await _refuse(settings, oidc, id_token, "disabled")

    try:
        if await _needs_second_factor(db, settings, idp, user):
            if pending.get("mfa"):
                return await _refuse(settings, oidc, id_token, "second_factor_required")
            # Ask Keycloak to enrol a second factor, then run the sign-in once more. (A change
            # to the account like any other: it takes its turn.)
            await advisory_lock(db, Lock.USER, user.id)
            await idp.require_second_factor_setup(user.idp_id)
            language = str(pending.get("lang") or "") or None
            return await _start_login(settings, oidc, return_to, second_factor_round=True, language=language)
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


@router.post("/logout", response_model=LogoutOut)
async def logout(
    request: Request,
    db: AsyncSession = Depends(get_db, scope="function"),
    settings: Settings = Depends(get_settings),
    oidc: OidcClient = Depends(get_oidc),
) -> Response:
    """End the Velydock session and return the address that also ends the Keycloak session.

    Deliberately works without a live session: someone who clicks "sign out" after the Velydock
    session idled out still has a Keycloak session, and that is the one that must end. The row
    is therefore looked up without the expiry check, and the answer is the same either way.
    """
    verify_csrf(request, settings)
    id_token: str | None = None
    cookie = request.cookies.get(settings.session_cookie, "")
    if cookie and len(cookie) <= 200:
        await set_rls_context(db, scope=Scope.SYSTEM)
        row = await db.get(AuthSession, hash_token(cookie))
        if row is not None:
            id_token = row.id_token
            await sessions.delete_session(db, row.id_hash)
    try:
        # Without the token Keycloak asks the user to confirm, then ends its session all the same.
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
