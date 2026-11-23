"""Publishing apps through the bundled reverse proxy.

An organization's administrator publishes an app: the reverse proxy (Traefik) then serves an
internal address under a public one, by path or by sub-domain of the apps host. Traefik fetches
its routes from Velydock (``traefik_configuration``) and, for publications that are not public,
asks Velydock before it forwards a request (``authorize``).

Three things keep this from becoming a hole in the wall:

* Routes are *built* here from checked parts (a name, a mode), never taken as text. A route is
  what decides which host gets which traffic; free text there could claim Velydock's own host.
* Where the proxy may send requests is decided by system administrators per organization
  (``ProxyTarget``). An organization picks within that; names that resolve later are only
  accepted when a system administrator listed that very name.
* Nothing is forwarded to the addresses of this installation itself, whoever allowed what.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import posixpath
import re
import secrets
import socket
import time
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlsplit

from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.api.deps import Principal
from velydock.config import Settings
from velydock.db import system_scope
from velydock.errors import ApiError, conflict, invalid, not_found
from velydock.models import (
    App,
    AppGroupGrant,
    AppPublication,
    AppType,
    AppUserGrant,
    AuthSession,
    GroupMember,
    Membership,
    ProxyTarget,
    ProxyTemplate,
    PublicationAccess,
    PublicationMode,
    Tenant,
    User,
)
from velydock.schemas import (
    ProxyInfo,
    ProxyTargetIn,
    ProxyTargetOut,
    ProxyTemplateIn,
    ProxyTemplateOut,
    ProxyTemplateUpdate,
    PublicationIn,
    PublicationOut,
)
from velydock.security import sessions
from velydock.security.tokens import TokenError, sign, verify
from velydock.services import audit

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------------------------
# Names and addresses
# ---------------------------------------------------------------------------------------------

_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")
# Not available as the name of a publication: what a browser or a proxy treats specially, and
# what a visitor would take for a part of the installation itself.
RESERVED_NAMES = frozenset(
    {
        "admin", "api", "apps", "assets", "auth", "dock", "favicon", "health", "internal", "login",
        "logout", "realms", "resources", "robots", "sandbox", "static", "status", "velydock", "www",
    }
)  # fmt: skip
# Below every publication, kept for Velydock's own sign-in round trip.
CALLBACK = "/__velydock/callback"

IDENTITY_HEADERS = ("X-Velydock-User", "X-Velydock-Email", "X-Velydock-Name")

BUILTIN = "builtin:"


def check_name(name: str) -> str:
    if not _NAME.fullmatch(name) or name in RESERVED_NAMES or name.startswith("xn--"):
        raise invalid(
            "The address name must consist of lower-case letters, digits and hyphens (2 to 40 characters) "
            "and must not be a reserved word.",
            "publication_name_invalid",
        )
    return name


def public_url(settings: Settings, mode: str, name: str) -> str:
    assert settings.apps_url is not None
    parts = urlsplit(settings.apps_url)
    if mode == PublicationMode.SUBDOMAIN.value:
        return f"{parts.scheme}://{name}.{parts.netloc}/"
    return f"{settings.apps_url}/{name}/"


def _prefix(publication: AppPublication) -> str:
    """The part of every path of a publication that names it ("" for a sub-domain)."""
    return f"/{publication.name}" if publication.mode == PublicationMode.PATH.value else ""


# ---------------------------------------------------------------------------------------------
# Where the proxy may send requests
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Rule:
    network: ipaddress.IPv4Network | ipaddress.IPv6Network | None
    host: str | None
    port: int | None


_HOST = re.compile(
    r"^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$"
)


def _split_port(value: str) -> tuple[str, int | None]:
    """ "10.0.0.7:8080" -> ("10.0.0.7", 8080); "[fd00::7]:8080" -> ("fd00::7", 8080); "fd00::/64" as it is."""
    if value.startswith("["):
        host, closed, rest = value[1:].partition("]")
        if not closed or (rest and not rest.startswith(":")):
            raise ValueError("malformed")
        return host, (int(rest[1:]) if rest else None)
    if value.count(":") == 1:
        host, _, port = value.partition(":")
        return host, int(port)
    return value, None


def parse_rule(value: str) -> _Rule:
    """What a system administrator released: a network, an address or a host name, optionally a port."""
    bad = invalid(
        "Enter a network (10.20.0.0/16), an address (10.20.0.7) or a host name (nas.intern), "
        "optionally with a port (10.20.0.7:8080).",
        "proxy_target_invalid",
    )
    text = value.strip().lower().rstrip(".")
    try:
        host, port = _split_port(text)
        if port is not None and not 0 < port < 65536:
            raise bad
    except ValueError:
        raise bad from None
    try:
        return _Rule(ipaddress.ip_network(host, strict=False), None, port)
    except ValueError:
        pass
    if not _HOST.fullmatch(host) or host.replace(".", "").isdigit():
        raise bad
    return _Rule(None, host, port)


def normalise_rule(value: str) -> str:
    rule = parse_rule(value)
    if rule.network is not None:
        base = str(rule.network if rule.network.num_addresses > 1 else rule.network.network_address)
        if rule.port is None:
            return base
        return f"[{base}]:{rule.port}" if ":" in base else f"{base}:{rule.port}"
    return rule.host if rule.port is None else f"{rule.host}:{rule.port}"  # type: ignore[return-value]


def _own_names(settings: Settings) -> set[str]:
    """Host names of this installation's own services: never a target, whoever released what."""
    names = {"localhost", "velydock", "keycloak", "postgres", "traefik", "host.docker.internal"}
    for url in (settings.backchannel_base_url, settings.keycloak_internal_url, settings.database_url):
        host = urlsplit(url.replace("postgresql+asyncpg://", "postgresql://")).hostname
        if host:
            names.add(host.lower())
    return names


