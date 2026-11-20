# Velydock – web frontend

The single-page app of Velydock: one sign-in, then everyone opens the web apps assigned
to them inside a common shell with a dock. The backend (`../backend`) serves the built app
and the API from one origin.

- Svelte 5 (runes), TypeScript strict, Vite, plain SPA with a History API router
- UI text in German (default) and English; code, comments and identifiers in English
- Design: [AdminCave design system](https://github.com/AdminCave/DesignSystem) – tokens are
  copied to `src/styles/tokens/`, Geist and Geist Mono are bundled, icons are Lucide
- License: GPL-3.0-or-later

## Commands

Node 22, npm.

| Command             | What it does                                                          |
| ------------------- | --------------------------------------------------------------------- |
| `npm install`       | install dependencies                                                  |
| `npm run dev`       | Vite dev server on <http://localhost:5173>, `/api` proxied to `:8765` |
| `npm run build`     | type check, then build to `dist/` (`index.html` + hashed `assets/`)   |
| `npm run check`     | `svelte-check` (must report zero errors)                              |
| `npm run lint`      | ESLint and Prettier check                                             |
| `npm run format`    | Prettier write                                                        |
| `npm run test:unit` | Vitest (jsdom, `@testing-library/svelte`)                             |
| `npm run gen:api`   | regenerate `src/lib/api/schema.d.ts` from `../backend/openapi.json`   |

### Running against the real API

A development backend with a simulated sign-in lives in the backend's test support. It needs
the PostgreSQL of the dev stack on `127.0.0.1:15432` and re-creates and seeds its database
on every start.

```sh
cd ../backend
# for `npm run dev` (the app runs on :5173 and proxies /api):
.venv/bin/python -m tests.support.devserver --public-url http://localhost:5173
# or: serve ../frontend/dist itself on http://localhost:8765
.venv/bin/python -m tests.support.devserver
```

`/api/dev/login?user=anna&return_to=/` signs in directly. Seeded users: `root` (system
administrator), `anna` (tenant administrator), `uwe` (user manager), `mia`/`ben` (members),
`gast` (guest), `ina` (deactivated), `neu` (no organization).

## Layout of the source

```
index.html              no inline script: the CSP is script-src 'self'
public/theme-init.js    applies the stored theme before the first paint (blocking, external)
public/favicon.svg
src/
  main.ts, App.svelte   entry; session start, route guard, document title
  routes.ts             route table: pattern → page, required permission
  styles/               global.css + tokens/ (copies of the design system's token files)
  lib/
    api/                schema.d.ts (generated), client.ts (typed fetch wrapper), errors.ts,
                        types.ts, helpers.ts
    i18n/               index.ts (t, tNow, language) + messages/*.ts ([German, English] pairs)
    router.ts           History API router, link interception, safe return paths
    routing.ts          route resolution (page / app / redirect / forbidden / not-found)
    nav.ts              navigation entries per permission, dock edge and orientation
    frames.ts           kept-alive frame list (LRU of 5), frame attributes
    theme.ts            theme preference → resolved theme, live system preference
    audit.ts            audit entries as readable text
    appIcons.ts         the curated Lucide icons for apps
    stores/             session (me, session watch), workspace (apps, frames), toasts, media queries
    utils/              slug, validation, forms, roving tabindex, date, clipboard, storage
    components/
      ui/               Button, Input, Select, Switch, Checkbox, Modal, ConfirmDialog, Toast,
                        Menu, Segmented, MultiPicker, Pagination, Callout, … (adapted from
                        AdminHelper)
      layout/           Shell, Dock, SubNav
      app/              AppStage (app view, kept-alive frames), AppFrame, AppIcon
      brand/            Mark (the product mark, currentColor)
  pages/                Login, Dashboard, Profile, Settings, NotFound, admin/*, system/*
  modals/               create/edit dialogs
  test/                 fixtures for unit tests
```

## How a few things work

**API client** (`lib/api/client.ts`). `api.get/post/put/patch/delete(path, { path, query,
body })` is typed against the generated OpenAPI types. Requests are same-origin with the
session cookie; every non-GET request carries `X-Velydock-CSRF: 1`. Error answers become an
`ApiError` with `status`, `code`, `details` (an answer without the JSON envelope, as a reverse
proxy sends it, gets its code from the status: 401, 413, 429); `errorMessage()` maps the code
to translated text (`error.<code>` in `lib/i18n/messages/errors.ts`) and falls back to a
generic message.
A 401 on any request ends the session in the UI and leads to `/login?return_to=…`; if the
session was in use until then, the address also carries `expired=1` and the login page says
that the session has expired.

**The organization a page acts on.** The active organization belongs to the session, which
all tabs share. While `me.active_tenant` is known, every request names it in
`X-Velydock-Tenant` (`TENANT_HEADER`, set from the session store). If the session has moved
to another organization meanwhile (switched in another tab, deactivated, membership
removed), the API refuses permission-scoped requests with `409 tenant_changed`. The client
then reads `/me` once, tells the user in a toast which organization is active now, and the
refused call fails with the text for `tenant_changed`. Pages are keyed by the organization
(`{#key tenantId}` in `App.svelte`): they start over when it changes.

**Keeping the session current** (`startSessionWatch()` in `lib/stores/session.ts`, started by
`App.svelte`). `/me` is read again, at most every 30 seconds, when the tab becomes visible,
and every five minutes while the window is visible and focused. The latter doubles as a sign
of life: working inside an embedded app sends no request to Velydock, and the session would
otherwise run into its idle timeout. A page restored from the browser's back/forward cache
(`pageshow` with `persisted`) is reloaded, so Back after signing out never shows the
signed-in page again; `signOut()` also switches to the splash before it leaves.

**After a write.** A page reads its list once more after a write: sorting, paging, totals
and counts are the server's business. Where the answer of a write is the complete new state
(personal and organization settings, the app order, the signed-in user after switching the
organization) that answer is used as it is.

**Routes and permissions.** `routes.ts` names the permission each page needs; the same
tables in `lib/nav.ts` decide which navigation entries are shown, and a unit test keeps both
in step. A page without the permission is never mounted (it resolves to "no access"). The
API enforces every permission again.

**App frames.** `AppStage` stays mounted on every page. Frames of opened embedded and custom
apps are kept alive (hidden) and capped at five; the least recently used one is dropped.
Custom apps get a fresh signed address from `POST /workspace/apps/{id}/launch` on every
(re)load and are rendered with exactly `sandbox="allow-scripts allow-forms allow-modals
allow-popups allow-popups-to-escape-sandbox"`, `referrerpolicy="no-referrer"` and no `allow`
attribute. **Never add `allow-same-origin` to a custom-app frame**: it is the security
boundary between administrator-written code and Velydock. `frames.test.ts` and
`AppFrame.test.ts` guard this.

**Dialogs** (`Modal.svelte`). Escape and a click beside a dialog close it, with three
exceptions. A click only counts if the mouse button went down _and_ up on the backdrop
(selecting text and overshooting is no click). A dialog with `dirty` (the form dialogs pass
whether their fields differ from what they opened with) ignores the click and asks before
Escape discards the input; "Abbrechen" and the X close at once. A dialog with
`dismissible={false}` (the one-time password) closes through its button only. A filled
search field takes Escape for itself and empties.

**Theme and language.** The effective settings come from `GET /api/v1/me` and are mirrored
to `localStorage` (`velydock-theme`, `velydock-language`) so `public/theme-init.js` can apply
them before the first paint. Dark is the default; `data-theme="light"` on `<html>` selects
the light theme; "system" follows `prefers-color-scheme` live.

**Translations.** Every key is one line with both languages:
`'action.save': ['Speichern', 'Save']`. Unit tests check that every key used in the code
exists, that none is dead, and that placeholders match. German microcopy addresses the user
informally ("du").

## Hooks for browser tests

Real semantics come first: buttons and links have visible text, form controls have
`<label>`s, dialogs are `role="dialog"` with an accessible name (their title), menus are
`role="menu"` with `role="menuitem"` entries, tables are `<table>`. A required field shows
its asterisk next to the label, not inside it, so `getByLabel('Name', { exact: true })`
matches. On top of that:

### Sign-in

| Hook            | Element                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `login-button`  | the "Anmelden" button; navigates to `/api/auth/login?return_to=…`                               |
| `login-message` | message for `?error=<code>` (`role="alert"`), `?expired=1` or `?signed_out=1` (`role="status"`) |

### Shell

| Hook              | Element                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dock`            | the dock `<nav>`. `data-nav="left\|right\|top\|bottom"` is the configured position; `data-edge` is the edge it is drawn at (on screens up to 720 px a left/right dock is drawn at the bottom); `data-orientation="vertical\|horizontal"` |
| `dock-home`       | link to `/` (product mark)                                                                                                                                                                                                               |
| `dock-app`        | one link per app, `data-app-id`, `data-app-type`; the accessible name is the app name; `aria-current="page"` when open                                                                                                                   |
| `dock-admin`      | link to the administration; only with at least one admin permission                                                                                                                                                                      |
| `tenant-switcher` | menu button; only with more than one organization. Entries are `menuitem`s named by the organization; the active one has `aria-current="true"`                                                                                           |
| `user-menu`       | menu button; entries "Profil", "Einstellungen", "Abmelden"                                                                                                                                                                               |
| `toast`           | each toast, `role="status"`, `data-kind="success\|error\|info"`                                                                                                                                                                          |

The active entry of the secondary navigation in the administration also carries
`aria-current="page"`.

### Workspace

| Hook                 | Element                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `app-tile`           | dashboard tile (link), `data-app-id`, `data-app-type`                                             |
| `no-tenant-page`     | the page shown to a user without organization (with a sign-out button)                            |
| `app-frame`          | each `<iframe>`, `data-app-id`, `data-app-type="embedded\|custom"`; hidden frames stay in the DOM |
| `app-reload`         | "Neu laden" in the app toolbar (embedded and custom)                                              |
| `app-open-external`  | "In neuem Tab öffnen": toolbar (embedded), blocked notice, or the page of an external app         |
| `app-blocked-notice` | notice shown instead of a frame when `embed_status` is `blocked`                                  |
| `not-found-page`     | 404 page                                                                                          |
| `account-link`       | link "Passwort & Sicherheit" on `/profile` to the identity provider's account page (new tab)      |
| `forbidden-page`     | shown for a page the user lacks the permission for                                                |

### Personal settings (`/settings`)

`setting-theme`, `setting-nav-position`, `setting-language` are radio groups
(`role="radiogroup"`) with native radio inputs; `data-value` holds the current value.

| Hook                   | Values (`data-value`, radio `value`)        | Radio labels (German)                                                            |
| ---------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| `setting-theme`        | `system`, `light`, `dark`                   | System, Hell, Dunkel                                                             |
| `setting-nav-position` | `default`, `left`, `right`, `top`, `bottom` | Standard, Links, Rechts, Oben, Unten                                             |
| `setting-language`     | `de`, `en`                                  | Deutsch, English                                                                 |
| `setting-nav-locked`   | –                                           | explanation shown when the organization fixed the position (radios are disabled) |

```ts
await page.getByTestId('setting-nav-position').getByRole('radio', { name: 'Rechts' }).check();
await expect(page.getByTestId('dock')).toHaveAttribute('data-nav', 'right');
```

### Administration

| Hook                  | Element                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users-table`         | `/admin/users`; rows carry `data-user-id`, `data-username`                                                                                                                                    |
| `users-filter-role`   | `<select>`: `all`, `member`, `user_manager`, `tenant_admin`                                                                                                                                   |
| `users-filter-status` | `<select>`: `all`, `active`, `inactive`                                                                                                                                                       |
| `user-actions`        | row menu button (Bearbeiten, Passwort zurücksetzen, Sitzungen beenden, Deaktivieren/Reaktivieren, Konto löschen / Aus Organisation entfernen); the own row only offers "Bearbeiten"           |
| `temp-password`       | the one-time password, shown once after creating a user without e-mail or resetting a password; its dialog closes only through "Notiert, schließen"                                           |
| `identity-locked`     | explanation in the edit dialog when name and e-mail are read-only                                                                                                                             |
| `groups-table`        | `/admin/groups`; rows carry `data-group-id`; row menu `group-actions`; in the group dialog the checkbox of a member who outranks the administrator (`can_edit_membership: false`) is disabled |
| `apps-table`          | `/admin/apps`; rows carry `data-app-id`; row menu `app-actions`; move buttons are named "… nach oben" / "… nach unten"                                                                        |
| `app-type`            | radio group in the app dialog: `embedded`, `external`, `custom`                                                                                                                               |
| `app-audience`        | radio group in the app dialog: `all`, `selected`                                                                                                                                              |
| `embed-check`         | result of "Einbettbarkeit prüfen"                                                                                                                                                             |
| `app-icon-preview`    | the chosen icon in the app dialog; the icon grid is a radio group, each icon named by its Lucide name (one Tab stop; arrow keys, Home, End move, Enter or Space choose)                       |
| `tenant-nav-position` | `<select>` on `/admin/settings`: `system`, `left`, `right`, `top`, `bottom`                                                                                                                   |
| `audit-table`         | `/admin/audit` and `/system/audit`; rows carry `data-action`                                                                                                                                  |
| `tenants-table`       | `/system/tenants`; rows carry `data-tenant-id`, `data-slug`; row menu `tenant-actions`                                                                                                        |
| `system-users-table`  | `/system/users`; rows carry `data-user-id`, `data-username`; row menu `system-user-actions`                                                                                                   |
| `smtp-status`         | the "konfiguriert" indicator on `/system/settings`, `data-configured="true\|false"`                                                                                                           |

Confirmations are dialogs named by their title (for example "Konto löschen", "Gruppe
löschen", "App löschen", "Organisation deaktivieren"); the confirming button repeats the
action. Escape in a form dialog that holds input opens "Eingaben verwerfen?" with
"Verwerfen" and "Weiter bearbeiten". Deleting an organization needs its short name typed into the dialog's text field
before "Endgültig löschen" is enabled.
