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
  routes.ts             route table: pattern → page, required permission, tenantScoped
  styles/               global.css + tokens/ (copies of the design system's token files)
  lib/
    api/                schema.d.ts (generated), client.ts (typed fetch wrapper), errors.ts,
                        types.ts, helpers.ts
    i18n/               index.ts (t, tNow, language) + messages/*.ts ([German, English] pairs)
    router.ts           History API router, link interception, safe return paths, leave guard
    listQuery.ts        search, filters and page of a list in the address
    routing.ts          route resolution (page / app / redirect / forbidden / not-found)
    nav.ts              navigation entries per permission, dock edge and orientation
    frames.ts           kept-alive frame list (LRU of 5), frame attributes
    frameFocus.ts       keeps the keyboard focus out of app frames that must not have it
    theme.ts            theme preference → resolved theme, live system preference
    audit.ts            audit entries as readable text
    embedDetail.ts      what the embedding check found, as text (codes of the API)
    appIcons.ts         the curated Lucide icons for apps
    stores/             session (me, session watch), workspace (apps, frames), toasts, media
                        queries, instance (name of the installation before sign-in)
    utils/              slug, validation, forms, focus, overflow, roving tabindex, date,
                        clipboard, storage
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
then reads `/me` once, and the refused call fails with the text for `tenant_changed`.
Whichever answer brings the other organization (that read, a saved setting, a profile
change), the session store tells the user in a toast which organization is active now; only
a switch made in this window goes without. It is one toast for the one event: `showError()`
says nothing about `tenant_changed`, the session store does. If the read finds the same
organization, or fails, the store reports the refusal itself; a refusal that arrives for an
organization the page has left since is ignored.

**Pages of the organization** are the routes with `tenantScoped` in `routes.ts` (the tenant
administration). Two things follow from the flag:

- `App.svelte` keys such a page by the organization (`{#key pageKey}`): it starts over when
  the organization changes. The system administration and the user's own pages are not
  keyed and keep what is on them, unsaved input included.
- Such a page, its dialogs and the app frames send their requests through `tenantApi()`
  instead of `api`: `const api = tenantApi();` once, while the component is set up. The
  result is bound to the organization on screen at that moment. A page is destroyed when
  the organization changes, but what it started lives on (a confirmation answered later, the
  request that follows an answer); bound like this, none of it can act on the organization
  that came after. Such a request is not sent and fails with `tenant_changed`
  (`isStaleRequest()`), which `showError()` does not report: the page is gone, and the
  change has been announced. ESLint forbids importing `api` in `src/pages/admin/`, the
  dialogs of those pages and `AppFrame.svelte`.

An open confirm dialog is withdrawn (answered "no") when the organization changes.

**Keeping the session current** (`startSessionWatch()` in `lib/stores/session.ts`, started by
`App.svelte`). `/me` is read again, at most every 30 seconds, when the tab becomes visible or
the window gets the focus back, and every two minutes while the window is visible and
focused. The latter doubles as a sign of life: working inside an embedded app sends no
request to Velydock, and the session would otherwise run into its idle timeout (five minutes
at the least, hence two). Tabs of one browser tell each other at once: after a switch of the
organization and before leaving on sign-out a tab posts on the `BroadcastChannel`
`velydock-session`, and a tab that receives it reads `/me` immediately. Without
`BroadcastChannel` the other triggers remain, and the API's check of the header holds in any
case. A page restored from the browser's back/forward cache (`pageshow` with `persisted`) is
reloaded, so Back after signing out never shows the signed-in page again; `signOut()` also
switches to the splash before it leaves and stays "signing out" from then on.

An answer about the user is only taken if the session has not changed since its request was
sent (another answer, a setting changed here, the end of the session). An overtaken answer
is dropped and `/me` is read once more; a failed settings change is only rolled back while
its optimistic value is still the one on screen.

**A session that ends under an open app.** If the check in the background is answered 401
while app frames are alive, the page and the frames stay (`sessionEnded`): the shell shows a
notice (`session-ended`) to save the work in the app and sign in again, with a button that
leads to `/login?expired=1&return_to=…`. Nothing is asked in the background in that state.
Moving between apps is possible; any other navigation inside Velydock and any request
answered 401 lead to the login page as usual. Without frames a 401 leads there at once.

**After a write.** A page reads its list once more after a write: sorting, paging, totals
and counts are the server's business. Where the answer of a write is the complete new state
(personal and organization settings, the app order, the signed-in user after switching the
organization) that answer is used as it is.

**Saving.** An edit form sends only the fields that were changed in it (users, apps, groups,
organization and system settings): a dialog that was open for a while must not take back
what somebody else changed meanwhile. Names are compared and sent as the server stores them
(`normalizeName()`: one blank between words, none around). A save that changes nothing is
not sent and not announced: the dialog closes, a page says "Es gibt nichts zu speichern."

**Lists and the address** (`lib/listQuery.ts`). Search text, filters and page number of the
user lists and the audit logs live in the query string (`/admin/users?q=anna&role=member&page=2`):
a reload and the browser's Back button keep them. They are written with `replaceState`, so
typing in a search field leaves no history entries, and what is as the list opens is left
out. A page follows the address when it changes under it (the navigation link to the page
itself shows the list as it opens).

**Fields of a form** (`FormField.svelte`). A message under a field is taken back as soon as
that field is edited (`bind:error`, or `onedit` where the page made the message up itself).
The rules of the API are mirrored where the message has to say what is wrong (names of
people in `personNameProblem()`, the name of the installation in `instanceNameProblem()`);
what the server refuses about a field (`details.fields` of a 422) is shown at that field
through `refusedFields()`. An input that has reached its `maxlength` says so (`field-limit`),
because the browser cuts what is typed or pasted without a word.

**Keyboard focus after something went away** (`lib/utils/focus.ts`). When the element that
had the focus is removed, the browser leaves the focus on `<body>`. `restoreFocus()` puts it
somewhere sensible: after a row was deleted on the menu button of the row that took its
place (or the page when no row is left), after "Auf „Neuer Tab“ umstellen" on the type, and
after a navigation that removed the focused element on `<main>`. The organization switcher
is not disabled while it switches, so it keeps the focus.

**Routes and permissions.** `routes.ts` names the permission each page needs; the same
tables in `lib/nav.ts` decide which navigation entries are shown, and a unit test keeps both
in step. A page without the permission is never mounted (it resolves to "no access"). The
API enforces every permission again. `tenantScoped` marks the pages that belong to the active
organization (see above); a unit test keeps the flag in step with the permissions.

**App frames.** `AppStage` stays mounted on every page. Frames of opened embedded and custom
apps are kept alive (hidden) and capped at five; the least recently used one is dropped.
Custom apps get a fresh signed address from `POST /workspace/apps/{id}/launch` on every
(re)load and are rendered with exactly `sandbox="allow-scripts allow-forms allow-modals
allow-popups allow-popups-to-escape-sandbox"`, `referrerpolicy="no-referrer"` and no `allow`
attribute. **Never add `allow-same-origin` to a custom-app frame**: it is the security
boundary between administrator-written code and Velydock. `frames.test.ts` and
`AppFrame.test.ts` guard this.

All a page learns about a frame of another site is its `load` event. A frame that has not
fired it after ten seconds (`SLOW_AFTER_MS`) gets a notice in its corner (`app-slow`) with
"In neuem Tab öffnen" for embedded apps. The notice does not say why, because that cannot be
known from outside (slow, unreachable, embedding refused; a browser also fires `load` for
its own error page), and it can be closed, since an app with one slow resource may be usable
long before `load`.

**Keyboard focus and app frames** (`lib/frameFocus.ts`, started by `AppStage` while frames
exist). A kept-alive frame goes on running while it is hidden, and a frame can focus its own
window: every key the user types would then arrive in the hidden app, and the field they
clicked in Velydock or in the app on screen stays empty. Neither `inert`, nor another way of
hiding, nor a permissions policy prevents that in the browser. So the rule is enforced by
watching: an app frame may hold the focus only while it is the one on screen and no dialog of
Velydock is open. Otherwise the focus is taken back and returned to where the user was (the
element of Velydock, the open dialog, or the app on screen). Three things in it are easy to
get wrong:

- The focus is never moved from inside the `blur` event that reports the change, but right
  after it. Inside the event `focus()` changes `document.activeElement` and leaves the
  keyboard with the frame.
- A frame that takes the focus from another frame causes no event in the Velydock document.
  That is found by looking at `document.activeElement` every 20 ms while the app on screen
  holds the focus (every 250 ms otherwise).
- A frame is given the focus through its window (`focusFrame()`), never with `focus()` on the
  `<iframe>`: focused as an element it stays `document.activeElement` when another frame takes
  the focus afterwards, and the page could not see that any more.

A frame that takes the focus three times within a minute is unloaded (`dropFrame()`); a toast
that stays names the app and says why, and opening the app again loads it fresh. An open
menu decides a moment after the window's `blur` whether the focus really left it, so the
taking back does not close it.

**Dialogs** (`Modal.svelte`). Escape and a click beside a dialog close it, with three
exceptions. A click only counts if the mouse button went down _and_ up on the backdrop
(selecting text and overshooting is no click). A dialog with `dirty` (the form dialogs pass
whether their fields differ from what they opened with; a list of chosen entries is compared
as a selection, not by its order) ignores the click and asks before Escape discards the
input; "Abbrechen" and the X close at once. A dialog with
`dismissible={false}` (the one-time password) closes through its button only. A filled
search field takes Escape for itself and empties.

The browser's Back button asks the same question while a dialog holds input
(`guardLeaving()` in `lib/router.ts`). A page only hears of Back when the browser has moved
already, so the router puts the address back first, asks, and takes the step again on
"Verwerfen".

**Toasts** lie over the bottom left of the window. While one is shown, the scrolling part of
the shell ends above it (`--toast-lane`, set by `Toast.svelte`, used by `Shell.svelte`), so a
toast never lies over a control of a page; what is below that line is reached by scrolling.

**Long values.** A name or address without a blank in it wraps in headings, dialogs, toasts
and table cells; a table cell takes at most 32ch for it (28ch for identifiers). The column of
the row actions sticks to the right edge of a table that scrolls sideways. Tags and the
caption of the secondary navigation are cut with an ellipsis and carry the full text as
`title`. These rules cannot be tested in jsdom; `build.test.ts` pins them.

**Colours.** The token files in `styles/tokens/` are copies of the design system's, with one
deliberate deviation: `--text-subtle` is `#8f969d` (dark) and `#696f76` (light) instead of
`#6e757c` and `#868d94`, which are below a contrast of 4.5:1 on the surfaces the tone is used
on. `build.test.ts` checks secondary and tertiary text against every surface.

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
| `login-button`  | the "Anmelden" button; navigates to `/api/auth/login?return_to=…&lang=<language of the page>`   |
| `login-message` | message for `?error=<code>` (`role="alert"`), `?expired=1` or `?signed_out=1` (`role="status"`) |

### Shell

| Hook                                  | Element                                                                                                                                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dock`                                | the dock `<nav>`. `data-nav="left\|right\|top\|bottom"` is the configured position; `data-edge` is the edge it is drawn at (on screens up to 720 px a left/right dock is drawn at the bottom); `data-orientation="vertical\|horizontal"` |
| `dock-home`                           | link to `/` (product mark)                                                                                                                                                                                                               |
| `dock-app`                            | one link per app, `data-app-id`, `data-app-type`; the accessible name is the app name; `aria-current="page"` when open                                                                                                                   |
| `dock-admin`                          | link to the administration; only with at least one admin permission                                                                                                                                                                      |
| `tenant-switcher`                     | menu button; only with more than one organization. Entries are `menuitem`s named by the organization; the active one has `aria-current="true"`                                                                                           |
| `user-menu`                           | menu button; entries "Profil", "Einstellungen", "Abmelden"                                                                                                                                                                               |
| `dock-more-before`, `dock-more-after` | markers at the ends of the app list, only while there are more apps than fit in that direction; a click scrolls there. Not in the Tab order: the keyboard walks the apps, and the list scrolls with the focus                            |
| `session-ended`                       | notice (`role="alert"`) while the page is kept after its session ended under an open app; its button "Neu anmelden" leads to the login page                                                                                              |
| `toast`                               | each toast, `role="status"`, `data-kind="success\|error\|info"`                                                                                                                                                                          |

The active entry of the secondary navigation in the administration also carries
`aria-current="page"`. Where its entries do not all fit (tablet, phone) the row scrolls, the
active entry is brought into view, and `subnav-more-before` / `subnav-more-after` mark the
end that has more beyond it (a click scrolls; not in the Tab order).

### Workspace

| Hook                 | Element                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `app-tile`           | dashboard tile (link), `data-app-id`, `data-app-type`                                             |
| `no-tenant-page`     | the page shown to a user without organization (with a sign-out button)                            |
| `app-frame`          | each `<iframe>`, `data-app-id`, `data-app-type="embedded\|custom"`; hidden frames stay in the DOM |
| `app-reload`         | "Neu laden" in the app toolbar (embedded and custom)                                              |
| `app-open-external`  | "In neuem Tab öffnen": toolbar (embedded), blocked notice, or the page of an external app         |
| `app-blocked-notice` | notice shown instead of a frame when `embed_status` is `blocked`                                  |
| `app-slow`           | notice in the corner of a frame that has not loaded after ten seconds; can be closed              |
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

| Hook                  | Element                                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users-table`         | `/admin/users`; rows carry `data-user-id`, `data-username`                                                                                                                                                                                    |
| `users-filter-role`   | `<select>`: `all`, `member`, `user_manager`, `tenant_admin`                                                                                                                                                                                   |
| `users-filter-status` | `<select>`: `all`, `active`, `inactive`                                                                                                                                                                                                       |
| `user-actions`        | row menu button (Bearbeiten, Passwort zurücksetzen, Sitzungen beenden, Deaktivieren/Reaktivieren, Konto löschen / Aus Organisation entfernen); the own row only offers "Bearbeiten"                                                           |
| `temp-password`       | the one-time password, shown once after creating a user without e-mail or resetting a password; its dialog closes only through "Notiert, schließen"                                                                                           |
| `identity-locked`     | explanation in the edit dialog when name and e-mail are read-only                                                                                                                                                                             |
| `groups-table`        | `/admin/groups`; rows carry `data-group-id`; row menu `group-actions`; in the group dialog the checkbox of a member who outranks the administrator (`can_edit_membership: false`) is disabled                                                 |
| `apps-table`          | `/admin/apps`; rows carry `data-app-id`; row menu `app-actions`; move buttons are named "… nach oben" / "… nach unten"                                                                                                                        |
| `apps-moved`          | polite live region on `/admin/apps`: says where an app is after a move ("Wiki: Position 2 von 4"). A press during a running move is carried out after it                                                                                      |
| `picker-chips`        | the chips of the chosen entries in a picker (members, groups); beyond six a button "und n weitere" shows the rest in a box that scrolls                                                                                                       |
| `app-type`            | radio group in the app dialog: `embedded`, `external`, `custom`                                                                                                                                                                               |
| `app-audience`        | radio group in the app dialog: `all`, `selected`                                                                                                                                                                                              |
| `embed-check`         | result of "Einbettbarkeit prüfen"                                                                                                                                                                                                             |
| `app-icon-preview`    | the chosen icon in the app dialog; the icon grid is a radio group, each icon named in the language of the page ("Rettungsring") and carrying its Lucide name as `data-icon` (one Tab stop; arrow keys, Home, End move, Enter or Space choose) |
| `role-signs-out`      | notice in the user dialogs when the chosen role gives administrative rights: saving signs the person out                                                                                                                                      |
| `field-limit`         | note under a field whose input has reached its `maxlength`                                                                                                                                                                                    |
| `tenant-protected`    | reason in the row menu of an organization that can be neither deactivated nor deleted (`protected`); both entries are disabled                                                                                                                |
| `revoke-self`         | reason in the own row menu on `/system/users` why the own system administrator right cannot be revoked                                                                                                                                        |
| `tenant-nav-position` | `<select>` on `/admin/settings`: `system`, `left`, `right`, `top`, `bottom`                                                                                                                                                                   |
| `audit-table`         | `/admin/audit` and `/system/audit`; rows carry `data-action`                                                                                                                                                                                  |
| `tenants-table`       | `/system/tenants`; rows carry `data-tenant-id`, `data-slug`; row menu `tenant-actions`                                                                                                                                                        |
| `system-users-table`  | `/system/users`; rows carry `data-user-id`, `data-username`; row menu `system-user-actions`                                                                                                                                                   |
| `smtp-status`         | the "konfiguriert" indicator on `/system/settings`, `data-configured="true\|false"`                                                                                                                                                           |

Confirmations are dialogs named by their title (for example "Konto löschen", "Gruppe
löschen", "App löschen", "Organisation deaktivieren"); the confirming button repeats the
action. Escape in a form dialog that holds input opens "Eingaben verwerfen?" with
"Verwerfen" and "Weiter bearbeiten"; so does the browser's Back button. Deleting an
organization needs its short name typed into the dialog's text field before "Endgültig
löschen" is enabled.

The link for setting the password by e-mail in "Benutzer anlegen" is only enabled when
`GET /api/v1/admin/capabilities` answers `email_invitations: true`. An empty list shows no
pagination. A user dialog in which nothing can be changed has "Schließen" instead of
"Abbrechen" and "Speichern".
