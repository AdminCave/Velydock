"""Signed tokens, generated passwords, input validation, configuration checks."""

from __future__ import annotations

import time

import pytest
from pydantic import ValidationError

from velydock.api.auth import safe_return_path
from velydock.config import Settings
from velydock.schemas import AppCreate, GroupCreate, SystemSettingsUpdate, TenantCreate, UserCreate
from velydock.security.tokens import TokenError, hash_token, sign, temporary_password, verify

SECRET = "s" * 40


class TestSignedTokens:
    def test_round_trip(self) -> None:
        token = sign(SECRET, "purpose", {"app": "42"}, 60)
        assert verify(SECRET, "purpose", token)["app"] == "42"

    def test_tampered_payload_is_rejected(self) -> None:
        token = sign(SECRET, "purpose", {"app": "42"}, 60)
        other = sign(SECRET, "purpose", {"app": "43"}, 60)
        forged = other.split(".")[0] + "." + token.split(".")[1]
        with pytest.raises(TokenError):
            verify(SECRET, "purpose", forged)

    def test_other_key_is_rejected(self) -> None:
        with pytest.raises(TokenError):
            verify("x" * 40, "purpose", sign(SECRET, "purpose", {}, 60))

    def test_token_for_another_purpose_is_rejected(self) -> None:
        with pytest.raises(TokenError):
            verify(SECRET, "custom-app", sign(SECRET, "login-state", {}, 60))

    def test_expired_token_is_rejected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        token = sign(SECRET, "purpose", {}, 60)
        monkeypatch.setattr(time, "time", lambda: time.monotonic() + 10**10)
        with pytest.raises(TokenError, match="expired"):
            verify(SECRET, "purpose", token)

    @pytest.mark.parametrize("garbage", ["", "abc", "a.b.c", "....", "e30.e30", "%%%.%%%"])
    def test_garbage_is_rejected(self, garbage: str) -> None:
        with pytest.raises(TokenError):
            verify(SECRET, "purpose", garbage)

    def test_hash_is_stable_and_not_the_token(self) -> None:
        assert hash_token("abc") == hash_token("abc") != "abc"
        assert len(hash_token("abc")) == 64


class TestTemporaryPassword:
    def test_is_random_long_and_mixed(self) -> None:
        passwords = {temporary_password() for _ in range(200)}
        assert len(passwords) == 200
        for password in passwords:
            assert len(password) >= 16
            assert any(c.islower() for c in password)
            assert any(c.isupper() for c in password)
            assert any(c.isdigit() for c in password)
            assert not set("Il1O0o") & set(password)


class TestInputValidation:
    def user(self, **fields: object) -> UserCreate:
        return UserCreate(**{"username": "anna", "first_name": "Anna", "last_name": "A", **fields})  # type: ignore[arg-type]

    @pytest.mark.parametrize("username", ["anna", "anna.admin", "a12", "user_01", "x-y"])
    def test_valid_usernames(self, username: str) -> None:
        assert self.user(username=username).username == username

    def test_usernames_are_lowercased(self) -> None:
        assert self.user(username="Anna.Admin").username == "anna.admin"

    @pytest.mark.parametrize(
        "username",
        # "ab": Keycloak refuses user names with fewer than three characters.
        [
            "",
            "a",
            "ab",
            ".anna",
            "anna.",
            "an na",
            "anna@acme",
            "<script>",
            "a" * 65,
            "anna/../root",
            "ünicode",
        ],
    )
    def test_invalid_usernames(self, username: str) -> None:
        with pytest.raises(ValidationError):
            self.user(username=username)

    @pytest.mark.parametrize(
        "name", ["Anna", "Müller-Lüdenscheidt", "O'Brien", "Jean Luc", "Åsa", "D. J.", "李"]
    )
    def test_person_names(self, name: str) -> None:
        assert self.user(first_name=name, last_name=name).first_name == name

    @pytest.mark.parametrize(
        "name",
        ["Müller (extern)", "A/B", "Tom & Jerry", "<b>x</b>", "a;b", "x=y", "50%", "a\x00b"],
    )
    def test_person_names_keycloak_would_refuse(self, name: str) -> None:
        with pytest.raises(ValidationError):
            self.user(first_name=name)
        with pytest.raises(ValidationError):
            self.user(last_name=name)

    def test_runs_of_blanks_in_names_become_one_blank(self) -> None:
        """Names that differ only in blanks look the same; they must be the same to the checks."""
        assert self.user(first_name="Anna\t  Maria ").first_name == "Anna Maria"
        # Line and paragraph separators count as blanks, too (Keycloak would refuse them).
        assert self.user(last_name="Mül\u2028ler\x85x").last_name == "Mül ler x"
        assert GroupCreate(name="  Büro  &   Verwaltung ").name == "Büro & Verwaltung"
        assert TenantCreate(slug="acme", name="Acme \n GmbH").name == "Acme GmbH"

    @pytest.mark.parametrize(
        "name", ["Müller & Söhne", "AT&T", 'R&D "Intranet"', "Sales&Registration", "100 % Dock"]
    )
    def test_instance_names(self, name: str) -> None:
        assert SystemSettingsUpdate(instance_name=name).instance_name == name

    @pytest.mark.parametrize(
        "name",
        [
            '<a href="https://elsewhere.example/">Weiter</a>',
            "<img src=x>",
            "a > b",
            "&lt;b&gt;fett",
            "&#60;b&#62;",
            "&#x3c;b",
            "A &amp; B",
            "a &lt b",
        ],
    )
    def test_instance_names_keycloak_would_read_as_markup(self, name: str) -> None:
        """Keycloak prints this name through a sanitizer that decodes character references first
        and lets links and images pass; escaping does not help (see the Keycloak suite)."""
        with pytest.raises(ValidationError):
            SystemSettingsUpdate(instance_name=name)

    def test_nul_characters_are_refused_anywhere(self) -> None:
        """PostgreSQL cannot store them; they must not get as far as a statement."""
        with pytest.raises(ValidationError):
            GroupCreate(name="Büro\x00")
        with pytest.raises(ValidationError):
            AppCreate(name="Notizen", type="custom", custom_html="<p>a\x00b</p>")
        with pytest.raises(ValidationError):
            SystemSettingsUpdate(smtp={"host": "mail\x00.example"})  # nested

    @pytest.mark.parametrize("email", ["anna@acme.example", "A.B+c@Sub.Example.ORG"])
    def test_valid_emails_are_normalised(self, email: str) -> None:
        assert self.user(email=email).email == email.lower()

    def test_empty_email_means_none(self) -> None:
        assert self.user(email="  ").email is None

    @pytest.mark.parametrize(
        "email", ["anna", "anna@", "@acme.example", "a b@acme.example", "anna@acme", "a@b@c.de"]
    )
    def test_invalid_emails(self, email: str) -> None:
        with pytest.raises(ValidationError):
            self.user(email=email)

    def test_unknown_fields_are_rejected(self) -> None:
        with pytest.raises(ValidationError):
            self.user(is_system_admin=True)

    @pytest.mark.parametrize("slug", ["acme", "kunde-a", "a1", "x" * 40])
    def test_valid_slugs(self, slug: str) -> None:
        assert TenantCreate(slug=slug, name="Acme").slug == slug

    @pytest.mark.parametrize(
        "slug", ["a", "-acme", "acme-", "ac me", "acme/..", "ACME!", "x" * 41, "master", "admin"]
    )
    def test_invalid_or_reserved_slugs(self, slug: str) -> None:
        with pytest.raises(ValidationError):
            TenantCreate(slug=slug, name="Acme")


