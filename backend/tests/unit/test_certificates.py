"""Own certificates: what an upload must be like, and which name a certificate is valid for."""

from __future__ import annotations

import base64
import json
import stat
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization

from tests.support.certs import Authority, as_pkcs12, issue, key_pem, new_key, pem
from velydock import cli
from velydock.errors import ApiError
from velydock.services import certificates
from velydock.services.certificates import matching_name, parse


@pytest.fixture(scope="module")
def authority() -> Authority:
    return Authority.new()


def refused(**upload: str | None) -> str:
    with pytest.raises(ApiError) as caught:
        parse(**upload)  # type: ignore[arg-type]
    assert caught.value.status == 422
    return caught.value.code


class TestWhatIsAccepted:
    def test_certificate_chain_and_key_in_any_order_and_any_field(self, authority: Authority) -> None:
        certificate, key = authority.leaf("dock.example.com", ["dock.example.com", "*.apps.example.com"])
        chain, private = authority.fullchain(certificate), key_pem(key)
        root, intermediate = pem(authority.root[0]), pem(authority.intermediate[0])
        expected = None
        for upload in (
            {"certificate": chain, "private_key": private},
            # Everything in one text, the key first, the chain upside down, the root with it.
            {"certificate": private + root + intermediate + pem(certificate)},
            {"private_key": chain + private},
            # A key in the form OpenSSL used to write ("EC PRIVATE KEY").
            {"certificate": chain, "private_key": key_pem(key, traditional=True)},
            # Windows line ends and text around the blocks, as some authorities deliver it.
            {"certificate": ("Bag Attributes\r\n" + chain).replace("\n", "\r\n"), "private_key": private},
        ):
            parsed = parse(**upload)
            expected = expected or parsed
            assert parsed == expected
        assert expected is not None
        assert expected.names == ["dock.example.com", "*.apps.example.com"]
        # The certificate first, then the one that issued it. The root is not stored: clients have it.
        assert expected.chain == ["CN=dock.example.com", "CN=Test Intermediate"]
        assert expected.certificate == pem(certificate) + intermediate
        assert expected.subject == "CN=dock.example.com" and expected.issuer == "CN=Test Intermediate"
        assert expected.key_type == "EC P-256"
        assert expected.fingerprint == certificate.fingerprint(hashes.SHA256()).hex()
        assert len(expected.fingerprint) == 64
        assert expected.not_after == certificate.not_valid_after_utc

    def test_the_key_is_stored_in_one_form_without_a_passphrase(self, authority: Authority) -> None:
        certificate, key = authority.leaf("a.example.com", key=new_key("rsa2048"))
        protected = key_pem(key, "geheim")
        assert "ENCRYPTED" in protected
        parsed = parse(
            certificate=authority.fullchain(certificate), private_key=protected, passphrase="geheim"
        )
        assert parsed.private_key == key_pem(key)
        assert parsed.private_key.startswith("-----BEGIN PRIVATE KEY-----")
        assert parsed.key_type == "RSA 2048"
        # A passphrase for a key that has none is no reason to refuse it.
        assert parse(
            certificate=pem(certificate), private_key=key_pem(key), passphrase="x"
        ).private_key == key_pem(key)

    def test_certificates_that_do_not_lead_to_the_issuer_are_left_out(self, authority: Authority) -> None:
        certificate, key = authority.leaf("a.example.com")
        stranger = Authority.new("Other")
        parsed = parse(
            certificate=pem(stranger.intermediate[0])
            + authority.fullchain(certificate)
            + pem(stranger.root[0]),
            private_key=key_pem(key),
        )
        assert parsed.chain == ["CN=a.example.com", "CN=Test Intermediate"]

    def test_a_key_kept_at_a_renewal_means_the_newer_certificate(self, authority: Authority) -> None:
        key = new_key()
        old, _ = authority.leaf("a.example.com", key=key, days=5)
        new, _ = authority.leaf("a.example.com", key=key, days=300)
        for text_ in (pem(old) + pem(new), pem(new) + pem(old)):
            parsed = parse(certificate=text_ + pem(authority.intermediate[0]), private_key=key_pem(key))
            assert parsed.not_after == new.not_valid_after_utc
            assert parsed.chain == ["CN=a.example.com", "CN=Test Intermediate"]

    def test_the_files_for_the_proxy_are_named_by_what_is_stored(self, authority: Authority) -> None:
        certificate, key = authority.leaf("a.example.com")
        alone = parse(certificate=pem(certificate), private_key=key_pem(key))
        complete = parse(certificate=authority.fullchain(certificate), private_key=key_pem(key))
        # The same certificate, with and without its chain: one fingerprint, two files.
        assert alone.fingerprint == complete.fingerprint
        assert alone.files_key != complete.files_key and len(complete.files_key) == 64
        assert (
            parse(certificate=authority.fullchain(certificate), private_key=key_pem(key)).files_key
            == complete.files_key
        )

    def test_a_certificate_signed_by_itself(self) -> None:
        certificate, key = issue("intern.example", names=["intern.example", "10.1.2.3"])
        parsed = parse(certificate=pem(certificate), private_key=key_pem(key))
        assert parsed.chain == ["CN=intern.example"] and parsed.names == ["intern.example", "10.1.2.3"]
        assert parsed.warnings == []

    def test_says_when_the_certificate_of_the_issuer_is_missing(self, authority: Authority) -> None:
        certificate, key = authority.leaf("a.example.com")
        alone = parse(certificate=pem(certificate), private_key=key_pem(key))
        assert (alone.chain, alone.warnings) == (["CN=a.example.com"], ["no_intermediate"])
        # A certificate that has nothing to do with it does not count as the issuer's.
        stranger = Authority.new("Other")
        assert parse(
            certificate=pem(certificate) + pem(stranger.intermediate[0]), private_key=key_pem(key)
        ).warnings == ["no_intermediate"]
        assert parse(certificate=authority.fullchain(certificate), private_key=key_pem(key)).warnings == []
        # Issued by a root directly, and the root is given: it is not stored (clients have it),
        # and nothing is missing.
        direct, direct_key = issue("b.example.com", names=["b.example.com"], issuer=authority.root)
        with_root = parse(certificate=pem(direct) + pem(authority.root[0]), private_key=key_pem(direct_key))
        assert (with_root.chain, with_root.warnings) == (["CN=b.example.com"], [])

    def test_a_pkcs12_file_with_its_passphrase(self, authority: Authority) -> None:
        certificate, key = authority.leaf("a.example.com", key=new_key("p384"))
        chain = [authority.intermediate[0], authority.root[0]]
        for passphrase in ("geheim", None):
            parsed = parse(
                pkcs12_file=base64.b64encode(as_pkcs12(certificate, key, chain, passphrase)).decode(),
                passphrase=passphrase,
            )
            assert (parsed.names, parsed.key_type) == (["a.example.com"], "EC P-384")
            assert parsed.chain == ["CN=a.example.com", "CN=Test Intermediate"]
            assert parsed.private_key == key_pem(key)

    def test_names_are_read_in_lower_case_and_once(self) -> None:
        certificate, key = issue("x", names=["Dock.Example.COM", "dock.example.com", "*.Apps.example.com"])
        assert parse(certificate=pem(certificate), private_key=key_pem(key)).names == [
            "dock.example.com",
            "*.apps.example.com",
        ]


