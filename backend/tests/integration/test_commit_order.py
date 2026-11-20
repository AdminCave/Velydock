"""A response must never be sent before its changes are committed.

Otherwise a client that reads right after a write may still get the old state – including the
browser that follows the sign-in redirect and finds no session yet.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import event

from tests.conftest import PUBLIC_URL, World
from velydock.db import get_engine
from velydock.models import Role
from velydock.security.http import CSRF_HEADER


async def order_of_events(
    world: World,
    method: str,
    path: str,
    *,
    cookie: str = "",
    body: Any = None,
    extra_headers: dict[str, str] | None = None,
) -> list[str]:
    """Call the ASGI application directly and record when the commit and the response happen."""
    events: list[str] = []
    engine = get_engine().sync_engine

    def on_commit(_: object) -> None:
        events.append("commit")

    def on_rollback(_: object) -> None:
        events.append("rollback")

    event.listen(engine, "commit", on_commit)
    event.listen(engine, "rollback", on_rollback)
    payload = json.dumps(body).encode() if body is not None else b""
    path_only, _, query = path.partition("?")
    headers = {
        "host": PUBLIC_URL.removeprefix("https://"),
        "content-type": "application/json",
        "content-length": str(len(payload)),
        CSRF_HEADER: "1",
        **(extra_headers or {}),
    }
    if cookie:
        headers["cookie"] = cookie
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "https",
        "path": path_only,
        "raw_path": path_only.encode(),
        "query_string": query.encode(),
        "headers": [(k.encode(), v.encode()) for k, v in headers.items()],
        "client": ("127.0.0.1", 1234),
        "server": ("dock.test", 443),
    }

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": payload, "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.start":
            events.append(f"response {message['status']}")

    try:
        await world.app(scope, receive, send)
    finally:
        event.remove(engine, "commit", on_commit)
        event.remove(engine, "rollback", on_rollback)
    return events


async def test_a_write_is_committed_before_its_response_is_sent(world: World) -> None:
    acme = await world.tenant("Acme")
    admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
    cookie = f"{world.settings.session_cookie}={await world.session(admin)}"

    events = await order_of_events(
        world, "POST", "/api/v1/admin/groups", cookie=cookie, body={"name": "Büro"}
    )
    assert events == ["commit", "response 201"]

    events = await order_of_events(
        world, "PATCH", "/api/v1/me/settings", cookie=cookie, body={"theme": "dark"}
    )
    assert events == ["commit", "response 200"]

    events = await order_of_events(
        world, "POST", "/api/v1/me/active-tenant", cookie=cookie, body={"tenant_id": str(acme.id)}
    )
    assert events == ["commit", "response 200"]


async def test_a_refused_request_is_rolled_back_before_its_response(world: World) -> None:
    acme = await world.tenant("Acme")
    member = await world.user(acme, "mia", Role.MEMBER)
    cookie = f"{world.settings.session_cookie}={await world.session(member)}"
    events = await order_of_events(world, "POST", "/api/v1/admin/groups", cookie=cookie, body={"name": "X"})
    assert events == ["rollback", "response 403"]


async def test_the_session_exists_before_the_sign_in_redirect_is_sent(world: World) -> None:
    acme = await world.tenant("Acme")
    anna = await world.user(acme, "anna")
    async with world.client() as browser:
        start = await browser.get("/api/auth/login")
        callback = world.mini.authorize(start.headers["location"], world.identity(anna))
        login_cookie = browser.cookies.get(world.settings.login_cookie)
    path = callback.removeprefix(PUBLIC_URL)
    events = await order_of_events(world, "GET", path, cookie=f"{world.settings.login_cookie}={login_cookie}")
    assert events == ["commit", "response 302"]
