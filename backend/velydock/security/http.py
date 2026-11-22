"""HTTP-level protections: CSRF check, security headers and limits on what a request may carry."""

from __future__ import annotations

import asyncio
import json

from fastapi import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from velydock.config import Settings
from velydock.errors import ApiError

CSRF_HEADER = "x-velydock-csrf"
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def verify_same_origin(request: Request) -> None:
    """Refuse a request that a page of another origin made with the user's session.

    Browsers say where a request comes from (``Sec-Fetch-Site``). The interface is the only
    page that has any business with the API, and it is same-origin. Everything else - an
    embedded app under a sibling host name, a custom app in its sandbox - is turned away
    before the session is even looked at, reads included.

    Why reads: the other page cannot see the answer, but the request would be carried out as
    the user. It could keep a session alive, and time or count answers to learn what exists.
    ``SameSite=Lax`` does not help here: sibling host names are the same site. Chromium and
    Firefox withhold cookies from sandboxed frames; WebKit (Safari) sends them along.

    A request without the header (an older browser, a script, a monitoring check) passes; so
    does "none": the user typed the address or used a bookmark.
    """
    fetch_site = request.headers.get("sec-fetch-site")
    if fetch_site is not None and fetch_site not in ("same-origin", "none"):
        raise ApiError(403, "csrf", "Cross-site request rejected.")


def verify_csrf(request: Request, settings: Settings) -> None:
    """Reject cross-site state changes.

    Three independent checks: the session cookie is ``SameSite=Lax``; the request must carry a
    custom header, which a foreign page cannot add without a CORS preflight (and CORS is not
    enabled); and where the browser states the request's origin, it must be ours.
    """
    if request.method in _SAFE_METHODS:
        return
    if request.headers.get(CSRF_HEADER) != "1":
        raise ApiError(403, "csrf", "Missing CSRF header.")
    origin = request.headers.get("origin")
    if origin is not None and origin != settings.public_origin:
        raise ApiError(403, "csrf", "Cross-origin request rejected.")
    fetch_site = request.headers.get("sec-fetch-site")
    if fetch_site is not None and fetch_site not in ("same-origin", "none"):
        raise ApiError(403, "csrf", "Cross-site request rejected.")


def app_csp(settings: Settings) -> str:
    """Content Security Policy for the Velydock UI itself."""
    frame_sources = "https:" if settings.secure_cookies else "https: http:"
    return "; ".join(
        [
            "default-src 'self'",
            "script-src 'self'",
            # Component styles are static files; inline style attributes are needed for positioning.
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self'",
            "connect-src 'self'",
            f"frame-src {frame_sources}",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "object-src 'none'",
        ]
    )


class SecurityHeadersMiddleware:
    """Adds security headers to every response of the main application."""

    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        headers = {
            "content-security-policy": app_csp(settings),
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "referrer-policy": "strict-origin-when-cross-origin",
            "cross-origin-opener-policy": "same-origin-allow-popups",
        }
        if settings.secure_cookies:
            headers["strict-transport-security"] = "max-age=31536000; includeSubDomains"
        self._headers = [(k.encode(), v.encode()) for k, v in headers.items()]

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        is_api = scope.get("path", "").startswith("/api/")

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                existing = {name for name, _ in message.get("headers", [])}
                extra = [(k, v) for k, v in self._headers if k not in existing]
                if is_api and b"cache-control" not in existing:
                    extra.append((b"cache-control", b"no-store"))
                message["headers"] = [*message.get("headers", []), *extra]
            await send(message)

        await self.app(scope, receive, send_with_headers)


# The largest legitimate request is a custom app (HTML, CSS and JavaScript at their limits plus
# an icon), a little over one megabyte as JSON.
MAX_BODY_BYTES = 4 * 1024 * 1024
# How much of a refused request is still read and thrown away, and for how long, before the
# answer is sent and the connection closed (RequestGuardMiddleware._discard).
LINGER_BYTES = 16 * 1024 * 1024
LINGER_SECONDS = 5.0


class RequestGuardMiddleware:
    """Turns away requests no legitimate client sends, before any handler reads them.

    * Bodies over ``MAX_BODY_BYTES``: without a limit an anonymous client could make the process
      buffer gigabytes, because bodies are read before authentication is checked. Such a body
      never reaches a handler and is never held in memory.
    * NUL bytes in path or query: PostgreSQL cannot store them, so they could only end in an error.
    """

    def __init__(
        self,
        app: ASGIApp,
        limit: int = MAX_BODY_BYTES,
        *,
        linger_bytes: int = LINGER_BYTES,
        linger_seconds: float = LINGER_SECONDS,
    ) -> None:
        self.app = app
        self.limit = limit
        self.linger_bytes = linger_bytes
        self.linger_seconds = linger_seconds

    async def _discard(self, receive: Receive) -> None:
        """Read what the client is still sending, and throw it away.

        A refusal goes out while the client - in practice the reverse proxy - is still writing
        the body. Closing the connection under it makes the proxy answer "502 Bad Gateway"
        every now and then instead of passing the refusal on. Reading on for a bounded while
        (what nginx calls a lingering close) lets the answer arrive. Nothing is kept, so
        memory stays flat; bytes and time are limited, so nobody can keep a worker busy.
        """
        seen = 0
        try:
            async with asyncio.timeout(self.linger_seconds):
                while seen < self.linger_bytes:
                    message = await receive()
                    if message["type"] != "http.request":
                        return
                    seen += len(message.get("body", b""))
                    if not message.get("more_body", False):
                        return
        except TimeoutError:
            return

    @staticmethod
    async def _refuse(send: Send, status: int, code: str, message: str) -> None:
        body = json.dumps({"error": {"code": code, "message": message, "details": {}}}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                    (b"cache-control", b"no-store"),
                    (b"x-content-type-options", b"nosniff"),
                    (b"connection", b"close"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if "\x00" in scope.get("path", "") or b"%00" in scope.get("query_string", b""):
            await self._refuse(send, 400, "bad_request", "The address contains a NUL byte.")
            return
        declared = next((v for k, v in scope.get("headers", []) if k == b"content-length"), None)
        if declared is not None:
            try:
                too_large = int(declared) > self.limit
            except ValueError:
                await self._refuse(send, 400, "bad_request", "Invalid Content-Length.")
                return
            if too_large:
                # A client that asked first ("Expect: 100-continue") has not sent the body yet
                # and gets the refusal right away; from everybody else it is on its way.
                expects = next((v for k, v in scope.get("headers", []) if k == b"expect"), b"")
                if expects.strip().lower() != b"100-continue":
                    await self._discard(receive)
                await self._refuse(send, 413, "too_large", "The request is too large.")
                return

        # Without a declared length (chunked upload) the bytes are counted as they arrive. Past
        # the limit the application is told the client went away, and whatever it answers is
        # replaced by the refusal.
        received = 0
        exceeded = False
        refused = False

        async def counting_receive() -> Message:
            nonlocal received, exceeded
            if exceeded:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.limit:
                    exceeded = True
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal refused
            if not exceeded:
                await send(message)
            elif not refused:
                refused = True
                await self._discard(receive)
                await self._refuse(send, 413, "too_large", "The request is too large.")

        try:
            await self.app(scope, counting_receive, guarded_send)
        except Exception:
            if not exceeded:
                raise
        if exceeded and not refused:
            await self._discard(receive)
            await self._refuse(send, 413, "too_large", "The request is too large.")