class TestWhatIsRefused:
    def test_a_key_that_belongs_to_another_certificate(self, authority: Authority) -> None:
        chain, _ = authority.bundle("a.example.com")
        assert refused(certificate=chain, private_key=key_pem(new_key())) == "key_mismatch"
        # The key of the issuer is not the key of the certificate either.
        assert refused(certificate=chain, private_key=key_pem(authority.intermediate[1])) != ""

    def test_a_protected_key_without_or_with_the_wrong_passphrase(self, authority: Authority) -> None:
        certificate, key = authority.leaf("a.example.com")
        chain = authority.fullchain(certificate)
        for protected in (key_pem(key, "geheim"), key_pem(key, "geheim", traditional=True)):
            assert refused(certificate=chain, private_key=protected) == "key_encrypted"
            assert (
                refused(certificate=chain, private_key=protected, passphrase="falsch") == "passphrase_wrong"
            )

    @pytest.mark.parametrize("kind", ["rsa1024", "p521", "ed25519"])
    def test_a_key_browsers_do_not_accept(self, kind: str) -> None:
        certificate, key = issue("a.example.com", names=["a.example.com"], key=new_key(kind))
        assert refused(certificate=pem(certificate), private_key=key_pem(key)) == "key_unsupported"

    def test_a_certificate_that_names_no_host(self) -> None:
        certificate, key = issue("a.example.com", names=None)
        assert refused(certificate=pem(certificate), private_key=key_pem(key)) == "no_names"

    def test_an_expired_certificate_and_one_that_is_not_valid_yet(self, authority: Authority) -> None:
        certificate, key = authority.leaf("a.example.com", days=10, starts_in_days=-20)
        assert refused(certificate=pem(certificate), private_key=key_pem(key)) == "expired"
        # Stored, it would be served at once, and no other certificate fetched for its name.
        later, later_key = authority.leaf("a.example.com", starts_in_days=1)
        assert refused(certificate=pem(later), private_key=key_pem(later_key)) == "not_yet_valid"
        # Judged at the moment of the upload.
        on_the_day = later.not_valid_before_utc + timedelta(seconds=1)
        assert parse(certificate=pem(later), private_key=key_pem(later_key), now=on_the_day).names == [
            "a.example.com"
        ]
        at_the_end = later.not_valid_after_utc + timedelta(seconds=1)
        with pytest.raises(ApiError):
            parse(certificate=pem(later), private_key=key_pem(later_key), now=at_the_end)

    def test_a_common_name_that_is_a_host_the_certificate_is_not_valid_for(self) -> None:
        # The proxy takes the common name for a host name too: this one would be served for
        # dock.example.com, and browsers would refuse it there.
        certificate, key = issue("dock.example.com", names=["intranet.example.com"])
        assert refused(certificate=pem(certificate), private_key=key_pem(key)) == "common_name_not_listed"
        # A common name that is one of the names, or covered by a wildcard among them, or no
        # host name at all, is fine.
        for common, names in (
            ("dock.example.com", ["dock.example.com", "auth.example.com"]),
            ("DOCK.example.com", ["dock.example.com"]),
            ("dock.example.com", ["*.example.com"]),
            ("*.example.com", ["*.example.com"]),
            ("Firma GmbH", ["dock.example.com"]),
            ("intranet", ["dock.example.com"]),
        ):
            certificate, key = issue(common, names=names)
            assert parse(certificate=pem(certificate), private_key=key_pem(key)).names == names

    def test_names_with_control_characters(self) -> None:
        for common, names in (
            ("dock\x00.example.com", ["dock.example.com"]),
            ("Firma\nGmbH", ["dock.example.com"]),
        ):
            certificate, key = issue(common, names=names)
            assert refused(certificate=pem(certificate), private_key=key_pem(key)) == "certificate_unreadable"

    def test_what_is_missing_or_too_much(self, authority: Authority) -> None:
        chain, key = authority.bundle("a.example.com")
        assert refused(certificate=chain) == "key_missing"
        assert refused(private_key=key) == "certificate_missing"
        assert refused(certificate="", private_key="") == "certificate_missing"
        assert refused(certificate=chain, private_key=key + key_pem(new_key())) == "several_keys"
        assert refused(certificate=chain * 6, private_key=key) == "too_many_certificates"
        assert refused(certificate="x" * (2 * certificates.MAX_PEM), private_key=key) == "too_large"
        assert refused(certificate=chain, private_key=key, pkcs12_file="AAAA") == "ambiguous"

    def test_what_cannot_be_read(self, authority: Authority) -> None:
        chain, key = authority.bundle("a.example.com")
        broken = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"
        assert refused(certificate=broken, private_key=key) == "certificate_unreadable"
        broken_key = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"
        assert refused(certificate=chain, private_key=broken_key) == "key_unreadable"
        # A file in binary form (DER) read as text: there is nothing in it that looks like PEM.
        certificate, _ = authority.leaf("b.example.com")
        der = certificate.public_bytes(serialization.Encoding.DER).decode("latin-1")
        assert refused(certificate=der, private_key=key) == "certificate_missing"

    def test_a_pkcs12_file_that_does_not_open(self, authority: Authority) -> None:
        certificate, key = authority.leaf("a.example.com")
        file = base64.b64encode(as_pkcs12(certificate, key, [], "geheim")).decode()
        assert refused(pkcs12_file=file, passphrase="falsch") == "pkcs12_unreadable"
        assert refused(pkcs12_file=file) == "pkcs12_unreadable"
        assert refused(pkcs12_file="kein base64!") == "pkcs12_unreadable"
        assert refused(pkcs12_file=base64.b64encode(b"x" * 200_000).decode()) == "too_large"
        only_certificate = base64.b64encode(as_pkcs12(certificate, None, [], None)).decode()
        assert refused(pkcs12_file=only_certificate) == "key_missing"

    def test_no_message_repeats_the_key(self, authority: Authority) -> None:
        chain, _ = authority.bundle("a.example.com")
        other = key_pem(new_key())
        with pytest.raises(ApiError) as caught:
            parse(certificate=chain, private_key=other)
        secret = other.splitlines()[1]
        assert secret not in caught.value.message and secret not in str(caught.value.details)


