// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { ApiError } from '$lib/api/client';
import type { Certificate, CertificateHost, CertificatesOverview } from '$lib/api/types';
import { hasMessage, type Language, type TVars } from '$lib/i18n';
import { formatDate } from '$lib/utils/datetime';

// Own TLS certificates for the bundled reverse proxy: what the page and the dialog need to
// know about an upload and about what the proxy serves. The rules are the API's
// (backend/velydock/services/certificates.py); those a form can check itself are mirrored
// here so that it says at once, at the right field, what is wrong. The server stays the
// authority. Nothing in here keeps, logs or returns a private key.

export type { Certificate, CertificateHost, CertificatesOverview };

// ── An upload ────────────────────────────────────────────────────────

export type CertificateFormat = 'pem' | 'pkcs12';

/** MAX_PEM and MAX_PKCS12 of the API: per PEM field, and for the PKCS#12 file. */
export const PEM_MAX_BYTES = 64 * 1024;
export const PKCS12_MAX_BYTES = 96 * 1024;
/** For the `accept` attribute of the file input. PEM files have too many names for one. */
export const PKCS12_ACCEPT = '.p12,.pfx,application/x-pkcs12';

export function maxKilobytes(format: CertificateFormat): number {
  return (format === 'pem' ? PEM_MAX_BYTES : PKCS12_MAX_BYTES) / 1024;
}

/** How many bytes a text takes when it is sent. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

// The same expression the API reads PEM with (_BLOCK).
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----.+?-----END \1-----/gs;

export interface PemBlock {
  label: string;
  text: string;
}

/** The PEM blocks of a text, in their order: certificates, keys, whatever else. */
export function pemBlocks(text: string): PemBlock[] {
  return [...text.matchAll(PEM_BLOCK)].map((match) => ({ label: match[1], text: match[0] }));
}

const isCertificate = (block: PemBlock) =>
  block.label === 'CERTIFICATE' || block.label === 'TRUSTED CERTIFICATE';
const isKey = (block: PemBlock) => block.label.endsWith('PRIVATE KEY');

/**
 * Whether a key says of itself that a passphrase protects it: the PKCS#8 form by its
 * label, the older forms by a header line. A key that does not say so may be protected
 * all the same (the OpenSSH form); the API then asks for the passphrase.
 */
export function keyIsEncrypted(text: string): boolean {
  return pemBlocks(text)
    .filter(isKey)
    .some(
      (block) =>
        block.label === 'ENCRYPTED PRIVATE KEY' || /Proc-Type:\s*4,ENCRYPTED/.test(block.text),
    );
}

/** The fields of the dialog a message can stand at; `form` is the dialog as a whole. */
export type CertificateField = 'name' | 'certificate' | 'key' | 'passphrase' | 'pkcs12' | 'form';

export interface PemProblem {
  field: 'certificate' | 'key' | 'passphrase';
  code: 'too_large' | 'certificate_missing' | 'key_missing' | 'several_keys' | 'key_encrypted';
}

/**
 * What is wrong with certificate and key as PEM before anything is sent, or null. The
 * codes are the API's, in the order it checks: it reads both texts as one, so the key may
 * stand with the certificate.
 */
export function pemProblem(input: {
  certificate: string;
  privateKey: string;
  passphrase: string;
}): PemProblem | null {
  if (byteLength(input.certificate) > PEM_MAX_BYTES) {
    return { field: 'certificate', code: 'too_large' };
  }
  if (byteLength(input.privateKey) > PEM_MAX_BYTES) return { field: 'key', code: 'too_large' };
  const blocks = pemBlocks(`${input.certificate}\n${input.privateKey}`);
  const keys = blocks.filter(isKey);
  if (!blocks.some(isCertificate)) return { field: 'certificate', code: 'certificate_missing' };
  if (keys.length === 0) return { field: 'key', code: 'key_missing' };
  if (keys.length > 1) return { field: 'key', code: 'several_keys' };
  if (!input.passphrase && keyIsEncrypted(keys[0].text)) {
    return { field: 'passphrase', code: 'key_encrypted' };
  }
  return null;
}

