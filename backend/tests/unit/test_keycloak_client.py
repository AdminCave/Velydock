"""What Velydock sends to Keycloak's Admin API - checked against a recorded conversation.

The behaviour of Keycloak itself is covered by ``tests/keycloak`` (a real server). These tests
pin down the requests: which fields a change carries, and what is never asked for.
"""

from __future__ import annotations

import json
from typing import Any, ClassVar

import httpx
import pytest

from tests.unit.test_request_guard import make_settings
from velydock.idp.base import AccountState, IdpMailFailed, IdpManaged, IdpUnavailable
from velydock.idp.keycloak import KeycloakIdp

BASE = "http://keycloak:8080/admin/realms/velydock"


class Keycloak:
    """Answers from a script and remembers every request made to the Admin API."""

    def __init__(self, answers: dict[tuple[str, str], Any] | None = None) -> None:
        self.answers = answers or {}
        self.requests: list[tuple[str, str, Any]] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/protocol/openid-connect/token"):
            return httpx.Response(200, json={"access_token": "t", "expires_in": 300})
        path = str(request.url).removeprefix(BASE).split("?")[0]
        body = json.loads(request.content) if request.content else None
        self.requests.append((request.method, path, body))
        answer = self.answers.get((request.method, path), 204)
        if isinstance(answer, int):
            headers = {"location": f"{BASE}{path}/new-id"} if request.method == "POST" else {}
            return httpx.Response(
                answer, json={"errorMessage": "scripted"} if answer >= 400 else None, headers=headers
            )
        return httpx.Response(200, json=answer)

    def idp(self) -> KeycloakIdp:
        http = httpx.AsyncClient(transport=httpx.MockTransport(self.handle))
        return KeycloakIdp(make_settings(), http)

    def sent(self, method: str) -> list[tuple[str, Any]]:
        return [(path, body) for verb, path, body in self.requests if verb == method]


class TestAccountChangesCarryOnlyWhatChanges:
    """A full account sent back would overwrite whatever changed in Keycloak a moment ago -
    a lock set by another request, or a field an operator edited in the console."""

    async def test_locking_sends_the_lock_and_nothing_else(self) -> None:
        keycloak = Keycloak()
        await keycloak.idp().set_enabled("u1", False)
        assert keycloak.requests == [("PUT", "/users/u1", {"enabled": False})], "no read, no other field"

    async def test_a_name_change_does_not_carry_the_state_or_the_address(self) -> None:
        keycloak = Keycloak()
        await keycloak.idp().update_user("u1", first_name="Neu")
        assert keycloak.requests == [("PUT", "/users/u1", {"firstName": "Neu"})]

    async def test_a_new_address_is_not_claimed_to_be_verified(self) -> None:
        """An administrator typed it; nobody has shown that it belongs to this person."""
        keycloak = Keycloak()
        await keycloak.idp().update_user("u1", email="neu@acme.example")
        assert keycloak.requests == [
            ("PUT", "/users/u1", {"email": "neu@acme.example", "emailVerified": False})
        ]
        keycloak = Keycloak()
        await keycloak.idp().create_user(
            username="mia",
            email="mia@acme.example",
            first_name="M",
            last_name="M",
            temporary_password="x" * 16,
        )
        assert keycloak.sent("POST")[0][1]["emailVerified"] is False

    async def test_nothing_to_change_sends_nothing(self) -> None:
        keycloak = Keycloak()
        await keycloak.idp().update_user("u1")
        assert keycloak.requests == []

    async def test_required_actions_are_extended_without_touching_other_fields(self) -> None:
        keycloak = Keycloak({("GET", "/users/u1"): {"enabled": True, "requiredActions": ["UPDATE_PASSWORD"]}})
        await keycloak.idp().require_second_factor_setup("u1")
        assert keycloak.sent("PUT") == [
            ("/users/u1", {"requiredActions": ["CONFIGURE_TOTP", "UPDATE_PASSWORD"]})
        ]