class TestWhichNameCounts:
    @pytest.mark.parametrize(
        ("names", "host", "expected"),
        [
            (["dock.example.com"], "dock.example.com", "dock.example.com"),
            (["dock.example.com"], "DOCK.example.com.", "dock.example.com"),
            (["dock.example.com"], "auth.example.com", None),
            # A wildcard stands for exactly one label.
            (["*.example.com"], "dock.example.com", "*.example.com"),
            (["*.example.com"], "example.com", None),
            (["*.example.com"], "a.dock.example.com", None),
            (["*.apps.example.com"], "wiki.apps.example.com", "*.apps.example.com"),
            # Not a pattern in the middle, and not a suffix match.
            (["*.example.com"], "dockexample.com", None),
            (["example.com"], "dock.example.com", None),
            # The exact name before the wildcard, whatever the order.
            (["*.example.com", "dock.example.com"], "dock.example.com", "dock.example.com"),
            (["10.1.2.3"], "10.1.2.3", "10.1.2.3"),
            (["2001:db8::1"], "[2001:DB8::1]", "2001:db8::1"),
            ([], "dock.example.com", None),
            (["*.com"], "localhost", None),
        ],
    )
    def test_as_browsers_read_it(self, names: list[str], host: str, expected: str | None) -> None:
        assert matching_name(names, host) == expected


