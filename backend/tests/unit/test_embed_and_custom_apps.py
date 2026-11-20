"""Embeddability check (incl. its SSRF guard) and the lock-down of custom apps."""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest

from velydock.models import App, EmbedStatus
from velydock.services.custom_apps import (
    SANDBOX_FLAGS,
    content_security_policy,
    render_document,
    response_headers,
)
from velydock.services.embedcheck import check_embeddable, evaluate_headers, is_public_address

ORIGIN = "https://dock.example.com"


def verdict(
    headers: dict[str, str] | list[tuple[str, str]], target: str = "https://cloud.example.com/"
) -> EmbedStatus:
    return evaluate_headers(httpx.Headers(headers), target_url=target, embedder_origin=ORIGIN).status


class TestFramingHeaders:
    def test_no_restriction(self) -> None:
        assert verdict({}) == EmbedStatus.OK

    @pytest.mark.parametrize("value", ["DENY", "deny", "SAMEORIGIN", "sameorigin", "SAMEORIGIN, SAMEORIGIN"])
    def test_x_frame_options_blocks(self, value: str) -> None:
        assert verdict({"X-Frame-Options": value}) == EmbedStatus.BLOCKED

    def test_sameorigin_allows_the_same_origin(self) -> None:
        assert verdict({"X-Frame-Options": "SAMEORIGIN"}, target=f"{ORIGIN}/app") == EmbedStatus.OK

    @pytest.mark.parametrize(
        "policy",
        [
            "frame-ancestors 'none'",
            "frame-ancestors 'self'",
            "default-src 'self'; frame-ancestors 'self' https://intranet.example.com",
            "frame-ancestors https://dock.example.com:8443",
            "frame-ancestors http://dock.example.com",
            "frame-ancestors https://*.other.example",
        ],
    )
    def test_frame_ancestors_blocks(self, policy: str) -> None:
        assert verdict({"Content-Security-Policy": policy}) == EmbedStatus.BLOCKED

    @pytest.mark.parametrize(
        "policy",
        [
            "frame-ancestors https://dock.example.com",
            "frame-ancestors 'self' https://dock.example.com",
            "frame-ancestors https://*.example.com",
            "frame-ancestors https:",
            "frame-ancestors *",
            "script-src 'self'; FRAME-ANCESTORS https://dock.example.com:443",
        ],
    )
    def test_frame_ancestors_allows(self, policy: str) -> None:
        assert verdict({"Content-Security-Policy": policy}) == EmbedStatus.OK

    def test_frame_ancestors_wins_over_x_frame_options(self) -> None:
        headers = {
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": "frame-ancestors https://dock.example.com",
        }
        assert verdict(headers) == EmbedStatus.OK

    @pytest.mark.parametrize(
        "headers",
        [
            # Every policy must allow: one that forbids is enough, whatever comes after it.
            [
                ("Content-Security-Policy", "frame-ancestors 'none'"),
                ("Content-Security-Policy", "frame-ancestors *"),
            ],
            [
                ("Content-Security-Policy", "frame-ancestors *"),
                ("Content-Security-Policy", "frame-ancestors 'none'"),
            ],
            # Two policies in one header, separated by a comma.
            [("Content-Security-Policy", "frame-ancestors 'self', frame-ancestors *")],
            # Within one policy the first directive counts; later repetitions are ignored.
            [("Content-Security-Policy", "frame-ancestors 'none'; frame-ancestors *")],
        ],
    )
    def test_several_policies_must_all_allow(self, headers: list[tuple[str, str]]) -> None:
        assert verdict(headers) == EmbedStatus.BLOCKED

    def test_a_policy_without_frame_ancestors_does_not_restrict(self) -> None:
        headers = [
            ("Content-Security-Policy", "default-src 'self'"),
            ("Content-Security-Policy", f"frame-ancestors {ORIGIN}"),
        ]
        assert verdict(headers) == EmbedStatus.OK

    @pytest.mark.parametrize(
        "headers",
        [
            [("X-Frame-Options", "SAMEORIGIN"), ("X-Frame-Options", "DENY")],
            [("X-Frame-Options", "ALLOWALL, DENY")],
            [("X-Frame-Options", "ALLOWALL"), ("X-Frame-Options", "SAMEORIGIN")],
        ],
    )
    def test_every_x_frame_options_value_counts(self, headers: list[tuple[str, str]]) -> None:
        # Same origin on purpose: SAMEORIGIN alone would allow, the second value must not be lost.
        assert verdict(headers, target=f"{ORIGIN}/app") == EmbedStatus.BLOCKED

    def test_wildcard_does_not_match_the_bare_domain(self) -> None:
        result = evaluate_headers(
            httpx.Headers({"Content-Security-Policy": "frame-ancestors https://*.example.com"}),
            target_url="https://cloud.example.com/",
            embedder_origin="https://example.com",
        )
        assert result.status == EmbedStatus.BLOCKED


