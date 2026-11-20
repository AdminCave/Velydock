// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Messages } from '../dictionaries';

export const workspace = {
  // ── Dashboard ────────────────────────────────────────────────────────
  'dashboard.greeting.morning': ['Guten Morgen, {name}.', 'Good morning, {name}.'],
  'dashboard.greeting.day': ['Hallo, {name}.', 'Hello, {name}.'],
  'dashboard.greeting.evening': ['Guten Abend, {name}.', 'Good evening, {name}.'],
  'dashboard.lead': [
    'Deine Apps. Ein Klick, und du bist drin.',
    'Your apps. One click and you are in.',
  ],
  'dashboard.apps': ['Deine Apps', 'Your apps'],
  'dashboard.empty.title': ['Noch keine Apps', 'No apps yet'],
  'dashboard.empty.text': [
    'Hier ist es aufgeräumter als auf jedem Schreibtisch. Sobald dir deine Administration Apps freigibt, erscheinen sie hier und im Dock.',
    'Tidier than any desk. As soon as your administrator shares apps with you, they appear here and in the dock.',
  ],
  'dashboard.empty.textAdmin': [
    'Hier ist es aufgeräumter als auf jedem Schreibtisch. Leg die erste App an, dann haben alle etwas zu klicken.',
    'Tidier than any desk. Add the first app so everyone has something to click.',
  ],
  'dashboard.empty.cta': ['Apps verwalten', 'Manage apps'],

  // ── No organization ──────────────────────────────────────────────────
  'noTenant.title': [
    'Du gehörst noch zu keiner Organisation',
    'You do not belong to an organization yet',
  ],
  'noTenant.text': [
    'Die Anmeldung hat geklappt, aber dein Konto ist noch keiner Organisation zugeordnet. Bitte deine Administration, dich hinzuzufügen. Danach genügt „Erneut prüfen“.',
    'Signing in worked, but your account is not assigned to an organization yet. Ask your administrator to add you. After that, “Check again” is enough.',
  ],
  'noTenant.retry': ['Erneut prüfen', 'Check again'],
  'noTenant.account': ['Angemeldet als {username}', 'Signed in as {username}'],
  'noTenant.systemAdmin': [
    'Als Systemadministrator kannst du trotzdem verwalten:',
    'As a system administrator you can still manage:',
  ],

  // ── App view ─────────────────────────────────────────────────────────
  'app.view': ['App-Ansicht', 'App view'],
  'app.type.embedded': ['Eingebettet', 'Embedded'],
  'app.type.external': ['Neuer Tab', 'New tab'],
  'app.type.custom': ['Eigene App', 'Custom app'],
  'app.reload': ['Neu laden', 'Reload'],
  'app.openInNewTab': ['In neuem Tab öffnen', 'Open in new tab'],
  'app.opensInNewTab': ['öffnet in neuem Tab', 'opens in a new tab'],
  'app.blocked.title': ['Diese App lässt sich nicht einbetten', 'This app cannot be embedded'],
  'app.blocked.text': [
    '{name} erlaubt nicht, innerhalb anderer Seiten angezeigt zu werden. Das legt der Anbieter fest, nicht Velydock. In einem eigenen Tab funktioniert die App wie gewohnt.',
    '{name} does not allow being shown inside other pages. That is decided by its provider, not by Velydock. In a tab of its own the app works as usual.',
  ],
  'app.external.title': ['{name} läuft in einem eigenen Tab', '{name} runs in a tab of its own'],
  'app.external.text': [
    'Die App wurde in einem neuen Tab geöffnet. Nichts passiert? Dann hat dein Browser das Pop-up blockiert – oder du hast den Tab schon wieder geschlossen.',
    'The app was opened in a new tab. Nothing happened? Then your browser blocked the pop-up – or you have already closed the tab.',
  ],
  'app.missing.title': ['Diese App gibt es hier nicht', 'There is no such app here'],
  'app.missing.text': [
    'Entweder wurde sie entfernt, oder sie ist für dich nicht freigegeben. Im Zweifel weiß es deine Administration.',
    'Either it was removed, or it is not shared with you. When in doubt, your administrator knows.',
  ],
  'app.missing.back': ['Zur Startseite', 'Back to the start page'],
  'app.loadFailed.title': ['Apps konnten nicht geladen werden', 'The apps could not be loaded'],
  'app.loadFailed.text': [
    'Der Server hat nicht geantwortet. Prüf deine Verbindung und versuch es noch einmal.',
    'The server did not answer. Check your connection and try again.',
  ],
  'app.launchFailed.title': [
    'Die App konnte nicht gestartet werden',
    'The app could not be started',
  ],
} satisfies Messages;
