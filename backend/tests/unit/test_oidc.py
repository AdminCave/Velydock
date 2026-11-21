"""ID-token and logout-token validation of the OpenID Connect relying party."""

from __future__ import annotations

import base64
import hashlib
import json
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from tests.support.mini_idp import Identity, MiniIdp
from velydock.config import Settings
from velydock.security.oidc import OidcClient, OidcError, new_pkce_pair

ANNA = Identity("sub-anna", "anna", "anna@acme.example", "Anna", "Admin")
NONCE = "nonce-123"


@pytest.fixture
def cfg() -> Settings:
    return Settings(
        environment="test",
        public_url="https://dock.test",
        sandbox_url="https://sandbox.test",
        database_url="postgresql+asyncpg://unused@localhost/unused",
        secret_key="k" * 40,
        keycloak_public_url="https://auth.test",
        keycloak_internal_url="http://keycloak.internal:8080",
        oidc_client_secret="c" * 20,
        idp_admin_client_secret="c" * 20,
    )


@pytest.fixture
def idp(cfg: Settings) -> MiniIdp:
    return MiniIdp(cfg)


@pytest.fixture
async def oidc(cfg: Settings, idp: MiniIdp) -> AsyncIterator[OidcClient]:
    async with httpx.AsyncClient(transport=idp.transport()) as http:
        yield OidcClient(cfg, http)


def token(idp: MiniIdp, **overrides: Any) -> str:
    nonce = overrides.pop("nonce", NONCE)
    claims = idp.id_token_claims(ANNA, nonce=nonce or "", **overrides)
    if nonce is None:
        del claims["nonce"]
    return idp.sign(claims)


