// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Messages } from '../dictionaries';

export const account = {
  // ── Profile ──────────────────────────────────────────────────────────
  'profile.title': ['Profil', 'Profile'],
  'profile.subtitle': ['Deine Angaben in dieser Installation.', 'Your details on this instance.'],
  'profile.personal.title': ['Persönliche Daten', 'Personal details'],
  'profile.personal.text': [
    'Deinen Namen kannst du selbst ändern. So sehen dich andere, etwa in Gruppenlisten.',
    'You can change your name yourself. This is how others see you, for example in group lists.',
  ],
  'profile.email.hint': [
    'Die E-Mail-Adresse ändert deine Administration.',
    'Your administrator changes the e-mail address.',
  ],
  'profile.email.none': ['keine hinterlegt', 'none on file'],
  'profile.saved': ['Profil gespeichert.', 'Profile saved.'],
  'profile.org.title': ['Organisation', 'Organization'],
  'profile.org.text': [
    'Wo du gerade arbeitest und was du dort darfst.',
    'Where you are working right now and what you may do there.',
  ],
  'profile.org.name': ['Organisation', 'Organization'],
  'profile.org.role': ['Rolle', 'Role'],
  'profile.org.system': ['System', 'System'],
  'profile.org.none': [
    'Dein Konto ist keiner Organisation zugeordnet. Das kann die Systemadministration ändern.',
    'Your account is not assigned to an organization. The system administrator can change that.',
  ],
  'profile.org.inactive': [
    'Du gehörst zurzeit zu keiner aktiven Organisation: Deine ist deaktiviert. Wieder aktivieren kann sie die Systemadministration.',
    'At the moment you belong to no active organization: yours is deactivated. The system administrator can activate it again.',
  ],
  'profile.security.title': ['Passwort & Sicherheit', 'Password & security'],
  'profile.security.text': [
    'Passwort ändern und Zwei-Faktor-Anmeldung einrichten: Das machst du direkt beim Anmeldedienst.',
    'Change your password and set up two-factor sign-in: you do that directly at the identity provider.',
  ],
  'profile.security.link': ['Passwort & Sicherheit', 'Password & security'],
  'profile.signOut.title': ['Abmelden', 'Sign out'],
  'profile.signOut.text': [
    'Beendet deine Sitzung in Velydock und beim Anmeldedienst.',
    'Ends your session in Velydock and at the identity provider.',
  ],

  // ── Personal settings ────────────────────────────────────────────────
  'settings.title': ['Einstellungen', 'Settings'],
  'settings.subtitle': [
    'Wie Velydock für dich aussieht. Änderungen gelten sofort und auf allen deinen Geräten.',
    'How Velydock looks for you. Changes apply at once and on all your devices.',
  ],
  'settings.theme.title': ['Design', 'Theme'],
  'settings.theme.text': [
    '„System“ folgt der Einstellung deines Geräts, auch wenn sie abends von selbst auf dunkel wechselt.',
    '“System” follows your device, even when it switches to dark by itself in the evening.',
  ],
  'settings.theme.system': ['System', 'System'],
  'settings.theme.light': ['Hell', 'Light'],
  'settings.theme.dark': ['Dunkel', 'Dark'],
  'settings.nav.title': ['Position der Navigation', 'Navigation position'],
  'settings.nav.text': [
    'An welcher Seite das Dock mit deinen Apps sitzt. Auf schmalen Bildschirmen wandert ein seitliches Dock nach unten.',
    'Which edge the dock with your apps sits at. On narrow screens a dock at the side moves to the bottom.',
  ],
  'settings.nav.default': ['Standard', 'Default'],
  'settings.nav.defaultHint': [
    '„Standard“ folgt der Vorgabe deiner Organisation. Derzeit: {position}.',
    '“Default” follows what your organization has set. Currently: {position}.',
  ],
  'settings.nav.locked': [
    'Deine Organisation hat die Position für alle festgelegt: {position}. Deshalb kannst du sie hier nicht ändern.',
    'Your organization has fixed the position for everyone: {position}. That is why you cannot change it here.',
  ],
  'settings.language.title': ['Sprache', 'Language'],
  'settings.language.text': [
    'Die Sprache der Oberfläche. Apps bringen ihre eigene Sprache mit.',
    'The language of the interface. Apps bring their own language.',
  ],
} satisfies Messages;