async def _own_addresses(settings: Settings) -> set[str]:
    """What those names resolve to right now, so that their addresses are no way in either."""
    loop = asyncio.get_running_loop()
    found: set[str] = set()
    for name in _own_names(settings):
        try:
            for info in await loop.getaddrinfo(name, None, type=socket.SOCK_STREAM):
                found.add(str(ipaddress.ip_address(info[4][0])))
        except (OSError, ValueError):
            continue
    return found


def _refused(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return (
        address.is_loopback
        or address.is_link_local  # includes the metadata address of cloud providers
        or address.is_multicast
        or address.is_unspecified
        or address.is_reserved
    )


async def check_target(settings: Settings, url: str, allowed: list[str]) -> str:
    """Validate the address an app is published from against what was released; returns it normalised."""
    bad = invalid(
        "The internal address must look like http://10.20.0.7:8080 or https://nas.intern.",
        "proxy_target_invalid",
    )
    not_released = ApiError(
        422,
        "proxy_target_not_allowed",
        "This internal address has not been released for your organization. Ask the system administrator.",
    )
    try:
        parts = urlsplit(url.strip())
        host = (parts.hostname or "").lower().rstrip(".")
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError:
        raise bad from None
    if parts.scheme not in ("http", "https") or not host or parts.username or parts.password:
        raise bad
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        # The proxy sends a request's own path there; an address with one would mislead.
        raise invalid(
            "The internal address must not contain a path. A path prefix belongs into the proxy options.",
            "proxy_target_invalid",
        )
    rules = [parse_rule(value) for value in allowed]
    try:
        address: ipaddress.IPv4Address | ipaddress.IPv6Address | None = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None:
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
            address = address.ipv4_mapped
        if _refused(address) or str(address) in await _own_addresses(settings):
            raise not_released
        if not any(
            rule.network is not None and address in rule.network and rule.port in (None, port)
            for rule in rules
        ):
            raise not_released
        netloc = f"[{address}]" if address.version == 6 else str(address)
    else:
        if not _HOST.fullmatch(host):
            raise bad
        # A name is only as good as what it resolves to at the moment of each request. It is
        # accepted only when a system administrator released exactly this name.
        if host in _own_names(settings) or host.endswith(".localhost"):
            raise not_released
        if not any(rule.host == host and rule.port in (None, port) for rule in rules):
            raise not_released
        netloc = host
    if parts.port is not None:
        netloc = f"{netloc}:{parts.port}"
    return f"{parts.scheme}://{netloc}"


# ---------------------------------------------------------------------------------------------
# Options and templates
# ---------------------------------------------------------------------------------------------

# What a publication does unless its template or the publication itself says otherwise.
DEFAULTS: dict[str, Any] = {
    "strip_prefix": True,
    "pass_host_header": True,
    "verify_upstream_tls": True,
    "allow_embedding": False,
    "identity_headers": False,
    "rate_limit": None,
    "request_headers": {},
    "response_headers": {},
    "custom_middlewares": {},
}

BUILTIN_TEMPLATES: dict[str, dict[str, Any]] = {
    "standard": {"name": "Standard", "description": "Forwards requests as they are.", "options": {}},
    "embeddable": {
        "name": "Embeddable in Velydock",
        "description": "Removes the app's X-Frame-Options header so that it can be shown inside Velydock.",
        "options": {"allow_embedding": True},
    },
    "subpath-aware": {
        "name": "App knows its sub-path",
        "description": "For apps configured to run below a path: the path prefix is passed on.",
        "options": {"strip_prefix": False},
    },
    "self-signed": {
        "name": "Internal device with a self-signed certificate",
        "description": "Does not verify the certificate of the internal address.",
        "options": {"verify_upstream_tls": False},
    },
    "header-login": {
        "name": "Sign-in by header",
        "description": (
            "Tells the app who is signed in (X-Velydock-User, -Email, -Name). Protected apps only."
        ),
        "options": {"identity_headers": True},
    },
}

_HEADER_NAME = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$")
# Headers that describe the connection or that the proxy and Velydock set themselves.
_FIXED_HEADERS = frozenset(
    {
        "connection", "content-length", "host", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "x-real-ip",
    }
)  # fmt: skip
# Middlewares a system administrator may add to a template in Traefik's own words. Left out on
# purpose: forwardAuth (it would replace or bypass the sign-in check and makes the proxy call any
# address), errors and chain (they refer to other services and middlewares), plugins.
CUSTOM_MIDDLEWARES = frozenset(
    {
        "addPrefix", "basicAuth", "buffering", "compress", "contentType", "digestAuth", "headers",
        "inFlightReq", "ipAllowList", "rateLimit", "redirectRegex", "redirectScheme", "replacePath",
        "replacePathRegex", "retry", "stripPrefix", "stripPrefixRegex",
    }
)  # fmt: skip


def _check_headers(value: Any, what: str) -> dict[str, str]:
    bad = invalid(f"The {what} headers are not valid.", "proxy_options_invalid")
    if not isinstance(value, dict) or len(value) > 20:
        raise bad
    checked: dict[str, str] = {}
    for name, content in value.items():
        if not isinstance(name, str) or not isinstance(content, str) or not _HEADER_NAME.fullmatch(name):
            raise bad
        lowered = name.lower()
        if lowered in _FIXED_HEADERS or lowered.startswith(("x-forwarded-", "x-velydock-")):
            raise invalid(
                f"The header {name} is set by the proxy and cannot be changed.", "proxy_options_invalid"
            )
        if len(content) > 1000 or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in content):
            raise bad
        checked[name] = content
    return checked


