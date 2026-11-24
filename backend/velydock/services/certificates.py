"""Own TLS certificates for the bundled reverse proxy.

A system administrator uploads a certificate with its private key; the proxy serves it for every
name the certificate is valid for - Velydock itself, the sign-in, the sandbox, published apps.

How it gets to the proxy: the database is the one place where certificates are kept (so a backup
of the database has them). Velydock writes them as files into a directory the proxy has mounted
and names these files in the configuration the proxy fetches (see services/proxy.py). The
private key itself never travels over the network, and no API returns it.

What is refused here is refused so that nothing reaches the proxy that it would silently skip:
a key that does not belong to the certificate, a key type browsers do not accept, a certificate
without names, an expired one. Tried with the real proxy: a certificate it cannot load is left
out without a word, and browsers get its self-signed default certificate instead.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import hashlib
import ipaddress
import json
import logging
import os
import re
import secrets
import ssl
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from velydock.api.deps import Principal
from velydock.config import Settings
from velydock.db import system_scope
from velydock.errors import ApiError, conflict, invalid, not_found
from velydock.models import AppPublication, AuditLog, Certificate, PublicationMode
from velydock.schemas import (
    CertificateHost,
    CertificateIn,
    CertificateOut,
    CertificateReplace,
    CertificatesOut,
    ServedCertificate,
)
from velydock.services import audit

log = logging.getLogger(__name__)

# A certificate with a long chain is a few kilobytes; a PKCS#12 file with it not much more.
MAX_PEM = 64 * 1024
MAX_PKCS12 = 96 * 1024
MAX_CERTIFICATES = 10
EXPIRES_SOON = timedelta(days=30)
# How long a removed certificate may still be served: the proxy fetches its configuration every
# few seconds and then needs a moment to apply it.
JUST_NOW = timedelta(seconds=60)
# What the proxy presents when it has nothing for a name.
PROXY_DEFAULT_SUBJECT = "TRAEFIK DEFAULT CERT"

_BLOCK = re.compile(r"-----BEGIN ([A-Z0-9 ]+)-----.+?-----END \1-----", re.DOTALL)
_DNS_NAME = re.compile(
    r"^(\*\.)?[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$"
)
_FILE = re.compile(r"^[0-9a-f]{64}\.(crt|key)$")


@dataclass(frozen=True)
class Parsed:
    """An upload that passed every check, in the form it is stored in."""

    certificate: str
    private_key: str
    fingerprint: str
    names: list[str]
    subject: str
    issuer: str
    chain: list[str]
    serial: str
    key_type: str
    not_before: datetime
    not_after: datetime
    warnings: list[str]
    proxy_key: str
    files_key: str


# ---- reading an upload ---------------------------------------------------------------------------


def _problem(code: str, message: str, **details: object) -> ApiError:
    return invalid(message, code=code, details=dict(details) or None)


def _load_key(block: str, passphrase: str | None) -> object:
    encrypted = "ENCRYPTED" in block
    password = passphrase.encode() if passphrase else None
    try:
        return serialization.load_pem_private_key(block.encode(), password=password)
    except TypeError:
        if password is None:
            raise _problem(
                "key_encrypted",
                "The private key is protected by a passphrase. Enter the passphrase with it.",
            ) from None
        # A passphrase for a key that has none: the key is what counts.
        try:
            return serialization.load_pem_private_key(block.encode(), password=None)
        except (TypeError, ValueError):
            raise _problem("key_unreadable", "The private key cannot be read.") from None
    except ValueError:
        if encrypted and password is not None:
            raise _problem("passphrase_wrong", "The passphrase does not open the private key.") from None
        raise _problem("key_unreadable", "The private key cannot be read.") from None


def _key_type(key: object) -> str:
    """What browsers accept in a server certificate - and nothing else."""
    if isinstance(key, rsa.RSAPrivateKey):
        if not 2048 <= key.key_size <= 8192:
            raise _problem(
                "key_unsupported",
                f"An RSA key of {key.key_size} bits is not accepted: use 2048 to 8192 bits.",
            )
        return f"RSA {key.key_size}"
    if isinstance(key, ec.EllipticCurvePrivateKey):
        curves = {"secp256r1": "P-256", "secp384r1": "P-384"}
        if key.curve.name not in curves:
            raise _problem(
                "key_unsupported",
                f"The curve {key.curve.name} is not accepted by browsers: use P-256 or P-384.",
            )
        return f"EC {curves[key.curve.name]}"
    raise _problem(
        "key_unsupported", "This kind of key is not accepted by browsers: use RSA or ECDSA (P-256, P-384)."
    )


def _public(key_or_cert: object) -> bytes:
    public = key_or_cert.public_key()  # type: ignore[attr-defined]
    data: bytes = public.public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    return data


def _issued_by(certificate: x509.Certificate, issuer: x509.Certificate) -> bool:
    if certificate.issuer != issuer.subject:
        return False
    try:
        certificate.verify_directly_issued_by(issuer)
    except Exception:
        return False
    return True


def _names_of(certificate: x509.Certificate) -> list[str]:
    try:
        san = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return []
    names: list[str] = []
    for value in san.get_values_for_type(x509.DNSName):
        name = value.strip().lower().rstrip(".")
        if _DNS_NAME.fullmatch(name) and name not in names:
            names.append(name)
    for address in san.get_values_for_type(x509.IPAddress):
        if str(address) not in names:
            names.append(str(address))
    return names


def proxy_key(certificate: x509.Certificate) -> str:
    """The key Traefik files a certificate under (pkg/tls/certificate_store.go, v3.7).

    The common name, then the DNS names and addresses of the certificate that differ from it,
    in lower case, sorted, joined by commas. Traefik matches a server name against the parts of
    this key - the common name included, though browsers have not looked at it for years.
    """
    common = [
        str(item.value) for item in certificate.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
    ]
    name = common[-1] if common else ""
    parts = [name.lower()] if name else []
    try:
        san = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        san = None
    if san is not None:
        parts += [value.lower() for value in san.get_values_for_type(x509.DNSName) if value != name]
        parts += [
            str(value).lower() for value in san.get_values_for_type(x509.IPAddress) if str(value) != name
        ]
    return ",".join(sorted(parts))


def _from_pkcs12(data: str, passphrase: str | None) -> tuple[object, list[x509.Certificate]]:
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise _problem("pkcs12_unreadable", "The PKCS#12 file cannot be read.") from None
    if len(raw) > MAX_PKCS12:
        raise _problem("too_large", "The file is too large for a certificate.")
    try:
        key, certificate, more = pkcs12.load_key_and_certificates(
            raw, passphrase.encode() if passphrase else None
        )
    except Exception:
        raise _problem(
            "pkcs12_unreadable",
            "The PKCS#12 file cannot be read: it is damaged, or the passphrase is not the right one.",
        ) from None
    if key is None:
        raise _problem("key_missing", "The file holds no private key.")
    certificates = ([certificate] if certificate is not None else []) + list(more)
    return key, certificates


def _from_pem(text: str, passphrase: str | None) -> tuple[object, list[x509.Certificate]]:
    blocks = [(match.group(1), match.group(0)) for match in _BLOCK.finditer(text)]
    keys = [block for label, block in blocks if label.endswith("PRIVATE KEY")]
    pems = [block for label, block in blocks if label in ("CERTIFICATE", "TRUSTED CERTIFICATE")]
    if not pems:
        raise _problem(
            "certificate_missing",
            "No certificate found. It is expected as PEM: text that starts with -----BEGIN CERTIFICATE-----.",
        )
    if not keys:
        raise _problem(
            "key_missing",
            "No private key found. It is expected as PEM: text that starts with -----BEGIN PRIVATE KEY-----.",
        )
    if len(keys) > 1:
        raise _problem("several_keys", "More than one private key was given: exactly one is expected.")
    if len(pems) > MAX_CERTIFICATES:
        raise _problem("too_many_certificates", f"More than {MAX_CERTIFICATES} certificates were given.")
    certificates = []
    for pem in pems:
        try:
            certificates.append(x509.load_pem_x509_certificate(pem.encode()))
        except ValueError:
            raise _problem("certificate_unreadable", "A certificate cannot be read.") from None
    return _load_key(keys[0], passphrase), certificates


def parse(
    *,
    certificate: str | None = None,
    private_key: str | None = None,
    pkcs12_file: str | None = None,
    passphrase: str | None = None,
    now: datetime | None = None,
) -> Parsed:
    """Check an upload and bring it into the stored form, or say what is wrong with it."""
    now = now or datetime.now(UTC)
    if pkcs12_file:
        if certificate or private_key:
            raise _problem("ambiguous", "Give either a PKCS#12 file or certificate and key as PEM, not both.")
        key, certificates = _from_pkcs12(pkcs12_file, passphrase)
    else:
        text = f"{certificate or ''}\n{private_key or ''}"
        if len(text) > 2 * MAX_PEM:
            raise _problem("too_large", "The text is too large for a certificate.")
        key, certificates = _from_pem(text, passphrase)
    key_type = _key_type(key)

    own = _public(key)
    belonging = [cert for cert in certificates if _public(cert) == own]
    if not belonging:
        raise _problem(
            "key_mismatch", "The private key does not belong to the certificate (or to any of those given)."
        )
    # A key that was kept at a renewal fits the old certificate and the new one: the new one is meant.
    leaf = max(belonging, key=lambda cert: cert.not_valid_after_utc)

    # The certificates that lead from it to its issuer, in that order; the others are left out.
    # A root at the end is left out as well: clients have their own copy and ignore one sent.
    chain = [leaf]
    rest = [cert for cert in certificates if cert is not leaf]
    while chain[-1].issuer != chain[-1].subject and len(chain) < MAX_CERTIFICATES:
        issuer = next((cert for cert in rest if _issued_by(chain[-1], cert)), None)
        if issuer is None:
            break
        rest.remove(issuer)
        chain.append(issuer)
    if len(chain) > 1 and chain[-1].issuer == chain[-1].subject:
        chain.pop()
    warnings = []
    # Issued by somebody else, and that somebody's certificate was not given: browsers that have
    # not seen the issuer before refuse the connection. (Issued directly by a root that was
    # given is no such case - there is nothing between the two to send.)
    if leaf.issuer != leaf.subject and not any(_issued_by(leaf, cert) for cert in certificates):
        warnings.append("no_intermediate")

    names = _names_of(leaf)
    if not names:
        raise _problem(
            "no_names",
            "The certificate names no host (no subject alternative name). Browsers do not accept such a "
            "certificate: the common name alone has not counted for years.",
        )
    not_before, not_after = leaf.not_valid_before_utc, leaf.not_valid_after_utc
    if not_after <= now:
        raise _problem(
            "expired", f"The certificate expired on {not_after:%Y-%m-%d}.", not_after=not_after.isoformat()
        )
    if not_before > now:
        # Stored, it would be served at once - and no other certificate fetched for its names.
        raise _problem(
            "not_yet_valid",
            f"The certificate is valid from {not_before:%Y-%m-%d} only. Store it on that day.",
            not_before=not_before.isoformat(),
        )
    # The proxy takes the common name for a host name too. One that is a host name and not
    # among the certificate's names would be served for that host - and refused by browsers.
    common = [str(item.value) for item in leaf.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)]
    for name in common:
        candidate = name.strip().lower().rstrip(".")
        if "." in candidate and _DNS_NAME.fullmatch(candidate) and matching_name(names, candidate) is None:
            raise _problem(
                "common_name_not_listed",
                f"The common name {candidate} is not among the names the certificate is valid for "
                f"({', '.join(names)}). The proxy would serve it for {candidate}, and browsers would "
                "refuse it.",
                common_name=candidate,
            )
    key_for_proxy = proxy_key(leaf)
    described = [key_for_proxy, leaf.subject.rfc4514_string(), leaf.issuer.rfc4514_string()]
    if any(ord(char) < 32 or ord(char) == 127 for text_ in described for char in text_):
        raise _problem("certificate_unreadable", "The names in the certificate contain control characters.")

    def pem(cert: x509.Certificate) -> str:
        return cert.public_bytes(serialization.Encoding.PEM).decode()

    stored_key: bytes = key.private_bytes(  # type: ignore[attr-defined]
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    )
    stored_chain = "".join(pem(cert) for cert in chain)
    return Parsed(
        certificate=stored_chain,
        private_key=stored_key.decode(),
        fingerprint=leaf.fingerprint(hashes.SHA256()).hex(),
        names=names,
        subject=leaf.subject.rfc4514_string()[:500],
        issuer=leaf.issuer.rfc4514_string()[:500],
        chain=[cert.subject.rfc4514_string()[:500] for cert in chain],
        serial=f"{leaf.serial_number:X}"[:80],
        key_type=key_type,
        not_before=not_before,
        not_after=not_after,
        warnings=warnings,
        proxy_key=key_for_proxy,
        files_key=hashlib.sha256(stored_chain.encode() + b"\n" + stored_key).hexdigest(),
    )


# ---- which name a certificate is valid for --------------------------------------------------------


def matching_name(names: Iterable[str], host: str) -> str | None:
    """The name among `names` that makes a certificate valid for `host`, an exact one first.

    A wildcard stands for exactly one label, as browsers read it: *.example.com is valid for
    a.example.com, not for example.com and not for a.b.example.com.
    """
    host = host.lower().rstrip(".")
    with contextlib.suppress(ValueError):
        host = str(ipaddress.ip_address(host.strip("[]")))
    wildcard = None
    for name in names:
        if name == host:
            return name
        if name.startswith("*.") and "." in host and host.split(".", 1)[1] == name[2:]:
            wildcard = name
    return wildcard


def key_matches(key: str, host: str) -> bool:
    """Whether Traefik takes a certificate with this key for a server name (its `matchDomain`)."""
    host = host.lower().rstrip(".")
    labels = host.split(".")
    labels[0] = "*"
    wildcard = ".".join(labels)
    return any(part == host or part.rstrip(".") == wildcard for part in key.split(","))


def chosen_for(rows: Iterable[Certificate], host: str) -> Certificate | None:
    """The stored certificate the proxy serves for a host, by the proxy's own rule.

    Traefik goes through its certificates by key, the greatest key first, and takes the first
    that matches. Among the stored ones that is the answer; whether a certificate the proxy
    fetched by itself comes before it is another matter (see `fetched_for`).
    """
    matching = [row for row in rows if key_matches(row.proxy_key, host)]
    return max(matching, key=lambda row: row.proxy_key) if matching else None


def hostname(url: str | None) -> str:
    return (urlsplit(url or "").hostname or "").lower()


# ---- storing --------------------------------------------------------------------------------------


def unavailable(settings: Settings) -> str | None:
    """Why own certificates cannot be used in this installation, or None."""
    if not settings.certs_dir:
        return "no_directory"
    if not settings.proxy_secret:
        return "no_secret"
    if not os.access(settings.certs_dir, os.W_OK | os.X_OK):
        return "not_writable"
    return None


def _status(row: Certificate, now: datetime) -> str:
    if row.not_after <= now:
        return "expired"
    if row.not_before > now:
        return "not_yet_valid"
    if row.not_after - now <= EXPIRES_SOON:
        return "expires_soon"
    return "valid"


def _out(row: Certificate, now: datetime | None = None) -> CertificateOut:
    now = now or datetime.now(UTC)
    return CertificateOut(
        id=row.id,
        name=row.name,
        names=list(row.names),
        subject=row.subject,
        issuer=row.issuer,
        chain=list(row.chain),
        serial=row.serial,
        key_type=row.key_type,
        fingerprint=row.fingerprint,
        not_before=row.not_before,
        not_after=row.not_after,
        status=_status(row, now),
        warnings=list(row.warnings),
        fetched_before=list(row.fetched_before),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def _check_names(db: AsyncSession, parsed: Parsed, *, besides: uuid.UUID | None) -> None:
    """No name may be in two certificates.

    The proxy picks by name. With the same name in two certificates it serves one of them, and
    which one is not defined - after a renewal that could be the old one.
    """
    for other in (await db.execute(select(Certificate))).scalars():
        if other.id == besides:
            continue
        if other.fingerprint == parsed.fingerprint:
            raise conflict("certificate_exists", f'This certificate is stored already, as "{other.name}".')
        shared = sorted(set(other.names) & set(parsed.names))
        if shared:
            raise ApiError(
                409,
                "names_taken",
                f'"{other.name}" is a certificate for {", ".join(shared)} already. Replace that one '
                "instead of adding a second for the same name.",
                {"names": shared, "certificate": other.name, "certificate_id": str(other.id)},
            )


def _apply(row: Certificate, parsed: Parsed) -> None:
    row.certificate = parsed.certificate
    row.private_key = parsed.private_key
    row.fingerprint = parsed.fingerprint
    row.names = parsed.names
    row.subject = parsed.subject
    row.issuer = parsed.issuer
    row.chain = parsed.chain
    row.serial = parsed.serial
    row.key_type = parsed.key_type
    row.not_before = parsed.not_before
    row.not_after = parsed.not_after
    row.warnings = parsed.warnings
    row.proxy_key = parsed.proxy_key
    row.files_key = parsed.files_key


def _details(row: Certificate) -> dict[str, object]:
    # What identifies the certificate. Never the key.
    return {"names": list(row.names), "fingerprint": row.fingerprint, "not_after": row.not_after.isoformat()}


def _require(settings: Settings) -> None:
    problem = unavailable(settings)
    if problem:
        raise conflict(
            "certificates_unavailable",
            "This installation cannot serve own certificates (the bundled proxy is not set up for it).",
        )


def _parsed(data: CertificateIn | CertificateReplace) -> Parsed:
    return parse(
        certificate=data.certificate,
        private_key=data.private_key,
        pkcs12_file=data.pkcs12,
        passphrase=data.passphrase,
    )


async def add(
    db: AsyncSession, principal: Principal | None, settings: Settings, data: CertificateIn
) -> CertificateOut:
    _require(settings)
    parsed = _parsed(data)
    async with system_scope(db):
        await _check_names(db, parsed, besides=None)
        row = Certificate(name=data.name)
        _apply(row, parsed)
        row.fetched_before = await _served_from_elsewhere(db, settings, parsed)
        db.add(row)
        try:
            async with db.begin_nested():
                await db.flush()
        except IntegrityError:
            raise conflict("name_taken", "A certificate with this name exists already.") from None
        await audit.record(
            db, principal, "certificate.add", target_type="certificate", target_id=row.id,
            target_label=row.name, details=_details(row), tenant_id=None,
        )  # fmt: skip
        await db.refresh(row)
        return _out(row)


async def replace(
    db: AsyncSession,
    principal: Principal | None,
    settings: Settings,
    certificate_id: uuid.UUID,
    data: CertificateReplace,
) -> CertificateOut:
    """Put a new certificate in the place of a stored one (a renewal): same entry, same name."""
    _require(settings)
    parsed = _parsed(data)
    async with system_scope(db):
        row = await db.get(Certificate, certificate_id)
        if row is None:
            raise not_found("Certificate")
        await _check_names(db, parsed, besides=row.id)
        before = _details(row)
        # What was noted for the certificate it replaces still holds: the proxy's own store
        # has not changed.
        kept = [host for host in row.fetched_before if key_matches(parsed.proxy_key, host)]
        _apply(row, parsed)
        row.fetched_before = sorted({*kept, *await _served_from_elsewhere(db, settings, parsed)})
        if data.name:
            row.name = data.name
        try:
            async with db.begin_nested():
                await db.flush()
        except IntegrityError:
            raise conflict("name_taken", "A certificate with this name exists already.") from None
        await audit.record(
            db, principal, "certificate.replace", target_type="certificate", target_id=row.id,
            target_label=row.name, details={**_details(row), "before": before}, tenant_id=None,
        )  # fmt: skip
        await db.refresh(row)
        return _out(row)


async def remove(db: AsyncSession, principal: Principal | None, certificate_id: uuid.UUID) -> None:
    async with system_scope(db):
        row = await db.get(Certificate, certificate_id)
        if row is None:
            raise not_found("Certificate")
        await audit.record(
            db, principal, "certificate.remove", target_type="certificate", target_id=row.id,
            target_label=row.name, details=_details(row), tenant_id=None,
        )  # fmt: skip
        await db.delete(row)
        await db.flush()


async def rows(db: AsyncSession) -> list[Certificate]:
    async with system_scope(db):
        return list((await db.execute(select(Certificate))).scalars())


async def listed(db: AsyncSession) -> list[CertificateOut]:
    async with system_scope(db):
        rows = (await db.execute(select(Certificate).order_by(func.lower(Certificate.name)))).scalars()
        return [_out(row) for row in rows]


async def by_name(db: AsyncSession, name: str) -> Certificate | None:
    return (
        await db.execute(select(Certificate).where(func.lower(Certificate.name) == name.strip().lower()))
    ).scalar_one_or_none()


# ---- files for the proxy --------------------------------------------------------------------------


def _write(directory: Path, name: str, content: str) -> None:
    # Complete or not there: the proxy must never read half a file. Readable by the owner and
    # the group only; the proxy is given that group (docker-compose.yml).
    temporary = directory / f".{name}.{secrets.token_hex(4)}.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
    try:
        with os.fdopen(descriptor, "w", encoding="ascii") as handle:
            handle.write(content)
        os.chmod(temporary, 0o640)
        os.replace(temporary, directory / name)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise


def _sync(directory: Path, wanted: dict[str, str]) -> None:
    present = {entry.name for entry in directory.iterdir() if entry.is_file()}
    for name, content in wanted.items():
        if name not in present:
            _write(directory, name, content)
    for name in present - set(wanted):
        # Only what this code wrote: files named by a fingerprint, and its own leftovers.
        if _FILE.fullmatch(name) or (name.startswith(".") and name.endswith(".tmp")):
            with contextlib.suppress(OSError):
                (directory / name).unlink()


# When a certificate was last mentioned in the log for running out (by fingerprint).
_warned: dict[str, datetime] = {}
WARN_EVERY = timedelta(hours=12)


def forget_warnings() -> None:
    _warned.clear()


def _warn_about_expiry(rows: Iterable[tuple[str, str, datetime]], now: datetime) -> None:
    """Say in the log that a stored certificate runs out: nobody renews an uploaded one by itself."""
    seen = set()
    for fingerprint, name, not_after in rows:
        seen.add(fingerprint)
        if (
            not_after - now > EXPIRES_SOON
            or now - _warned.get(fingerprint, datetime.min.replace(tzinfo=UTC)) < WARN_EVERY
        ):
            continue
        _warned[fingerprint] = now
        if not_after <= now:
            log.warning('certificate "%s" expired on %s: browsers refuse it', name, f"{not_after:%Y-%m-%d}")
        else:
            log.warning(
                'certificate "%s" expires on %s (in %d days): replace it under System → Zertifikate',
                name, f"{not_after:%Y-%m-%d}", (not_after - now).days,
            )  # fmt: skip
    for fingerprint in set(_warned) - seen:
        del _warned[fingerprint]


async def files_for_proxy(db: AsyncSession, settings: Settings) -> list[dict[str, str]]:
    """The stored certificates as the proxy is to load them, written to its directory first.

    Called whenever the proxy fetches its configuration (every few seconds): whatever is in the
    database is in the directory a moment later, and what was removed is gone from it - after an
    upload, a removal, a restore of the database, or a new, empty volume.
    The caller has set the system scope.
    """
    if unavailable(settings) or not settings.certs_dir:
        return []
    directory = Path(settings.certs_dir)
    stored = (
        await db.execute(
            select(Certificate.fingerprint, Certificate.name, Certificate.not_after, Certificate.files_key)
        )
    ).all()
    _warn_about_expiry([(row[0], row[1], row[2]) for row in stored], datetime.now(UTC))
    # Named by what is stored, not by the certificate alone: the same certificate stored again
    # with its chain is another file and another configuration - the proxy only reads anew what
    # changes its configuration.
    stems = sorted(row[3] for row in stored)
    expected = {f"{stem}.{kind}" for stem in stems for kind in ("crt", "key")}
    try:
        present = {name for name in os.listdir(directory) if _FILE.fullmatch(name)}
        if present != expected:
            wanted: dict[str, str] = {}
            for row in (await db.execute(select(Certificate))).scalars():
                wanted[f"{row.files_key}.crt"] = row.certificate
                wanted[f"{row.files_key}.key"] = row.private_key
            await asyncio.to_thread(_sync, directory, wanted)
    except OSError:
        # The routes must still go out: say it, and name only the files that are there.
        log.exception("could not write the certificates for the proxy to %s", directory)
    return [
        {"certFile": str(directory / f"{stem}.crt"), "keyFile": str(directory / f"{stem}.key")}
        for stem in stems
        if (directory / f"{stem}.crt").is_file() and (directory / f"{stem}.key").is_file()
    ]


# ---- certificates the proxy fetches by itself ------------------------------------------------------

# Nobody asks for this path; the routers below exist to name a host, not to serve anything.
REQUEST_PATH = "/.well-known/velydock-tls"


def certificate_requests(settings: Settings, rows: Iterable[Certificate]) -> dict[str, Any]:
    """Routers that make the proxy fetch a certificate (Let's Encrypt) for Velydock's own names.

    The proxy fetches a certificate for every name of a router that carries a resolver. The
    routers of Velydock, the sandbox and the sign-in carry none (deploy/traefik/dynamic): which
    of their names get a fetched certificate is said here, with the same answer that names the
    uploaded ones - so a name with a certificate of its own is never fetched one as well. Two
    certificates for one name are what must not happen: the proxy picks by the order of their
    keys, and an uploaded wildcard loses against every fetched certificate.
    """
    if not settings.proxy_tls_resolver:
        return {}
    stored = list(rows)
    routers: dict[str, Any] = {}
    seen: set[str] = set()
    for label, url in (
        ("velydock", settings.public_url),
        ("sandbox", settings.sandbox_url),
        ("keycloak", settings.keycloak_public_url),
    ):
        host = hostname(url)
        # Built from the configured address; nothing but a plain host name goes into a rule.
        if not _DNS_NAME.fullmatch(host) or host.startswith("*") or host in seen:
            continue
        seen.add(host)
        if chosen_for(stored, host) is not None:
            continue
        routers[f"vd-tls-{label}"] = {
            "rule": f"Host(`{host}`) && Path(`{REQUEST_PATH}`)",
            "entryPoints": [settings.proxy_entry_point],
            "service": "noop@internal",
            "tls": {"certResolver": settings.proxy_tls_resolver, "domains": [{"main": host}]},
        }
    return routers


def prune_fetched(storage: Path, rows: Iterable[Certificate]) -> list[str]:
    """Remove from the proxy's own store the fetched certificates for names that have an uploaded one.

    The proxy keeps every certificate it ever fetched and renews it for good. One that was
    fetched before a certificate was uploaded for the same name stays next to it, and the proxy
    serves whichever key sorts last - for an uploaded wildcard that is never the uploaded one.
    The file is the proxy's (acme.json); it reads it at start only, so this runs while the
    proxy is stopped. A fetched certificate for several names goes as a whole when one of its
    names is taken over; the proxy fetches the others anew.
    """
    stored = list(rows)
    text_ = storage.read_text(encoding="utf-8")
    if not text_.strip():
        return []
    data = json.loads(text_)
    removed: list[str] = []
    for resolver in data.values() if isinstance(data, dict) else []:
        if not isinstance(resolver, dict) or not isinstance(resolver.get("Certificates"), list):
            continue
        kept = []
        for entry in resolver["Certificates"]:
            domain = entry.get("domain") if isinstance(entry, dict) else None
            names = [domain.get("main"), *(domain.get("sans") or [])] if isinstance(domain, dict) else []
            names = [name for name in names if isinstance(name, str) and name]
            if any(chosen_for(stored, name) is not None for name in names):
                removed.append(", ".join(names))
            else:
                kept.append(entry)
        resolver["Certificates"] = kept
    if removed:
        temporary = storage.with_name(f".{storage.name}.{secrets.token_hex(4)}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(data, handle, indent=2)
            os.replace(temporary, storage)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(temporary)
            raise
    return removed


# ---- what the proxy really serves -----------------------------------------------------------------


async def _served(address: str, host: str, stored: dict[str, uuid.UUID]) -> ServedCertificate:
    """Ask the proxy for the certificate of a name, as a browser would (without judging it)."""
    target, _, port = address.rpartition(":")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(target, int(port), ssl=context, server_hostname=host), timeout=3
        )
    except (OSError, TimeoutError, ValueError, ssl.SSLError):
        return ServedCertificate(source="unreachable")
    try:
        der = writer.get_extra_info("ssl_object").getpeercert(binary_form=True)
    finally:
        writer.close()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(writer.wait_closed(), timeout=1)
    try:
        certificate = x509.load_der_x509_certificate(der)
    except (TypeError, ValueError):
        return ServedCertificate(source="unreachable")
    fingerprint = certificate.fingerprint(hashes.SHA256()).hex()
    common = [
        str(item.value) for item in certificate.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
    ]
    if fingerprint in stored:
        source = "uploaded"
    elif PROXY_DEFAULT_SUBJECT in common:
        source = "default"
    else:
        source = "other"
    return ServedCertificate(
        source=source,
        certificate_id=stored.get(fingerprint),
        subject=certificate.subject.rfc4514_string()[:500],
        issuer=certificate.issuer.rfc4514_string()[:500],
        not_after=certificate.not_valid_after_utc,
        fingerprint=fingerprint,
        valid_for_host=matching_name(_names_of(certificate), host) is not None,
    )


async def _hosts(db: AsyncSession, settings: Settings) -> list[tuple[str, str, str]]:
    """Every name of this installation: (host, what it is, the name of a published app)."""
    apps_host = hostname(settings.apps_url)
    hosts: list[tuple[str, str, str]] = [
        (hostname(settings.public_url), "velydock", ""),
        (hostname(settings.keycloak_public_url), "keycloak", ""),
        (hostname(settings.sandbox_url), "sandbox", ""),
    ]
    if apps_host:
        hosts.append((apps_host, "apps", ""))
        published = await db.execute(
            select(AppPublication.name)
            .where(AppPublication.mode == PublicationMode.SUBDOMAIN.value)
            .order_by(AppPublication.name)
            .limit(40)
        )
        hosts.extend((f"{name}.{apps_host}", "app", name) for name in published.scalars())
    return hosts


async def _served_from_elsewhere(db: AsyncSession, settings: Settings, parsed: Parsed) -> list[str]:
    """The names of this installation a new certificate is for that the proxy serves with one from elsewhere.

    Asked at the moment of the upload, before the proxy knows the new certificate: what it
    presents then and is not stored here is one it fetched itself. Next to that one the new
    certificate is not reliably served - with the same list of names, which of the two the proxy
    takes changes with every reload of its configuration - so one look at what is served later
    proves nothing. The note stays until the fetched ones are pruned.
    """
    if not settings.proxy_tls_address:
        return []
    hosts = [host for host, _, _ in await _hosts(db, settings) if key_matches(parsed.proxy_key, host)]
    stored = {row.fingerprint: row.id for row in (await db.execute(select(Certificate))).scalars()}
    stored.setdefault(parsed.fingerprint, uuid.uuid4())
    # A certificate that was removed or replaced here a moment ago is still served until the
    # proxy has fetched its configuration again: that one is ours, not one it fetched.
    recent = await db.execute(
        select(AuditLog.details).where(
            AuditLog.action.in_(("certificate.remove", "certificate.replace")),
            AuditLog.created_at > datetime.now(UTC) - JUST_NOW,
        )
    )
    for details in recent.scalars():
        for source in (details, details.get("before") or {}):
            if isinstance(source.get("fingerprint"), str):
                stored.setdefault(source["fingerprint"], uuid.uuid4())
    answers = await asyncio.gather(*(_served(settings.proxy_tls_address, host, stored) for host in hosts))
    return sorted(host for host, answer in zip(hosts, answers, strict=True) if answer.source == "other")


async def forget_fetched(db: AsyncSession) -> None:
    """After the proxy's own store was pruned: no name has a fetched certificate next to a stored one."""
    async with system_scope(db):
        for row in (await db.execute(select(Certificate))).scalars():
            if row.fetched_before:
                row.fetched_before = []
        await db.flush()


async def overview(db: AsyncSession, settings: Settings) -> CertificatesOut:
    """The stored certificates, and for every name of this installation what it is served with."""
    now = datetime.now(UTC)
    async with system_scope(db):
        rows = list((await db.execute(select(Certificate).order_by(func.lower(Certificate.name)))).scalars())
        hosts = await _hosts(db, settings)
    stored = {row.fingerprint: row.id for row in rows}
    if settings.proxy_tls_address:
        served = await asyncio.gather(
            *(_served(settings.proxy_tls_address, host, stored) for host, _, _ in hosts)
        )
    else:
        served = [ServedCertificate(source="unknown") for _ in hosts]
    listed = []
    for (host, purpose, label), answer in zip(hosts, served, strict=True):
        expected = chosen_for(rows, host)
        listed.append(
            CertificateHost(
                host=host,
                purpose=purpose,
                label=label,
                certificate_id=expected.id if expected else None,
                takeover=expected is not None and host in expected.fetched_before,
                served=answer,
            )
        )
    return CertificatesOut(
        available=unavailable(settings) is None,
        problem=unavailable(settings),
        acme=bool(settings.proxy_tls_resolver),
        certificates=[_out(row, now) for row in rows],
        hosts=listed,
    )
