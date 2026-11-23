"""Runtime configuration, read from ``VELYDOCK_*`` environment variables."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="VELYDOCK_", extra="ignore")

    environment: Literal["production", "development", "test"] = "production"
    log_level: str = "INFO"

    # Public addresses. The sandbox host serves custom apps and must differ from the main host.
    public_url: str
    sandbox_url: str

    database_url: str
    secret_key: str = Field(min_length=32)

    # Identity provider (Keycloak)
    keycloak_public_url: str
    keycloak_internal_url: str
    keycloak_realm: str = "velydock"
    oidc_client_id: str = "velydock"
    oidc_client_secret: str = Field(min_length=16)
    idp_admin_client_id: str = "velydock-admin"
    idp_admin_client_secret: str = Field(min_length=16)
    # Velydock needs these only until the realm exists. (With the bundled Compose file the
    # secret stays in .env all the same: Keycloak does not start without it.)
    idp_bootstrap_client_id: str | None = None
    idp_bootstrap_client_secret: str | None = None
    # Where Keycloak reaches this service for back-channel logout (internal network).
    backchannel_base_url: str = "http://velydock:8000"

    session_idle_minutes: int = Field(default=120, ge=5)
    session_max_hours: int = Field(default=12, ge=1)
    require_admin_2fa: bool = True
    # The embeddability check fetches admin-supplied URLs; private networks stay off-limits by default.
    embed_check_allow_private: bool = False

    # Addresses and networks whose X-Forwarded-For entries are believed. The default covers the
    # reverse proxy in front of Velydock wherever it sits in a private or container network; a
    # client address that such a proxy merely passes on is not believed. docker-compose.yml
    # repeats this default; change both together.
    trusted_proxies: str = "127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7"

    # Publishing apps through the bundled reverse proxy. Without an apps address the feature is
    # off. Apps are published under this host by path (https://apps.example.com/<name>/) or
    # under a sub-domain of it (https://<name>.apps.example.com/) - never under the host of
    # Velydock itself: an app there would run with the rights of the interface.
    apps_url: str | None = None
    # Shared with the reverse proxy, which fetches its routes from Velydock with it.
    proxy_secret: str | None = Field(default=None, min_length=16)
    # The certificate resolver the proxy uses for published hosts ("" in development: its default
    # certificate).
    proxy_tls_resolver: str = ""
    # The entry point of the proxy that serves the published addresses.
    proxy_entry_point: str = "websecure"

    static_dir: str = "/app/static"
    theme_source_dir: str = "/opt/velydock/keycloak-theme"

    @field_validator(
        "public_url", "sandbox_url", "keycloak_public_url", "keycloak_internal_url", "backchannel_base_url"
    )
    @classmethod
    def _strip_slash(cls, value: str) -> str:
        value = value.rstrip("/")
        parts = urlsplit(value)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            raise ValueError("must be an absolute http(s) URL")
        return value

    @field_validator("proxy_secret", mode="before")
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        # An empty variable in .env means "not set", not "a secret of no characters".
        return value or None

    @field_validator("apps_url")
    @classmethod
    def _apps_url(cls, value: str | None) -> str | None:
        if not value:
            return None
        value = value.rstrip("/")
        parts = urlsplit(value)
        if parts.scheme not in ("http", "https") or not parts.netloc or parts.path:
            raise ValueError("must be an absolute http(s) URL without a path")
        return parts._replace(netloc=parts.netloc.lower()).geturl()

    @field_validator("public_url", "sandbox_url")
    @classmethod
    def _lower_case_host(cls, value: str) -> str:
        # Host names are case-insensitive, but browsers send them in lower case (Origin and Host
        # headers) and these two are compared with what browsers send. The Keycloak address is
        # left as written: it must equal the issuer Keycloak states, letter for letter.
        parts = urlsplit(value)
        return parts._replace(netloc=parts.netloc.lower()).geturl()

    @model_validator(mode="after")
    def _check_hosts(self) -> Settings:
        if urlsplit(self.public_url).netloc == urlsplit(self.sandbox_url).netloc:
            raise ValueError(
                "VELYDOCK_SANDBOX_URL must use a different host than VELYDOCK_PUBLIC_URL: "
                "custom apps are isolated by serving them from their own origin"
            )
        if self.environment == "production" and not self.public_url.startswith("https://"):
            raise ValueError("VELYDOCK_PUBLIC_URL must use https in production")
        if self.apps_url:
            apps = (urlsplit(self.apps_url).hostname or "").lower()
            own = {
                (urlsplit(url).hostname or "").lower()
                for url in (self.public_url, self.sandbox_url, self.keycloak_public_url)
            }
            # Neither one of Velydock's own hosts nor a parent of one: "<name>.<apps host>" must
            # never be able to spell the address of the interface, the sandbox or the sign-in.
            if apps in own or any(host.endswith("." + apps) for host in own):
                raise ValueError(
                    "VELYDOCK_APPS_URL must be a host of its own, and none of Velydock's hosts may "
                    "lie below it (apps.example.com, not example.com)"
                )
            if not self.proxy_secret:
                raise ValueError("VELYDOCK_PROXY_SECRET is required when VELYDOCK_APPS_URL is set")
            if self.environment == "production" and not self.apps_url.startswith("https://"):
                raise ValueError("VELYDOCK_APPS_URL must use https in production")
        return self

    @property
    def apps_host(self) -> str | None:
        """Host and port of the apps address as browsers send it, or None with the feature off."""
        return urlsplit(self.apps_url).netloc.lower() if self.apps_url else None

    @property
    def internal_host(self) -> str:
        """How other services of the stack address Velydock (the reverse proxy, Keycloak)."""
        return urlsplit(self.backchannel_base_url).netloc.lower()

    @property
    def public_origin(self) -> str:
        return _origin(self.public_url)

    @property
    def public_host(self) -> str:
        return urlsplit(self.public_url).netloc.lower()

    @property
    def sandbox_origin(self) -> str:
        return _origin(self.sandbox_url)

    @property
    def sandbox_host(self) -> str:
        return urlsplit(self.sandbox_url).netloc.lower()

    @property
    def secure_cookies(self) -> bool:
        return self.public_url.startswith("https://")

    @property
    def session_cookie(self) -> str:
        # The __Host- prefix pins the cookie to this exact host (no Domain attribute, Secure, Path=/).
        return "__Host-velydock_session" if self.secure_cookies else "velydock_session"

    @property
    def login_cookie(self) -> str:
        return "__Host-velydock_login" if self.secure_cookies else "velydock_login"

    @property
    def issuer(self) -> str:
        return f"{self.keycloak_public_url}/realms/{self.keycloak_realm}"

    @property
    def realm_internal_url(self) -> str:
        return f"{self.keycloak_internal_url}/realms/{self.keycloak_realm}"

    @property
    def account_url(self) -> str:
        return f"{self.issuer}/account/"


@lru_cache
def get_settings() -> Settings:
    return Settings()