class TestSetupAdminCommand:
    def test_invalid_input_ends_with_a_message_not_a_traceback(
        self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        from velydock import cli

        monkeypatch.setattr(cli, "get_settings", lambda: Settings(**TestConfiguration.base))  # type: ignore[arg-type]
        monkeypatch.setattr(cli, "_configure_logging", lambda level: None)
        assert cli.main(["setup-admin", "--username", "ab"]) == 1
        captured = capsys.readouterr()
        assert captured.err.startswith("error: username:") and "Traceback" not in captured.err


class TestReturnPath:
    @pytest.mark.parametrize("path", ["/", "/app/123", "/admin/users?page=2"])
    def test_local_paths_are_kept(self, path: str) -> None:
        assert safe_return_path(path) == path

    @pytest.mark.parametrize(
        "path",
        [
            None,
            "",
            "https://evil.example/",
            "//evil.example/",
            "/\\evil.example",
            "javascript:alert(1)",
            "evil.example",
            "/api/auth/login",
            "/ok\r\nSet-Cookie: x=1",
        ],
    )
    def test_everything_else_falls_back_to_home(self, path: str | None) -> None:
        assert safe_return_path(path) == "/"


class TestConfiguration:
    base: dict[str, object] = {  # noqa: RUF012
        "environment": "production",
        "public_url": "https://dock.example.com",
        "sandbox_url": "https://sandbox.example.com",
        "database_url": "postgresql+asyncpg://u:p@db/velydock",
        "secret_key": "k" * 40,
        "keycloak_public_url": "https://auth.example.com",
        "keycloak_internal_url": "http://keycloak:8080",
        "oidc_client_secret": "c" * 20,
        "idp_admin_client_secret": "c" * 20,
    }

    def test_valid_configuration(self) -> None:
        settings = Settings(**self.base)  # type: ignore[arg-type]
        assert settings.session_cookie == "__Host-velydock_session"
        assert settings.issuer == "https://auth.example.com/realms/velydock"
        assert settings.sandbox_origin == "https://sandbox.example.com"

    def test_sandbox_must_be_a_different_host(self) -> None:
        with pytest.raises(ValidationError, match="different host"):
            Settings(**{**self.base, "sandbox_url": "https://dock.example.com"})  # type: ignore[arg-type]

    def test_production_requires_https(self) -> None:
        with pytest.raises(ValidationError, match="https"):
            Settings(**{**self.base, "public_url": "http://dock.example.com"})  # type: ignore[arg-type]

    def test_short_secrets_are_rejected(self) -> None:
        with pytest.raises(ValidationError):
            Settings(**{**self.base, "secret_key": "short"})  # type: ignore[arg-type]

    def test_plain_http_only_outside_production_and_without_host_prefix(self) -> None:
        settings = Settings(
            **{
                **self.base,
                "environment": "development",
                "public_url": "http://localhost:8000",  # type: ignore[arg-type]
                "sandbox_url": "http://127.0.0.1:8000",
            }
        )
        assert settings.session_cookie == "velydock_session"
        assert not settings.secure_cookies