def check_options(options: dict[str, Any], *, by_system_admin: bool) -> dict[str, Any]:
    """Validate what a template or a publication sets. Unknown keys are refused."""
    bad = invalid("The proxy options are not valid.", "proxy_options_invalid")
    checked: dict[str, Any] = {}
    for key, value in options.items():
        if key in (
            "strip_prefix",
            "pass_host_header",
            "verify_upstream_tls",
            "allow_embedding",
            "identity_headers",
        ):
            if not isinstance(value, bool):
                raise bad
            checked[key] = value
        elif key == "rate_limit":
            if value is None:
                checked[key] = None
                continue
            if not isinstance(value, dict) or set(value) != {"average", "burst"}:
                raise bad
            average, burst = value["average"], value["burst"]
            if not (isinstance(average, int) and isinstance(burst, int) and 1 <= average <= 10_000):
                raise bad
            if not average <= burst <= 100_000:
                raise bad
            checked[key] = {"average": average, "burst": burst}
        elif key == "request_headers":
            checked[key] = _check_headers(value, "request")
        elif key == "response_headers":
            checked[key] = _check_headers(value, "response")
        elif key == "custom_middlewares":
            if not by_system_admin:
                raise ApiError(403, "forbidden", "Only system administrators may add proxy middlewares.")
            checked[key] = _check_custom(value)
        else:
            raise bad
    return checked


def _check_custom(value: Any) -> dict[str, Any]:
    bad = invalid(
        "Custom middlewares must be an object of name -> one Traefik middleware, for example "
        '{"limit": {"ipAllowList": {"sourceRange": ["10.0.0.0/8"]}}}. Allowed: '
        + ", ".join(sorted(CUSTOM_MIDDLEWARES))
        + ".",
        "proxy_options_invalid",
    )
    if not isinstance(value, dict) or len(value) > 10 or len(json.dumps(value)) > 8000:
        raise bad
    for name, definition in value.items():
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,30}", name):
            raise bad
        if not isinstance(definition, dict) or len(definition) != 1:
            raise bad
        ((kind, body),) = definition.items()
        if kind not in CUSTOM_MIDDLEWARES or not isinstance(body, dict):
            raise bad
    return value


async def templates(db: AsyncSession) -> dict[str, dict[str, Any]]:
    """Every template by its id: the built-in ones and those system administrators made."""
    found = {f"{BUILTIN}{key}": {**template, "builtin": True} for key, template in BUILTIN_TEMPLATES.items()}
    for row in (await db.execute(select(ProxyTemplate).order_by(ProxyTemplate.name))).scalars():
        found[str(row.id)] = {
            "name": row.name,
            "description": row.description,
            "options": dict(row.options or {}),
            "builtin": False,
        }
    return found


def effective_options(template: dict[str, Any] | None, own: dict[str, Any]) -> dict[str, Any]:
    """Defaults, then the template, then what the publication itself sets."""
    merged = {**DEFAULTS, **(template or {}).get("options", {})}
    merged.update({key: value for key, value in own.items() if key != "custom_middlewares"})
    return merged


# ---------------------------------------------------------------------------------------------
# Traefik's dynamic configuration
# ---------------------------------------------------------------------------------------------


