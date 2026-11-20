import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');
export const AUTH_DIR = resolve(here, '..', '.auth');

const port = process.env.DEV_HTTPS_PORT ?? '8443';
export const DOCK_URL = `https://dock.velydock.localhost:${port}`;
export const AUTH_URL = `https://auth.velydock.localhost:${port}`;
export const SANDBOX_URL = `https://sandbox.velydock.localhost:${port}`;
export const DEMO_URL = `https://demo.velydock.localhost:${port}`;
/** Keycloak's Admin API, published on localhost by the development stack only. */
export const KEYCLOAK_ADMIN_URL = `http://127.0.0.1:${process.env.DEV_KEYCLOAK_PORT ?? '18080'}`;
export const KEYCLOAK_BOOTSTRAP = { id: 'velydock-bootstrap', secret: 'dev-keycloak-bootstrap-secret' };

/** The password every test account ends up with after its forced first change. */
export const PASSWORD = 'Velydock-E2E-Passwort-1';

/** Run a command in the development stack (scripts/dev-stack.sh …). */
export function compose(...args: string[]): string {
  return execFileSync(resolve(REPO_ROOT, 'scripts', 'dev-stack.sh'), args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
