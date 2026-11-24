// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import type { CertificateHost, CertificatesOverview, ServedCertificate } from '$lib/api/types';
import { translate } from '$lib/i18n';
import { translations } from '$lib/i18n/dictionaries';
import {
  LOCAL_ERRORS,
  PEM_MAX_BYTES,
  PKCS12_ACCEPT,
  PKCS12_MAX_BYTES,
  UPLOAD_ERRORS,
  awaited,
  byteLength,
  errorKey,
  fieldFor,
  fingerprintPairs,
  hostsOf,
  keyIsEncrypted,
  lagging,
  maxKilobytes,
  nameLabel,
  pemBlocks,
  pemProblem,
  readFileBase64,
  readTextFile,
  settled,
  shadowed,
  shortFingerprint,
  uploadFailure,
} from './certificates';

// Nothing in here is a real certificate or key: the form only looks for the PEM frame.
const pem = (label: string, body = 'MIIBfakefakefake') =>
  `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
const CERT = pem('CERTIFICATE');
const ISSUER = pem('CERTIFICATE', 'MIICissuerissuer');
const KEY = pem('PRIVATE KEY');
const RSA_KEY = pem('RSA PRIVATE KEY');
const ENCRYPTED_KEY = pem('ENCRYPTED PRIVATE KEY');
const LEGACY_ENCRYPTED_KEY = pem(
  'RSA PRIVATE KEY',
  'Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,0011\n\nMIIBfake',
);

// The codes the API answers an upload with (backend/velydock/services/certificates.py).
const API_CODES = [
  'certificate_missing',
  'certificate_unreadable',
  'key_missing',
  'key_unreadable',
  'key_encrypted',
  'passphrase_wrong',
  'key_mismatch',
  'key_unsupported',
  'several_keys',
  'too_many_certificates',
  'too_large',
  'no_names',
  'expired',
  'not_yet_valid',
  'common_name_not_listed',
  'pkcs12_unreadable',
  'ambiguous',
  'validation',
  'names_taken',
  'certificate_exists',
  'name_taken',
  'certificates_unavailable',
];

const refusal = (code: string, details: Record<string, unknown> = {}, status = 422) =>
  new ApiError(status, code, 'English text of the server, never shown', details);

describe('certificate and key as PEM', () => {
  it('takes what the API takes: 64 KB per field, 96 KB for a PKCS#12 file', () => {
    expect(PEM_MAX_BYTES).toBe(64 * 1024);
    expect(PKCS12_MAX_BYTES).toBe(96 * 1024);
    expect(maxKilobytes('pem')).toBe(64);
    expect(maxKilobytes('pkcs12')).toBe(96);
    expect(PKCS12_ACCEPT.split(',')).toEqual(expect.arrayContaining(['.p12', '.pfx']));
    // Bytes as they are sent, not characters.
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('äöü')).toBe(6);
  });

  it('finds the blocks of a text in their order, whatever stands around them', () => {
    const blocks = pemBlocks(`Bag Attributes\n${CERT}some comment\n${KEY}${ISSUER}`);
    expect(blocks.map((block) => block.label)).toEqual([
      'CERTIFICATE',
      'PRIVATE KEY',
      'CERTIFICATE',
    ]);
    expect(blocks[1].text).toBe(KEY.trim());
    expect(pemBlocks('')).toEqual([]);
    expect(pemBlocks('0\u0082\u0003binary')).toEqual([]);
    // A frame that does not close with its own label is none.
    expect(pemBlocks('-----BEGIN CERTIFICATE-----\nMIIB\n-----END PRIVATE KEY-----')).toEqual([]);
  });

  it('sees whether a key says that a passphrase protects it', () => {
    expect(keyIsEncrypted(ENCRYPTED_KEY)).toBe(true);
    expect(keyIsEncrypted(LEGACY_ENCRYPTED_KEY)).toBe(true);
    expect(keyIsEncrypted(KEY)).toBe(false);
    expect(keyIsEncrypted(RSA_KEY)).toBe(false);
    expect(keyIsEncrypted(CERT)).toBe(false);
    expect(keyIsEncrypted('')).toBe(false);
  });

  describe('is checked before it is sent', () => {
    const check = (certificate: string, privateKey = '', passphrase = '') =>
      pemProblem({ certificate, privateKey, passphrase });

    it('and passes with a certificate and one key', () => {
      expect(check(CERT, KEY)).toBeNull();
      expect(check(CERT + ISSUER, RSA_KEY)).toBeNull();
    });

    it('wherever the key stands: the API reads both texts as one', () => {
      expect(check(CERT + KEY)).toBeNull();
      expect(check(KEY + CERT + ISSUER)).toBeNull();
      expect(check('', CERT + KEY)).toBeNull();
    });

    it('says that the certificate is missing, at the certificate', () => {
      expect(check('', KEY)).toEqual({ field: 'certificate', code: 'certificate_missing' });
      expect(check('not a certificate', KEY)).toEqual({
        field: 'certificate',
        code: 'certificate_missing',
      });
      // Both missing: the certificate comes first, as with the API.
      expect(check('')).toEqual({ field: 'certificate', code: 'certificate_missing' });
    });

    it('says that the key is missing, or that there is more than one, at the key', () => {
      expect(check(CERT)).toEqual({ field: 'key', code: 'key_missing' });
      expect(check(CERT, 'something else')).toEqual({ field: 'key', code: 'key_missing' });
      expect(check(CERT, KEY + RSA_KEY)).toEqual({ field: 'key', code: 'several_keys' });
      expect(check(CERT + KEY, KEY)).toEqual({ field: 'key', code: 'several_keys' });
    });

    it('asks for the passphrase of a protected key, at the passphrase', () => {
      expect(check(CERT, ENCRYPTED_KEY)).toEqual({ field: 'passphrase', code: 'key_encrypted' });
      expect(check(CERT, LEGACY_ENCRYPTED_KEY)).toEqual({
        field: 'passphrase',
        code: 'key_encrypted',
      });
      expect(check(CERT, ENCRYPTED_KEY, 'geheim')).toBeNull();
      // A passphrase for a key that has none does no harm: the key is what counts.
      expect(check(CERT, KEY, 'geheim')).toBeNull();
    });

    it('refuses more than 64 KB in a field, and nothing below', () => {
      const filler = (bytes: number) => 'a'.repeat(bytes);
      expect(check(CERT + filler(PEM_MAX_BYTES - CERT.length), KEY)).toBeNull();
      expect(check(CERT + filler(PEM_MAX_BYTES - CERT.length + 1), KEY)).toEqual({
        field: 'certificate',
        code: 'too_large',
      });
      expect(check(CERT, KEY + filler(PEM_MAX_BYTES - KEY.length))).toBeNull();
      expect(check(CERT, KEY + filler(PEM_MAX_BYTES - KEY.length + 1))).toEqual({
        field: 'key',
        code: 'too_large',
      });
      // The size is said first: a text that large is not searched for what it holds.
      expect(check(filler(PEM_MAX_BYTES + 1))).toEqual({ field: 'certificate', code: 'too_large' });
    });
  });

  it('is read from a file as text', async () => {
    const file = new File([CERT, KEY], 'fullchain.pem', { type: 'application/x-pem-file' });
    expect(await readTextFile(file)).toBe(CERT + KEY);
  });

  it('or comes as a PKCS#12 file, whose bytes are handed over as base64', async () => {
    const bytes = new Uint8Array([0x30, 0x82, 0x00, 0xff, 0x01, 0x80]);
    const file = new File([bytes], 'wildcard.p12', { type: 'application/x-pkcs12' });
    const encoded = await readFileBase64(file);
    expect(encoded).toBe('MIIA/wGA');
    expect([...atob(encoded)].map((char) => char.charCodeAt(0))).toEqual([...bytes]);
  });
});

describe('what the API refuses about an upload', () => {
  const de = (key: string, vars?: Record<string, string | number | null | undefined>) =>
    translate('de', key, vars);
  const text = (failure: ReturnType<typeof uploadFailure>, lang: 'de' | 'en' = 'de') =>
    failure.key ? translate(lang, failure.key, failure.vars) : null;

  it('has its own text for every code, in both languages', () => {
    expect(Object.keys(UPLOAD_ERRORS).sort()).toEqual([...API_CODES].sort());
    for (const code of [...API_CODES, ...LOCAL_ERRORS]) {
      expect(translations.de[`certificates.error.${code}`], code).toBeTruthy();
      expect(translations.en[`certificates.error.${code}`], code).toBeTruthy();
    }
  });

  it('has no text for a code that does not exist', () => {
    // These keys are built at run time, so the check for dead keys cannot see them.
    const variants = [
      'certificate_missing.pkcs12',
      'key_missing.pkcs12',
      'expired.undated',
      'not_yet_valid.undated',
      'common_name_not_listed.unnamed',
      'names_taken.unnamed',
    ];
    const known = [...API_CODES, ...LOCAL_ERRORS, ...variants].map(
      (code) => `certificates.error.${code}`,
    );
    const defined = Object.keys(translations.de).filter((key) =>
      key.startsWith('certificates.error.'),
    );
    expect(defined.sort()).toEqual(known.sort());
  });

  it('says it at the field it is about', () => {
    const at = (code: string, format: 'pem' | 'pkcs12') =>
      uploadFailure(refusal(code), format, 'de').field;
    const fields = Object.fromEntries(API_CODES.map((code) => [code, at(code, 'pem')]));
    expect(fields).toEqual({
      certificate_missing: 'certificate',
      certificate_unreadable: 'certificate',
      too_many_certificates: 'certificate',
      no_names: 'certificate',
      expired: 'certificate',
      not_yet_valid: 'certificate',
      common_name_not_listed: 'certificate',
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
      pkcs12_unreadable: 'form',
      name_taken: 'name',
      validation: 'form',
      certificates_unavailable: 'form',
    });
  });

  it('says it at the file where certificate and key come out of one PKCS#12 file', () => {
    const at = (code: string) => uploadFailure(refusal(code), 'pkcs12', 'de').field;
    for (const code of API_CODES) {
      const pemField = UPLOAD_ERRORS[code];
      const expected = pemField === 'certificate' || pemField === 'key' ? 'pkcs12' : pemField;
      expect(at(code), code).toBe(expected);
    }
    expect(at('pkcs12_unreadable')).toBe('pkcs12');
    expect(at('key_mismatch')).toBe('pkcs12');
    expect(at('passphrase_wrong')).toBe('passphrase');
    expect(at('name_taken')).toBe('name');
    expect(fieldFor('key', 'pem')).toBe('key');
    expect(fieldFor('pkcs12', 'pem')).toBe('form');
  });

  it('keeps the code, and never shows the text of the server', () => {
    for (const code of API_CODES) {
      for (const format of ['pem', 'pkcs12'] as const) {
        const failure = uploadFailure(refusal(code), format, 'de');
        expect(failure.code).toBe(code);
        expect(text(failure) ?? '', code).not.toContain('English text of the server');
      }
    }
  });

  it('words a missing key for the format it came in', () => {
    expect(errorKey('key_missing', 'pem')).toBe('certificates.error.key_missing');
    expect(errorKey('key_missing', 'pkcs12')).toBe('certificates.error.key_missing.pkcs12');
    expect(errorKey('key_mismatch', 'pkcs12')).toBe('certificates.error.key_mismatch');
    expect(text(uploadFailure(refusal('key_missing'), 'pem', 'de'))).toContain(
      '-----BEGIN PRIVATE KEY-----',
    );
    expect(text(uploadFailure(refusal('key_missing'), 'pkcs12', 'de'))).toBe(
      'Die Datei enthält keinen privaten Schlüssel.',
    );
  });

  it('says when an expired certificate ran out, in the language of the page', () => {
    const expired = refusal('expired', { not_after: '2025-03-01T12:00:00+00:00' });
    expect(text(uploadFailure(expired, 'pem', 'de'))).toBe(
      'Dieses Zertifikat ist am 01.03.2025 abgelaufen.',
    );
    expect(text(uploadFailure(expired, 'pem', 'en'), 'en')).toBe(
      'This certificate expired on 1 Mar 2025.',
    );
    // Without a date that can be read, no sentence with a hole in it.
    for (const details of [{}, { not_after: 'soon' }, { not_after: 7 }]) {
      expect(text(uploadFailure(refusal('expired', details), 'pem', 'de'))).toBe(
        'Dieses Zertifikat ist abgelaufen.',
      );
    }
  });

  it('names the size that is possible for the format', () => {
    expect(text(uploadFailure(refusal('too_large'), 'pem', 'de'))).toBe(
      'Zu groß für ein Zertifikat: Möglich sind hier höchstens 64 KB.',
    );
    expect(text(uploadFailure(refusal('too_large'), 'pkcs12', 'de'))).toContain('96 KB');
  });

  it('names the names that are taken and the certificate that holds them, to replace instead', () => {
    const taken = refusal(
      'names_taken',
      {
        names: ['*.example.com', 'example.com'],
        certificate: 'Wildcard',
        certificate_id: 'c-1',
      },
      409,
    );
    const failure = uploadFailure(taken, 'pem', 'de');
    expect(failure.field).toBe('certificate');
    expect(failure.other).toEqual({ id: 'c-1', name: 'Wildcard' });
    expect(text(failure)).toBe(
      'Für *.example.com, example.com ist schon das Zertifikat „Wildcard“ gespeichert. Ein Name darf nur in einem gespeicherten Zertifikat stehen: Ersetz „Wildcard“, statt ein zweites hinzuzufügen.',
    );
    expect(text(failure, 'en')).toContain('replace “Wildcard” instead of adding a second one');
    expect(uploadFailure(taken, 'pkcs12', 'de').field).toBe('pkcs12');
  });

  it('still says what to do where the answer does not name them', () => {
    for (const details of [
      {},
      { names: [], certificate: 'Wildcard', certificate_id: 'c-1' },
      { names: ['example.com'] },
      { names: 'example.com', certificate: 'Wildcard' },
    ]) {
      const failure = uploadFailure(refusal('names_taken', details, 409), 'pem', 'de');
      expect(failure.other).toBeUndefined();
      expect(text(failure)).toBe(
        'Für mindestens einen dieser Namen ist schon ein Zertifikat gespeichert. Ersetz das, statt ein zweites hinzuzufügen.',
      );
    }
    // Named, but without the id there is nothing to offer.
    const unnamed = uploadFailure(
      refusal('names_taken', { names: ['example.com'], certificate: 'Wildcard' }, 409),
      'pem',
      'de',
    );
    expect(unnamed.other).toBeUndefined();
    expect(text(unnamed)).toContain('„Wildcard“');
  });

  it('puts a refused field of the request at the field of the dialog', () => {
    const refused = (field: string) =>
      refusal('validation', { fields: [{ field, message: 'String should have at most …' }] });
    const at = (field: string, format: 'pem' | 'pkcs12' = 'pem') =>
      uploadFailure(refused(field), format, 'de');
    expect(at('name').field).toBe('name');
    expect(at('certificate').field).toBe('certificate');
    expect(at('private_key').field).toBe('key');
    expect(at('passphrase').field).toBe('passphrase');
    expect(at('pkcs12', 'pkcs12').field).toBe('pkcs12');
    expect(text(at('name'))).toBe('Diese Eingabe nimmt der Server nicht an.');
    // A field the dialog does not have: the failure is about the request as a whole.
    expect(at('something_new')).toEqual({ field: 'form', code: 'validation', key: null });
    expect(uploadFailure(refusal('validation'), 'pem', 'de')).toEqual({
      field: 'form',
      code: 'validation',
      key: null,
    });
  });

  it('leaves everything else to the general texts', () => {
    expect(uploadFailure(refusal('forbidden', {}, 403), 'pem', 'de')).toEqual({
      field: 'form',
      code: 'forbidden',
      key: null,
    });
    expect(uploadFailure(new Error('boom'), 'pem', 'de')).toEqual({
      field: 'form',
      code: 'error',
      key: null,
    });
    expect(de('certificates.error.certificates_unavailable')).toContain('Lade die Seite neu');
  });
});

describe('what the page shows', () => {
  it('names an issuer by organization and common name', () => {
    expect(nameLabel('CN=R11,O=Let’s Encrypt,C=US')).toBe('Let’s Encrypt (R11)');
    expect(nameLabel('CN=TRAEFIK DEFAULT CERT')).toBe('TRAEFIK DEFAULT CERT');
    expect(nameLabel('O=Haus-CA,C=DE')).toBe('Haus-CA');
    // A comma inside a value is escaped, and is no end of the part.
    expect(nameLabel('CN=Server CA,O=Muster\\, Meier & Co.,C=DE')).toBe(
      'Muster, Meier & Co. (Server CA)',
    );
    expect(nameLabel('cn=lower.example')).toBe('lower.example');
    // Nothing to pick from: shown as it came.
    expect(nameLabel('C=DE')).toBe('C=DE');
    expect(nameLabel('')).toBe('');
  });

  it('groups a fingerprint for the eye and shortens it for the log', () => {
    const fingerprint = '3f9a1c2b7d4e5f60a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
    expect(fingerprintPairs(fingerprint)).toHaveLength(32);
    expect(fingerprintPairs(fingerprint).join('')).toBe(fingerprint);
    expect(fingerprintPairs(fingerprint).slice(0, 3)).toEqual(['3f', '9a', '1c']);
    expect(fingerprintPairs('')).toEqual([]);
    expect(shortFingerprint(fingerprint)).toBe('3f9a1c2b7d4e5f60…');
    expect(shortFingerprint('3f9a')).toBe('3f9a');
  });

  const served = (overrides: Partial<ServedCertificate> = {}): ServedCertificate => ({
    source: 'default',
    certificate_id: null,
    subject: '',
    issuer: '',
    not_after: null,
    fingerprint: '',
    valid_for_host: false,
    ...overrides,
  });
  const host = (
    name: string,
    certificateId: string | null,
    answer: Partial<ServedCertificate> = {},
  ): CertificateHost => ({
    host: name,
    purpose: 'velydock',
    label: '',
    certificate_id: certificateId,
    takeover: false,
    served: served(answer),
  });
  const overview = (hosts: CertificateHost[]): CertificatesOverview => ({
    available: true,
    problem: null,
    acme: false,
    certificates: [],
    hosts,
  });

  it('knows which addresses a stored certificate is meant for', () => {
    const all = overview([
      host('a.example', 'c-1'),
      host('b.example', 'c-2'),
      host('c.example', 'c-1'),
    ]);
    expect(hostsOf(all, 'c-1').map((entry) => entry.host)).toEqual(['a.example', 'c.example']);
    expect(hostsOf(all, 'c-3')).toEqual([]);
  });

  it('waits for the proxy while it answers with something else than what is stored', () => {
    const uploaded = (id: string) => ({ source: 'uploaded' as const, certificate_id: id });
    expect(awaited(host('a', 'c-1', { source: 'default' }))).toBe(true);
    expect(awaited(host('a', 'c-1', { source: 'other', fingerprint: 'aa' }))).toBe(true);
    // Another stored certificate than the one meant for the name.
    expect(awaited(host('a', 'c-1', uploaded('c-2')))).toBe(true);
    expect(awaited(host('a', 'c-1', uploaded('c-1')))).toBe(false);
    // Nothing stored for the name: nothing to wait for.
    expect(awaited(host('a', null, { source: 'default' }))).toBe(false);
    expect(awaited(host('a', null, { source: 'other' }))).toBe(false);
    // Not even when a stored certificate answers for it, or the answer names none at all.
    expect(awaited(host('a', null, uploaded('c-2')))).toBe(false);
    expect(awaited(host('a', null, { source: 'other', certificate_id: undefined }))).toBe(false);
    // The proxy did not answer, or cannot be asked: asking again would not tell more.
    expect(awaited(host('a', 'c-1', { source: 'unreachable' }))).toBe(false);
    expect(awaited(host('a', 'c-1', { source: 'unknown' }))).toBe(false);
  });

  it('is settled once every name gets its stored certificate, and none one that is gone', () => {
    const served1 = { source: 'uploaded' as const, certificate_id: 'c-1', fingerprint: 'new' };
    expect(settled(overview([]))).toBe(true);
    expect(settled(overview([host('a', 'c-1', served1), host('b', null)]))).toBe(true);
    expect(settled(overview([host('a', 'c-1', served1), host('b', 'c-1')]))).toBe(false);
    // A certificate that was removed is still served for a moment: as "another" one.
    const stale = host('a', null, { source: 'other', fingerprint: 'old' });
    expect(settled(overview([stale]))).toBe(true);
    expect(settled(overview([stale]), ['old'])).toBe(false);
    expect(settled(overview([stale]), ['other'])).toBe(true);
    // Hosts that were never answered for have no fingerprint, and match nothing.
    expect(settled(overview([host('a', null, { source: 'unknown' })]), [''])).toBe(true);
    expect(settled(overview([host('a', 'c-1', { source: 'unknown' })]))).toBe(true);
  });

  it('knows the answer that does not resolve itself: a certificate the proxy fetched for the name', () => {
    const fetched = { source: 'other' as const, fingerprint: 'acme' };
    // A stored certificate is meant for the name, and another one answers.
    expect(shadowed(host('a', 'c-1', fetched))).toBe(true);
    // Nothing stored for the name: the fetched one is simply what the name has.
    expect(shadowed(host('a', null, fetched))).toBe(false);
    // The stand-in of the proxy: it has not taken the stored one over, or cannot read it.
    expect(shadowed(host('a', 'c-1', { source: 'default', fingerprint: 'dflt' }))).toBe(false);
    // No answer, or none that can be asked for: nothing is known.
    expect(shadowed(host('a', 'c-1', { source: 'unreachable' }))).toBe(false);
    expect(shadowed(host('a', 'c-1', { source: 'unknown' }))).toBe(false);
    // A stored certificate answers, the meant one or another.
    expect(shadowed(host('a', 'c-1', { source: 'uploaded', certificate_id: 'c-1' }))).toBe(false);
    expect(shadowed(host('a', 'c-1', { source: 'uploaded', certificate_id: 'c-2' }))).toBe(false);
    // What was stored until a moment ago is no stored one any more, and none the proxy fetched.
    expect(shadowed(host('a', 'c-1', fetched), ['acme'])).toBe(false);
    expect(shadowed(host('a', 'c-1', fetched), ['old'])).toBe(true);
  });

  it('tells what is behind without a reason the row names', () => {
    const fetched = { source: 'other' as const, fingerprint: 'acme' };
    const fine = host('a', 'c-1', {
      source: 'uploaded',
      certificate_id: 'c-1',
      fingerprint: 'new',
    });
    expect(lagging(overview([fine]))).toBe(false);
    expect(lagging(overview([]))).toBe(false);
    // Held by a fetched certificate: the row says so, nothing to add.
    expect(lagging(overview([fine, host('b', 'c-1', fetched)]))).toBe(false);
    expect(settled(overview([fine, host('b', 'c-1', fetched)]))).toBe(false);
    // A stored certificate the proxy has not loaded.
    expect(lagging(overview([fine, host('b', 'c-1', { source: 'default' })]))).toBe(true);
    expect(lagging(overview([host('b', 'c-1', fetched), host('c', 'c-1')]))).toBe(true);
    // One that is gone and still served, with or without a stored one meant for the name.
    expect(lagging(overview([host('b', null, fetched)]), ['acme'])).toBe(true);
    expect(lagging(overview([host('b', 'c-1', fetched)]), ['acme'])).toBe(true);
    expect(lagging(overview([host('b', null, fetched)]), ['old'])).toBe(false);
  });

  it('has a text for every reason, purpose, state and warning of the API, and none more', () => {
    const keys = (prefix: string) =>
      Object.keys(translations.de)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length))
        .sort();
    expect(keys('certificates.problem.')).toEqual([
      'no_directory',
      'no_secret',
      'not_writable',
      'unknown',
    ]);
    expect(keys('certificates.purpose.')).toEqual([
      'app',
      'apps',
      'keycloak',
      'sandbox',
      'velydock',
    ]);
    // "valid" has no mark of its own.
    expect(keys('certificates.status.')).toEqual(['expired', 'expires_soon', 'not_yet_valid']);
    expect(keys('certificates.warning.')).toEqual(['no_intermediate']);
    for (const prefix of ['problem', 'purpose', 'status', 'warning']) {
      for (const key of keys(`certificates.${prefix}.`)) {
        expect(translations.en[`certificates.${prefix}.${key}`], key).toBeTruthy();
      }
    }
  });
});