def _router_rule(settings: Settings, publication: AppPublication) -> str:
    # Built from a checked name and the configured host: nothing in here is free text.
    apps_host = urlsplit(settings.apps_url or "").hostname or ""
    name = check_name(publication.name)
    if publication.mode == PublicationMode.SUBDOMAIN.value:
        return f"Host(`{name}.{apps_host}`)"
    return f"Host(`{apps_host}`) && (Path(`/{name}`) || PathPrefix(`/{name}/`))"


def _build(settings: Settings, publication: AppPublication, options: dict[str, Any]) -> dict[str, Any]:
    key = f"vd-{publication.app_id.hex}"
    middlewares: dict[str, Any] = {}
    chain: list[str] = []

    def add(suffix: str, definition: dict[str, Any]) -> None:
        middlewares[f"{key}-{suffix}"] = definition
        chain.append(f"{key}-{suffix}")

    path_mode = publication.mode == PublicationMode.PATH.value
    if path_mode:
        # "/name" without the slash is the same place for a person; relative links need the slash.
        add(
            "slash",
            {"redirectRegex": {"regex": f"^(https?://[^/]+/{publication.name})$", "replacement": "${1}/"}},
        )

    request_headers = dict(options["request_headers"])
    if publication.access == PublicationAccess.PROTECTED.value:
        add(
            "auth",
            {
                "forwardAuth": {
                    "address": f"http://{settings.internal_host}/internal/proxy/auth/{publication.app_id}",
                    # Only what the check needs reaches Velydock - not the app's own cookies' worth
                    # of headers, and nothing a client could use to speak for the proxy.
                    "authRequestHeaders": ["Cookie", "Accept", "Sec-Fetch-Mode"],
                    # Always all of them: what Velydock does not set, the proxy removes, so a
                    # client cannot bring its own.
                    "authResponseHeaders": list(IDENTITY_HEADERS),
                    "trustForwardHeader": False,
                }
            },
        )
    else:
        # Nobody is signed in here; whatever a client claims in these headers is removed.
        request_headers.update(dict.fromkeys(IDENTITY_HEADERS, ""))
    if options["rate_limit"]:
        add("rate", {"rateLimit": {**options["rate_limit"], "period": "1s"}})
    response_headers = dict(options["response_headers"])
    if options["allow_embedding"]:
        response_headers["X-Frame-Options"] = ""
    if request_headers or response_headers:
        headers: dict[str, Any] = {}
        if request_headers:
            headers["customRequestHeaders"] = request_headers
        if response_headers:
            headers["customResponseHeaders"] = response_headers
        add("headers", {"headers": headers})
    if path_mode and options["strip_prefix"]:
        add("strip", {"stripPrefix": {"prefixes": [f"/{publication.name}"]}})
    for name, definition in options["custom_middlewares"].items():
        add(f"c-{name}", definition)

    service: dict[str, Any] = {
        "loadBalancer": {
            "servers": [{"url": publication.target_url}],
            "passHostHeader": bool(options["pass_host_header"]),
        }
    }
    transports: dict[str, Any] = {}
    if publication.target_url.startswith("https://") and not options["verify_upstream_tls"]:
        transports[key] = {"insecureSkipVerify": True}
        service["loadBalancer"]["serversTransport"] = key
    router: dict[str, Any] = {
        "rule": _router_rule(settings, publication),
        "entryPoints": [settings.proxy_entry_point],
        "service": key,
        "tls": {"certResolver": settings.proxy_tls_resolver} if settings.proxy_tls_resolver else {},
    }
    if chain:
        router["middlewares"] = chain
    return {
        "router": router,
        "service": service,
        "middlewares": middlewares,
        "transports": transports,
        "key": key,
    }


def still_released(settings: Settings, url: str, allowed: list[str]) -> bool:
    """Is the address a publication points to (still) among what was released?

    Asked every time the routes are built: a release that is withdrawn takes its publications
    off the proxy at once, without anybody having to find and remove them.
    """
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        port = parts.port or (443 if parts.scheme == "https" else 80)
        rules = [parse_rule(value) for value in allowed]
    except (ValueError, ApiError):
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return host not in _own_names(settings) and any(
            rule.host == host and rule.port in (None, port) for rule in rules
        )
    if _refused(address):
        return False
    return any(
        rule.network is not None and address in rule.network and rule.port in (None, port) for rule in rules
    )


def problem_of(
    settings: Settings, publication: AppPublication, allowed: list[str], known: dict[str, dict[str, Any]]
) -> str | None:
    """Why the proxy does not serve a publication, or None if it does."""
    if publication.template not in known:
        # Not "then without a template": the template may be what restricted who gets in.
        return "template_missing"
    if not still_released(settings, publication.target_url, allowed):
        return "target_not_allowed"
    return None