function read(file: Blob, how: 'text' | 'dataUrl'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('The file could not be read.'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    if (how === 'text') reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

/** A PEM file as text. Rejects when the browser cannot read it. */
export function readTextFile(file: Blob): Promise<string> {
  return read(file, 'text');
}

/** A PKCS#12 file as the API takes it: its bytes as base64. */
export async function readFileBase64(file: Blob): Promise<string> {
  const url = await read(file, 'dataUrl');
  return url.slice(url.indexOf(',') + 1);
}

// ── What the API refuses ─────────────────────────────────────────────

/**
 * The error codes of an upload that have their own text (`certificates.error.<code>`),
 * each with the field it is about when certificate and key come as PEM. From a PKCS#12
 * file both come out of the one file, so what is about either stands at the file.
 */
export const UPLOAD_ERRORS: Readonly<Record<string, CertificateField>> = {
  certificate_missing: 'certificate',
  certificate_unreadable: 'certificate',
  too_many_certificates: 'certificate',
  no_names: 'certificate',
  expired: 'certificate',
  names_taken: 'certificate',
  certificate_exists: 'certificate',
  too_large: 'certificate',
  ambiguous: 'certificate',
  key_missing: 'key',
  key_unreadable: 'key',
  key_mismatch: 'key',
  key_unsupported: 'key',
  several_keys: 'key',
  key_encrypted: 'passphrase',
  passphrase_wrong: 'passphrase',
  pkcs12_unreadable: 'pkcs12',
  name_taken: 'name',
  validation: 'form',
  certificates_unavailable: 'form',
};

/** Problems the dialog finds itself, before a file is even read to the end. */
export const LOCAL_ERRORS = ['not_pem', 'file_unreadable'] as const;

// The fields of the request, as a 422 `validation` names them, and where the dialog has them.
const REQUEST_FIELDS: Readonly<Record<string, CertificateField>> = {
  name: 'name',
  certificate: 'certificate',
  private_key: 'key',
  passphrase: 'passphrase',
  pkcs12: 'pkcs12',
};

/** Where a message about `field` stands in the dialog as it is shown for `format`. */
export function fieldFor(field: CertificateField, format: CertificateFormat): CertificateField {
  if (format === 'pkcs12' && (field === 'certificate' || field === 'key')) return 'pkcs12';
  if (format === 'pem' && field === 'pkcs12') return 'form';
  return field;
}

/** The i18n key of the text for a code: the one for this format if there is one. */
export function errorKey(code: string, format: CertificateFormat): string {
  const own = `certificates.error.${code}.${format}`;
  return hasMessage(own) ? own : `certificates.error.${code}`;
}

export interface UploadFailure {
  field: CertificateField;
  /** The code of the API, as the dialog shows it in `data-code`. */
  code: string;
  /** The text to show, with its values. Null: the general text for the code (errorMessage()). */
  key: string | null;
  vars?: TVars;
  /** `names_taken`: the stored certificate that holds the names, to replace instead. */
  other?: { id: string; name: string };
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * What a refused upload means for the dialog: which field it is about and which text says
 * so. The server's own message is English and for developers, and is never shown; nor is
 * anything of what was sent.
 */
export function uploadFailure(
  err: unknown,
  format: CertificateFormat,
  lang: Language,
): UploadFailure {
  if (!(err instanceof ApiError) || !(err.code in UPLOAD_ERRORS)) {
    return { field: 'form', code: err instanceof ApiError ? err.code : 'error', key: null };
  }
  const { code, details } = err;
  const failure: UploadFailure = {
    field: fieldFor(UPLOAD_ERRORS[code], format),
    code,
    key: errorKey(code, format),
  };
  if (code === 'validation') {
    // The first field the dialog has; without one the failure is about the whole request.
    const known = err.fields.find((entry) => entry.field in REQUEST_FIELDS);
    if (!known) return { ...failure, key: null };
    failure.field = fieldFor(REQUEST_FIELDS[known.field], format);
  } else if (code === 'too_large') {
    failure.vars = { max: maxKilobytes(format) };
  } else if (code === 'expired') {
    const date = formatDate(text(details.not_after), lang);
    if (date) failure.vars = { date };
    else failure.key = 'certificates.error.expired.undated';
  } else if (code === 'names_taken') {
    const names = Array.isArray(details.names)
      ? details.names.filter((name): name is string => typeof name === 'string')
      : [];
    const name = text(details.certificate);
    if (names.length > 0 && name) {
      failure.vars = { names: names.join(', '), certificate: name };
      const id = text(details.certificate_id);
      if (id) failure.other = { id, name };
    } else {
      failure.key = 'certificates.error.names_taken.unnamed';
    }
  }
  return failure;
}

// ── What is stored, and what the proxy serves ────────────────────────

/** The parts of a distinguished name as the API writes it (RFC 4514): "CN=R11,O=Let's Encrypt". */
function nameParts(dn: string): Record<string, string> {
  const parts: Record<string, string> = {};
  // One part ends at a comma or plus that no backslash stands before; `\,` is a comma
  // inside a value. Read by hand: not every browser in use knows look-behind.
  const pieces: string[] = [];
  let piece = '';
  for (let at = 0; at < dn.length; at++) {
    const char = dn[at];
    if (char === '\\' && at + 1 < dn.length) {
      piece += dn[++at];
    } else if (char === ',' || char === '+') {
      pieces.push(piece);
      piece = '';
    } else {
      piece += char;
    }
  }
  pieces.push(piece);
  for (const entry of pieces) {
    const at = entry.indexOf('=');
    if (at < 1) continue;
    const value = entry.slice(at + 1).trim();
    if (value) parts[entry.slice(0, at).trim().toUpperCase()] ??= value;
  }
  return parts;
}

/**
 * A subject or issuer as a table can show it: the organization with the common name
 * ("Let's Encrypt (R11)"), whichever of the two there is, else the name as it came.
 */
export function nameLabel(dn: string): string {
  const { O: organization, CN: common } = nameParts(dn);
  if (organization && common) return `${organization} (${common})`;
  return organization ?? common ?? dn;
}

/** A fingerprint in pairs, as certificate viewers group it. */
export function fingerprintPairs(fingerprint: string): string[] {
  return fingerprint.match(/.{1,2}/g) ?? [];
}

/** The beginning of a fingerprint: enough to tell two certificates apart in a log. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.length > 16 ? `${fingerprint.slice(0, 16)}…` : fingerprint;
}

/** The hosts of this installation a stored certificate is meant for: those that lose it with it. */
export function hostsOf(overview: CertificatesOverview, certificateId: string): CertificateHost[] {
  return overview.hosts.filter((host) => host.certificate_id === certificateId);
}

/**
 * A stored certificate is meant for this name, the proxy answered, and it answered with
 * something else: it has not taken the certificate over yet. Where the proxy did not
 * answer, or cannot be asked, nothing is known and nothing awaited.
 */
export function awaited(host: CertificateHost): boolean {
  if (!host.certificate_id) return false;
  const { source } = host.served;
  if (source === 'unreachable' || source === 'unknown') return false;
  return host.served.certificate_id !== host.certificate_id;
}

/** The proxy still answers for this name with a certificate that was just removed or replaced. */
function servesGone(host: CertificateHost, gone: readonly string[]): boolean {
  return host.served.fingerprint !== '' && gone.includes(host.served.fingerprint);
}

/**
 * A stored certificate is meant for this name, and the proxy answers with one that is
 * none of the stored ones (nor one that was stored until a moment ago). Once the proxy
 * has had its few seconds this does not resolve itself: the proxy holds a certificate it
 * fetched itself (Let's Encrypt) for the name. It keeps every one it fetched and, of two
 * for one name, serves the one whose list of names sorts later, so an uploaded wildcard
 * always loses. Only removing the fetched one on the server helps.
 */
export function shadowed(host: CertificateHost, gone: readonly string[] = []): boolean {
  return awaited(host) && host.served.source === 'other' && !servesGone(host, gone);
}

/**
 * The proxy is behind what is stored for a reason the page cannot name at the address:
 * a stored certificate it has not loaded, or one that is gone and still served. What is
 * `shadowed` says so itself, in its row.
 */
export function lagging(overview: CertificatesOverview, gone: readonly string[] = []): boolean {
  return overview.hosts.some(
    (host) => !shadowed(host, gone) && (awaited(host) || servesGone(host, gone)),
  );
}

/**
 * Whether the proxy serves what is stored: every name with a stored certificate gets it,
 * and none still gets one of `gone` (the fingerprints of what was just removed or
 * replaced). The page stops asking again once this holds.
 */
export function settled(overview: CertificatesOverview, gone: readonly string[] = []): boolean {
  return !overview.hosts.some((host) => awaited(host) || servesGone(host, gone));
}