class TestMembersKeycloakManagesItself:
    MANAGED: ClassVar[dict[str, str]] = {"id": "u1", "membershipType": "MANAGED"}
    ORDINARY: ClassVar[dict[str, str]] = {"id": "u1", "membershipType": "UNMANAGED"}

    async def test_a_managed_member_is_never_removed(self) -> None:
        """Keycloak deletes the account of such a member when the membership goes."""
        keycloak = Keycloak({("GET", "/organizations/o1/members/u1"): self.MANAGED})
        with pytest.raises(IdpManaged):
            await keycloak.idp().remove_organization_member("o1", "u1")
        assert keycloak.sent("DELETE") == []

    async def test_an_ordinary_member_is_removed(self) -> None:
        keycloak = Keycloak({("GET", "/organizations/o1/members/u1"): self.ORDINARY})
        await keycloak.idp().remove_organization_member("o1", "u1")
        assert keycloak.sent("DELETE") == [("/organizations/o1/members/u1", None)]

    async def test_removing_an_address_lifts_no_membership_if_one_of_them_is_managed(self) -> None:
        keycloak = Keycloak(
            {
                ("GET", "/users/u1"): {"email": "mia@acme.example"},
                ("GET", "/organizations/members/u1/organizations"): [{"id": "o1"}, {"id": "o2"}],
                ("GET", "/organizations/o1/members/u1"): self.ORDINARY,
                ("GET", "/organizations/o2/members/u1"): self.MANAGED,
            }
        )
        with pytest.raises(IdpManaged):
            await keycloak.idp().update_user("u1", email=None)
        assert keycloak.sent("DELETE") == [] and keycloak.sent("PUT") == []

    async def test_removing_an_address_restores_the_memberships_even_if_the_update_fails(self) -> None:
        keycloak = Keycloak(
            {
                ("GET", "/users/u1"): {"email": "mia@acme.example"},
                ("GET", "/organizations/members/u1/organizations"): [{"id": "o1"}],
                ("GET", "/organizations/o1/members/u1"): self.ORDINARY,
                ("PUT", "/users/u1"): 500,
            }
        )
        with pytest.raises(IdpUnavailable):
            await keycloak.idp().update_user("u1", email=None, first_name="Neu")
        assert keycloak.sent("DELETE") == [("/organizations/o1/members/u1", None)]
        assert keycloak.sent("POST") == [("/organizations/o1/members", "u1")]


class TestSecondFactor:
    @pytest.mark.parametrize(
        ("credentials", "expected"),
        [
            ([{"type": "password"}], False),
            ([{"type": "password"}, {"type": "otp"}], True),
            # A security key is stored, but the realm's sign-in never asks for it: it must not
            # satisfy the rule on paper.
            ([{"type": "password"}, {"type": "webauthn"}], False),
            ([{"type": "webauthn-passwordless"}], False),
        ],
    )
    async def test_only_what_the_sign_in_asks_for_counts(
        self, credentials: list[dict[str, str]], expected: bool
    ) -> None:
        keycloak = Keycloak({("GET", "/users/u1/credentials"): credentials})
        assert await keycloak.idp().has_second_factor("u1") is expected


class TestAccountState:
    async def state(self, answers: dict[tuple[str, str], Any], sid: str | None = "s1") -> AccountState:
        return await Keycloak(answers).idp().account_state("u1", sid)

    async def test_what_keycloak_says_about_an_account_and_its_session(self) -> None:
        enabled = {("GET", "/users/u1"): {"enabled": True}}
        assert await self.state({("GET", "/users/u1"): 404}) is AccountState.DELETED
        assert await self.state({("GET", "/users/u1"): {"enabled": False}}) is AccountState.DISABLED
        assert await self.state({**enabled, ("GET", "/users/u1/sessions"): [{"id": "s2"}]}) is (
            AccountState.SESSION_ENDED
        )
        assert (
            await self.state({**enabled, ("GET", "/users/u1/sessions"): [{"id": "s1"}]})
            is AccountState.ACTIVE
        )
        assert await self.state(enabled, sid=None) is AccountState.ACTIVE, (
            "a session without id is not judged"
        )


class TestInvitationMail:
    async def test_a_mail_server_failure_is_told_apart_from_keycloak_being_down(self) -> None:
        keycloak = Keycloak({("PUT", "/users/u1/execute-actions-email"): 500})
        with pytest.raises(IdpMailFailed):
            await keycloak.idp().send_password_setup_email("u1")

        def unreachable(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route")

        idp = KeycloakIdp(make_settings(), httpx.AsyncClient(transport=httpx.MockTransport(unreachable)))
        with pytest.raises(IdpUnavailable) as failure:
            await idp.send_password_setup_email("u1")
        assert not isinstance(failure.value, IdpMailFailed)