async def traefik_configuration(db: AsyncSession, settings: Settings) -> dict[str, Any]:
    """The routes of everything that is published right now, in Traefik's dynamic configuration format."""
    if not settings.apps_url:
        return {}
    rows = (
        await db.execute(
            select(AppPublication)
            .join(App, App.id == AppPublication.app_id)
            .join(Tenant, Tenant.id == AppPublication.tenant_id)
            .where(
                App.enabled.is_(True),
                Tenant.active.is_(True),
                App.type.in_([AppType.EMBEDDED.value, AppType.EXTERNAL.value]),
            )
            .order_by(AppPublication.name)
        )
    ).scalars()
    known = await templates(db)
    released: dict[uuid.UUID, list[str]] = {}
    for tenant_id, value in (await db.execute(select(ProxyTarget.tenant_id, ProxyTarget.value))).all():
        released.setdefault(tenant_id, []).append(value)
    routers: dict[str, Any] = {}
    services: dict[str, Any] = {}
    middlewares: dict[str, Any] = {}
    transports: dict[str, Any] = {}
    for publication in rows:
        if problem_of(settings, publication, released.get(publication.tenant_id, []), known) is not None:
            continue
        try:
            built = _build(
                settings,
                publication,
                effective_options(known.get(publication.template), dict(publication.options or {})),
            )
        except Exception:
            # One publication that cannot be built must not take the others down with it.
            log.exception("publication %s left out of the proxy configuration", publication.name)
            continue
        routers[built["key"]] = built["router"]
        services[built["key"]] = built["service"]
        middlewares.update(built["middlewares"])
        transports.update(built["transports"])
    if not routers:
        return {}
    http: dict[str, Any] = {"routers": routers, "services": services}
    if middlewares:
        http["middlewares"] = middlewares
    if transports:
        http["serversTransports"] = transports
    return {"http": http}


# ---------------------------------------------------------------------------------------------
# Sign-in before forwarding
# ---------------------------------------------------------------------------------------------

_TICKET = "proxy-ticket"
_SESSION = "proxy-session"
_TICKET_SECONDS = 60
_SESSION_SECONDS = 12 * 3600
_DECISION_SECONDS = 30.0

# Tickets that were used already (one sign-in, one ticket), until they would have expired anyway.
_used_tickets: dict[str, float] = {}
# Recent answers of ``_may_use``: every request of a published app asks, and most ask the same.
_decisions: dict[tuple[str, uuid.UUID], tuple[float, tuple[str, str, str] | None]] = {}


def forget_decisions() -> None:
    """After a change that affects who may use what (tests; a grant, a lock): ask again."""
    _decisions.clear()


def cookie_name(settings: Settings, publication: AppPublication) -> str:
    secure = (settings.apps_url or "").startswith("https://")
    if publication.mode == PublicationMode.SUBDOMAIN.value:
        return "__Host-velydock-app" if secure else "velydock-app"
    # Path mode: several apps under one host, each with a cookie of its own path and name.
    return f"{'__Secure-' if secure else ''}velydock-app-{publication.name}"


def _set_cookie(settings: Settings, publication: AppPublication, value: str, max_age: int) -> str:
    secure = "; Secure" if (settings.apps_url or "").startswith("https://") else ""
    path = f"{_prefix(publication)}/"
    name = cookie_name(settings, publication)
    return f"{name}={value}; Path={path}; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}"


async def _may_use(
    db: AsyncSession, settings: Settings, publication: AppPublication, session_hash: str
) -> tuple[str, str, str] | None:
    """Is this session alive, and may its user use the published app? Returns who it is, or None."""
    cached = _decisions.get((session_hash, publication.app_id))
    if cached is not None and cached[0] > time.monotonic():
        return cached[1]
    answer: tuple[str, str, str] | None = None
    session = await sessions.session_by_hash(db, settings, session_hash)
    if session is not None:
        user = await db.get(User, session.user_id)
        if user is not None and user.active and await granted(db, publication, user):
            answer = (user.username, user.email or "", f"{user.first_name} {user.last_name}".strip())
    if len(_decisions) > 20_000:
        _decisions.clear()
    _decisions[(session_hash, publication.app_id)] = (time.monotonic() + _DECISION_SECONDS, answer)
    return answer


async def granted(db: AsyncSession, publication: AppPublication, user: User) -> bool:
    """The same rule as in the workspace: enabled app, active organization, member with a grant."""
    app = await db.get(App, publication.app_id)
    tenant = await db.get(Tenant, publication.tenant_id)
    if app is None or tenant is None or not app.enabled or not tenant.active:
        return False
    member = (
        await db.execute(
            select(Membership.role).where(Membership.tenant_id == tenant.id, Membership.user_id == user.id)
        )
    ).scalar_one_or_none()
    if member is None:
        # System administrators see every app of an organization they enter.
        return bool(user.is_system_admin)
    if app.visible_to_all:
        return True
    by_group = (
        select(AppGroupGrant.app_id)
        .join(GroupMember, GroupMember.group_id == AppGroupGrant.group_id)
        .where(
            AppGroupGrant.app_id == app.id, GroupMember.user_id == user.id, GroupMember.tenant_id == tenant.id
        )
    )
    by_user = select(AppUserGrant.app_id).where(
        AppUserGrant.app_id == app.id, AppUserGrant.user_id == user.id
    )
    found = await db.execute(
        select(App.id).where(App.id == app.id, or_(App.id.in_(by_group), App.id.in_(by_user)))
    )
    return found.first() is not None