def stored(*keys: str) -> list[SimpleNamespace]:
    return [SimpleNamespace(proxy_key=key, name=key) for key in keys]


class TestWhichCertificateTheProxyTakes:
    """Traefik's own rule (pkg/tls/certificate_store.go), which this code must predict exactly."""

    def test_the_key_is_common_name_and_names_sorted(self) -> None:
        certificate, _ = issue(
            "Zeta.Example.com", names=["dock.example.com", "*.Apps.example.com", "10.1.2.3"]
        )
        assert (
            certificates.proxy_key(certificate)
            == "*.apps.example.com,10.1.2.3,dock.example.com,zeta.example.com"
        )
        # A name that is the common name too is in it once.
        same, _ = issue("dock.example.com", names=["dock.example.com", "auth.example.com"])
        assert certificates.proxy_key(same) == "auth.example.com,dock.example.com"
        unnamed, _ = issue("only-a-common-name")
        assert certificates.proxy_key(unnamed) == "only-a-common-name"

    @pytest.mark.parametrize(
        ("key", "host", "expected"),
        [
            ("dock.example.com", "dock.example.com", True),
            ("auth.example.com,dock.example.com", "DOCK.example.com", True),
            ("*.example.com", "dock.example.com", True),
            ("*.example.com", "example.com", False),
            ("*.example.com", "a.dock.example.com", False),
            ("dock.example.com", "auth.example.com", False),
            ("dock.example.com.", "dock.example.com", False),
            ("*.example.com.", "dock.example.com", True),
            # The common name counts for the proxy, whatever browsers think of it.
            ("dock.example.com,other.example.org", "other.example.org", True),
        ],
    )
    def test_which_names_a_key_matches(self, key: str, host: str, expected: bool) -> None:
        assert certificates.key_matches(key, host) is expected

    def test_among_several_the_greatest_key_wins(self) -> None:
        def chosen(keys: list[str], host: str) -> str | None:
            row = certificates.chosen_for(stored(*keys), host)  # type: ignore[arg-type]
            return row.proxy_key if row else None

        wildcard, exact, pair = "*.example.com", "dock.example.com", "auth.example.com,dock.example.com"
        # An exact name before a wildcard - because "*" sorts before every letter and digit …
        assert chosen([wildcard, exact], "dock.example.com") == exact
        assert chosen([exact, wildcard], "auth.example.com") == wildcard
        # … and between two that both name the host, the one whose key sorts last.
        assert chosen([pair, exact], "dock.example.com") == exact
        assert chosen([exact, "dock.example.com,zeta.example.com"], "dock.example.com") == (
            "dock.example.com,zeta.example.com"
        )
        assert chosen([wildcard], "example.org") is None
        assert chosen([], "dock.example.com") is None


