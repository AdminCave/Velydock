// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { get } from 'svelte/store';
import type { Certificate } from '$lib/api/types';
import { PEM_MAX_BYTES, PKCS12_MAX_BYTES, UPLOAD_ERRORS } from '$lib/certificates';
import ConfirmDialog, { cancelConfirm } from '$lib/components/ui/ConfirmDialog.svelte';
import { setLanguage, translate } from '$lib/i18n';
import { clearToasts, toasts } from '$lib/stores/toasts';
import { errorResponse, jsonResponse, stubApi } from '../test/fixtures';
import CertificateModal from './CertificateModal.svelte';

// The dialog that adds a certificate or puts a new one in the place of a stored one.

afterEach(() => {
  cancelConfirm();
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setLanguage('de', { persist: false });
});

// Nothing in here is a real certificate or key: the dialog only looks for the PEM frame.
const pem = (label: string, body: string) =>
  `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
const CERT = pem('CERTIFICATE', 'MIIBcertcertcert');
const CHAIN = CERT + pem('CERTIFICATE', 'MIICissuerissuer');
const KEY = pem('PRIVATE KEY', 'MIIEsecretsecretsecret');
const ENCRYPTED_KEY = pem('ENCRYPTED PRIVATE KEY', 'MIIFlockedlockedlocked');
// A protected key that does not say so: only the API can tell.
const OPENSSH_KEY = pem('OPENSSH PRIVATE KEY', 'b3BlbnNzaC1rZXktdjEAAAAA');
const P12 = new Uint8Array([0x30, 0x82, 0x00, 0xff, 0x01, 0x80]);
const P12_BASE64 = 'MIIA/wGA';

const stored = (overrides: Partial<Certificate> = {}): Certificate => ({
  id: 'c-1',
  name: 'Wildcard',
  names: ['*.example.com', 'example.com'],
  subject: 'CN=example.com',
  issuer: 'CN=R11,O=Let’s Encrypt,C=US',
  chain: ['CN=example.com', 'CN=R11,O=Let’s Encrypt,C=US'],
  serial: '4F2A',
  key_type: 'EC P-256',
  fingerprint: '3f9a1c2b7d4e5f60a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718',
  not_before: '2026-10-01T00:00:00Z',
  not_after: '2027-10-01T00:00:00Z',
  status: 'valid',
  warnings: [],
  fetched_before: [],
  created_at: '2026-11-20T09:00:00Z',
  updated_at: '2026-11-20T09:00:00Z',
  ...overrides,
});

const de = (key: string, vars?: Record<string, string | number | null | undefined>) =>
  translate('de', key, vars);

function open(
  props: { certificate?: Certificate | null } = {},
  routes: Parameters<typeof stubApi>[0] = {},
) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const api = stubApi({
    'POST /api/v1/system/certificates': ({ body }) =>
      jsonResponse(stored({ id: 'c-new', name: (body as { name: string }).name }), 201),
    'PUT /api/v1/system/certificates/c-1': () => stored(),
    ...routes,
  });
  const view = render(CertificateModal, {
    open: true,
    certificate: null,
    onClose,
    onSaved,
    ...props,
  });
  return { ...api, view, onClose, onSaved };
}

const field = <T extends HTMLElement = HTMLInputElement>(testid: string) =>
  screen.getByTestId(testid) as T;
const type = (testid: string, value: string) =>
  fireEvent.input(screen.getByTestId(testid), { target: { value } });
const pick = (testid: string, file: File) =>
  fireEvent.change(screen.getByTestId(testid), { target: { files: [file] } });
const choose = (format: 'pem' | 'pkcs12') =>
  fireEvent.click(
    screen
      .getByTestId('certificate-format')
      .querySelector<HTMLInputElement>(`input[value="${format}"]`)!,
  );
const save = () => fireEvent.click(screen.getByTestId('certificate-save'));
const file = (parts: BlobPart[], name: string) => new File(parts, name);
const writes = (calls: { method: string; url: string; body: unknown }[]) =>
  calls.filter((call) => call.method !== 'GET');

/** Name, certificate and key as PEM: what the API would take. */
async function fillPem(name = 'Wildcard 2027') {
  await type('certificate-name', name);
  await type('certificate-text', CHAIN);
  await type('certificate-key-text', KEY);
}

async function fillPkcs12(name = 'Wildcard 2027') {
  await type('certificate-name', name);
  await choose('pkcs12');
  await pick('certificate-pkcs12-file', file([P12], 'wildcard.p12'));
  await screen.findByTestId('certificate-pkcs12-chosen');
}

/** The messages on screen: the code each stands for, its text and the control it is at. */
function errorsShown() {
  return screen.queryAllByTestId('certificate-error').map((message) => {
    const at = message.closest('.ui-field')?.querySelector<HTMLElement>('[aria-invalid="true"]');
    // Each message is tied to its control, for those who do not see where it stands.
    if (at) expect(at.getAttribute('aria-describedby')).toContain(message.id);
    return {
      code: message.getAttribute('data-code'),
      text: message.textContent?.trim() ?? '',
      at: at?.getAttribute('data-testid') ?? (message.closest('.ui-field') ? 'field' : 'form'),
    };
  });
}

describe('CertificateModal: adding a certificate as PEM', () => {
  it('asks for a name, the format, certificate with chain, key and passphrase', () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Zertifikat hinzufügen' });
    expect(within(dialog).getByLabelText('Name', { exact: true })).toBe(field('certificate-name'));
    expect(screen.getByTestId('certificate-format')).toHaveAttribute('data-value', 'pem');
    expect(
      within(screen.getByTestId('certificate-format'))
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent?.trim()),
    ).toEqual(['PEM (Text)', 'PKCS#12 (.p12, .pfx)']);
    expect(within(dialog).getByLabelText('Zertifikat', { exact: true })).toBe(
      field('certificate-text'),
    );
    expect(within(dialog).getByLabelText('Privater Schlüssel', { exact: true })).toBe(
      field('certificate-key-text'),
    );
    expect(within(dialog).getByLabelText('Passphrase', { exact: true })).toBe(
      field('certificate-passphrase'),
    );
    for (const id of ['certificate-file', 'certificate-key-file']) {
      expect(field(id)).toHaveAttribute('type', 'file');
    }
    expect(within(dialog).getByLabelText('Zertifikatsdatei wählen')).toBe(
      field('certificate-file'),
    );
    expect(within(dialog).getByLabelText('Schlüsseldatei wählen')).toBe(
      field('certificate-key-file'),
    );
    expect(screen.queryByTestId('certificate-pkcs12-file')).toBeNull();
    // The file of the certificate may hold the key as well; and when the passphrase is needed.
    expect(dialog).toHaveTextContent(
      'Die Datei darf auch den privaten Schlüssel enthalten – dann bleibt das nächste Feld leer.',
    );
    expect(dialog).toHaveTextContent(
      'Nur nötig, wenn der private Schlüssel mit einer Passphrase geschützt ist.',
    );
    expect(screen.getByTestId('certificate-save')).toHaveTextContent('Zertifikat hinzufügen');
    expect(screen.queryByTestId('certificate-error')).toBeNull();
  });

  it('keeps browsers from remembering or checking what is entered', () => {
    open();
    for (const id of ['certificate-text', 'certificate-key-text', 'certificate-passphrase']) {
      expect(field(id), id).toHaveAttribute('autocomplete', 'off');
      expect(field(id), id).toHaveAttribute('spellcheck', 'false');
    }
    expect(field('certificate-name')).toHaveAttribute('autocomplete', 'off');
    expect(field('certificate-passphrase')).toHaveAttribute('type', 'password');
    expect(field('certificate-name').closest('form')).toHaveAttribute('autocomplete', 'off');
  });

  it('sends what was pasted, and nothing that was left empty', async () => {
    const { calls, onSaved } = open();
    await fillPem('  Wildcard   2027 ');
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(writes(calls).map((call) => [call.method, call.url, call.body])).toEqual([
      [
        'POST',
        '/api/v1/system/certificates',
        { name: 'Wildcard 2027', certificate: CHAIN, private_key: KEY },
      ],
    ]);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-new' }), true);
    // The page says that it worked; the dialog itself announces nothing.
    expect(get(toasts)).toEqual([]);
  });

  it('reads chosen files in the browser, as text', async () => {
    const { calls, onSaved } = open();
    await type('certificate-name', 'Wildcard');
    await pick('certificate-file', file([CHAIN], 'fullchain.pem'));
    await waitFor(() => expect(field('certificate-text')).toHaveValue(CHAIN));
    // The input itself keeps nothing of the file: it is emptied as soon as the file is taken.
    const emptied = vi.fn();
    Object.defineProperty(field('certificate-key-file'), 'value', {
      configurable: true,
      get: () => 'C:\\fakepath\\privkey.pem',
      set: emptied,
    });
    await pick('certificate-key-file', file([KEY], 'privkey.pem'));
    await waitFor(() => expect(field('certificate-key-text')).toHaveValue(KEY));
    expect(emptied).toHaveBeenCalledWith('');
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(writes(calls)[0].body).toEqual({
      name: 'Wildcard',
      certificate: CHAIN,
      private_key: KEY,
    });
  });

  it('waits for a file that is still being read when "save" is pressed, and sends it then', async () => {
    // Readers that answer when the test says so: a click can come before the file is read.
    const reading: { reader: FileReader; file: Blob }[] = [];
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (
      this: FileReader,
      blob: Blob,
    ) {
      reading.push({ reader: this, file: blob });
    });
    const finish = async (at: number, text: string) => {
      Object.defineProperty(reading[at].reader, 'result', { value: text });
      reading[at].reader.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>);
    };
    const { calls, onSaved } = open();
    await type('certificate-name', 'Wildcard');
    await pick('certificate-file', file([CHAIN], 'fullchain.pem'));
    await pick('certificate-key-file', file([KEY], 'privkey.pem'));
    await waitFor(() => expect(reading).toHaveLength(2));
    await save();
    // Nothing is sent without the files, and nothing is called missing that is on its way.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes(calls)).toEqual([]);
    expect(errorsShown()).toEqual([]);
    expect(screen.getByTestId('certificate-save')).toBeDisabled();
    await finish(0, CHAIN);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes(calls)).toEqual([]);
    await finish(1, KEY);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(writes(calls).map((call) => call.body)).toEqual([
      { name: 'Wildcard', certificate: CHAIN, private_key: KEY },
    ]);
  });

  it('says what is wrong with a file that was still being read when "save" was pressed', async () => {
    const reading: FileReader[] = [];
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader) {
      reading.push(this);
    });
    const { calls } = open();
    await type('certificate-name', 'Wildcard');
    await type('certificate-text', CHAIN);
    await pick('certificate-key-file', file(['no key in here'], 'notes.txt'));
    await waitFor(() => expect(reading).toHaveLength(1));
    await save();
    Object.defineProperty(reading[0], 'result', { value: 'no key in here' });
    reading[0].onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>);
    // The file is refused, and so the key is missing: both are said at the key.
    await waitFor(() => expect(errorsShown()).toHaveLength(1));
    expect(errorsShown()[0]).toMatchObject({ code: 'key_missing', at: 'certificate-key-text' });
    expect(writes(calls)).toEqual([]);
    expect(screen.getByTestId('certificate-save')).toBeEnabled();
  });

  it('takes a file of the certificate that holds the key as well', async () => {
    const { calls, onSaved } = open();
    await type('certificate-name', 'Wildcard');
    await pick('certificate-file', file([KEY, CHAIN], 'bundle.pem'));
    await waitFor(() => expect(field('certificate-text')).toHaveValue(KEY + CHAIN));
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(writes(calls)[0].body).toEqual({ name: 'Wildcard', certificate: KEY + CHAIN });
  });

  it('sends the passphrase with a protected key', async () => {
    const { calls, onSaved } = open();
    await type('certificate-name', 'Wildcard');
    await type('certificate-text', CERT);
    await type('certificate-key-text', ENCRYPTED_KEY);
    await type('certificate-passphrase', 'correct horse');
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(writes(calls)[0].body).toEqual({
      name: 'Wildcard',
      certificate: CERT,
      private_key: ENCRYPTED_KEY,
      passphrase: 'correct horse',
    });
  });

  it('says that the passphrase is needed as soon as the key says it is protected', async () => {
    open();
    const dialog = screen.getByRole('dialog');
    expect(dialog).not.toHaveTextContent('Dieser Schlüssel ist mit einer Passphrase geschützt');
    await type('certificate-key-text', ENCRYPTED_KEY);
    expect(dialog).toHaveTextContent(
      'Dieser Schlüssel ist mit einer Passphrase geschützt: Ohne sie lässt er sich nicht lesen.',
    );
    await type('certificate-key-text', KEY);
    expect(dialog).not.toHaveTextContent('Dieser Schlüssel ist mit einer Passphrase geschützt');
  });

  describe('says what is missing before anything is sent', () => {
    it('an empty form: the name and the certificate', async () => {
      const { calls } = open();
      await save();
      expect(errorsShown()).toEqual([
        { code: 'validation', text: 'Dieses Feld wird gebraucht.', at: 'certificate-name' },
        {
          code: 'certificate_missing',
          text: de('certificates.error.certificate_missing'),
          at: 'certificate-text',
        },
      ]);
      expect(writes(calls)).toEqual([]);
      // The first field that needs something gets the focus.
      await waitFor(() => expect(document.activeElement).toBe(field('certificate-name')));
    });

    it('a certificate without its key', async () => {
      const { calls } = open();
      await type('certificate-name', 'Wildcard');
      await type('certificate-text', CHAIN);
      await save();
      expect(errorsShown()).toEqual([
        {
          code: 'key_missing',
          text: de('certificates.error.key_missing'),
          at: 'certificate-key-text',
        },
      ]);
      expect(writes(calls)).toEqual([]);
    });

    it('more than one key', async () => {
      const { calls } = open();
      await type('certificate-name', 'Wildcard');
      await type('certificate-text', CHAIN + KEY);
      await type('certificate-key-text', KEY);
      await save();
      expect(errorsShown()).toEqual([
        {
          code: 'several_keys',
          text: 'Hier steht mehr als ein privater Schlüssel. Erwartet wird genau einer.',
          at: 'certificate-key-text',
        },
      ]);
      expect(writes(calls)).toEqual([]);
    });

    it('a protected key without its passphrase: said at the passphrase, which gets the focus', async () => {
      const { calls } = open();
      await type('certificate-name', 'Wildcard');
      await type('certificate-text', CERT);
      await type('certificate-key-text', ENCRYPTED_KEY);
      await save();
      expect(errorsShown()).toEqual([
        {
          code: 'key_encrypted',
          text: 'Der private Schlüssel ist mit einer Passphrase geschützt. Gib sie hier ein.',
          at: 'certificate-passphrase',
        },
      ]);
      expect(writes(calls)).toEqual([]);
      await waitFor(() => expect(document.activeElement).toBe(field('certificate-passphrase')));
    });
  });

  describe('refuses what is too large before sending it', () => {
    const big = (bytes: number) => file(['a'.repeat(bytes)], 'big.pem');

    it('a certificate file of more than 64 KB', async () => {
      const { calls } = open();
      await pick('certificate-file', big(PEM_MAX_BYTES + 1));
      await waitFor(() =>
        expect(errorsShown()).toEqual([
          {
            code: 'too_large',
            text: 'Zu groß für ein Zertifikat: Möglich sind hier höchstens 64 KB.',
            at: 'certificate-text',
          },
        ]),
      );
      // Nothing of it was taken.
      expect(field('certificate-text')).toHaveValue('');
      expect(calls).toEqual([]);
    });

    it('a key file of more than 64 KB, and none of exactly that size', async () => {
      open();
      await pick('certificate-key-file', big(PEM_MAX_BYTES + 1));
      await waitFor(() => expect(errorsShown().map((error) => error.code)).toEqual(['too_large']));
      expect(errorsShown()[0].at).toBe('certificate-key-text');
      expect(field('certificate-key-text')).toHaveValue('');
      // The next file is judged on its own: the message goes, the text comes.
      const fits = file([KEY, 'a'.repeat(PEM_MAX_BYTES - KEY.length)], 'key.pem');
      expect(fits.size).toBe(PEM_MAX_BYTES);
      await pick('certificate-key-file', fits);
      await waitFor(() => expect(field('certificate-key-text').value).toHaveLength(PEM_MAX_BYTES));
      expect(errorsShown()).toEqual([]);
    });

    it('pasted text of more than 64 KB', async () => {
      const { calls } = open();
      await type('certificate-name', 'Wildcard');
      await type('certificate-text', CERT + 'a'.repeat(PEM_MAX_BYTES));
      await type('certificate-key-text', KEY);
      await save();
      expect(errorsShown()).toEqual([
        {
          code: 'too_large',
          text: 'Zu groß für ein Zertifikat: Möglich sind hier höchstens 64 KB.',
          at: 'certificate-text',
        },
      ]);
      expect(writes(calls)).toEqual([]);
    });
  });

  it('does not take a file that holds no PEM text, and says where such a file belongs', async () => {
    open();
    await pick('certificate-file', file([P12], 'wildcard.pfx'));
    await waitFor(() =>
      expect(errorsShown()).toEqual([
        {
          code: 'not_pem',
          text: 'In dieser Datei steht kein PEM-Text (-----BEGIN …-----). Eine .p12- oder .pfx-Datei lädst du über „PKCS#12“ hoch.',
          at: 'certificate-text',
        },
      ]),
    );
    expect(field('certificate-text')).toHaveValue('');
    await pick('certificate-key-file', file([], 'empty.key'));
    await waitFor(() => expect(errorsShown()).toHaveLength(2));
    expect(errorsShown()[1]).toMatchObject({ code: 'not_pem', at: 'certificate-key-text' });
  });

  it('says so when the browser cannot read a file', async () => {
    open();
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader) {
      queueMicrotask(() => this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>));
    });
    await pick('certificate-key-file', file([KEY], 'privkey.pem'));
    await waitFor(() =>
      expect(errorsShown()).toEqual([
        {
          code: 'file_unreadable',
          text: 'Die Datei ließ sich nicht lesen. Wähl sie noch einmal.',
          at: 'certificate-key-text',
        },
      ]),
    );
  });
});

describe('CertificateModal: adding a certificate as PKCS#12', () => {
  it('asks for one file and its passphrase instead of certificate and key', async () => {
    open();
    await choose('pkcs12');
    expect(screen.getByTestId('certificate-format')).toHaveAttribute('data-value', 'pkcs12');
    for (const id of [
      'certificate-text',
      'certificate-file',
      'certificate-key-text',
      'certificate-key-file',
    ]) {
      expect(screen.queryByTestId(id), id).toBeNull();
    }
    const input = field('certificate-pkcs12-file');
    expect(input).toHaveAttribute('type', 'file');
    expect(input.accept.split(',')).toEqual(expect.arrayContaining(['.p12', '.pfx']));
    expect(screen.getByLabelText(/PKCS#12-Datei/)).toBe(input);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Die Passphrase der Datei. Leer lassen, wenn sie keine hat.');
    expect(field('certificate-passphrase')).toBeInTheDocument();
  });

  it('reads the file as bytes and sends them as base64, with the passphrase', async () => {
    const { calls, onSaved } = open();
    await fillPkcs12();
    expect(screen.getByTestId('certificate-pkcs12-chosen')).toHaveTextContent(
      'Gewählt: wildcard.p12 (1 KB)',
    );
    await type('certificate-passphrase', 'correct horse');
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(writes(calls).map((call) => [call.method, call.url, call.body])).toEqual([
      [
        'POST',
        '/api/v1/system/certificates',
        { name: 'Wildcard 2027', pkcs12: P12_BASE64, passphrase: 'correct horse' },
      ],
    ]);
  });

  it('waits for the file when "save" is pressed while it is still being read', async () => {
    const reading: FileReader[] = [];
    vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader) {
      reading.push(this);
    });
    const { calls, onSaved } = open();
    await type('certificate-name', 'Wildcard');
    await choose('pkcs12');
    await pick('certificate-pkcs12-file', file([P12], 'wildcard.p12'));
    await waitFor(() => expect(reading).toHaveLength(1));
    await save();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes(calls)).toEqual([]);
    expect(errorsShown()).toEqual([]);
    Object.defineProperty(reading[0], 'result', {
      value: `data:application/x-pkcs12;base64,${P12_BASE64}`,
    });
    reading[0].onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(writes(calls)[0].body).toEqual({ name: 'Wildcard', pkcs12: P12_BASE64 });
  });

  it('sends only the format that is chosen, whatever was entered for the other', async () => {
    const { calls, onSaved } = open();
    await fillPem();
    await choose('pkcs12');
    await pick('certificate-pkcs12-file', file([P12], 'wildcard.p12'));
    await screen.findByTestId('certificate-pkcs12-chosen');
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(writes(calls)[0].body).toEqual({ name: 'Wildcard 2027', pkcs12: P12_BASE64 });
  });

  it('asks for the file when there is none', async () => {
    const { calls } = open();
    await type('certificate-name', 'Wildcard');
    await choose('pkcs12');
    await save();
    expect(errorsShown()).toEqual([
      {
        code: 'certificate_missing',
        text: 'Wähl eine .p12- oder .pfx-Datei mit Zertifikat und privatem Schlüssel.',
        at: 'certificate-pkcs12-file',
      },
    ]);
    expect(writes(calls)).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(field('certificate-pkcs12-file')));
  });

  it('refuses a file of more than 96 KB before sending it, and takes one of exactly that size', async () => {
    const { calls } = open();
    await type('certificate-name', 'Wildcard');
    await choose('pkcs12');
    await pick('certificate-pkcs12-file', file([new Uint8Array(PKCS12_MAX_BYTES + 1)], 'huge.p12'));
    await waitFor(() =>
      expect(errorsShown()).toEqual([
        {
          code: 'too_large',
          text: 'Zu groß für ein Zertifikat: Möglich sind hier höchstens 96 KB.',
          at: 'certificate-pkcs12-file',
        },
      ]),
    );
    expect(screen.queryByTestId('certificate-pkcs12-chosen')).toBeNull();
    await save();
    expect(writes(calls)).toEqual([]);

    await pick('certificate-pkcs12-file', file([new Uint8Array(PKCS12_MAX_BYTES)], 'fits.p12'));
    expect(await screen.findByTestId('certificate-pkcs12-chosen')).toHaveTextContent(
      'Gewählt: fits.p12 (96 KB)',
    );
    expect(errorsShown()).toEqual([]);
  });

  it('drops the file chosen before when the next one is refused', async () => {
    open();
    await fillPkcs12();
    await pick('certificate-pkcs12-file', file([], 'empty.p12'));
    await waitFor(() =>
      expect(errorsShown().map((error) => error.code)).toEqual(['pkcs12_unreadable']),
    );
    expect(screen.queryByTestId('certificate-pkcs12-chosen')).toBeNull();
  });
});

describe('CertificateModal: what the API refuses', () => {
  const refusal = (code: string, details: Record<string, unknown> = {}, status = 422) =>
    jsonResponse(
      { error: { code, message: 'English text of the server, never shown', details } },
      status,
    );
  const CONTROL = {
    name: 'certificate-name',
    certificate: 'certificate-text',
    key: 'certificate-key-text',
    passphrase: 'certificate-passphrase',
    pkcs12: 'certificate-pkcs12-file',
    form: 'form',
  };
  // The answers with details, as the API sends them.
  const DETAILS: Record<string, Record<string, unknown>> = {
    expired: { not_after: '2025-03-01T12:00:00+00:00' },
    not_yet_valid: { not_before: '2027-03-01T12:00:00+00:00' },
    common_name_not_listed: { common_name: 'dock.example.com' },
    names_taken: { names: ['example.com'], certificate: 'Wildcard', certificate_id: 'c-1' },
    validation: {
      fields: [{ field: 'name', message: 'String should have at most 80 characters' }],
    },
  };
  const STATUS: Record<string, number> = {
    names_taken: 409,
    certificate_exists: 409,
    name_taken: 409,
    certificates_unavailable: 409,
  };
  const TEXT: Record<string, string> = {
    expired: 'Dieses Zertifikat ist am 01.03.2025 abgelaufen.',
    not_yet_valid:
      'Dieses Zertifikat gilt erst ab dem 01.03.2027. Hinterlege es an diesem Tag: Der Proxy würde es sofort ausliefern, und Browser lehnen es bis dahin ab.',
    common_name_not_listed:
      'Der „Common Name“ dock.example.com steht nicht unter den Namen, für die das Zertifikat gilt. Der Proxy würde es für dock.example.com ausliefern, und Browser lehnten es dort ab.',
    too_large: 'Zu groß für ein Zertifikat: Möglich sind hier höchstens 64 KB.',
    names_taken:
      'Für example.com ist schon das Zertifikat „Wildcard“ gespeichert. Ein Name darf nur in einem gespeicherten Zertifikat stehen: Ersetz „Wildcard“, statt ein zweites hinzuzufügen.',
  };
  const answer = (code: string) => () => refusal(code, DETAILS[code], STATUS[code] ?? 422);

  it.each(Object.keys(UPLOAD_ERRORS))('%s: its own text at the field it is about', async (code) => {
    open({}, { 'POST /api/v1/system/certificates': answer(code) });
    await fillPem();
    // Nothing the dialog would stop itself: a key whose protection only the API sees.
    await type('certificate-key-text', OPENSSH_KEY);
    await save();
    const pemField = code === 'validation' ? 'name' : UPLOAD_ERRORS[code];
    const expected = pemField === 'pkcs12' ? 'form' : pemField;
    await waitFor(() => expect(errorsShown()).toHaveLength(1));
    const [shown] = errorsShown();
    expect(shown.code).toBe(code);
    expect(shown.at).toBe(CONTROL[expected]);
    expect(shown.text).toBe(TEXT[code] ?? de(`certificates.error.${code}`));
    expect(shown.text).not.toContain('English text');
    // It stays in the dialog: no toast.
    expect(get(toasts)).toEqual([]);
    if (expected === 'form') {
      expect(within(screen.getByTestId('certificate-error')).getByRole('alert')).toBeVisible();
    } else {
      await waitFor(() => expect(document.activeElement).toBe(field(CONTROL[expected])));
    }
  });

  it.each(Object.keys(UPLOAD_ERRORS))(
    '%s from a PKCS#12 file: at the file unless it is about name or passphrase',
    async (code) => {
      open({}, { 'POST /api/v1/system/certificates': answer(code) });
      await fillPkcs12();
      await save();
      const pemField = code === 'validation' ? 'name' : UPLOAD_ERRORS[code];
      const expected = pemField === 'certificate' || pemField === 'key' ? 'pkcs12' : pemField;
      await waitFor(() => expect(errorsShown()).toHaveLength(1));
      const [shown] = errorsShown();
      expect(shown.code).toBe(code);
      expect(shown.at).toBe(CONTROL[expected]);
      expect(shown.text).not.toContain('English text');
    },
  );

  it('words them for the file where the wording for PEM would be wrong', async () => {
    open({}, { 'POST /api/v1/system/certificates': answer('key_missing') });
    await fillPkcs12();
    await save();
    await waitFor(() => expect(errorsShown()).toHaveLength(1));
    expect(errorsShown()[0].text).toBe('Die Datei enthält keinen privaten Schlüssel.');
    await fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
  });

  it('asks for the passphrase at its field, and puts the focus there', async () => {
    const { calls } = open({}, { 'POST /api/v1/system/certificates': answer('key_encrypted') });
    await fillPem();
    await type('certificate-key-text', OPENSSH_KEY);
    await save();
    await waitFor(() => expect(errorsShown()).toHaveLength(1));
    expect(writes(calls)).toHaveLength(1);
    expect(errorsShown()).toEqual([
      {
        code: 'key_encrypted',
        text: 'Der private Schlüssel ist mit einer Passphrase geschützt. Gib sie hier ein.',
        at: 'certificate-passphrase',
      },
    ]);
    await waitFor(() => expect(document.activeElement).toBe(field('certificate-passphrase')));
    expect(field('certificate-passphrase')).toHaveAttribute('aria-invalid', 'true');
    // Typing it takes the message back; the other fields keep what they hold.
    await type('certificate-passphrase', 'correct horse');
    expect(errorsShown()).toEqual([]);
    expect(field('certificate-key-text')).toHaveValue(OPENSSH_KEY);
  });

  it('says it in English on an English page', async () => {
    setLanguage('en', { persist: false });
    open({}, { 'POST /api/v1/system/certificates': answer('key_mismatch') });
    await fillPem();
    await save();
    await waitFor(() => expect(errorsShown()).toHaveLength(1));
    expect(errorsShown()[0]).toEqual({
      code: 'key_mismatch',
      text: 'The private key does not belong to this certificate.',
      at: 'certificate-key-text',
    });
    expect(screen.getByRole('dialog', { name: 'Add certificate' })).toBeVisible();
  });

  it('offers to replace the certificate that holds a name already, with what was entered', async () => {
    const { calls, onSaved } = open(
      {},
      {
        'POST /api/v1/system/certificates': answer('names_taken'),
        'PUT /api/v1/system/certificates/c-1': () => stored({ name: 'Wildcard' }),
      },
    );
    await fillPem('Neues Zertifikat');
    await type('certificate-passphrase', 'correct horse');
    await save();
    const offer = await screen.findByTestId('certificate-replace-other');
    expect(offer).toHaveTextContent('Stattdessen „Wildcard“ ersetzen');
    expect(errorsShown()[0]).toMatchObject({ code: 'names_taken', at: 'certificate-text' });

    // A click puts the focus on the button, which then goes away with its message.
    offer.focus();
    await fireEvent.click(offer);
    // The dialog is now the one for that entry: its name, and nothing to complain about.
    expect(screen.getByRole('dialog', { name: 'Zertifikat „Wildcard“ ersetzen' })).toBeVisible();
    expect(field('certificate-name')).toHaveValue('Wildcard');
    expect(errorsShown()).toEqual([]);
    expect(screen.queryByTestId('certificate-replace-other')).toBeNull();
    expect(field('certificate-text')).toHaveValue(CHAIN);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('certificate-save')),
    );

    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(writes(calls).map((call) => [call.method, call.url, call.body])).toEqual([
      [
        'POST',
        '/api/v1/system/certificates',
        {
          name: 'Neues Zertifikat',
          certificate: CHAIN,
          private_key: KEY,
          passphrase: 'correct horse',
        },
      ],
      [
        'PUT',
        '/api/v1/system/certificates/c-1',
        { certificate: CHAIN, private_key: KEY, passphrase: 'correct horse' },
      ],
    ]);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-1' }), false);
  });

  it('takes the offer back when the certificate is edited', async () => {
    open({}, { 'POST /api/v1/system/certificates': answer('names_taken') });
    await fillPem();
    await save();
    await screen.findByTestId('certificate-replace-other');
    await type('certificate-text', CERT);
    expect(screen.queryByTestId('certificate-replace-other')).toBeNull();
    expect(errorsShown()).toEqual([]);
  });

  it('makes no offer where the answer does not say which certificate it is', async () => {
    open(
      {},
      {
        'POST /api/v1/system/certificates': () => refusal('names_taken', {}, 409),
      },
    );
    await fillPem();
    await save();
    await waitFor(() => expect(errorsShown()).toHaveLength(1));
    expect(errorsShown()[0].text).toBe(
      'Für mindestens einen dieser Namen ist schon ein Zertifikat gespeichert. Ersetz das, statt ein zweites hinzuzufügen.',
    );
    expect(screen.queryByTestId('certificate-replace-other')).toBeNull();
  });

  it('says what it does not know with the general texts, in the dialog', async () => {
    open({}, { 'POST /api/v1/system/certificates': () => errorResponse(403, 'forbidden') });
    await fillPem();
    await save();
    await waitFor(() => expect(errorsShown()).toHaveLength(1));
    expect(errorsShown()[0]).toEqual({
      code: 'forbidden',
      text: 'Dafür fehlt dir die Berechtigung.',
      at: 'form',
    });
    expect(get(toasts)).toEqual([]);
    // What was entered is still there for another try.
    expect(field('certificate-key-text')).toHaveValue(KEY);
  });

  it('forgets what was said about one format when the other is chosen', async () => {
    open({}, { 'POST /api/v1/system/certificates': answer('key_mismatch') });
    await fillPem();
    await save();
    await waitFor(() => expect(errorsShown()).toHaveLength(1));
    await choose('pkcs12');
    expect(errorsShown()).toEqual([]);
    await choose('pem');
    expect(errorsShown()).toEqual([]);
    expect(field('certificate-key-text')).not.toHaveAttribute('aria-invalid');
  });
});

describe('CertificateModal: the private key stays where it was entered', () => {
  const SECRET = 'MIIEsecretsecretsecret';
  const everywhere = () =>
    ['certificate-name', 'certificate-text', 'certificate-key-text', 'certificate-passphrase'].map(
      (id) => field(id).value,
    );

  it('never shows up in a message, a toast or the console, whatever the API answers', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    let answers = 0;
    const { onSaved } = open(
      {},
      {
        // An answer that repeats what was sent, as a careless server might.
        'POST /api/v1/system/certificates': ({ body }) => {
          answers += 1;
          if (answers > 1) return jsonResponse(stored(), 201);
          return jsonResponse(
            {
              error: {
                code: 'key_unreadable',
                message: `Cannot read ${(body as { private_key: string }).private_key}`,
                details: { private_key: (body as { private_key: string }).private_key },
              },
            },
            422,
          );
        },
      },
    );
    await fillPem();
    await type('certificate-passphrase', 'correct horse');
    await save();
    await waitFor(() => expect(errorsShown()).toHaveLength(1));
    const shown = () =>
      [
        ...screen.queryAllByTestId('certificate-error').map((message) => message.textContent),
        ...screen.queryAllByRole('alert').map((alert) => alert.textContent),
        ...get(toasts).map((toast) => toast.message),
        ...spies.flatMap((spy) => spy.mock.calls.flat().map(String)),
      ].join('\n');
    expect(shown()).not.toContain(SECRET);
    expect(shown()).not.toContain('correct horse');
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(shown()).not.toContain(SECRET);
    expect(shown()).not.toContain('correct horse');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('is gone once the upload succeeded, even while the dialog is still on screen', async () => {
    // A page that does not close the dialog at once.
    const { onSaved } = open();
    await fillPem();
    await type('certificate-passphrase', 'correct horse');
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(everywhere()).toEqual(['', '', '', '']);
  });

  it('is gone once the dialog closes, however it is opened again', async () => {
    const { view } = open();
    await fillPem();
    await type('certificate-passphrase', 'correct horse');
    expect(everywhere()).toEqual(['Wildcard 2027', CHAIN, KEY, 'correct horse']);
    await view.rerender({ open: false });
    expect(screen.queryByTestId('certificate-key-text')).toBeNull();
    await view.rerender({ open: true });
    expect(everywhere()).toEqual(['', '', '', '']);
    expect(screen.getByTestId('certificate-format')).toHaveAttribute('data-value', 'pem');
  });

  it('takes the PKCS#12 file and its messages away as well', async () => {
    const { view, calls } = open();
    await fillPkcs12();
    await view.rerender({ open: false });
    await view.rerender({ open: true });
    await choose('pkcs12');
    expect(screen.queryByTestId('certificate-pkcs12-chosen')).toBeNull();
    await type('certificate-name', 'Wildcard');
    await save();
    expect(errorsShown().map((error) => error.code)).toEqual(['certificate_missing']);
    expect(writes(calls)).toEqual([]);
  });

  it('takes nothing from a file that was still being read when the dialog closed', async () => {
    // A reader whose answer comes when the test says so.
    const reading: FileReader[] = [];
    vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader) {
      reading.push(this);
    });
    const { view } = open();
    await pick('certificate-key-file', file([KEY], 'privkey.pem'));
    await waitFor(() => expect(reading).toHaveLength(1));
    await view.rerender({ open: false });
    await view.rerender({ open: true });
    Object.defineProperty(reading[0], 'result', { value: KEY });
    reading[0].onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(field('certificate-key-text')).toHaveValue('');

    // The same answer while the dialog is open is taken.
    await pick('certificate-key-file', file([KEY], 'privkey.pem'));
    await waitFor(() => expect(reading).toHaveLength(2));
    Object.defineProperty(reading[1], 'result', { value: KEY });
    reading[1].onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>);
    await waitFor(() => expect(field('certificate-key-text')).toHaveValue(KEY));
  });

  it('says nothing in a dialog opened anew about an upload of the one before', async () => {
    let answer: (response: Response) => void = () => {};
    const { view, calls } = open(
      {},
      {
        'POST /api/v1/system/certificates': () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      },
    );
    await fillPem();
    await save();
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    // Closed while the request is under way, and opened again for something else.
    await view.rerender({ open: false });
    await view.rerender({ open: true });
    answer(jsonResponse({ error: { code: 'key_mismatch', message: 'no', details: {} } }, 422));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errorsShown()).toEqual([]);
    expect(screen.getByTestId('certificate-save')).toBeEnabled();
    expect(everywhere()).toEqual(['', '', '', '']);
  });

  it('is not thrown away by a stray Escape: the dialog asks first', async () => {
    render(ConfirmDialog);
    const { onClose } = open();
    await type('certificate-key-text', KEY);
    await fireEvent.keyDown(document, { key: 'Escape' });
    const question = await screen.findByRole('dialog', { name: 'Eingaben verwerfen?' });
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.click(within(question).getByRole('button', { name: 'Verwerfen' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('closes at once on Escape while nothing was entered', async () => {
    render(ConfirmDialog);
    const { onClose } = open();
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Eingaben verwerfen?' })).toBeNull();
  });
});

describe('CertificateModal: replacing a stored certificate', () => {
  const wildcard = stored();

  it('is the dialog of that entry: its name, and the new certificate to give', () => {
    open({ certificate: wildcard });
    const dialog = screen.getByRole('dialog', { name: 'Zertifikat „Wildcard“ ersetzen' });
    expect(field('certificate-name')).toHaveValue('Wildcard');
    expect(dialog).toHaveTextContent(
      'Das neue Zertifikat tritt an die Stelle des bisherigen, zum Beispiel nach einer Verlängerung.',
    );
    expect(field('certificate-text')).toHaveValue('');
    expect(screen.getByTestId('certificate-save')).toHaveTextContent('Ersetzen');
  });

  it('sends the new certificate to the entry, and no name while it was not changed', async () => {
    const { calls, onSaved } = open({ certificate: wildcard });
    await type('certificate-text', CHAIN);
    await type('certificate-key-text', KEY);
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(writes(calls).map((call) => [call.method, call.url, call.body])).toEqual([
      ['PUT', '/api/v1/system/certificates/c-1', { certificate: CHAIN, private_key: KEY }],
    ]);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-1' }), false);
  });

  it('does not take blanks around the name for a change', async () => {
    const { calls, onSaved } = open({ certificate: wildcard });
    await type('certificate-name', '  Wildcard ');
    await type('certificate-text', CHAIN + KEY);
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(writes(calls)[0].body).toEqual({ certificate: CHAIN + KEY });
  });

  it('sends the name when it was edited', async () => {
    const { calls, onSaved } = open(
      { certificate: wildcard },
      { 'PUT /api/v1/system/certificates/c-1': () => stored({ name: 'Wildcard 2027' }) },
    );
    await type('certificate-name', 'Wildcard  2027');
    await fillPkcs12('Wildcard  2027');
    await save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(writes(calls).map((call) => [call.method, call.url, call.body])).toEqual([
      ['PUT', '/api/v1/system/certificates/c-1', { name: 'Wildcard 2027', pkcs12: P12_BASE64 }],
    ]);
  });

  it('needs a name all the same', async () => {
    const { calls } = open({ certificate: wildcard });
    await type('certificate-name', '   ');
    await type('certificate-text', CHAIN + KEY);
    await save();
    expect(errorsShown()).toEqual([
      { code: 'validation', text: 'Dieses Feld wird gebraucht.', at: 'certificate-name' },
    ]);
    expect(writes(calls)).toEqual([]);
  });

  it('says what the API refuses about the new certificate at its field', async () => {
    open(
      { certificate: wildcard },
      {
        'PUT /api/v1/system/certificates/c-1': () =>
          jsonResponse({ error: { code: 'passphrase_wrong', message: 'no', details: {} } }, 422),
      },
    );
    await type('certificate-text', CHAIN);
    await type('certificate-key-text', ENCRYPTED_KEY);
    await type('certificate-passphrase', 'wrong');
    await save();
    await waitFor(() => expect(errorsShown()).toHaveLength(1));
    expect(errorsShown()[0]).toEqual({
      code: 'passphrase_wrong',
      text: 'Mit dieser Passphrase lässt sich der private Schlüssel nicht öffnen.',
      at: 'certificate-passphrase',
    });
  });

  it('sends one request however often the button is pressed while it runs', async () => {
    let finish: (value: unknown) => void = () => {};
    const { calls, onSaved } = open(
      { certificate: wildcard },
      {
        'PUT /api/v1/system/certificates/c-1': () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    );
    await type('certificate-text', CHAIN + KEY);
    await save();
    await waitFor(() => expect(screen.getByTestId('certificate-save')).toBeDisabled());
    await fireEvent.submit(field('certificate-name').closest('form')!);
    finish(stored());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(writes(calls)).toHaveLength(1);
  });
});