def safe_destination(publication: AppPublication, wanted: str | None) -> str:
    """Where to send somebody after the sign-in: a path of this publication, nothing else."""
    base = f"{_prefix(publication)}/"
    if not wanted or not wanted.startswith(base) or wanted.startswith("//") or "\\" in wanted:
        return base
    if any(ord(ch) < 0x20 for ch in wanted) or wanted.startswith(f"{_prefix(publication)}{CALLBACK}"):
        return base
    # "/wiki/../other/" starts with the right words and ends up at another app: a browser
    # resolves the dots before it asks. Compare what it would ask for.
    path = wanted.split("?", 1)[0].split("#", 1)[0]
    if not (posixpath.normpath(path) + "/").startswith(base):
        return base
    return wanted[:2000]


def ticket_for(
    settings: Settings, publication: AppPublication, session: AuthSession, destination: str
) -> str:
    """After Velydock recognised the user: the address that carries this over to the app's host."""
    ticket = sign(
        settings.secret_key,
        _TICKET,
        {
            "pub": str(publication.app_id),
            "sid": session.id_hash,
            "rd": safe_destination(publication, destination),
            "jti": secrets.token_urlsafe(12),
        },
        _TICKET_SECONDS,
    )
    base = public_url(settings, publication.mode, publication.name).rstrip("/")
    return f"{base}{CALLBACK}?t={quote(ticket, safe='')}"


@dataclass
class Answer:
    status: int
    headers: dict[str, str]
    body: str = ""


def _origin_of(settings: Settings, publication: AppPublication) -> str:
    parts = urlsplit(public_url(settings, publication.mode, publication.name))
    return f"{parts.scheme}://{parts.netloc}"


async def authorize(
    db: AsyncSession,
    settings: Settings,
    publication: AppPublication,
    *,
    uri: str,
    cookies: dict[str, str],
    navigation: bool,
) -> Answer:
    """What the proxy asks before every request to a protected publication.

    200 lets the request through (with who is signed in, for apps that are told). Anything else
    is sent to the client as it is: the way to Velydock's sign-in, or a refusal.
    """
    path, _, query = uri.partition("?")
    origin = _origin_of(settings, publication)

    if path == f"{_prefix(publication)}{CALLBACK}":
        token = next((part[2:] for part in query.split("&") if part.startswith("t=")), "")
        try:
            from urllib.parse import unquote

            ticket = verify(settings.secret_key, _TICKET, unquote(token))
        except TokenError:
            return Answer(
                403, {"Content-Type": "text/plain; charset=utf-8"}, "This sign-in link is not valid any more."
            )
        now = time.time()
        for jti in [key for key, until in _used_tickets.items() if until < now]:
            del _used_tickets[jti]
        if ticket.get("pub") != str(publication.app_id) or ticket.get("jti") in _used_tickets:
            return Answer(
                403, {"Content-Type": "text/plain; charset=utf-8"}, "This sign-in link is not valid any more."
            )
        _used_tickets[str(ticket.get("jti"))] = now + _TICKET_SECONDS + 5
        session_hash = str(ticket.get("sid", ""))
        if await _may_use(db, settings, publication, session_hash) is None:
            return Answer(
                403, {"Content-Type": "text/plain; charset=utf-8"}, "You are not allowed to use this app."
            )
        value = sign(
            settings.secret_key,
            _SESSION,
            {"pub": str(publication.app_id), "sid": session_hash},
            _SESSION_SECONDS,
        )
        return Answer(
            302,
            {
                "Location": origin + safe_destination(publication, str(ticket.get("rd", ""))),
                "Set-Cookie": _set_cookie(settings, publication, value, _SESSION_SECONDS),
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
            },
        )

    value = cookies.get(cookie_name(settings, publication), "")
    if value:
        try:
            claims = verify(settings.secret_key, _SESSION, value)
        except TokenError:
            claims = {}
        if claims.get("pub") == str(publication.app_id):
            who = await _may_use(db, settings, publication, str(claims.get("sid", "")))
            if who is not None:
                await sessions.touch_by_hash(db, str(claims.get("sid", "")))
                options = effective_options(
                    (await templates(db)).get(publication.template), dict(publication.options or {})
                )
                headers = dict(zip(IDENTITY_HEADERS, who, strict=True)) if options["identity_headers"] else {}
                return Answer(200, headers)

    if not navigation:
        # A request of the app's own scripts: no page to send anywhere. The app sees 401.
        return Answer(401, {"Cache-Control": "no-store"})
    destination = quote(safe_destination(publication, uri), safe="")
    return Answer(
        302,
        {
            "Location": f"{settings.public_url}/proxy/login?p={publication.app_id}&rd={destination}",
            "Cache-Control": "no-store",
        },
    )


# ---------------------------------------------------------------------------------------------
# Publications of an organization's apps
# ---------------------------------------------------------------------------------------------


