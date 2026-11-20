// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Messages } from '../dictionaries';

export const shell = {
  // ── Login ────────────────────────────────────────────────────────────
  'login.lead': ['Ein Login. Alle deine Apps.', 'One sign-in. All your apps.'],
  'login.submit': ['Anmelden', 'Sign in'],
  'login.hint': [
    'Du wirst zur Anmeldung weitergeleitet und landest danach wieder hier.',
    'You will be taken to the sign-in and come back here afterwards.',
  ],
  'login.signedOut': ['Du bist abgemeldet. Bis später.', 'You are signed out. See you later.'],
  'login.sessionExpired': [
    'Deine Sitzung ist abgelaufen. Melde dich erneut an, dann geht es dort weiter, wo du warst.',
    'Your session has expired. Sign in again and you will be back where you were.',
  ],

  // ── Session ──────────────────────────────────────────────────────────
  'session.tenantChanged': [
    'Die aktive Organisation hat sich geändert, zum Beispiel in einem anderen Fenster. Du arbeitest jetzt in „{name}“.',
    'The active organization has changed, for example in another window. You are now working in “{name}”.',
  ],
  'session.tenantChanged.refused': [
    'Die aktive Organisation hat sich geändert, zum Beispiel in einem anderen Fenster. Deine letzte Anfrage wurde deshalb nicht ausgeführt. Du arbeitest jetzt in „{name}“.',
    'The active organization has changed, for example in another window. Your last request was therefore not carried out. You are now working in “{name}”.',
  ],
  'session.signOutFailed': [
    'Die Abmeldung hat nicht geklappt, du bist weiterhin angemeldet. Bitte versuch es noch einmal.',
    'Signing out did not work, you are still signed in. Please try again.',
  ],
  'session.tenantGone': [
    'Die Organisation, in der du gearbeitet hast, steht dir nicht mehr zur Verfügung.',
    'The organization you were working in is no longer available to you.',
  ],

  // ── Dock ─────────────────────────────────────────────────────────────
  'shell.skip': ['Zum Inhalt springen', 'Skip to content'],
  'dock.label': ['Hauptnavigation', 'Main navigation'],
  'dock.home': ['Startseite', 'Home'],
  'dock.apps': ['Apps', 'Apps'],
  'dock.admin': ['Verwaltung', 'Admin'],
  'dock.tenant.switch': [
    'Organisation wechseln (aktuell: {name})',
    'Switch organization (current: {name})',
  ],
  'dock.tenant.title': ['Organisation wechseln', 'Switch organization'],
  'dock.tenant.caption': ['Organisation wechseln', 'Switch organization'],
  'dock.tenant.none': ['Keine Organisation', 'No organization'],
  'dock.user.menu': ['Benutzermenü von {name}', 'User menu of {name}'],
  'nav.profile': ['Profil', 'Profile'],
  'nav.settings': ['Einstellungen', 'Settings'],
  'nav.signOut': ['Abmelden', 'Sign out'],

  // ── Secondary navigation of the administration ───────────────────────
  'nav.admin.label': ['Verwaltung', 'Administration'],
  'nav.admin.scope': [
    'Diese Seiten gelten für die aktive Organisation',
    'These pages act on the active organization',
  ],
  'nav.admin.users': ['Benutzer', 'Users'],
  'nav.admin.groups': ['Gruppen', 'Groups'],
  'nav.admin.apps': ['Apps', 'Apps'],
  'nav.admin.settings': ['Einstellungen', 'Settings'],
  'nav.admin.audit': ['Protokoll', 'Audit log'],
  'nav.system.caption': ['System', 'System'],
  'nav.system.tenants': ['Organisationen', 'Organizations'],
  'nav.system.users': ['Alle Benutzer', 'All users'],
  'nav.system.settings': ['Systemeinstellungen', 'System settings'],
  'nav.system.audit': ['Systemprotokoll', 'System audit log'],
} satisfies Messages;
