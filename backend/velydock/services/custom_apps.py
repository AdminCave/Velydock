"""Custom apps: author-written HTML/CSS/JS, rendered into one document and locked down.

The document is only ever served from the sandbox host, with a ``sandbox`` Content Security
Policy and inside a sandboxed frame without ``allow-same-origin``. The browser therefore runs it
in an opaque origin: no cookies, no storage, no credentialed requests to Velydock, no access to
the embedding page.
"""

from __future__ import annotations

import html
import re

from velydock.models import App

# What the frame may do. Deliberately absent: allow-same-origin (would give the code a real
# origin) and allow-top-navigation (would let it replace the Velydock page, e.g. for phishing).
SANDBOX_FLAGS = "allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"
# A network-off app loses popups on top of that: without a network grant it has no legitimate
# reason to open a new window, and a single click must not be able to open an attacker's address
# with data in it. Such an app is also delivered inside a wrapper (see ``wrapper_document``) whose
# ``frame-src`` confines every navigation it makes to the sandbox host; these are the flags of the
# app document that runs one level down inside that wrapper.
SEALED_SANDBOX_FLAGS = "allow-scripts allow-forms allow-modals"

_SCRIPT_END = re.compile(r"</(script)", re.IGNORECASE)
_STYLE_END = re.compile(r"</(style)", re.IGNORECASE)


def render_document(app: App, *, theme: str, language: str) -> str:
    """Combine the three author-supplied parts into one HTML document."""
    # A literal "</script" inside the code would end the block early.
    script = _SCRIPT_END.sub(r"<\\/\1", app.custom_js)
    style = _STYLE_END.sub(r"<\\/\1", app.custom_css)
    theme = theme if theme in ("light", "dark") else "light"
    language = language if language in ("de", "en") else "en"
    return (
        "<!doctype html>\n"
        f'<html lang="{language}" data-theme="{theme}">\n'
        "<head>\n"
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f'<meta name="color-scheme" content="{theme}">\n'
        f"<title>{html.escape(app.name)}</title>\n"
        f"<style>{style}</style>\n"
        "</head>\n"
        f"<body>\n{app.custom_html}\n"
        f"<script>{script}</script>\n"
        "</body>\n</html>\n"
    )


def content_security_policy(*, allow_network: bool, embedder_origin: str) -> str:
    if allow_network:
        sources = {
            "script-src": "'unsafe-inline' https:",
            "style-src": "'unsafe-inline' https:",
            "img-src": "data: blob: https:",
            "media-src": "data: blob: https:",
            "font-src": "data: https:",
            "connect-src": "https:",
            "frame-src": "https:",
        }
        return "; ".join(
            [
                f"sandbox {SANDBOX_FLAGS}",
                "default-src 'none'",
                *(f"{name} {value}" for name, value in sources.items()),
                "base-uri 'none'",
                "object-src 'none'",
                "form-action https:",
                f"frame-ancestors {embedder_origin}",
            ]
        )
    sources = {
        "script-src": "'unsafe-inline'",
        "style-src": "'unsafe-inline'",
        "img-src": "data: blob:",
        "media-src": "data: blob:",
        "font-src": "data:",
        "connect-src": "'none'",
        "frame-src": "'none'",
    }
    # No ``frame-ancestors``: a network-off app is framed by the wrapper, whose origin is opaque
    # (``sandbox`` without ``allow-same-origin``) and which no host-source could match. The wrapper
    # carries ``frame-ancestors`` for the embedding check and, through its ``frame-src``, confines
    # every navigation this document makes to the sandbox host. ``form-action 'none'`` and the
    # absence of ``allow-popups`` close forms and new windows as data-carrying exits.
    return "; ".join(
        [
            f"sandbox {SEALED_SANDBOX_FLAGS}",
            "default-src 'none'",
            *(f"{name} {value}" for name, value in sources.items()),
            "base-uri 'none'",
            "object-src 'none'",
            "form-action 'none'",
        ]
    )


def response_headers(*, allow_network: bool, embedder_origin: str) -> dict[str, str]:
    headers = {
        "Content-Security-Policy": content_security_policy(
            allow_network=allow_network, embedder_origin=embedder_origin
        ),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Permissions-Policy": (
            "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()"
        ),
    }
    if not allow_network:
        # Resource hints resolve DNS and open connections that ``connect-src`` does not govern;
        # turn the speculative ones off. (WebRTC stays reachable: no response header governs it in
        # current engines - see docs/sicherheit.md for what "network off" does and does not promise.)
        headers["X-DNS-Prefetch-Control"] = "off"
    return headers


def wrapper_document(*, inner_path: str) -> str:
    """A script-less page that frames the network-off app one level down.

    The app's own navigations (``location = …``, a form or link ``target``, ``<meta refresh>``)
    are then governed by this document's ``frame-src``, which pins them to the sandbox host, so
    the app cannot carry data to a foreign address. A network-off app needs nothing else: without
    a network grant it has no legitimate reason to leave the sandbox host at all.
    """
    return (
        "<!doctype html>\n"
        '<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        "<style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style>\n"
        "</head>\n<body>\n"
        f'<iframe src="{html.escape(inner_path, quote=True)}" sandbox="{SEALED_SANDBOX_FLAGS}" '
        'allow="" referrerpolicy="no-referrer" title="App"></iframe>\n'
        "</body>\n</html>\n"
    )


def wrapper_headers(*, embedder_origin: str, sandbox_origin: str) -> dict[str, str]:
    policy = "; ".join(
        [
            f"sandbox {SEALED_SANDBOX_FLAGS}",
            "default-src 'none'",
            "style-src 'unsafe-inline'",
            f"frame-src {sandbox_origin}",
            "base-uri 'none'",
            "form-action 'none'",
            f"frame-ancestors {embedder_origin}",
        ]
    )
    return {
        "Content-Security-Policy": policy,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
        "X-DNS-Prefetch-Control": "off",
    }