async def allowed_targets(db: AsyncSession, tenant_id: uuid.UUID) -> list[str]:
    return list(
        (
            await db.execute(
                select(ProxyTarget.value)
                .where(ProxyTarget.tenant_id == tenant_id)
                .order_by(ProxyTarget.value)
            )
        ).scalars()
    )


def require_enabled(settings: Settings) -> None:
    if not settings.apps_url:
        raise conflict(
            "proxy_disabled",
            "Publishing through the proxy is not set up on this installation (VELYDOCK_APPS_URL).",
        )


async def publish(
    db: AsyncSession,
    settings: Settings,
    app: App,
    data: PublicationIn,
    *,
    by_system_admin: bool,
) -> AppPublication:
    """Create or change the publication of an app. The app's address becomes the public one."""
    require_enabled(settings)
    if app.type not in (AppType.EMBEDDED.value, AppType.EXTERNAL.value):
        raise invalid("Only embedded apps and apps in a new tab can be published.", "publication_type")
    name = check_name(data.name)
    target = await check_target(settings, data.target_url, await allowed_targets(db, app.tenant_id))
    known = await templates(db)
    if data.template not in known:
        raise invalid("This proxy template does not exist.", "proxy_template_unknown")
    options = check_options(data.options, by_system_admin=by_system_admin)
    if data.access == PublicationAccess.PUBLIC and options.get("identity_headers"):
        raise invalid(
            "A public app has nobody signed in whom the headers could name.", "proxy_options_invalid"
        )
    # The name is an address, and addresses are shared by all organizations.
    async with system_scope(db):
        taken = (
            await db.execute(
                select(AppPublication.app_id).where(
                    AppPublication.name == name, AppPublication.app_id != app.id
                )
            )
        ).first()
    if taken is not None:
        raise conflict("publication_name_taken", "This address name is already in use.")
    publication = await db.get(AppPublication, app.id)
    if publication is None:
        publication = AppPublication(app_id=app.id, tenant_id=app.tenant_id)
        db.add(publication)
    publication.name = name
    publication.mode = data.mode.value
    publication.target_url = target
    publication.access = data.access.value
    publication.template = data.template
    publication.options = options
    try:
        async with db.begin_nested():
            await db.flush()
    except IntegrityError:
        raise conflict("publication_name_taken", "This address name is already in use.") from None
    app.url = public_url(settings, publication.mode, publication.name)
    forget_decisions()
    return publication


async def unpublish(db: AsyncSession, app: App) -> bool:
    publication = await db.get(AppPublication, app.id)
    if publication is None:
        return False
    await db.delete(publication)
    await db.flush()
    forget_decisions()
    return True


def out(settings: Settings, publication: AppPublication, problem: str | None) -> PublicationOut:
    return PublicationOut(
        name=publication.name,
        mode=PublicationMode(publication.mode),
        target_url=publication.target_url,
        access=PublicationAccess(publication.access),
        template=publication.template,
        options=dict(publication.options or {}),
        public_url=public_url(settings, publication.mode, publication.name) if settings.apps_url else "",
        problem=problem if settings.apps_url else "proxy_disabled",
    )


async def publications_of(
    db: AsyncSession, settings: Settings, tenant_id: uuid.UUID, app_ids: list[uuid.UUID]
) -> dict[uuid.UUID, PublicationOut]:
    if not app_ids:
        return {}
    rows = list(
        (
            await db.execute(
                select(AppPublication).where(
                    AppPublication.tenant_id == tenant_id, AppPublication.app_id.in_(app_ids)
                )
            )
        ).scalars()
    )
    if not rows:
        return {}
    allowed = await allowed_targets(db, tenant_id)
    known = await templates(db)
    return {row.app_id: out(settings, row, problem_of(settings, row, allowed, known)) for row in rows}


async def info(db: AsyncSession, settings: Settings, tenant_id: uuid.UUID) -> ProxyInfo:
    if not settings.apps_url:
        return ProxyInfo(enabled=False)
    parts = urlsplit(settings.apps_url)
    return ProxyInfo(
        enabled=True,
        path_base=f"{settings.apps_url}/",
        subdomain_suffix=f".{parts.netloc}",
        subdomain_scheme=parts.scheme,
        targets=await allowed_targets(db, tenant_id),
        templates=[ProxyTemplateOut(id=key, **template) for key, template in (await templates(db)).items()],
        defaults={key: value for key, value in DEFAULTS.items() if key != "custom_middlewares"},
    )


# ---------------------------------------------------------------------------------------------
# System administration: what organizations may reach, and templates
# ---------------------------------------------------------------------------------------------


async def list_targets(db: AsyncSession, tenant_id: uuid.UUID) -> list[ProxyTargetOut]:
    async with system_scope(db):
        if await db.get(Tenant, tenant_id) is None:
            raise not_found("Organization")
        rows = (
            await db.execute(
                select(ProxyTarget).where(ProxyTarget.tenant_id == tenant_id).order_by(ProxyTarget.value)
            )
        ).scalars()
        return [ProxyTargetOut(id=row.id, value=row.value, note=row.note) for row in rows]