class TestTheProxysOwnStore:
    """acme.json as Traefik 3 writes it; only the parts this code looks at."""

    @staticmethod
    def storage(tmp_path: Path, *fetched: tuple[str, list[str]]) -> Path:
        path = tmp_path / "acme.json"
        path.write_text(
            json.dumps(
                {
                    "letsencrypt": {
                        "Account": {"Email": "admin@example.com", "PrivateKey": "account-key"},
                        "Certificates": [
                            {
                                "domain": {"main": main, **({"sans": sans} if sans else {})},
                                "certificate": f"certificate of {main}",
                                "key": f"key of {main}",
                                "Store": "default",
                            }
                            for main, sans in fetched
                        ],
                    }
                }
            )
        )
        path.chmod(0o600)
        return path

    def test_fetched_certificates_for_taken_over_names_go_and_nothing_else(self, tmp_path: Path) -> None:
        path = self.storage(
            tmp_path,
            ("dock.example.com", ["sandbox.example.com"]),
            ("auth.example.com", []),
            ("wiki.apps.example.com", []),
            ("other.example.org", []),
        )
        removed = certificates.prune_fetched(path, stored("*.apps.example.com", "dock.example.com"))  # type: ignore[arg-type]
        # The one for dock and sandbox goes as a whole: the proxy fetches sandbox anew.
        assert removed == ["dock.example.com, sandbox.example.com", "wiki.apps.example.com"]
        left = json.loads(path.read_text())["letsencrypt"]
        assert [entry["domain"]["main"] for entry in left["Certificates"]] == [
            "auth.example.com",
            "other.example.org",
        ]
        assert left["Certificates"][0] == {
            "domain": {"main": "auth.example.com"},
            "certificate": "certificate of auth.example.com",
            "key": "key of auth.example.com",
            "Store": "default",
        }
        # The account with the authority stays, and the file is still the proxy's alone.
        assert left["Account"] == {"Email": "admin@example.com", "PrivateKey": "account-key"}
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        assert [entry.name for entry in tmp_path.iterdir()] == ["acme.json"]

    def test_nothing_to_do_leaves_the_file_alone(self, tmp_path: Path) -> None:
        path = self.storage(tmp_path, ("auth.example.com", []))
        before = (path.stat().st_ino, path.read_text())
        assert certificates.prune_fetched(path, stored("dock.example.com")) == []  # type: ignore[arg-type]
        assert certificates.prune_fetched(path, []) == []
        assert (path.stat().st_ino, path.read_text()) == before
        # A store the proxy has not written yet.
        empty = tmp_path / "empty.json"
        empty.write_text("")
        assert certificates.prune_fetched(empty, stored("dock.example.com")) == []  # type: ignore[arg-type]

    def test_a_file_that_is_not_the_proxys_is_not_rewritten(self, tmp_path: Path) -> None:
        other = tmp_path / "other.json"
        for content in ('["a"]', '{"letsencrypt": {"Certificates": "x"}}', '{"x": 1}'):
            other.write_text(content)
            assert certificates.prune_fetched(other, stored("dock.example.com")) == []  # type: ignore[arg-type]
            assert other.read_text() == content
        other.write_text("{not json")
        with pytest.raises(json.JSONDecodeError):
            certificates.prune_fetched(other, stored("dock.example.com"))  # type: ignore[arg-type]
        with pytest.raises(FileNotFoundError):
            certificates.prune_fetched(tmp_path / "missing.json", [])


