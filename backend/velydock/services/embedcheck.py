"""Can a URL be shown inside a frame of Velydock?

Sites forbid framing with ``X-Frame-Options`` or the CSP directive ``frame-ancestors``. Browsers
give a framing page no way to see that, so the check is done here, server-side, when an
administrator adds an embedded app.

Fetching admin-supplied URLs from the server is a classic SSRF vector. Therefore: http(s) only,
no redirects are followed, the body is never read or returned, and by default every address the
host resolves to must be public. The connection goes to the vetted address itself, so a DNS
answer that changes between check and request cannot redirect it.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from velydock.models import EmbedStatus

_TIMEOUT = httpx.Timeout(6.0, connect=4.0)
_USER_AGENT = "Velydock-EmbedCheck/1.0"


@dataclass(frozen=True)
class EmbedResult:
    status: EmbedStatus
    detail: str
    http_status: int | None = None


def is_public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def _source_matches(source: str, origin: str) -> bool:
    """Does one CSP source expression (host-source or scheme-source) cover our origin?"""
    source = source.strip().lower()
    scheme, _, host_port = origin.lower().partition("://")
    if source == "*":
        return True
    if source.endswith(":") and "/" not in source:
        return source[:-1] == scheme
    src_scheme = scheme
    if "://" in source:
        src_scheme, _, source = source.partition("://")
    source = source.split("/", 1)[0]
    if src_scheme != scheme:
        return False
    host, _, port = host_port.partition(":")
    src_host, _, src_port = source.partition(":")
    default_port = "443" if scheme == "https" else "80"
    if src_port not in ("", "*") and src_port != (port or default_port):
        return False
    if not src_port and port and port != default_port:
        return False
    if src_host.startswith("*."):
        return host.endswith(src_host[1:]) and host != src_host[2:]
    return src_host == host


def evaluate_headers(headers: httpx.Headers, *, target_url: str, embedder_origin: str) -> EmbedResult:
    """Decide from response headers whether ``embedder_origin`` may frame ``target_url``."""
    target = urlsplit(target_url)
    same_origin = f"{target.scheme}://{target.netloc}".lower() == embedder_origin.lower()

    ancestors: list[str] | None = None
    for policy in headers.get_list("content-security-policy"):
        for directive in policy.split(";"):
            parts = directive.split()
            if parts and parts[0].lower() == "frame-ancestors":
                ancestors = parts[1:]
    if ancestors is not None:
        # frame-ancestors takes precedence over X-Frame-Options.
        allowed = False
        for source in ancestors:
            lowered = source.lower()
            if lowered == "'none'":
                continue
            if lowered == "'self'":
                allowed = allowed or same_origin
            elif _source_matches(source, embedder_origin):
                allowed = True
        if allowed:
            return EmbedResult(EmbedStatus.OK, "frame-ancestors allows this Velydock address")
        return EmbedResult(
            EmbedStatus.BLOCKED, f"Content-Security-Policy: frame-ancestors {' '.join(ancestors)}"[:300]
        )

    xfo = headers.get("x-frame-options")
    if xfo:
        value = xfo.split(",")[0].strip().upper()
        if value == "DENY" or (value == "SAMEORIGIN" and not same_origin):
            return EmbedResult(EmbedStatus.BLOCKED, f"X-Frame-Options: {value}")
        if value.startswith("ALLOW-FROM"):
            # Obsolete and ignored by current browsers, which then allow framing.
            return EmbedResult(EmbedStatus.OK, "X-Frame-Options: ALLOW-FROM is ignored by current browsers")
    return EmbedResult(EmbedStatus.OK, "no framing restriction found")


async def _resolve(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


async def check_embeddable(url: str, *, embedder_origin: str, allow_private: bool) -> EmbedResult:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return EmbedResult(EmbedStatus.UNKNOWN, "only http(s) addresses can be checked")
    if parts.username or parts.password:
        return EmbedResult(EmbedStatus.UNKNOWN, "addresses with credentials are not checked")
    port = parts.port or (443 if parts.scheme == "https" else 80)

    try:
        addresses = await _resolve(parts.hostname, port)
    except OSError:
        return EmbedResult(EmbedStatus.UNKNOWN, "host name could not be resolved")
    if not addresses:
        return EmbedResult(EmbedStatus.UNKNOWN, "host name could not be resolved")
    if not allow_private and not all(is_public_address(a) for a in addresses):
        return EmbedResult(EmbedStatus.UNKNOWN, "address is in a private network and was not checked")

    path = parts.path or "/"
    response: httpx.Response | None = None
    failure = "address not reachable"
    # Try the vetted addresses in turn: a host often has an IPv6 address that cannot be reached
    # from inside a container while its IPv4 address works.
    for address in addresses[:4]:
        host_in_url = f"[{address}]" if ":" in address else address
        pinned = f"{parts.scheme}://{host_in_url}:{port}{path}" + (f"?{parts.query}" if parts.query else "")
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=False, trust_env=False) as client:
                request = client.build_request(
                    "GET",
                    pinned,
                    headers={
                        "Host": parts.netloc,
                        "User-Agent": _USER_AGENT,
                        "Accept": "text/html,*/*;q=0.5",
                    },
                    extensions={"sni_hostname": parts.hostname},
                )
                response = await client.send(request, stream=True)
                await response.aclose()
            break
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            failure = f"address not reachable ({type(exc).__name__})"
        except httpx.HTTPError as exc:
            return EmbedResult(EmbedStatus.UNKNOWN, f"address not reachable ({type(exc).__name__})")
    if response is None:
        return EmbedResult(EmbedStatus.UNKNOWN, failure)

    if 300 <= response.status_code < 400:
        location = response.headers.get("location", "")
        target = urlsplit(location)
        if target.netloc and target.netloc.lower() != parts.netloc.lower():
            return EmbedResult(
                EmbedStatus.UNKNOWN,
                f"redirects to {target.netloc}; check that address instead"[:300],
                response.status_code,
            )
    result = evaluate_headers(response.headers, target_url=url, embedder_origin=embedder_origin)
    return EmbedResult(result.status, result.detail, response.status_code)