class TestSsrfGuard:
    @pytest.mark.parametrize(
        "address",
        [
            "127.0.0.1",
            "10.0.0.5",
            "172.16.3.4",
            "192.168.1.1",
            "169.254.169.254",
            "::1",
            "fe80::1",
            "fc00::1",
            "0.0.0.0",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "224.0.0.1",
            "100.64.0.1",
            "not-an-ip",
        ],
    )
    def test_internal_addresses_are_not_public(self, address: str) -> None:
        assert not is_public_address(address)

    @pytest.mark.parametrize("address", ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "1.1.1.1"])
    def test_public_addresses(self, address: str) -> None:
        assert is_public_address(address)

    @pytest.mark.parametrize(
        "url",
        [
            "http://127.0.0.1:9000/",
            "http://localhost/",
            "http://[::1]/",
            "http://169.254.169.254/latest/meta-data/",
        ],
    )
    async def test_private_targets_are_never_contacted(self, url: str) -> None:
        result = await check_embeddable(url, embedder_origin=ORIGIN, allow_private=False)
        assert result.status == EmbedStatus.UNKNOWN
        assert "private" in result.detail
        assert result.http_status is None

    @pytest.mark.parametrize(
        "url", ["file:///etc/passwd", "gopher://example.com/", "ftp://example.com/", "javascript:1"]
    )
    async def test_other_schemes_are_refused(self, url: str) -> None:
        result = await check_embeddable(url, embedder_origin=ORIGIN, allow_private=True)
        assert result.status == EmbedStatus.UNKNOWN
        assert result.http_status is None

    async def test_urls_with_credentials_are_refused(self) -> None:
        result = await check_embeddable(
            "https://user:pw@example.com/", embedder_origin=ORIGIN, allow_private=True
        )
        assert result.status == EmbedStatus.UNKNOWN


class TestCustomAppLockdown:
    def app(self, **fields: str | bool) -> App:
        defaults: dict[str, str | bool] = {
            "name": "Demo",
            "custom_html": "<h1>Hi</h1>",
            "custom_css": "h1{color:red}",
            "custom_js": "console.log(1)",
            "custom_allow_network": False,
        }
        return App(**{**defaults, **fields})

    def test_sandbox_never_grants_an_origin_or_top_navigation(self) -> None:
        flags = SANDBOX_FLAGS.split()
        assert "allow-scripts" in flags
        assert "allow-same-origin" not in flags
        assert not [f for f in flags if f.startswith("allow-top-navigation")]

    @pytest.mark.parametrize("allow_network", [False, True])
    def test_policy_always_sandboxes_and_pins_the_embedder(self, allow_network: bool) -> None:
        policy = content_security_policy(allow_network=allow_network, embedder_origin=ORIGIN)
        directives = {d.split()[0]: d.split()[1:] for d in policy.split("; ")}
        assert directives["sandbox"] == SANDBOX_FLAGS.split()
        assert "allow-same-origin" not in directives["sandbox"]
        assert directives["default-src"] == ["'none'"]
        assert directives["frame-ancestors"] == [ORIGIN]
        assert directives["base-uri"] == ["'none'"]

    def test_network_is_closed_by_default(self) -> None:
        policy = content_security_policy(allow_network=False, embedder_origin=ORIGIN)
        assert "connect-src 'none'" in policy
        assert "form-action 'none'" in policy
        assert "https:" not in policy.replace(ORIGIN, "")

    def test_network_can_be_opened_for_https_only(self) -> None:
        policy = content_security_policy(allow_network=True, embedder_origin=ORIGIN)
        assert "connect-src https:" in policy
        assert "http:" not in policy.replace("https:", "")

    def test_headers_forbid_referrer_caching_and_sensors(self) -> None:
        headers = response_headers(allow_network=False, embedder_origin=ORIGIN)
        assert headers["Referrer-Policy"] == "no-referrer"
        assert headers["Cache-Control"] == "no-store"
        assert headers["X-Content-Type-Options"] == "nosniff"
        assert "camera=()" in headers["Permissions-Policy"]
        assert "Set-Cookie" not in headers

    def test_document_contains_the_three_parts(self) -> None:
        document = render_document(self.app(), theme="dark", language="de")
        assert document.startswith("<!doctype html>")
        assert '<html lang="de" data-theme="dark">' in document
        assert "<style>h1{color:red}</style>" in document
        assert "<h1>Hi</h1>" in document
        assert "<script>console.log(1)</script>" in document

    def test_closing_tags_inside_code_cannot_end_the_block(self) -> None:
        document = render_document(
            self.app(custom_js="var s = '</script><h1>x</h1>';", custom_css="a::after{content:'</style>'}"),
            theme="light",
            language="en",
        )
        assert document.count("</script>") == 1
        assert document.count("</style>") == 1

    def test_title_is_escaped_and_theme_is_whitelisted(self) -> None:
        document = render_document(self.app(name="<img src=x onerror=1>"), theme='"><script>', language="xx")
        assert "<title>&lt;img src=x onerror=1&gt;</title>" in document
        assert 'data-theme="light"' in document
        assert 'lang="en"' in document


