"""Certificates made for the tests: a small authority with an intermediate, and what it issues."""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID


def _name(common: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common)])


def pem(certificate: x509.Certificate) -> str:
    return certificate.public_bytes(serialization.Encoding.PEM).decode()


def key_pem(key: Any, passphrase: str | None = None, *, traditional: bool = False) -> str:
    encryption: serialization.KeySerializationEncryption = (
        serialization.BestAvailableEncryption(passphrase.encode())
        if passphrase
        else serialization.NoEncryption()
    )
    form = (
        serialization.PrivateFormat.TraditionalOpenSSL if traditional else serialization.PrivateFormat.PKCS8
    )
    data: bytes = key.private_bytes(serialization.Encoding.PEM, form, encryption)
    return data.decode()


def new_key(kind: str = "ec") -> Any:
    if kind == "ec":
        return ec.generate_private_key(ec.SECP256R1())
    if kind == "p384":
        return ec.generate_private_key(ec.SECP384R1())
    if kind == "p521":
        return ec.generate_private_key(ec.SECP521R1())
    if kind == "ed25519":
        return ed25519.Ed25519PrivateKey.generate()
    if kind.startswith("rsa"):
        return rsa.generate_private_key(public_exponent=65537, key_size=int(kind[3:] or 2048))
    raise ValueError(kind)


def issue(
    common: str,
    *,
    names: list[str] | None = None,
    key: Any = None,
    issuer: tuple[x509.Certificate, Any] | None = None,
    ca: bool = False,
    days: int = 90,
    starts_in_days: int = -1,
) -> tuple[x509.Certificate, Any]:
    """A certificate for `names`, signed by `issuer` (or by itself)."""
    key = key or new_key()
    now = datetime.now(UTC)
    builder = (
        x509.CertificateBuilder()
        .subject_name(_name(common))
        .issuer_name(issuer[0].subject if issuer else _name(common))
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now + timedelta(days=starts_in_days))
        .not_valid_after(now + timedelta(days=starts_in_days + days))
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
    )
    if names:
        entries: list[x509.GeneralName] = []
        for name in names:
            try:
                entries.append(x509.IPAddress(ipaddress.ip_address(name)))
            except ValueError:
                entries.append(x509.DNSName(name))
        builder = builder.add_extension(x509.SubjectAlternativeName(entries), critical=False)
    signer = issuer[1] if issuer else key
    algorithm = None if isinstance(signer, ed25519.Ed25519PrivateKey) else hashes.SHA256()
    return builder.sign(signer, algorithm), key


@dataclass
class Authority:
    """A root, an intermediate below it, and certificates issued by the intermediate."""

    root: tuple[x509.Certificate, Any]
    intermediate: tuple[x509.Certificate, Any]

    @classmethod
    def new(cls, label: str = "Test") -> Authority:
        root = issue(f"{label} Root", ca=True, days=3650)
        return cls(root=root, intermediate=issue(f"{label} Intermediate", ca=True, issuer=root, days=1825))

    def leaf(self, common: str, names: list[str] | None = None, **more: Any) -> tuple[x509.Certificate, Any]:
        return issue(common, names=names if names is not None else [common], issuer=self.intermediate, **more)

    def fullchain(self, certificate: x509.Certificate) -> str:
        """The certificate with what leads to its issuer, as a CA hands it out."""
        return pem(certificate) + pem(self.intermediate[0])

    def bundle(self, common: str, names: list[str] | None = None, **more: Any) -> tuple[str, str]:
        """Certificate with chain, and key, both as PEM."""
        certificate, key = self.leaf(common, names, **more)
        return self.fullchain(certificate), key_pem(key)


def as_pkcs12(
    certificate: x509.Certificate, key: Any, chain: list[x509.Certificate], passphrase: str | None
) -> bytes:
    encryption: serialization.KeySerializationEncryption = (
        serialization.BestAvailableEncryption(passphrase.encode())
        if passphrase
        else serialization.NoEncryption()
    )
    return pkcs12.serialize_key_and_certificates(b"test", key, certificate, chain, encryption)
