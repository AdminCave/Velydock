# Security Policy

## Supported versions

Velydock is under active development. Security fixes are applied to the latest released `0.x`
version. Please always run the most recent release, together with a current Keycloak.

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do **not** open a public issue for
security problems.

- Preferred: GitHub's [private vulnerability reporting](https://github.com/AdminCave/Velydock/security/advisories/new)
  (repository → **Security** → **Report a vulnerability**), or
- email **security@admincave.com** with a description and, if possible, a proof of concept.

You can expect an initial response within a few days. Please allow a reasonable amount of time
for a fix before any public disclosure.

## Scope

Velydock is a multi-tenant workspace platform. Areas of particular interest:

- tenant isolation (API checks and PostgreSQL row-level security),
- authorization between roles, in particular anything that lets a user manager, a tenant
  administrator or a guest reach beyond their rights,
- sign-in and sessions (OIDC code flow, back-channel logout, session handling, CSRF),
- the sandbox for custom apps — code written by a tenant administrator must not reach Velydock's
  session, API or page,
- the embeddability check, which fetches administrator-supplied URLs from the server.

Out of scope: issues that require an already compromised system administrator account or access
to the server's `.env`, and misconfigurations of deployments that deviate from the documented
setup (for example exposing Keycloak's `/admin` path).

The security model, including the limits that come with sharing one Keycloak realm between
tenants, is described in [docs/sicherheit.md](docs/sicherheit.md) and
[docs/einschraenkungen.md](docs/einschraenkungen.md).