class TestIdToken:
    async def test_valid_token_yields_the_identity(self, oidc: OidcClient, idp: MiniIdp) -> None:
        claims = await oidc.validate_id_token(token(idp), nonce=NONCE)
        assert (claims.sub, claims.username, claims.email) == ("sub-anna", "anna", "anna@acme.example")
        assert (claims.first_name, claims.last_name, claims.sid) == ("Anna", "Admin", "sid-1")

    async def test_wrong_nonce(self, oidc: OidcClient, idp: MiniIdp) -> None:
        with pytest.raises(OidcError, match="nonce"):
            await oidc.validate_id_token(token(idp), nonce="another-nonce")

    async def test_missing_nonce(self, oidc: OidcClient, idp: MiniIdp) -> None:
        with pytest.raises(OidcError, match="nonce"):
            await oidc.validate_id_token(token(idp, nonce=None), nonce=NONCE)

    async def test_wrong_issuer(self, oidc: OidcClient, idp: MiniIdp) -> None:
        with pytest.raises(OidcError):
            await oidc.validate_id_token(token(idp, iss="https://evil.example/realms/velydock"), nonce=NONCE)

    async def test_token_for_another_client(self, oidc: OidcClient, idp: MiniIdp) -> None:
        with pytest.raises(OidcError):
            await oidc.validate_id_token(token(idp, aud="some-other-app"), nonce=NONCE)

    async def test_multiple_audiences_need_matching_azp(self, oidc: OidcClient, idp: MiniIdp) -> None:
        with pytest.raises(OidcError, match="another party"):
            await oidc.validate_id_token(token(idp, aud=["velydock", "other"], azp="other"), nonce=NONCE)
        claims = await oidc.validate_id_token(
            token(idp, aud=["velydock", "other"], azp="velydock"), nonce=NONCE
        )
        assert claims.sub == "sub-anna"

    async def test_expired_token(self, oidc: OidcClient, idp: MiniIdp) -> None:
        past = int(time.time()) - 3600
        with pytest.raises(OidcError):
            await oidc.validate_id_token(token(idp, iat=past, exp=past + 60), nonce=NONCE)

    async def test_missing_expiry(self, oidc: OidcClient, idp: MiniIdp) -> None:
        with pytest.raises(OidcError):
            await oidc.validate_id_token(token(idp, exp=None), nonce=NONCE)

    async def test_signature_from_another_key(self, oidc: OidcClient, idp: MiniIdp) -> None:
        attacker = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        forged = idp.sign(idp.id_token_claims(ANNA, nonce=NONCE), key=attacker)
        with pytest.raises(OidcError):
            await oidc.validate_id_token(forged, nonce=NONCE)

    async def test_unknown_key_id(self, oidc: OidcClient, idp: MiniIdp) -> None:
        forged = idp.sign(idp.id_token_claims(ANNA, nonce=NONCE), kid="unknown-key")
        with pytest.raises(OidcError, match="unknown key"):
            await oidc.validate_id_token(forged, nonce=NONCE)

    async def test_unsigned_token_alg_none(self, oidc: OidcClient, idp: MiniIdp) -> None:
        def b64(data: dict[str, Any]) -> str:
            return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()

        unsigned = f"{b64({'alg': 'none', 'kid': idp.kid})}.{b64(idp.id_token_claims(ANNA, nonce=NONCE))}."
        with pytest.raises(OidcError, match="disallowed algorithm"):
            await oidc.validate_id_token(unsigned, nonce=NONCE)

    @pytest.mark.parametrize("algorithm", ["ES256", "ES384", "PS256"])
    async def test_algorithm_that_does_not_fit_the_key(
        self, oidc: OidcClient, idp: MiniIdp, algorithm: str
    ) -> None:
        """The key id is public. Naming it with another allowed algorithm must be a clean refusal."""

        def b64(data: dict[str, Any]) -> str:
            return base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()

        forged = (
            f"{b64({'alg': algorithm, 'kid': idp.kid})}.{b64(idp.id_token_claims(ANNA, nonce=NONCE))}.AAAA"
        )
        with pytest.raises(OidcError):
            await oidc.validate_id_token(forged, nonce=NONCE)

    async def test_hmac_signed_with_the_public_key(self, oidc: OidcClient, idp: MiniIdp) -> None:
        """Algorithm confusion: the public key must never be accepted as an HMAC secret."""
        public_pem = idp.key.public_key().public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        claims = idp.id_token_claims(ANNA, nonce=NONCE)
        header = base64.urlsafe_b64encode(json.dumps({"alg": "HS256", "kid": idp.kid}).encode()).rstrip(b"=")
        body = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=")
        import hmac

        signature = base64.urlsafe_b64encode(
            hmac.new(public_pem, header + b"." + body, hashlib.sha256).digest()
        ).rstrip(b"=")
        forged = b".".join([header, body, signature]).decode()
        with pytest.raises(OidcError, match="disallowed algorithm"):
            await oidc.validate_id_token(forged, nonce=NONCE)

    async def test_a_nonce_outside_ascii_is_a_mismatch_not_an_error(
        self, oidc: OidcClient, idp: MiniIdp
    ) -> None:
        token = idp.sign(idp.id_token_claims(ANNA, nonce="nönce"))
        with pytest.raises(OidcError, match="nonce"):
            await oidc.validate_id_token(token, nonce=NONCE)
        assert (await oidc.validate_id_token(token, nonce="nönce")).username == ANNA.username

    async def test_garbage(self, oidc: OidcClient) -> None:
        with pytest.raises(OidcError):
            await oidc.validate_id_token("not-a-token", nonce=NONCE)

    async def test_missing_username(self, oidc: OidcClient, idp: MiniIdp) -> None:
        with pytest.raises(OidcError, match="preferred_username"):
            await oidc.validate_id_token(token(idp, preferred_username=None), nonce=NONCE)


