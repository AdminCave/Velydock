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
    else:
        sources = {
            "script-src": "'unsafe-inline'",
            "style-src": "'unsafe-inline'",
            "img-src": "data: blob:",
            "media-src": "data: blob:",
            "font-src": "data:",
            "connect-src": "'none'",
            "frame-src": "'none'",
        }
    directives = [
        f"sandbox {SANDBOX_FLAGS}",
        "default-src 'none'",
        *(f"{name} {value}" for name, value in sources.items()),
        "base-uri 'none'",
        "form-action 'none'" if not allow_network else "form-action https:",
        f"frame-ancestors {embedder_origin}",
    ]
    return "; ".join(directives)


def response_headers(*, allow_network: bool, embedder_origin: str) -> dict[str, str]:
    return {
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