class TestFilesForTheProxy:
    def test_writes_what_is_missing_and_removes_what_it_wrote_before(self, tmp_path: Path) -> None:
        one, two = "a" * 64, "b" * 64
        (tmp_path / f"{two}.crt").write_text("old")
        (tmp_path / f"{two}.key").write_text("old")
        (tmp_path / ".x.tmp").write_text("left over from a write that was interrupted")
        (tmp_path / "README").write_text("not ours")
        (tmp_path / "abc.crt").write_text("not ours either")
        certificates._sync(tmp_path, {f"{one}.crt": "CERT", f"{one}.key": "KEY"})
        assert {entry.name for entry in tmp_path.iterdir()} == {
            "README",
            "abc.crt",
            f"{one}.crt",
            f"{one}.key",
        }
        assert (tmp_path / f"{one}.key").read_text() == "KEY"
        for name in (f"{one}.crt", f"{one}.key"):
            # Owner and group, nobody else.
            assert stat.S_IMODE((tmp_path / name).stat().st_mode) == 0o640

    def test_a_file_that_is_there_is_not_written_again(self, tmp_path: Path) -> None:
        name = "c" * 64 + ".crt"
        certificates._sync(tmp_path, {name: "CERT"})
        before = (tmp_path / name).stat().st_ino
        certificates._sync(tmp_path, {name: "CERT"})
        assert (tmp_path / name).stat().st_ino == before


def test_the_test_authority_issues_what_it_says(authority: Authority) -> None:
    # The helpers above are only worth something if the chain they build is a real one.
    certificate, _ = authority.leaf("a.example.com")
    certificate.verify_directly_issued_by(authority.intermediate[0])
    authority.intermediate[0].verify_directly_issued_by(authority.root[0])
    assert isinstance(certificate, x509.Certificate)


def test_the_command_line_says_what_is_wrong_and_fails(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def refuse(settings: object, args: object) -> int:
        return parse(certificate="nothing in here") and 0

    monkeypatch.setattr(cli, "get_settings", lambda: SimpleNamespace(log_level="INFO"))
    monkeypatch.setattr(cli, "_configure_logging", lambda level: None)
    monkeypatch.setattr(cli, "_certificates_and_close", refuse)
    assert cli.main(["cert", "add", "--name", "a"]) == 1
    printed = capsys.readouterr()
    assert printed.err.startswith("error: No certificate found.") and printed.out == ""
    # A name is required: without one nothing is read at all.
    with pytest.raises(SystemExit):
        cli.main(["cert", "add"])