class TestLogoutToken:
    async def test_valid_with_session_id(self, oidc: OidcClient, idp: MiniIdp) -> None:
        claims = await oidc.validate_logout_token(idp.logout_token(sid="sid-7"))
        assert (claims.sid, claims.sub) == ("sid-7", None)

    async def test_valid_with_subject(self, oidc: OidcClient, idp: MiniIdp) -> None:
        assert (await oidc.validate_logout_token(idp.logout_token(sub="sub-anna"))).sub == "sub-anna"

    async def test_an_id_token_is_not_a_logout_token(self, oidc: OidcClient, idp: MiniIdp) -> None:
        with pytest.raises(OidcError, match="not a logout token"):
            await oidc.validate_logout_token(token(idp))

    async def test_nonce_is_forbidden(self, oidc: OidcClient, idp: MiniIdp) -> None:
        with pytest.raises(OidcError, match="nonce"):
            await oidc.validate_logout_token(idp.logout_token(sid="sid-7", nonce="n"))

    async def test_needs_subject_or_session(self, oidc: OidcClient, idp: MiniIdp) -> None:
        with pytest.raises(OidcError, match="neither"):
            await oidc.validate_logout_token(idp.logout_token())

    async def test_wrong_audience(self, oidc: OidcClient, idp: MiniIdp) -> None:
        with pytest.raises(OidcError):
            await oidc.validate_logout_token(idp.logout_token(sid="s", aud="other"))

    async def test_forged_signature(self, oidc: OidcClient, idp: MiniIdp) -> None:
        attacker = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        claims = jwt.decode(idp.logout_token(sid="s"), options={"verify_signature": False})
        with pytest.raises(OidcError):
            await oidc.validate_logout_token(idp.sign(claims, key=attacker))


class TestProvider:
    async def test_issuer_mismatch_in_discovery_is_fatal(self, cfg: Settings) -> None:
        idp = MiniIdp(cfg, issuer_override="https://evil.example/realms/velydock")
        async with httpx.AsyncClient(transport=idp.transport()) as http:
            with pytest.raises(OidcError, match="issuer mismatch"):
                await OidcClient(cfg, http).metadata()

    async def test_authorization_request_uses_pkce_state_and_nonce(self, oidc: OidcClient) -> None:
        url = await oidc.authorization_url(
            state="st", nonce="no", code_challenge="ch", redirect_uri="https://dock.test/cb"
        )
        assert url.startswith("https://auth.test/realms/velydock/protocol/openid-connect/auth?")
        for part in (
            "response_type=code",
            "code_challenge=ch",
            "code_challenge_method=S256",
            "state=st",
            "nonce=no",
            "scope=openid",
        ):
            assert part in url

    async def test_code_exchange_checks_pkce(self, oidc: OidcClient, idp: MiniIdp) -> None:
        verifier, challenge = new_pkce_pair()
        url = await oidc.authorization_url(
            state="s", nonce=NONCE, code_challenge=challenge, redirect_uri="https://dock.test/cb"
        )
        callback = idp.authorize(url, ANNA)
        code = callback.split("code=")[1].split("&")[0]
        with pytest.raises(OidcError, match="rejected"):
            await oidc.exchange_code(
                code=code, code_verifier="wrong-verifier", redirect_uri="https://dock.test/cb"
            )
        # The code was consumed by the failed attempt: no replay.
        with pytest.raises(OidcError):
            await oidc.exchange_code(code=code, code_verifier=verifier, redirect_uri="https://dock.test/cb")

    @pytest.mark.parametrize("answer", ["[]", '"text"', "<html>proxy error</html>"])
    async def test_a_token_answer_that_is_no_json_object_is_a_refusal(
        self, cfg: Settings, idp: MiniIdp, answer: str
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/token"):
                return httpx.Response(
                    200, content=answer.encode(), headers={"content-type": "application/json"}
                )
            return idp._handle(request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            with pytest.raises(OidcError, match="token response"):
                await OidcClient(cfg, http).exchange_code(
                    code="c", code_verifier="v", redirect_uri="https://dock.test/cb"
                )

    def test_pkce_pair(self) -> None:
        verifier, challenge = new_pkce_pair()
        expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        assert challenge == expected
        assert len(verifier) >= 43