async def add_target(
    db: AsyncSession, settings: Settings, principal: Principal, tenant_id: uuid.UUID, data: ProxyTargetIn
) -> ProxyTargetOut:
    value = normalise_rule(data.value)
    rule = parse_rule(value)
    if rule.host is not None and (rule.host in _own_names(settings) or rule.host.endswith(".localhost")):
        raise invalid(
            "This name belongs to the installation itself and cannot be released.", "proxy_target_invalid"
        )
    async with system_scope(db):
        tenant = await db.get(Tenant, tenant_id)
        if tenant is None:
            raise not_found("Organization")
        row = ProxyTarget(tenant_id=tenant_id, value=value, note=data.note)
        db.add(row)
        try:
            async with db.begin_nested():
                await db.flush()
        except IntegrityError:
            raise conflict(
                "proxy_target_exists", "This address is released for the organization already."
            ) from None
        await audit.record(
            db,
            principal,
            "proxy.target.add",
            target_type="tenant",
            target_id=tenant.id,
            target_label=tenant.name,
            details={"value": value},
            tenant_id=None,
        )
        return ProxyTargetOut(id=row.id, value=row.value, note=row.note)


async def remove_target(
    db: AsyncSession, principal: Principal, tenant_id: uuid.UUID, target_id: uuid.UUID
) -> None:
    async with system_scope(db):
        row = await db.get(ProxyTarget, target_id)
        tenant = await db.get(Tenant, tenant_id)
        if row is None or tenant is None or row.tenant_id != tenant_id:
            raise not_found("Released address")
        value = row.value
        await db.delete(row)
        await db.flush()
        await audit.record(
            db,
            principal,
            "proxy.target.remove",
            target_type="tenant",
            target_id=tenant.id,
            target_label=tenant.name,
            details={"value": value},
            tenant_id=None,
        )


async def list_templates(db: AsyncSession) -> list[ProxyTemplateOut]:
    return [ProxyTemplateOut(id=key, **template) for key, template in (await templates(db)).items()]


async def create_template(db: AsyncSession, principal: Principal, data: ProxyTemplateIn) -> ProxyTemplateOut:
    options = check_options(data.options, by_system_admin=True)
    async with system_scope(db):
        row = ProxyTemplate(name=data.name, description=data.description, options=options)
        db.add(row)
        try:
            async with db.begin_nested():
                await db.flush()
        except IntegrityError:
            raise conflict("name_taken", "A template with this name exists already.") from None
        await audit.record(
            db, principal, "proxy.template.create", target_type="proxy_template", target_id=row.id,
            target_label=row.name, tenant_id=None,
        )  # fmt: skip
        return ProxyTemplateOut(
            id=str(row.id), name=row.name, description=row.description, options=options, builtin=False
        )


async def update_template(
    db: AsyncSession, principal: Principal, template_id: uuid.UUID, data: ProxyTemplateUpdate
) -> ProxyTemplateOut:
    async with system_scope(db):
        row = await db.get(ProxyTemplate, template_id)
        if row is None:
            raise not_found("Template")
        if data.name is not None:
            row.name = data.name
        if data.description is not None:
            row.description = data.description
        if data.options is not None:
            # Takes effect for every publication that uses the template, at the proxy's next look.
            row.options = check_options(data.options, by_system_admin=True)
        try:
            async with db.begin_nested():
                await db.flush()
        except IntegrityError:
            raise conflict("name_taken", "A template with this name exists already.") from None
        await audit.record(
            db, principal, "proxy.template.update", target_type="proxy_template", target_id=row.id,
            target_label=row.name, details={"fields": sorted(data.model_fields_set)}, tenant_id=None,
        )  # fmt: skip
        forget_decisions()
        return ProxyTemplateOut(
            id=str(row.id),
            name=row.name,
            description=row.description,
            options=dict(row.options or {}),
            builtin=False,
        )


async def delete_template(db: AsyncSession, principal: Principal, template_id: uuid.UUID) -> None:
    async with system_scope(db):
        row = await db.get(ProxyTemplate, template_id)
        if row is None:
            raise not_found("Template")
        used = (
            (
                await db.execute(
                    select(AppPublication.name).where(AppPublication.template == str(template_id)).limit(5)
                )
            )
            .scalars()
            .all()
        )
        if used:
            # A template may be what restricts a publication (an address list, a rate limit).
            # Taking it away would leave those publications without it.
            raise conflict(
                "template_in_use",
                "This template is still used by published apps: " + ", ".join(used) + ".",
            )
        name = row.name
        await db.delete(row)
        await db.flush()
        await audit.record(
            db, principal, "proxy.template.delete", target_type="proxy_template", target_id=template_id,
            target_label=name, tenant_id=None,
        )  # fmt: skip
