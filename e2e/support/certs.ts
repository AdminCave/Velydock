import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';

/**
 * Certificates for the tests, made with the openssl command: a root of our own and what it
 * signs. Nothing here is trusted by a browser - the tests look at which certificate the proxy
 * presents, not at whether it is accepted.
 */

const port = Number(process.env.DEV_HTTPS_PORT ?? '8443');

function openssl(...args: string[]): void {
  execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

export interface Issued {
  /** The certificate followed by the root that signed it, as PEM. */
  chain: string;
  /** The certificate alone. */
  certificate: string;
  key: string;
  /** SHA-256 of the certificate, lower-case hex without colons - as the API reports it. */
  fingerprint: string;
  directory: string;
}

export class Authority {
  readonly directory = mkdtempSync(join(tmpdir(), 'velydock-e2e-ca-'));
  readonly root: string;

  constructor(name = 'Velydock E2E Root') {
    openssl(
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '30',
      '-subj', `/CN=${name}`, '-keyout', this.path('root.key'), '-out', this.path('root.crt'),
    ); // prettier-ignore
    this.root = readFileSync(this.path('root.crt'), 'utf8');
  }

  path(file: string): string {
    return join(this.directory, file);
  }

  /** A certificate for the given names, valid for `days` from now. */
  issue(label: string, names: string[], days = 60): Issued {
    const extensions = this.path(`${label}.ext`);
    writeFileSync(extensions, `subjectAltName=${names.map((name) => `DNS:${name}`).join(',')}\n`);
    openssl(
      'req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${label}`,
      '-keyout', this.path(`${label}.key`), '-out', this.path(`${label}.csr`),
    ); // prettier-ignore
    openssl(
      'x509', '-req', '-in', this.path(`${label}.csr`), '-CA', this.path('root.crt'), '-CAkey', this.path('root.key'),
      '-CAcreateserial', '-days', String(days), '-extfile', extensions, '-out', this.path(`${label}.crt`),
    ); // prettier-ignore
    const certificate = readFileSync(this.path(`${label}.crt`), 'utf8');
    writeFileSync(this.path(`${label}.chain.pem`), certificate + this.root);
    return {
      chain: certificate + this.root,
      certificate,
      key: readFileSync(this.path(`${label}.key`), 'utf8'),
      fingerprint: fingerprintOf(certificate),
      directory: this.directory,
    };
  }

  /** The same key, protected by a passphrase (as some authorities and tools deliver it). */
  protectedKey(label: string, passphrase: string): string {
    const target = this.path(`${label}.protected.key`);
    openssl('pkcs8', '-topk8', '-in', this.path(`${label}.key`), '-out', target, '-passout', `pass:${passphrase}`);
    return target;
  }

  /** Certificate, chain and key in one PKCS#12 file. */
  pkcs12(label: string, passphrase: string): string {
    const target = this.path(`${label}.p12`);
    openssl(
      'pkcs12', '-export', '-inkey', this.path(`${label}.key`), '-in', this.path(`${label}.crt`),
      '-certfile', this.path('root.crt'), '-out', target, '-passout', `pass:${passphrase}`,
    ); // prettier-ignore
    return target;
  }
}

export function fingerprintOf(pem: string): string {
  return new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();
}

export interface Presented {
  fingerprint: string;
  subject: string;
  issuer: string;
}

/**
 * The certificate the proxy presents for a host name: a TLS handshake with that name, as a
 * browser makes it, without judging the certificate.
 */
export function presented(host: string): Promise<Presented> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, servername: host, rejectUnauthorized: false }, () => {
      const certificate = socket.getPeerX509Certificate();
      socket.end();
      if (!certificate) return reject(new Error(`no certificate presented for ${host}`));
      resolve({
        fingerprint: certificate.fingerprint256.replaceAll(':', '').toLowerCase(),
        subject: certificate.subject,
        issuer: certificate.issuer,
      });
    });
    socket.setTimeout(5000, () => socket.destroy(new Error(`TLS handshake with ${host} timed out`)));
    socket.on('error', reject);
  });
}
