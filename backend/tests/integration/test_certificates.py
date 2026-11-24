"""Own TLS certificates: who may store them, what is stored, and what the proxy is told.

That the proxy really serves what it is told is the business of the browser suite, which runs
the real one.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import ssl
import stat
from collections.abc import AsyncIterator
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from tests.conftest import World
from tests.support.certs import Authority, as_pkcs12, issue, key_pem, pem
from tests.support.fake_idp import FakeIdp
from tests.support.mini_idp import MiniIdp
from velydock import cli
from velydock.app import create_app
from velydock.config import Settings
from velydock.db import Scope, get_engine, transaction
from velydock.errors import ApiError
from velydock.models import AuditLog, Certificate, ProxyTarget, Role, User
from velydock.security.oidc import OidcClient
from velydock.services import certificates, proxy

SECRET = "proxy-secret-for-the-tests"
FROM_PROXY = {"Host": "velydock:8000", "X-Velydock-Proxy-Secret": SECRET}
URL = "/api/v1/system/certificates"


def installation(settings: Settings, **changes: Any) -> World:
    changed = Settings.model_validate({**settings.model_dump(), **changes})
    idp = FakeIdp()
    mini = MiniIdp(changed)
    http = httpx.AsyncClient(transport=mini.transport())
    proxy.forget_decisions()
    return World(
        settings=changed, idp=idp, mini=mini, app=create_app(changed, idp=idp, oidc=OidcClient(changed, http))
    )


@pytest.fixture
def directory(tmp_path: Path) -> Path:
    path = tmp_path / "certs"
    path.mkdir()
    return path


@pytest.fixture
async def world(settings: Settings, clean_db: None, directory: Path) -> AsyncIterator[World]:
    """An installation with the bundled proxy: a directory for certificates, and an apps host."""
    yield installation(
        settings,
        apps_url="https://apps.test",
        proxy_secret=SECRET,
        proxy_tls_resolver="le",
        certs_dir=str(directory),
    )


@pytest.fixture(scope="module")
def authority() -> Authority:
    return Authority.new()


@pytest.fixture
async def root(world: World) -> User:
    main = await world.tenant("Admin Cave", "main")
    return await world.user(main, "root", Role.TENANT_ADMIN, system_admin=True)


def upload(authority: Authority, name: str, names: list[str], **more: Any) -> dict[str, str]:
    certificate, key = authority.bundle(names[0], names, **more)
    return {"name": name, "certificate": certificate, "private_key": key}


def sent_back(body: dict[str, Any], answer: httpx.Response) -> bool:
    """Whether an answer repeats a line of the key (or of the certificate) it was sent."""
    lines = [
        line
        for field in ("private_key", "certificate")
        for line in (body.get(field) or "").splitlines()
        if len(line) > 40 and not line.startswith("-----")
    ]
    return any(line in answer.text for line in lines)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def read_text(path: Path) -> str:
    return path.read_text()


def write_text(path: Path, content: str) -> None:
    path.write_text(content)


def mode_of(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def files_in(directory: Path) -> set[str]:
    return {entry.name for entry in directory.iterdir()}


def empty(directory: Path) -> None:
    for entry in directory.iterdir():
        entry.unlink()


async def document(world: World) -> dict[str, Any]:
    async with world.client() as client:
        response = await client.get("/internal/proxy/traefik", headers=FROM_PROXY)
    assert response.status_code == 200, response.text
    return response.json()  # type: ignore[no-any-return]


def requested(told: dict[str, Any]) -> dict[str, str]:
    """The names the proxy is asked to fetch a certificate for, by router."""
    return {
        name: router["tls"]["domains"][0]["main"]
        for name, router in told.get("http", {}).get("routers", {}).items()
        if name.startswith("vd-tls-")
    }


class TestStoring:
    async def test_a_system_administrator_stores_lists_and_removes(
        self, world: World, root: User, authority: Authority
    ) -> None:
        body = upload(authority, "Firma", ["dock.test", "*.apps.test"])
        async with await world.login(root) as client:
            empty = (await client.get(URL)).json()
            assert (empty["available"], empty["problem"], empty["certificates"]) == (True, None, [])
            assert empty["acme"] is True

            created = await client.post(URL, json=body)
            assert created.status_code == 201, created.text
            stored = created.json()
            assert stored["name"] == "Firma" and stored["names"] == ["dock.test", "*.apps.test"]
            assert stored["chain"] == ["CN=dock.test", "CN=Test Intermediate"]
            assert (stored["status"], stored["warnings"], stored["key_type"]) == ("valid", [], "EC P-256")
            assert len(stored["fingerprint"]) == 64

            listed = (await client.get(URL)).json()
            assert [item["id"] for item in listed["certificates"]] == [stored["id"]]
            # No answer carries the key, or a part of it.
            secret = body["private_key"].splitlines()[1]
            for answer in (created.text, (await client.get(URL)).text):
                assert "PRIVATE KEY" not in answer and secret not in answer

            assert (await client.delete(f"{URL}/{stored['id']}")).status_code == 204
            assert (await client.get(URL)).json()["certificates"] == []
            assert (await client.delete(f"{URL}/{stored['id']}")).status_code == 404

    async def test_what_is_stored_is_what_the_proxy_can_load(
        self, world: World, root: User, authority: Authority
    ) -> None:
        certificate, key = authority.leaf("dock.test", ["dock.test"])
        # As a CA delivers it and as people paste it: the root with it, the order mixed up.
        text_ = pem(authority.root[0]) + pem(authority.intermediate[0]) + pem(certificate)
        async with await world.login(root) as client:
            created = await client.post(
                URL, json={"name": "a", "certificate": text_, "private_key": key_pem(key, "geheim")}
            )
            assert (created.status_code, created.json()["error"]["code"]) == (422, "key_encrypted")
            created = await client.post(
                URL,
                json={
                    "name": "a",
                    "certificate": text_,
                    "private_key": key_pem(key, "geheim"),
                    "passphrase": "geheim",
                },
            )
            assert created.status_code == 201, created.text
        async with transaction(Scope.SYSTEM) as db:
            row = (await db.execute(select(Certificate))).scalar_one()
        assert row.certificate == pem(certificate) + pem(authority.intermediate[0])
        assert row.private_key == key_pem(key)
        # Python's own TLS takes the pair: certificate first, key belongs to it, no passphrase.
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        files = Path(world.settings.certs_dir or "") / "check"
        files.mkdir()
        (files / "c.pem").write_text(row.certificate)
        (files / "k.pem").write_text(row.private_key)
        context.load_cert_chain(files / "c.pem", files / "k.pem")

    async def test_a_pkcs12_file(self, world: World, root: User, authority: Authority) -> None:
        certificate, key = authority.leaf("dock.test", ["dock.test"])
        file = base64.b64encode(as_pkcs12(certificate, key, [authority.intermediate[0]], "geheim")).decode()
        async with await world.login(root) as client:
            wrong = await client.post(URL, json={"name": "p", "pkcs12": file, "passphrase": "falsch"})
            assert (wrong.status_code, wrong.json()["error"]["code"]) == (422, "pkcs12_unreadable")
            created = await client.post(URL, json={"name": "p", "pkcs12": file, "passphrase": "geheim"})
            assert created.status_code == 201, created.text
            assert created.json()["chain"] == ["CN=dock.test", "CN=Test Intermediate"]

    async def test_what_an_upload_is_refused_for(
        self, world: World, root: User, authority: Authority
    ) -> None:
        good = upload(authority, "a", ["dock.test"])
        _, other_key = authority.bundle("x.test")
        expired = upload(authority, "a", ["dock.test"], days=5, starts_in_days=-10)
        unnamed_certificate, unnamed_key = issue("dock.test")
        async with await world.login(root) as client:
            for body, code in (
                ({**good, "private_key": other_key}, "key_mismatch"),
                ({**good, "private_key": None}, "key_missing"),
                ({**good, "certificate": "Hallo"}, "certificate_missing"),
                (expired, "expired"),
                (
                    {
                        "name": "a",
                        "certificate": pem(unnamed_certificate),
                        "private_key": key_pem(unnamed_key),
                    },
                    "no_names",
                ),
            ):
                answer = await client.post(URL, json=body)
                assert (answer.status_code, answer.json()["error"]["code"]) == (422, code), answer.text
                # A refusal names what is wrong, never what was sent.
                assert not sent_back(body, answer)
            for body in ({**good, "name": ""}, {**good, "name": "x" * 81}, {**good, "surprise": 1}):
                answer = await client.post(URL, json=body)
                assert answer.status_code == 422 and not sent_back(body, answer)
            assert (await client.get(URL)).json()["certificates"] == []

    async def test_no_name_is_in_two_certificates(
        self, world: World, root: User, authority: Authority
    ) -> None:
        async with await world.login(root) as client:
            first = await client.post(URL, json=upload(authority, "Dock", ["dock.test", "auth.test"]))
            assert first.status_code == 201
            # The same name in a second certificate: the proxy would serve one of the two, and
            # which is not defined.
            again = await client.post(URL, json=upload(authority, "Neu", ["auth.test", "sandbox.test"]))
            assert again.status_code == 409 and again.json()["error"]["code"] == "names_taken"
            assert again.json()["error"]["details"] == {
                "names": ["auth.test"],
                "certificate": "Dock",
                "certificate_id": first.json()["id"],
            }
            # A wildcard next to an exact name is no such case: the exact name wins.
            assert (await client.post(URL, json=upload(authority, "Stern", ["*.test"]))).status_code == 201
            taken = await client.post(URL, json=upload(authority, "dock", ["other.test"]))
            assert (taken.status_code, taken.json()["error"]["code"]) == (409, "name_taken")
            # The very same certificate under another name.
            body = upload(authority, "Eins", ["eins.test"])
            assert (await client.post(URL, json=body)).status_code == 201
            same = await client.post(URL, json={**body, "name": "Zwei"})
            assert (same.status_code, same.json()["error"]["code"]) == (409, "certificate_exists")

    async def test_a_renewal_takes_the_place_of_the_old_certificate(
        self, world: World, root: User, authority: Authority
    ) -> None:
        async with await world.login(root) as client:
            old = (await client.post(URL, json=upload(authority, "Dock", ["dock.test"]))).json()
            other = (await client.post(URL, json=upload(authority, "Auth", ["auth.test"]))).json()
            renewed = upload(authority, "ignored", ["dock.test", "sandbox.test"])
            del renewed["name"]
            answer = await client.put(f"{URL}/{old['id']}", json=renewed)
            assert answer.status_code == 200, answer.text
            new = answer.json()
            assert (new["id"], new["name"]) == (old["id"], "Dock")
            assert new["fingerprint"] != old["fingerprint"] and new["names"] == ["dock.test", "sandbox.test"]
            # Not into the names of another one, and not with a key that does not belong to it.
            clash = upload(authority, "x", ["auth.test"])
            del clash["name"]
            assert (await client.put(f"{URL}/{old['id']}", json=clash)).json()["error"][
                "code"
            ] == "names_taken"
            assert (
                await client.put(f"{URL}/{old['id']}", json={"certificate": renewed["certificate"]})
            ).json()["error"]["code"] == "key_missing"
            renamed = await client.put(f"{URL}/{old['id']}", json={**renewed, "name": "Auth"})
            assert (renamed.status_code, renamed.json()["error"]["code"]) == (409, "name_taken")
            # Nothing of the failed attempts stuck.
            listed = {
                item["name"]: item["fingerprint"] for item in (await client.get(URL)).json()["certificates"]
            }
            assert listed == {"Dock": new["fingerprint"], "Auth": other["fingerprint"]}
            missing = await client.put(f"{URL}/{'0' * 8}-0000-0000-0000-{'0' * 12}", json=renewed)
            assert missing.status_code == 404

    async def test_status_and_warnings(self, world: World, root: User, authority: Authority) -> None:
        soon = upload(authority, "Bald", ["a.test"], days=10)
        later = upload(authority, "Morgen", ["b.test"], starts_in_days=2)
        alone_certificate, alone_key = authority.leaf("c.test")
        own_certificate, own_key = issue("d.test", names=["d.test"])
        async with await world.login(root) as client:
            # Not valid yet: stored, it would be served at once, and nothing else fetched for its name.
            refused = await client.post(URL, json=later)
            assert (refused.status_code, refused.json()["error"]["code"]) == (422, "not_yet_valid")
            for body in (
                soon,
                # Without the certificate of its issuer: browsers that do not know it refuse.
                {"name": "Allein", "certificate": pem(alone_certificate), "private_key": key_pem(alone_key)},
                # Signed by itself: there is no issuer to send.
                {"name": "Selbst", "certificate": pem(own_certificate), "private_key": key_pem(own_key)},
            ):
                assert (await client.post(URL, json=body)).status_code == 201
            listed = {item["name"]: item for item in (await client.get(URL)).json()["certificates"]}
        assert {name: item["status"] for name, item in listed.items()} == {
            "Bald": "expires_soon",
            "Allein": "valid",
            "Selbst": "valid",
        }
        assert {name: item["warnings"] for name, item in listed.items()} == {
            "Bald": [],
            "Allein": ["no_intermediate"],
            "Selbst": [],
        }
        # One that has run out since it was stored is still listed, and says so.
        async with transaction(Scope.SYSTEM) as db:
            await db.execute(
                text("UPDATE certificates SET not_after = now() - interval '1 day' WHERE name = 'Bald'")
            )
        async with await world.login(root) as client:
            listed = {item["name"]: item for item in (await client.get(URL)).json()["certificates"]}
        assert listed["Bald"]["status"] == "expired"


class TestWhoMay:
    async def test_only_system_administrators(self, world: World, root: User, authority: Authority) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna", Role.TENANT_ADMIN)
        body = upload(authority, "Firma", ["dock.test"])
        async with await world.login(root) as client:
            stored = (await client.post(URL, json=body)).json()
        for session in (await world.login(anna), world.client()):
            async with session as client:
                status = 403 if session.cookies else 401
                assert (await client.get(URL)).status_code == status
                assert (await client.post(URL, json={**body, "name": "x"})).status_code in (status, 403)
                assert (await client.put(f"{URL}/{stored['id']}", json=body)).status_code in (status, 403)
                assert (await client.delete(f"{URL}/{stored['id']}")).status_code in (status, 403)
        async with await world.login(root) as client:
            assert [item["name"] for item in (await client.get(URL)).json()["certificates"]] == ["Firma"]

    async def test_no_request_of_an_organization_reaches_the_table(
        self, world: World, root: User, authority: Authority
    ) -> None:
        acme = await world.tenant("Acme")
        async with await world.login(root) as client:
            assert (await client.post(URL, json=upload(authority, "Firma", ["dock.test"]))).status_code == 201
        # Whatever a query asks for: in the scope of an organization the table is empty …
        async with transaction(Scope.TENANT, tenant_id=acme.id) as db:
            assert (await db.execute(select(Certificate))).scalars().all() == []
            assert (await db.execute(text("SELECT count(*) FROM certificates"))).scalar_one() == 0
            changed = await db.execute(text("UPDATE certificates SET name = 'x'"))
            assert changed.rowcount == 0  # type: ignore[attr-defined]
        # … and takes nothing.
        with pytest.raises(DBAPIError):
            async with transaction(Scope.TENANT, tenant_id=acme.id) as db:
                await db.execute(
                    text(
                        "INSERT INTO certificates (id, name, certificate, private_key, fingerprint, not_before, "
                        "not_after) VALUES (gen_random_uuid(), 'x', 'c', 'k', 'f', now(), now())"
                    )
                )
        async with transaction(Scope.SYSTEM) as db:
            assert [row.name for row in (await db.execute(select(Certificate))).scalars()] == ["Firma"]

    async def test_the_log_says_who_and_what_but_never_the_key(
        self, world: World, root: User, authority: Authority
    ) -> None:
        body = upload(authority, "Firma", ["dock.test"])
        renewed = upload(authority, "x", ["dock.test"])
        del renewed["name"]
        async with await world.login(root) as client:
            stored = (await client.post(URL, json=body)).json()
            new = (await client.put(f"{URL}/{stored['id']}", json=renewed)).json()
            await client.delete(f"{URL}/{stored['id']}")
            shown = (await client.get("/api/v1/system/audit")).json()["items"]
        async with transaction(Scope.SYSTEM) as db:
            entries = list(
                (
                    await db.execute(
                        select(AuditLog)
                        .where(AuditLog.action.like("certificate.%"))
                        .order_by(AuditLog.created_at)
                    )
                ).scalars()
            )
        assert [(entry.action, entry.actor_name, entry.target_label) for entry in entries] == [
            ("certificate.add", "root", "Firma"),
            ("certificate.replace", "root", "Firma"),
            ("certificate.remove", "root", "Firma"),
        ]
        assert entries[0].details["fingerprint"] == stored["fingerprint"]
        assert entries[0].details["names"] == ["dock.test"]
        assert entries[1].details["before"]["fingerprint"] == stored["fingerprint"]
        assert entries[1].details["fingerprint"] == new["fingerprint"]
        assert all(entry.tenant_id is None for entry in entries)
        for line in (body["private_key"].splitlines()[1], renewed["private_key"].splitlines()[1]):
            assert all(line not in str(entry.details) for entry in entries)
            assert line not in str(shown)


async def file_names() -> dict[str, str]:
    """Certificate name -> the name of its files for the proxy (without the ending)."""
    async with transaction(Scope.SYSTEM) as db:
        return {row.name: row.files_key for row in (await db.execute(select(Certificate))).scalars()}


class TestWhatTheProxyIsTold:
    async def test_files_in_its_directory_named_in_its_configuration(
        self, world: World, root: User, authority: Authority, directory: Path
    ) -> None:
        assert "tls" not in await document(world)
        body = upload(authority, "Firma", ["dock.test"])
        async with await world.login(root) as client:
            stored = (await client.post(URL, json=body)).json()
        told = await document(world)
        name = (await file_names())["Firma"]
        assert len(name) == 64 and name != stored["fingerprint"]
        assert told["tls"] == {
            "certificates": [{"certFile": f"{directory}/{name}.crt", "keyFile": f"{directory}/{name}.key"}]
        }
        # The key is in a file only the proxy's group reads - not in what goes over the network.
        assert "PRIVATE KEY" not in str(told)
        assert read_text(directory / f"{name}.key") == body["private_key"]
        assert read_text(directory / f"{name}.crt") == body["certificate"]
        for kind in ("crt", "key"):
            assert mode_of(directory / f"{name}.{kind}") == 0o640

        # Removed: gone from the configuration and from the directory at the next fetch.
        async with await world.login(root) as client:
            await client.delete(f"{URL}/{stored['id']}")
        assert "tls" not in await document(world)
        assert files_in(directory) == set()

    async def test_the_directory_follows_the_database(
        self, world: World, root: User, authority: Authority, directory: Path
    ) -> None:
        async with await world.login(root) as client:
            assert (await client.post(URL, json=upload(authority, "Eins", ["one.test"]))).status_code == 201
            assert (await client.post(URL, json=upload(authority, "Zwei", ["two.test"]))).status_code == 201
        names = await file_names()
        one, two = names["Eins"], names["Zwei"]
        await document(world)
        # A new, empty volume (or a restored database on a fresh server): everything is written again.
        empty(directory)
        # Something that is none of ours stays; something of an earlier certificate goes.
        write_text(directory / "README", "x")
        write_text(directory / f"{'d' * 64}.key", "stale")
        told = await document(world)
        assert [Path(item["certFile"]).name for item in told["tls"]["certificates"]] == sorted(
            [f"{one}.crt", f"{two}.crt"]
        )
        assert files_in(directory) == {"README", f"{one}.crt", f"{one}.key", f"{two}.crt", f"{two}.key"}

    async def test_a_renewal_is_a_new_file_so_the_proxy_notices(
        self, world: World, root: User, authority: Authority, directory: Path
    ) -> None:
        renewed = upload(authority, "x", ["dock.test"])
        del renewed["name"]
        async with await world.login(root) as client:
            old = (await client.post(URL, json=upload(authority, "Dock", ["dock.test"]))).json()
            before = await document(world)
            await client.put(f"{URL}/{old['id']}", json=renewed)
        after = await document(world)
        assert before != after
        name = (await file_names())["Dock"]
        assert files_in(directory) == {f"{name}.crt", f"{name}.key"}

    async def test_the_same_certificate_stored_again_with_its_chain_reaches_the_proxy(
        self, world: World, root: User, authority: Authority, directory: Path
    ) -> None:
        # What the warning about a missing issuer tells the administrator to do. The certificate
        # is the same, so is its fingerprint - but the proxy must get the chain.
        certificate, key = authority.leaf("dock.test")
        alone = {"certificate": pem(certificate), "private_key": key_pem(key)}
        complete = {"certificate": authority.fullchain(certificate), "private_key": key_pem(key)}
        async with await world.login(root) as client:
            first = (await client.post(URL, json={"name": "Dock", **alone})).json()
            assert first["warnings"] == ["no_intermediate"]
            before = await document(world)
            name_before = (await file_names())["Dock"]
            assert read_text(directory / f"{name_before}.crt") == pem(certificate)

            second = (await client.put(f"{URL}/{first['id']}", json=complete)).json()
            assert (second["warnings"], second["fingerprint"]) == ([], first["fingerprint"])
        after = await document(world)
        name_after = (await file_names())["Dock"]
        # Another file, another configuration: this is what makes the proxy read it.
        assert name_after != name_before and after["tls"] != before["tls"]
        assert read_text(directory / f"{name_after}.crt") == authority.fullchain(certificate)
        assert files_in(directory) == {f"{name_after}.crt", f"{name_after}.key"}

    async def test_a_published_name_with_a_certificate_of_its_own_is_not_fetched_one(
        self, world: World, root: User, authority: Authority
    ) -> None:
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna", Role.TENANT_ADMIN)
        async with transaction(Scope.SYSTEM) as db:
            db.add(ProxyTarget(tenant_id=acme.id, value="10.20.0.0/16"))
        async with await world.login(anna) as client:
            for name, mode in (("wiki", "subdomain"), ("deep", "subdomain"), ("notes", "path")):
                created = await client.post(
                    "/api/v1/admin/apps",
                    json={
                        "name": name,
                        "type": "external",
                        "visible_to_all": True,
                        "publication": {"name": name, "target_url": "http://10.20.0.7:8080", "mode": mode},
                    },
                )
                assert created.status_code == 201, created.text

        def tls() -> dict[str, Any]:
            return {
                router["rule"].split("`")[1]: router["tls"]
                for name, router in told["http"]["routers"].items()
                if not name.startswith("vd-tls-")
            }

        told = await document(world)
        assert "tls" not in told
        assert tls() == {
            "wiki.apps.test": {"certResolver": "le"},
            "deep.apps.test": {"certResolver": "le"},
            "apps.test": {"certResolver": "le"},
        }
        async with await world.login(root) as client:
            # One for all sub-domains - which is not one for the apps host itself.
            assert (
                await client.post(URL, json=upload(authority, "Apps", ["*.apps.test"]))
            ).status_code == 201
        told = await document(world)
        assert len(told["tls"]["certificates"]) == 1
        assert tls() == {"wiki.apps.test": {}, "deep.apps.test": {}, "apps.test": {"certResolver": "le"}}

    async def test_only_the_proxy_gets_it(self, world: World, root: User, authority: Authority) -> None:
        async with await world.login(root) as client:
            await client.post(URL, json=upload(authority, "Firma", ["dock.test"]))
            # Not through the public address, signed in or not, with the secret or without.
            assert (
                await client.get("/internal/proxy/traefik", headers={"X-Velydock-Proxy-Secret": SECRET})
            ).status_code == 404
        async with world.client() as client:
            for headers in (
                {"Host": "velydock:8000"},
                {"Host": "velydock:8000", "X-Velydock-Proxy-Secret": "wrong" * 5},
            ):
                assert (await client.get("/internal/proxy/traefik", headers=headers)).status_code == 404


class TestWhatTheProxyFetchesItself:
    """Velydock's own names: a certificate from Let's Encrypt, unless there is one of our own."""

    async def test_every_own_name_without_a_certificate_is_requested(self, world: World) -> None:
        told = await document(world)
        keycloak = world.settings.keycloak_public_url.split("//")[1]
        assert requested(told) == {
            "vd-tls-velydock": "dock.test",
            "vd-tls-sandbox": "sandbox.test",
            "vd-tls-keycloak": keycloak,
        }
        # A router that names the host and nothing else: nobody asks for its path, and what
        # would answer there is the proxy itself.
        assert told["http"]["routers"]["vd-tls-velydock"] == {
            "rule": "Host(`dock.test`) && Path(`/.well-known/velydock-tls`)",
            "entryPoints": ["websecure"],
            "service": "noop@internal",
            "tls": {"certResolver": "le", "domains": [{"main": "dock.test"}]},
        }
        assert "services" not in told["http"]

    async def test_a_name_with_an_own_certificate_is_not_requested(
        self, world: World, root: User, authority: Authority
    ) -> None:
        keycloak = world.settings.keycloak_public_url.split("//")[1]
        async with await world.login(root) as client:
            assert (await client.post(URL, json=upload(authority, "Dock", ["dock.test"]))).status_code == 201
            # In the same answer: the certificate is named, and the request for its name is gone.
            # Both at once is what keeps the proxy from ever holding two for one name.
            told = await document(world)
            assert len(told["tls"]["certificates"]) == 1
            assert requested(told) == {"vd-tls-sandbox": "sandbox.test", "vd-tls-keycloak": keycloak}
            # Removed again: the proxy is asked to fetch it again.
            for item in (await client.get(URL)).json()["certificates"]:
                await client.delete(f"{URL}/{item['id']}")
            assert len(requested(await document(world))) == 3
            # One for everything below .test: nothing of ours below it is left to fetch.
            assert (await client.post(URL, json=upload(authority, "Alle", ["*.test"]))).status_code == 201
            left = requested(await document(world))
            assert "vd-tls-velydock" not in left and "vd-tls-sandbox" not in left

    async def test_an_installation_without_a_resolver_requests_nothing(
        self, settings: Settings, clean_db: None, directory: Path
    ) -> None:
        plain = installation(settings, proxy_secret=SECRET, certs_dir=str(directory), proxy_tls_resolver="")
        assert await document(plain) == {}

    async def test_the_command_that_clears_what_was_fetched_before(
        self, world: World, authority: Authority, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        storage = tmp_path / "acme.json"
        fetched = {
            "letsencrypt": {
                "Account": {"Email": "a@example.com"},
                "Certificates": [
                    {
                        "domain": {"main": "dock.test", "sans": ["sandbox.test"]},
                        "certificate": "c",
                        "key": "k",
                    },
                    {"domain": {"main": "auth.test"}, "certificate": "c", "key": "k"},
                ],
            }
        }
        storage.write_text(json.dumps(fetched))
        arguments = argparse.Namespace(command="cert", cert_command="prune-fetched", storage=str(storage))
        assert await cli.certificates(world.settings, arguments) == 0
        assert "Nothing to remove" in capsys.readouterr().out
        certificate, key = authority.bundle("dock.test")
        add = argparse.Namespace(command="cert", cert_command="add", name="Dock", replace=False)
        assert await cli.certificates(world.settings, add, certificate + key) == 0
        capsys.readouterr()
        assert await cli.certificates(world.settings, arguments) == 0
        assert capsys.readouterr().out == "Removed the fetched certificate for dock.test, sandbox.test.\n"
        assert read_json(storage)["letsencrypt"]["Certificates"] == [
            fetched["letsencrypt"]["Certificates"][1]
        ]
        missing = argparse.Namespace(
            command="cert", cert_command="prune-fetched", storage=str(tmp_path / "x")
        )
        assert await cli.certificates(world.settings, missing) == 1
        assert "does not exist" in capsys.readouterr().err


class TestRunningOut:
    async def test_the_log_says_so_now_and_then_not_with_every_fetch(
        self, world: World, root: User, authority: Authority, caplog: pytest.LogCaptureFixture
    ) -> None:
        async with await world.login(root) as client:
            assert (await client.post(URL, json=upload(authority, "Lang", ["a.test"]))).status_code == 201
            assert (
                await client.post(URL, json=upload(authority, "Bald", ["b.test"], days=8))
            ).status_code == 201
            assert (
                await client.post(URL, json=upload(authority, "Vorbei", ["c.test"], days=3))
            ).status_code == 201
        async with transaction(Scope.SYSTEM) as db:
            await db.execute(
                text("UPDATE certificates SET not_after = now() - interval '1 day' WHERE name = 'Vorbei'")
            )
        certificates.forget_warnings()
        caplog.set_level("WARNING", logger="velydock.services.certificates")
        for _ in range(3):
            await document(world)
        said = [
            record.getMessage()
            for record in caplog.records
            if record.name == "velydock.services.certificates"
        ]
        assert len(said) == 2
        assert any(
            line.startswith('certificate "Bald" expires on ') and "(in 6 days)" in line for line in said
        )
        assert any(line.startswith('certificate "Vorbei" expired on ') for line in said)
        # Half a day later it is said again.
        for fingerprint in list(certificates._warned):
            certificates._warned[fingerprint] -= certificates.WARN_EVERY
        await document(world)
        assert (
            len([record for record in caplog.records if record.name == "velydock.services.certificates"]) == 4
        )


class TestWhereItCannotWork:
    async def test_an_installation_without_the_directory_says_so(
        self, settings: Settings, clean_db: None, authority: Authority, tmp_path: Path
    ) -> None:
        read_only = tmp_path / "ro"
        read_only.mkdir()
        read_only.chmod(0o500)
        for changes, problem in (
            ({"proxy_secret": SECRET}, "no_directory"),
            ({"certs_dir": str(tmp_path)}, "no_secret"),
            ({"proxy_secret": SECRET, "certs_dir": str(read_only)}, "not_writable"),
            ({"proxy_secret": SECRET, "certs_dir": str(tmp_path / "missing")}, "not_writable"),
        ):
            plain = installation(settings, **changes)
            main = await plain.tenant(f"Main {problem} {len(changes)}{changes.get('certs_dir', '')[-3:]}")
            root = await plain.user(main, f"root-{main.slug[-12:]}", Role.TENANT_ADMIN, system_admin=True)
            async with await plain.login(root) as client:
                state = (await client.get(URL)).json()
                assert (state["available"], state["problem"]) == (False, problem)
                refused = await client.post(URL, json=upload(authority, "Firma", ["dock.test"]))
                assert (refused.status_code, refused.json()["error"]["code"]) == (
                    409,
                    "certificates_unavailable",
                )
        read_only.chmod(0o700)


class TestWhatIsReallyServed:
    """`hosts` in the overview: every name of the installation, asked at the proxy."""

    @pytest.fixture
    async def served(
        self, settings: Settings, clean_db: None, directory: Path, authority: Authority, tmp_path: Path
    ) -> AsyncIterator[tuple[World, dict[str, str]]]:
        # A TLS server in the place of the proxy: the uploaded certificate for dock.test, another
        # authority's for auth.test, and for everything else what Traefik has when it has nothing.
        uploaded = upload(authority, "Firma", ["dock.test", "*.apps.test"])
        foreign_certificate, foreign_key = Authority.new("Lets Encrypt").bundle("auth.test")
        fallback_certificate, fallback_key = issue("TRAEFIK DEFAULT CERT", names=["x.traefik.default"])

        def context(certificate: str, key: str, label: str) -> ssl.SSLContext:
            made = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            (tmp_path / f"{label}.crt").write_text(certificate)
            (tmp_path / f"{label}.key").write_text(key)
            made.load_cert_chain(tmp_path / f"{label}.crt", tmp_path / f"{label}.key")
            return made

        contexts = {
            "dock.test": context(uploaded["certificate"], uploaded["private_key"], "own"),
            "wiki.apps.test": context(uploaded["certificate"], uploaded["private_key"], "own2"),
            "auth.test": context(foreign_certificate, foreign_key, "foreign"),
        }
        default = context(pem(fallback_certificate), key_pem(fallback_key), "default")

        def choose(socket: ssl.SSLObject, name: str | None, _: ssl.SSLContext) -> None:
            if name in contexts:
                socket.context = contexts[name]

        default.sni_callback = choose

        async def answer(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            writer.close()

        server = await asyncio.start_server(answer, "127.0.0.1", 0, ssl=default)
        port = server.sockets[0].getsockname()[1]
        world = installation(
            settings,
            public_url="https://dock.test",
            sandbox_url="https://sandbox.test",
            keycloak_public_url="https://auth.test",
            apps_url="https://apps.test",
            proxy_secret=SECRET,
            certs_dir=str(directory),
            proxy_tls_address=f"127.0.0.1:{port}",
        )
        yield world, uploaded
        server.close()
        await server.wait_closed()

    async def test_every_name_with_the_certificate_it_gets(
        self, served: tuple[World, dict[str, str]]
    ) -> None:
        world, uploaded = served
        acme = await world.tenant("Acme")
        anna = await world.user(acme, "anna", Role.TENANT_ADMIN)
        main = await world.tenant("Admin Cave", "main")
        root = await world.user(main, "root", Role.TENANT_ADMIN, system_admin=True)
        async with transaction(Scope.SYSTEM) as db:
            db.add(ProxyTarget(tenant_id=acme.id, value="10.20.0.0/16"))
        async with await world.login(anna) as client:
            for name, mode in (("wiki", "subdomain"), ("notes", "path")):
                created = await client.post(
                    "/api/v1/admin/apps",
                    json={
                        "name": name,
                        "type": "external",
                        "visible_to_all": True,
                        "publication": {"name": name, "target_url": "http://10.20.0.7:8080", "mode": mode},
                    },
                )
                assert created.status_code == 201, created.text
        async with await world.login(root) as client:
            stored = (await client.post(URL, json=uploaded)).json()
            state = (await client.get(URL)).json()
        assert state["acme"] is False
        hosts = {item["host"]: item for item in state["hosts"]}
        assert [(item["host"], item["purpose"], item["label"]) for item in state["hosts"]] == [
            ("dock.test", "velydock", ""),
            ("auth.test", "keycloak", ""),
            ("sandbox.test", "sandbox", ""),
            ("apps.test", "apps", ""),
            # A published app with a name of its own; one published by path is under apps.test.
            ("wiki.apps.test", "app", "wiki"),
        ]
        # Which stored certificate is valid for the name …
        assert {host: item["certificate_id"] for host, item in hosts.items()} == {
            "dock.test": stored["id"],
            "auth.test": None,
            "sandbox.test": None,
            "apps.test": None,
            "wiki.apps.test": stored["id"],
        }
        # … and what a browser gets.
        assert {host: item["served"]["source"] for host, item in hosts.items()} == {
            "dock.test": "uploaded",
            "auth.test": "other",
            "sandbox.test": "default",
            "apps.test": "default",
            "wiki.apps.test": "uploaded",
        }
        own, other, fallback = (
            hosts["dock.test"]["served"],
            hosts["auth.test"]["served"],
            hosts["apps.test"]["served"],
        )
        assert (own["certificate_id"], own["fingerprint"], own["valid_for_host"]) == (
            stored["id"],
            stored["fingerprint"],
            True,
        )
        assert (other["issuer"], other["valid_for_host"], other["certificate_id"]) == (
            "CN=Lets Encrypt Intermediate",
            True,
            None,
        )
        assert (fallback["subject"], fallback["valid_for_host"]) == ("CN=TRAEFIK DEFAULT CERT", False)
        assert own["not_after"] == stored["not_after"]

    async def test_a_name_the_proxy_served_from_elsewhere_needs_the_takeover_whatever_is_served_later(
        self,
        served: tuple[World, dict[str, str]],
        authority: Authority,
        tmp_path: Path,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        world, uploaded = served
        main = await world.tenant("Admin Cave", "main")
        root = await world.user(main, "root", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(root) as client:
            # dock.test is served with this very certificate: nothing from elsewhere there.
            own = (await client.post(URL, json=uploaded)).json()
            assert own["fetched_before"] == []
            # auth.test is served with a certificate of another authority - one the proxy fetched.
            # A stored one next to it is not reliably served, whatever one look shows afterwards.
            second = (await client.post(URL, json=upload(authority, "Anmeldung", ["auth.test"]))).json()
            assert second["fetched_before"] == ["auth.test"]
            hosts = {item["host"]: item for item in (await client.get(URL)).json()["hosts"]}
            assert {host: item["takeover"] for host, item in hosts.items()} == {
                "dock.test": False,
                "auth.test": True,
                "sandbox.test": False,
                "apps.test": False,
            }
            # A renewal keeps the note: the proxy's own store has not changed.
            renewed = upload(authority, "x", ["auth.test", "sandbox.test"])
            del renewed["name"]
            again = (await client.put(f"{URL}/{second['id']}", json=renewed)).json()
            assert again["fetched_before"] == ["auth.test"]

        # Pruning the proxy's store settles it - also when there was nothing left to remove.
        storage = tmp_path / "acme.json"
        storage.write_text(json.dumps({"letsencrypt": {"Certificates": [{"domain": {"main": "auth.test"}}]}}))
        arguments = argparse.Namespace(command="cert", cert_command="prune-fetched", storage=str(storage))
        assert await cli.certificates(world.settings, arguments) == 0
        assert capsys.readouterr().out == "Removed the fetched certificate for auth.test.\n"
        async with await world.login(root) as client:
            state = (await client.get(URL)).json()
        assert [item["fetched_before"] for item in state["certificates"]] == [[], []]
        assert not any(item["takeover"] for item in state["hosts"])

    async def test_a_certificate_removed_a_moment_ago_and_still_served_is_not_taken_for_a_fetched_one(
        self, served: tuple[World, dict[str, str]], authority: Authority, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # dock.test is served with the certificate of the fixture throughout - as a proxy does
        # for the seconds until it has fetched its configuration again.
        world, uploaded = served
        main = await world.tenant("Admin Cave", "main")
        root = await world.user(main, "root", Role.TENANT_ADMIN, system_admin=True)
        async with await world.login(root) as client:
            first = (await client.post(URL, json=uploaded)).json()
            # Removed and stored anew at once, with another certificate for the same name.
            assert (await client.delete(f"{URL}/{first['id']}")).status_code == 204
            again = (await client.post(URL, json=upload(authority, "Neu", ["dock.test"]))).json()
            assert again["fetched_before"] == []
            # The same after a replacement: what is still served is the one that was replaced.
            renewed = upload(authority, "x", ["dock.test", "sandbox.test"])
            del renewed["name"]
            assert (await client.put(f"{URL}/{again['id']}", json=renewed)).json()["fetched_before"] == []
            hosts = {item["host"]: item["takeover"] for item in (await client.get(URL)).json()["hosts"]}
        assert hosts["dock.test"] is False
        # Long after the removal it would be another matter: then nothing of ours explains it.
        # (The log cannot be changed afterwards, so the test shortens "a moment ago" instead.)
        monkeypatch.setattr(certificates, "JUST_NOW", timedelta(0))
        async with await world.login(root) as client:
            for item in (await client.get(URL)).json()["certificates"]:
                await client.delete(f"{URL}/{item['id']}")
            late = (await client.post(URL, json=upload(authority, "Spät", ["dock.test"]))).json()
        assert late["fetched_before"] == ["dock.test"]

    async def test_the_command_line_says_when_a_takeover_is_needed(
        self, served: tuple[World, dict[str, str]], authority: Authority, capsys: pytest.CaptureFixture[str]
    ) -> None:
        world, _ = served
        certificate, key = authority.bundle("auth.test")
        add = argparse.Namespace(command="cert", cert_command="add", name="Anmeldung", replace=False)
        assert await cli.certificates(world.settings, add, certificate + key) == 0
        printed = capsys.readouterr()
        assert "warning: for auth.test the proxy holds a certificate it fetched itself" in printed.err
        assert "velydock cert takeover" in printed.err

    async def test_a_proxy_that_does_not_answer_and_an_installation_that_cannot_ask(
        self, settings: Settings, clean_db: None, directory: Path
    ) -> None:
        for address, source in (("127.0.0.1:1", "unreachable"), (None, "unknown")):
            world = installation(
                settings, proxy_secret=SECRET, certs_dir=str(directory), proxy_tls_address=address
            )
            main = await world.tenant(f"Main {source}")
            root = await world.user(main, f"root-{source}", Role.TENANT_ADMIN, system_admin=True)
            async with await world.login(root) as client:
                state = (await client.get(URL)).json()
            assert {item["served"]["source"] for item in state["hosts"]} == {source}
            assert [item["purpose"] for item in state["hosts"]] == ["velydock", "keycloak", "sandbox"]


class TestTheKeyStaysOutOfTheLog:
    async def test_a_statement_that_fails_is_reported_without_its_values(
        self, world: World, authority: Authority
    ) -> None:
        # A failing INSERT carries the key among its values; SQLAlchemy prints values unless told not to.
        assert get_engine().sync_engine.hide_parameters is True
        certificate, key = authority.bundle("dock.test")
        secret = key.splitlines()[1]
        with pytest.raises(DBAPIError) as caught:
            async with transaction(Scope.SYSTEM) as db:
                await db.execute(
                    text(
                        "INSERT INTO certificates (id, name, certificate, private_key, fingerprint, not_before) "
                        "VALUES (gen_random_uuid(), 'x', :certificate, :key, 'f', now())"
                    ),
                    {"certificate": certificate, "key": key},
                )
        assert secret not in str(caught.value) and "PRIVATE KEY" not in str(caught.value)

    async def test_names_with_control_characters_are_refused_before_the_database_sees_them(
        self, world: World, root: User
    ) -> None:
        certificate, key = issue("dock\x00.test", names=["dock.test"])
        async with await world.login(root) as client:
            answer = await client.post(
                URL, json={"name": "a", "certificate": pem(certificate), "private_key": key_pem(key)}
            )
        assert (answer.status_code, answer.json()["error"]["code"]) == (422, "certificate_unreadable")


class TestCommandLine:
    """`velydock cert …`, as the installer calls it."""

    @staticmethod
    def arguments(command: str, **more: Any) -> argparse.Namespace:
        return argparse.Namespace(command="cert", cert_command=command, **more)

    async def test_add_list_replace_remove(
        self, world: World, authority: Authority, capsys: pytest.CaptureFixture[str]
    ) -> None:
        settings = world.settings
        certificate, key = authority.bundle("dock.test", ["dock.test", "*.apps.test"])
        assert await cli.certificates(settings, self.arguments("list")) == 0
        assert "No certificates stored." in capsys.readouterr().out
        # One stream, as `cat fullchain.pem privkey.pem | velydock cert add` sends it.
        assert (
            await cli.certificates(
                settings, self.arguments("add", name="Firma", replace=False), certificate + key
            )
            == 0
        )
        printed = capsys.readouterr()
        assert "Stored Firma: valid for dock.test, *.apps.test until" in printed.out and printed.err == ""
        assert key.splitlines()[1] not in printed.out

        assert await cli.certificates(settings, self.arguments("list")) == 0
        assert capsys.readouterr().out.startswith("Firma\tdock.test, *.apps.test\tvalid until ")

        renewed_certificate, renewed_key = authority.bundle("dock.test", ["dock.test"])
        renewed = renewed_key + renewed_certificate
        assert (
            await cli.certificates(settings, self.arguments("add", name="Firma", replace=False), renewed) == 1
        )
        assert "exists already (use --replace" in capsys.readouterr().err
        assert (
            await cli.certificates(settings, self.arguments("add", name="firma", replace=True), renewed) == 0
        )
        assert "Stored Firma: valid for dock.test until" in capsys.readouterr().out

        async with transaction(Scope.SYSTEM) as db:
            rows = list((await db.execute(select(Certificate))).scalars())
            entries = list(
                (await db.execute(select(AuditLog).where(AuditLog.action.like("certificate.%")))).scalars()
            )
        assert [(row.name, row.names) for row in rows] == [("Firma", ["dock.test"])]
        # Nobody was signed in: the log says it was the system.
        assert sorted((entry.action, entry.actor_name) for entry in entries) == [
            ("certificate.add", "system"),
            ("certificate.replace", "system"),
        ]

        assert await cli.certificates(settings, self.arguments("remove", name="Nichts")) == 1
        assert "no certificate is called 'Nichts'" in capsys.readouterr().err
        assert await cli.certificates(settings, self.arguments("remove", name="FIRMA")) == 0
        async with transaction(Scope.SYSTEM) as db:
            assert (await db.execute(select(Certificate))).scalars().all() == []

    async def test_a_certificate_without_its_chain_is_stored_with_a_warning(
        self, world: World, authority: Authority, capsys: pytest.CaptureFixture[str]
    ) -> None:
        certificate, key = authority.leaf("dock.test")
        stream = pem(certificate) + key_pem(key)
        assert (
            await cli.certificates(world.settings, self.arguments("add", name="a", replace=False), stream)
            == 0
        )
        assert "the certificate of its issuer is not with it" in capsys.readouterr().err

    async def test_what_is_wrong_is_an_error_and_nothing_is_stored(
        self, world: World, authority: Authority
    ) -> None:
        certificate, _ = authority.bundle("dock.test")
        with pytest.raises(ApiError) as caught:
            await cli.certificates(
                world.settings, self.arguments("add", name="a", replace=False), certificate
            )
        assert caught.value.code == "key_missing"
        async with transaction(Scope.SYSTEM) as db:
            assert (await db.execute(select(Certificate))).scalars().all() == []
