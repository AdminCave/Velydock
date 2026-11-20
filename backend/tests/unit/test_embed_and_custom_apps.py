"""Embeddability check (incl. its SSRF guard) and the lock-down of custom apps."""

from __future__ import annotations

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
