"""What a request may carry, and which application answers it - checked without a database."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from starlette.requests import Request
from starlette.types import Message, Receive, Scope, Send

from velydock.app import HostDispatch, create_main_app
from velydock.config import Settings
from velydock.security.http import RequestGuardMiddleware, SecurityHeadersMiddleware
from velydock.security.sessions import client_ip


def make_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "environment": "test",
        "public_url": "https://dock.test",
        "sandbox_url": "https://sandbox.test",
        "database_url": "postgresql+asyncpg://u:p@127.0.0.1:1/none",
        "secret_key": "k" * 40,
        "keycloak_public_url": "https://auth.test",
        "keycloak_internal_url": "http://keycloak:8080",
        "oidc_client_secret": "oidc-secret-" + "0" * 16,
        "idp_admin_client_secret": "admin-secret-" + "0" * 16,
        "static_dir": "/nonexistent",
    }
    values.update(overrides)
    return Settings(**values)


async def echo(scope: Scope, receive: Receive, send: Send) -> None:
    """Reads the whole body like a framework would and answers with its size."""
    size = 0
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            raise RuntimeError("client disconnected")
        size += len(message.get("body", b""))
        if not message.get("more_body"):
            break
    body = json.dumps({"size": size}).encode()
    await send(
        {"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"application/json")]}
    )
    await send({"type": "http.response.body", "body": body})


def client(app: Any, base_url: str = "https://dock.test") -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url=base_url)


class TestBodyLimit:
    async def test_normal_bodies_pass(self) -> None:
        async with client(RequestGuardMiddleware(echo, limit=1000)) as http:
            response = await http.post("/x", content=b"a" * 1000)
        assert response.status_code == 200 and response.json() == {"size": 1000}

    async def test_a_declared_length_over_the_limit_is_refused_unread(self) -> None:
        reads = 0

        async def counting(scope: Scope, receive: Receive, send: Send) -> None:
            nonlocal reads
            reads += 1
            await echo(scope, receive, send)

        async with client(RequestGuardMiddleware(counting, limit=1000)) as http:
            response = await http.post("/x", content=b"a" * 1001)
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "too_large"
        assert reads == 0, "the application never saw the request"

    async def test_a_body_without_declared_length_is_cut_off_at_the_limit(self) -> None:
        """Chunked uploads state no length; the bytes are counted as they arrive."""
        sent: list[Message] = []

        async def receive() -> Message:
            return {"type": "http.request", "body": b"a" * 600, "more_body": True}

        async def send(message: Message) -> None:
            sent.append(message)

        scope = {"type": "http", "method": "POST", "path": "/x", "query_string": b"", "headers": []}
        await RequestGuardMiddleware(echo, limit=1000)(scope, receive, send)
        assert [m["type"] for m in sent] == ["http.response.start", "http.response.body"]
        assert sent[0]["status"] == 413

    async def test_an_answer_the_application_gives_after_the_cut_is_replaced(self) -> None:
        async def tolerant(scope: Scope, receive: Receive, send: Send) -> None:
            while (await receive())["type"] != "http.disconnect":
                pass
            await send({"type": "http.response.start", "status": 400, "headers": []})
            await send({"type": "http.response.body", "body": b"bad request"})

        sent: list[Message] = []

        async def receive() -> Message:
            return {"type": "http.request", "body": b"a" * 600, "more_body": True}

        async def send(message: Message) -> None:
            sent.append(message)

        scope = {"type": "http", "method": "POST", "path": "/x", "query_string": b"", "headers": []}
        await RequestGuardMiddleware(tolerant, limit=1000)(scope, receive, send)
        assert [m.get("status") for m in sent if m["type"] == "http.response.start"] == [413]

    async def test_the_rest_of_a_refused_body_is_read_and_thrown_away_before_the_answer(self) -> None:
        """Answering while the reverse proxy is still sending makes it report 502 now and then
        (seen in the browser suite); so what is on its way is taken off the wire first."""
        events: list[str] = []
        chunks = [b"a" * 500] * 5

        async def receive() -> Message:
            body = chunks.pop()
            events.append("read")
            return {"type": "http.request", "body": body, "more_body": bool(chunks)}

        async def send(message: Message) -> None:
            events.append(message["type"])

        scope = {
            "type": "http",
            "method": "POST",
            "path": "/x",
            "query_string": b"",
            "headers": [(b"content-length", b"2500")],
        }
        await RequestGuardMiddleware(echo, limit=1000)(scope, receive, send)
        assert events == ["read"] * 5 + ["http.response.start", "http.response.body"]

    async def test_a_client_that_asked_first_is_refused_without_its_body(self) -> None:
        async def receive() -> Message:
            raise AssertionError("reading would invite the client to send the body (100 Continue)")

        sent: list[Message] = []

        async def send(message: Message) -> None:
            sent.append(message)

        scope = {
            "type": "http",
            "method": "POST",
            "path": "/x",
            "query_string": b"",
            "headers": [(b"content-length", b"5000000"), (b"expect", b"100-continue")],
        }
        await RequestGuardMiddleware(echo, limit=1000)(scope, receive, send)
        assert sent[0]["status"] == 413

    async def test_throwing_away_is_limited_in_bytes_and_in_time(self) -> None:
        read = 0

        async def endless() -> Message:
            nonlocal read
            read += 600
            return {"type": "http.request", "body": b"a" * 600, "more_body": True}

        async def silent() -> Message:
            await asyncio.sleep(30)
            raise AssertionError("waited for a client that sends nothing")

        declared = {
            "type": "http",
            "method": "POST",
            "path": "/x",
            "query_string": b"",
            "headers": [(b"content-length", b"999999999")],
        }
        for receive in (endless, silent):
            sent: list[Message] = []

            async def send(message: Message, sent: list[Message] = sent) -> None:
                sent.append(message)

            guard = RequestGuardMiddleware(echo, limit=1000, linger_bytes=3000, linger_seconds=0.05)
            await asyncio.wait_for(guard(declared, receive, send), timeout=2)
            assert sent[0]["status"] == 413
        assert read == 3000

    async def test_nonsense_as_length_is_refused(self) -> None:
        async with client(RequestGuardMiddleware(echo)) as http:
            response = await http.post("/x", content=b"abc", headers={"Content-Length": "many"})
        assert response.status_code == 400

    async def test_errors_of_the_application_still_surface(self) -> None:
        async def broken(scope: Scope, receive: Receive, send: Send) -> None:
            raise ValueError("boom")

        async with client(RequestGuardMiddleware(broken)) as http:
            with pytest.raises(ValueError, match="boom"):
                await http.get("/x")


class TestNulBytes:
    @pytest.mark.parametrize("target", ["/api/v1/admin/users?search=a%00b", "/a%00b", "/x?%00=1"])
    async def test_nul_in_the_address_is_refused(self, target: str) -> None:
        async with client(RequestGuardMiddleware(echo)) as http:
            response = await http.get(target)
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "bad_request"


class TestHostDispatch:
    """Custom apps are isolated by host name, so the decision which host a request is for matters."""

    def dispatch(self, **overrides: Any) -> HostDispatch:
        async def main(scope: Scope, receive: Receive, send: Send) -> None:
            await send({"type": "http.response.start", "status": 200, "headers": [(b"x-app", b"main")]})
            await send({"type": "http.response.body", "body": b""})

        async def sandbox(scope: Scope, receive: Receive, send: Send) -> None:
            await send({"type": "http.response.start", "status": 200, "headers": [(b"x-app", b"sandbox")]})
            await send({"type": "http.response.body", "body": b""})

        return HostDispatch(main, sandbox, make_settings(**overrides))

    async def answered_by(self, app: HostDispatch, host: str) -> str:
        async with client(app) as http:
            return (await http.get("/", headers={"Host": host})).headers["x-app"]

    @pytest.mark.parametrize(
        "host", ["sandbox.test", "SANDBOX.test", "sandbox.test:443", "sandbox.test.", "Sandbox.Test.:8443"]
    )
    async def test_every_spelling_of_the_sandbox_host_gets_the_sandbox(self, host: str) -> None:
        assert await self.answered_by(self.dispatch(), host) == "sandbox"

    @pytest.mark.parametrize("host", ["dock.test", "dock.test.", "evil.test", "sandbox.test.evil.test", ""])
    async def test_other_hosts_get_the_main_application(self, host: str) -> None:
        assert await self.answered_by(self.dispatch(), host) == "main"

    async def test_same_host_different_port_is_told_apart_by_the_port(self) -> None:
        app = self.dispatch(public_url="http://localhost:8000", sandbox_url="http://localhost:8001")
        assert await self.answered_by(app, "localhost:8001") == "sandbox"
        assert await self.answered_by(app, "localhost:8000") == "main"


class TestStaticFiles:
    @pytest.fixture
    def app(self, tmp_path: Path) -> SecurityHeadersMiddleware:
        (tmp_path / "index.html").write_text("<!doctype html><title>shell</title>")
        (tmp_path / "favicon.svg").write_text("<svg/>")
        (tmp_path.parent / "secret.txt").write_text("outside")
        settings = make_settings(static_dir=str(tmp_path))
        return SecurityHeadersMiddleware(create_main_app(settings), settings)

    async def test_files_and_the_shell(self, app: SecurityHeadersMiddleware) -> None:
        async with client(app) as http:
            assert (await http.get("/favicon.svg")).text == "<svg/>"
            shell = await http.get("/admin/users")
            assert "shell" in shell.text and shell.headers["cache-control"] == "no-cache"
            assert "outside" not in (await http.get("/..%2Fsecret.txt")).text

    @pytest.mark.parametrize("path", ["/" + "a" * 300, "/" + "a/" * 2100, "/%ff%fe"])
    async def test_impossible_file_names_get_the_shell_not_an_error(
        self, app: SecurityHeadersMiddleware, path: str
    ) -> None:
        async with client(app) as http:
            response = await http.get(path)
        assert response.status_code == 200 and "shell" in response.text

    @pytest.mark.parametrize("path", ["/", "/api/health"])
    async def test_head_is_answered(self, app: SecurityHeadersMiddleware, path: str) -> None:
        """Uptime monitors use HEAD by default."""
        async with client(app) as http:
            assert (await http.head(path)).status_code == 200

    async def test_there_is_no_interactive_api_documentation_page(
        self, app: SecurityHeadersMiddleware
    ) -> None:
        # It would load scripts from a CDN, which the Content Security Policy blocks.
        async with client(app) as http:
            assert (await http.get("/api/docs")).status_code == 404

    async def test_an_unexpected_error_is_answered_with_the_security_headers(self, tmp_path: Path) -> None:
        settings = make_settings(static_dir=str(tmp_path))
        main = create_main_app(settings)

        @main.get("/api/boom")
        async def boom() -> None:
            raise RuntimeError("unexpected")

        # In front of the catch-all for unknown API routes.
        main.router.routes.insert(0, main.router.routes.pop())

        transport = httpx.ASGITransport(
            app=SecurityHeadersMiddleware(main, settings), raise_app_exceptions=False
        )
        async with httpx.AsyncClient(transport=transport, base_url="https://dock.test") as http:
            response = await http.get("/api/boom")
        assert response.status_code == 500
        assert response.headers["x-content-type-options"] == "nosniff"
        assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
        assert response.headers["cache-control"] == "no-store"


class TestClientAddress:
    def request(self, host: str | None) -> Request:
        scope: dict[str, Any] = {
            "type": "http",
            "headers": [],
            "client": (host, 1234) if host is not None else None,
        }
        return Request(scope)

    @pytest.mark.parametrize("host", ["203.0.113.9", "2001:db8::1", "::ffff:203.0.113.9"])
    def test_addresses_are_kept(self, host: str) -> None:
        assert client_ip(self.request(host)) != ""

    @pytest.mark.parametrize(
        "host",
        [
            None,
            "",
            "unknown",
            "203.0.113.9, 6.6.6.6",
            "x" * 70,
            "<script>",
            "fe80::1%eth0",
            "fe80::1%" + "a" * 60,
        ],
    )
    def test_anything_else_becomes_empty(self, host: str | None) -> None:
        """Behind a proxy the value comes from a header; it must fit the column and be an address."""
        assert client_ip(self.request(host)) == ""


class TestConfiguredHosts:
    def test_host_names_are_compared_in_lower_case(self) -> None:
        """Browsers send the Origin header in lower case; a capital letter in the configuration
        must not make every change fail the cross-site check."""
        settings = make_settings(
            public_url="https://Dock.Example.COM/", sandbox_url="https://Sandbox.Example.com"
        )
        assert settings.public_url == "https://dock.example.com"
        assert settings.public_origin == "https://dock.example.com"
        assert settings.sandbox_host == "sandbox.example.com"

    def test_the_keycloak_address_is_left_as_written(self) -> None:
        """It must equal the issuer Keycloak states, letter for letter."""
        settings = make_settings(keycloak_public_url="https://Auth.Example.com")
        assert settings.issuer == "https://Auth.Example.com/realms/velydock"

    def test_only_private_networks_are_trusted_as_proxies_by_default(self) -> None:
        assert "*" not in make_settings().trusted_proxies

    def test_the_server_is_started_with_exactly_these_trusted_proxies(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A proxy header from anywhere else is not believed (it names the client address)."""
        import uvicorn

        from velydock import cli

        started: dict[str, Any] = {}
        monkeypatch.setattr(uvicorn, "run", lambda *args, **options: started.update(options))
        settings = make_settings(trusted_proxies="10.1.2.3")
        cli.serve(settings)
        assert started["proxy_headers"] is True
        assert started["forwarded_allow_ips"] == "10.1.2.3"


class TestSessionBookkeeping:
    async def test_a_session_whose_row_is_gone_at_the_moment_of_use_is_over(self) -> None:
        """A sign-out can remove the row between reading it and marking it as used."""
        from datetime import UTC, datetime, timedelta
        from types import SimpleNamespace

        from velydock.security.sessions import resolve_session

        row = SimpleNamespace(
            id_hash="h",
            last_seen_at=datetime.now(UTC) - timedelta(minutes=10),
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )

        class Database:
            def __init__(self, matched: int) -> None:
                self.matched = matched

            async def get(self, model: object, key: object) -> object:
                return row

            async def execute(self, statement: object) -> object:
                return SimpleNamespace(rowcount=self.matched)

        settings = make_settings()
        assert await resolve_session(Database(1), settings, "cookie") is row  # type: ignore[arg-type]
        assert await resolve_session(Database(0), settings, "cookie") is None  # type: ignore[arg-type]