class TestEmbedCheckOverHttp:
    """The complete check against a real (local) web server, including the redirect handling."""

    @pytest.fixture
    async def site(self) -> AsyncIterator[str]:
        import asyncio

        responses = {
            "/open": (200, {}),
            "/deny": (200, {"X-Frame-Options": "DENY"}),
            "/ancestors": (200, {"Content-Security-Policy": f"frame-ancestors {ORIGIN}"}),
            "/self-only": (200, {"Content-Security-Policy": "frame-ancestors 'self'"}),
            "/login-redirect": (302, {"Location": "https://sso.example.org/auth"}),
            "/local-redirect": (302, {"Location": "/deny"}),
            "/to-open": (301, {"Location": "open?x=1"}),
            "/open?x=1": (200, {}),
            "/loop": (302, {"Location": "/loop"}),
            "/error": (500, {"X-Frame-Options": "DENY"}),
        }
        seen: list[tuple[str, str]] = []

        async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            request = (await reader.readuntil(b"\r\n\r\n")).decode()
            _method, path, _ = request.split("\r\n")[0].split(" ")
            host = next(
                line.split(": ", 1)[1] for line in request.split("\r\n") if line.lower().startswith("host:")
            )
            seen.append((path, host))
            if path == "/drip":
                # Never finishes its headers, but keeps the connection busy: one byte at a time,
                # each well within the read timeout.
                writer.write(b"HTTP/1.1 200 X\r\nX-Slow: ")
                try:
                    for _ in range(200):
                        writer.write(b"a")
                        await writer.drain()
                        await asyncio.sleep(0.2)
                except (ConnectionError, asyncio.CancelledError):
                    pass
                writer.close()
                return
            status, headers = responses.get(path, (404, {}))
            head = "".join(f"{k}: {v}\r\n" for k, v in headers.items())
            # A large body that the check must not wait for.
            writer.write(
                f"HTTP/1.1 {status} X\r\n{head}Content-Length: 5000000\r\n\r\n".encode() + b"x" * 1000
            )
            await writer.drain()
            writer.close()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        self.seen = seen
        async with server:
            yield f"http://localhost:{port}"

    async def check(self, url: str) -> tuple[EmbedStatus, int | None, str]:
        result = await check_embeddable(url, embedder_origin=ORIGIN, allow_private=True)
        return result.status, result.http_status, result.detail

    async def test_headers_of_a_real_response_decide(self, site: str) -> None:
        assert (await self.check(f"{site}/open"))[:2] == (EmbedStatus.OK, 200)
        assert (await self.check(f"{site}/deny"))[:2] == (EmbedStatus.BLOCKED, 200)
        assert (await self.check(f"{site}/ancestors"))[:2] == (EmbedStatus.OK, 200)
        assert (await self.check(f"{site}/self-only"))[:2] == (EmbedStatus.BLOCKED, 200)
        assert (await self.check(f"{site}/error"))[:2] == (EmbedStatus.BLOCKED, 500)

    async def test_the_original_host_name_is_sent_although_the_address_is_pinned(self, site: str) -> None:
        await self.check(f"{site}/open")
        assert self.seen == [("/open", site.removeprefix("http://"))]

    async def test_a_redirect_to_another_host_is_reported_not_followed(self, site: str) -> None:
        status, http_status, detail = await self.check(f"{site}/login-redirect")
        assert (status, http_status) == (EmbedStatus.UNKNOWN, 302)
        assert "sso.example.org" in detail
        assert [path for path, _ in self.seen] == ["/login-redirect"], "no second request was made"

    async def test_a_redirect_within_the_host_is_followed_to_the_page_that_is_shown(self, site: str) -> None:
        """The usual case: the base address redirects to a sign-in page that forbids framing."""
        status, http_status, _ = await self.check(f"{site}/local-redirect")
        assert (status, http_status) == (EmbedStatus.BLOCKED, 200)
        host = site.removeprefix("http://")
        assert self.seen == [("/local-redirect", host), ("/deny", host)]

    async def test_relative_redirect_targets_are_resolved(self, site: str) -> None:
        assert (await self.check(f"{site}/to-open"))[:2] == (EmbedStatus.OK, 200)
        assert [path for path, _ in self.seen] == ["/to-open", "/open?x=1"]

    async def test_a_redirect_loop_ends(self, site: str) -> None:
        status, http_status, detail = await self.check(f"{site}/loop")
        assert (status, http_status) == (EmbedStatus.UNKNOWN, 302)
        assert "too many redirects" in detail
        assert len(self.seen) == 4, "the first request and three redirects, then it stops"

    async def test_a_site_that_drips_its_headers_cannot_hold_the_check(
        self, site: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import time

        from velydock.services import embedcheck

        monkeypatch.setattr(embedcheck, "_DEADLINE", 1.0)
        started = time.monotonic()
        status, http_status, detail = await self.check(f"{site}/drip")
        assert (status, http_status) == (EmbedStatus.UNKNOWN, None)
        assert "in time" in detail
        assert time.monotonic() - started < 3, "ended by the overall deadline, not by the site"

    async def test_only_a_few_checks_run_at_the_same_time(
        self, site: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import asyncio

        from velydock.services import embedcheck

        monkeypatch.setattr(embedcheck, "_DEADLINE", 1.5)
        monkeypatch.setattr(embedcheck, "_MAX_PARALLEL", 2)
        slow = [asyncio.create_task(self.check(f"{site}/drip")) for _ in range(2)]
        await asyncio.sleep(0.3)
        status, _, detail = await self.check(f"{site}/open")
        assert status == EmbedStatus.UNKNOWN and "too many checks" in detail
        assert [path for path, _ in self.seen] == ["/drip", "/drip"], "the third check never left the server"
        await asyncio.gather(*slow)
        # The slots are free again afterwards.
        assert (await self.check(f"{site}/open"))[0] == EmbedStatus.OK
        assert embedcheck._running == 0

    @pytest.mark.parametrize(
        "url",
        [
            "https://example..com/",
            "https://example.com:99999/",
            "https://[::1/",
            "https://exa mple.com/",
            "https://b\u00fccher.invalid/",
            "https://" + "a" * 70 + ".example/",
        ],
    )
    async def test_addresses_that_are_none_end_in_a_verdict_not_an_error(self, url: str) -> None:
        result = await check_embeddable(url, embedder_origin=ORIGIN, allow_private=False)
        assert result.status == EmbedStatus.UNKNOWN

    async def test_private_addresses_stay_off_limits_by_default(self, site: str) -> None:
        result = await check_embeddable(f"{site}/open", embedder_origin=ORIGIN, allow_private=False)
        assert result.status == EmbedStatus.UNKNOWN and self.seen == []

    async def test_unreachable_host(self) -> None:
        status, http_status, _ = await self.check("http://127.0.0.1:9/")
        assert (status, http_status) == (EmbedStatus.UNKNOWN, None)
