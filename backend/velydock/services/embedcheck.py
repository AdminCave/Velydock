"""Can a URL be shown inside a frame of Velydock?

Sites forbid framing with ``X-Frame-Options`` or the CSP directive ``frame-ancestors``. Browsers
give a framing page no way to see that, so the check is done here, server-side, when an
administrator adds an embedded app.

Fetching admin-supplied URLs from the server is a classic SSRF vector. Therefore: http(s) only,
the body is never read or returned, and by default every address the host resolves to must be
public. The connection goes to the vetted address itself, so a DNS answer that changes between
check and request cannot redirect it. Redirects are followed only within the same host (to that
same vetted address, a few steps at most); a redirect to another host ends the check.

The check also must not become a way to tie up the server: it has an overall deadline and only a
few run at the same time, because each one holds the database connection of its request.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx

from velydock.models import EmbedStatus

_TIMEOUT = httpx.Timeout(6.0, connect=4.0)
_USER_AGENT = "Velydock-EmbedCheck/1.0"
# The read timeout above restarts with every byte; a site that drips its headers would keep a
# check (and a database connection) busy for days. This is the limit for the whole check.
_DEADLINE = 12.0
_MAX_PARALLEL = 3
_MAX_REDIRECTS = 3
_running = 0


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


def _frame_ancestors(policy: str) -> list[str] | None:
    """The sources of the first ``frame-ancestors`` directive of one policy (later ones are ignored)."""
    for directive in policy.split(";"):
        parts = directive.split()
        if parts and parts[0].lower() == "frame-ancestors":
            return parts[1:]
    return None


def evaluate_headers(headers: httpx.Headers, *, target_url: str, embedder_origin: str) -> EmbedResult:
    """Decide from response headers whether ``embedder_origin`` may frame ``target_url``."""
    target = urlsplit(target_url)
    same_origin = f"{target.scheme}://{target.netloc}".lower() == embedder_origin.lower()

    # A response may carry several policies (several headers, or comma-separated in one). The
    # browser enforces each of them, so every policy that restricts framing has to allow us.
    restricting = [
        ancestors
        for policy in headers.get_list("content-security-policy", split_commas=True)
        if (ancestors := _frame_ancestors(policy)) is not None
    ]
    if restricting:
        # frame-ancestors takes precedence over X-Frame-Options.
        for ancestors in restricting:
            allowed = False
            for source in ancestors:
                lowered = source.lower()
                if lowered == "'none'":
                    continue
                if lowered == "'self'":
                    allowed = allowed or same_origin
                elif _source_matches(source, embedder_origin):
                    allowed = True
            if not allowed:
                return EmbedResult(
                    EmbedStatus.BLOCKED,
                    f"Content-Security-Policy: frame-ancestors {' '.join(ancestors)}"[:300],
                )
        return EmbedResult(EmbedStatus.OK, "frame-ancestors allows this Velydock address")

    # X-Frame-Options as browsers read it: every value counts, DENY wins, contradictory values
    # block, and anything unknown (the obsolete ALLOW-FROM included) is ignored.
    values = {v.strip().upper() for v in headers.get_list("x-frame-options", split_commas=True) if v.strip()}
    if "DENY" in values:
        return EmbedResult(EmbedStatus.BLOCKED, "X-Frame-Options: DENY")
    known = values & {"SAMEORIGIN", "ALLOWALL"}
    if len(known) > 1:
        return EmbedResult(EmbedStatus.BLOCKED, "X-Frame-Options: contradictory values")
    if "SAMEORIGIN" in known and not same_origin:
        return EmbedResult(EmbedStatus.BLOCKED, "X-Frame-Options: SAMEORIGIN")
    if any(v.startswith("ALLOW-FROM") for v in values):
        return EmbedResult(EmbedStatus.OK, "X-Frame-Options: ALLOW-FROM is ignored by current browsers")
    return EmbedResult(EmbedStatus.OK, "no framing restriction found")


async def _resolve(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(str(info[4][0]) for info in infos))


async def check_embeddable(url: str, *, embedder_origin: str, allow_private: bool) -> EmbedResult:
    """Check one address. Never raises and never takes longer than the deadline."""
    global _running
    if _running >= _MAX_PARALLEL:
        return EmbedResult(EmbedStatus.UNKNOWN, "too many checks are running; try again in a moment")
    _running += 1
    try:
        return await asyncio.wait_for(
            _check(url, embedder_origin=embedder_origin, allow_private=allow_private), _DEADLINE
        )
    except TimeoutError:
        return EmbedResult(EmbedStatus.UNKNOWN, "address did not answer in time")
    finally:
        _running -= 1


async def _check(url: str, *, embedder_origin: str, allow_private: bool) -> EmbedResult:
    try:
        parts = urlsplit(url)
        explicit_port = parts.port
        hostname = parts.hostname
    except ValueError:
        return EmbedResult(EmbedStatus.UNKNOWN, "not a valid address")
    if parts.scheme not in ("http", "https") or not hostname:
        return EmbedResult(EmbedStatus.UNKNOWN, "only http(s) addresses can be checked")
    if parts.username or parts.password:
        return EmbedResult(EmbedStatus.UNKNOWN, "addresses with credentials are not checked")
    port = explicit_port or (443 if parts.scheme == "https" else 80)
    try:
        # Internationalized names travel in their ASCII form (DNS, TLS and the Host header).
        ascii_host = hostname if ":" in hostname else hostname.encode("idna").decode("ascii")
    except UnicodeError:
        return EmbedResult(EmbedStatus.UNKNOWN, "host name is not valid")
    host_header = f"[{ascii_host}]" if ":" in ascii_host else ascii_host
    if explicit_port is not None:
        host_header = f"{host_header}:{explicit_port}"

    try:
        addresses = await _resolve(ascii_host, port)
    except (OSError, UnicodeError):
        return EmbedResult(EmbedStatus.UNKNOWN, "host name could not be resolved")
    if not addresses:
        return EmbedResult(EmbedStatus.UNKNOWN, "host name could not be resolved")
    if not allow_private and not all(is_public_address(a) for a in addresses):
        return EmbedResult(EmbedStatus.UNKNOWN, "address is in a private network and was not checked")

    async def fetch(address: str, path_and_query: str) -> httpx.Response:
        host_in_url = f"[{address}]" if ":" in address else address
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=False, trust_env=False) as client:
            request = client.build_request(
                "GET",
                f"{parts.scheme}://{host_in_url}:{port}{path_and_query}",
                headers={
                    "Host": host_header,
                    "User-Agent": _USER_AGENT,
                    "Accept": "text/html,*/*;q=0.5",
                },
                extensions={"sni_hostname": ascii_host},
            )
            response = await client.send(request, stream=True)
            await response.aclose()
            return response

    path_and_query = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    response: httpx.Response | None = None
    reached = ""
    failure = "address not reachable"
    # Try the vetted addresses in turn: a host often has an IPv6 address that cannot be reached
    # from inside a container while its IPv4 address works.
    for address in addresses[:4]:
        try:
            response = await fetch(address, path_and_query)
            reached = address
            break
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            failure = f"address not reachable ({type(exc).__name__})"
        except (httpx.HTTPError, httpx.InvalidURL, ValueError) as exc:
            return EmbedResult(EmbedStatus.UNKNOWN, f"address not reachable ({type(exc).__name__})")
    if response is None:
        return EmbedResult(EmbedStatus.UNKNOWN, failure)

    # What decides is the page the browser ends up showing. Many apps answer their base address
    # with a redirect to a sign-in page of their own that forbids framing.
    final_url = url
    hops = 0
    while 300 <= response.status_code < 400:
        if hops == _MAX_REDIRECTS:
            return EmbedResult(EmbedStatus.UNKNOWN, "too many redirects", response.status_code)
        hops += 1
        location = response.headers.get("location", "")
        try:
            target = urlsplit(urljoin(final_url, location))
        except ValueError:
            target = None
        same_host = (
            target is not None
            and bool(location)
            and target.scheme == parts.scheme
            and target.netloc.lower() == parts.netloc.lower()
        )
        if target is None or not same_host:
            shown = (target.netloc if target is not None and target.netloc else location) or "another address"
            return EmbedResult(
                EmbedStatus.UNKNOWN,
                f"redirects to {shown}; check that address instead"[:300],
                response.status_code,
            )
        final_url = target.geturl()
        next_path = (target.path or "/") + (f"?{target.query}" if target.query else "")
        try:
            response = await fetch(reached, next_path)
        except (httpx.HTTPError, httpx.InvalidURL, ValueError) as exc:
            return EmbedResult(EmbedStatus.UNKNOWN, f"address not reachable ({type(exc).__name__})")

    result = evaluate_headers(response.headers, target_url=final_url, embedder_origin=embedder_origin)
    return EmbedResult(result.status, result.detail, response.status_code)
