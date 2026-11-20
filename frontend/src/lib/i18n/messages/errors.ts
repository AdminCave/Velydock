// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Messages } from '../dictionaries';

// `error.<code>`: one text per error code of the API (see lib/api/errors.ts).
// `login.error.<code>`: reasons the backend appends to /login?error=<code>.
export const errors = {
  'error.generic': [
    'Das hat nicht geklappt. Bitte versuch es noch einmal.',
    'That did not work. Please try again.',
  ],
  'error.network': [
    'Der Server ist nicht erreichbar. Prüf deine Verbindung.',
    'The server cannot be reached. Check your connection.',
  ],
  'error.not_authenticated': [
    'Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.',
    'Your session has expired. Please sign in again.',
  ],
  'error.forbidden': ['Dafür fehlt dir die Berechtigung.', 'You are not allowed to do this.'],
  'error.not_found': [
    'Der Eintrag wurde nicht gefunden. Möglicherweise wurde er inzwischen gelöscht.',
    'The entry was not found. It may have been deleted in the meantime.',
  ],
  'error.validation': ['Bitte prüf deine Eingaben.', 'Please check your input.'],
  'error.csrf': [
    'Die Anfrage wurde aus Sicherheitsgründen abgelehnt. Lade die Seite neu und versuch es noch einmal.',
    'The request was rejected for security reasons. Reload the page and try again.',
  ],
  'error.no_tenant': ['Es ist keine Organisation ausgewählt.', 'No organization is selected.'],
  'error.username_taken': [
    'Dieser Benutzername ist bereits vergeben.',
    'This username is already in use.',
  ],
  'error.email_taken': [
    'Diese E-Mail-Adresse wird bereits verwendet.',
    'This e-mail address is already in use.',
  ],
  'error.group_name_taken': [
    'Eine Gruppe mit diesem Namen gibt es schon.',
    'A group with this name already exists.',
  ],
  'error.tenant_slug_taken': [
    'Dieser Kurzname ist bereits vergeben.',
    'This short name is already in use.',
  ],
  'error.tenant_name_taken': [
    'Eine Organisation mit diesem Namen gibt es schon.',
    'An organization with this name already exists.',
  ],
  'error.tenant_exists': [
    'Eine Organisation mit diesem Namen oder Kurznamen gibt es schon.',
    'An organization with this name or short name already exists.',
  ],
  'error.already_member': [
    'Das Konto gehört bereits zu dieser Organisation.',
    'The account already belongs to this organization.',
  ],
  'error.unknown_group': [
    'Mindestens eine der Gruppen gibt es nicht mehr. Lade die Seite neu.',
    'At least one of the groups no longer exists. Reload the page.',
  ],
  'error.unknown_user': [
    'Mindestens eine der Personen gehört nicht mehr zu dieser Organisation. Lade die Seite neu.',
    'At least one of the people no longer belongs to this organization. Reload the page.',
  ],
  'error.email_required': [
    'Für den Versand wird eine E-Mail-Adresse gebraucht.',
    'An e-mail address is required to send the link.',
  ],
  'error.smtp_not_configured': [
    'Der E-Mail-Versand ist nicht eingerichtet. Leg das Konto ohne E-Mail-Versand an oder bitte die Systemadministration, SMTP einzurichten.',
    'E-mail delivery is not set up. Create the account without sending an e-mail, or ask the system administrator to configure SMTP.',
  ],
  'error.self_action': [
    'Das geht nicht mit dem eigenen Konto.',
    'You cannot do this to your own account.',
  ],
  'error.last_system_admin': [
    'Mindestens ein Systemadministrator muss übrig bleiben.',
    'At least one system administrator must remain.',
  ],
  'error.tenant_protected': [
    'Diese Organisation gehört einem Systemadministrator und kann weder deaktiviert noch gelöscht werden.',
    'This organization is the home of a system administrator and can be neither deactivated nor deleted.',
  ],
  'error.confirmation_mismatch': [
    'Der eingegebene Kurzname stimmt nicht.',
    'The short name you typed does not match.',
  ],
  'error.url_required': ['Bitte gib eine Adresse (URL) an.', 'Please enter an address (URL).'],
  'error.url_invalid': [
    'Die Adresse muss mit https:// oder http:// beginnen und darf keine Zugangsdaten enthalten.',
    'The address must start with https:// or http:// and must not contain credentials.',
  ],
  'error.url_needs_https': [
    'Eingebettete Apps brauchen eine https://-Adresse.',
    'Embedded apps need an https:// address.',
  ],
  'error.content_required': [
    'Eine eigene App braucht HTML-Inhalt.',
    'A custom app needs HTML content.',
  ],
  'error.icon_invalid': [
    'Das Symbol muss ein PNG-, JPEG-, GIF-, WebP- oder SVG-Bild sein.',
    'The icon must be a PNG, JPEG, GIF, WebP or SVG image.',
  ],
  'error.icon_too_large': [
    'Das Symbol darf höchstens 256 KB groß sein.',
    'The icon must be at most 256 KB.',
  ],
  'error.order_mismatch': [
    'Die App-Liste hat sich inzwischen geändert. Die Reihenfolge wurde neu geladen.',
    'The list of apps has changed in the meantime. The order was reloaded.',
  ],
  'error.not_embedded': [
    'Nur eingebettete Apps können geprüft werden.',
    'Only embedded apps can be checked.',
  ],
  'error.idp_unavailable': [
    'Der Anmeldedienst ist gerade nicht erreichbar. Bitte versuch es gleich noch einmal.',
    'The identity provider cannot be reached right now. Please try again in a moment.',
  ],
  'error.idp_error': [
    'Der Anmeldedienst hat die Änderung abgelehnt.',
    'The identity provider rejected the change.',
  ],

  // ── /login?error=<code> ──────────────────────────────────────────────
  'login.error.generic': [
    'Die Anmeldung ist fehlgeschlagen. Bitte versuch es erneut.',
    'Sign-in failed. Please try again.',
  ],
  'login.error.expired': [
    'Die Anmeldung hat zu lange gedauert und ist abgelaufen. Bitte starte sie noch einmal.',
    'Sign-in took too long and has expired. Please start again.',
  ],
  'login.error.cancelled': ['Die Anmeldung wurde abgebrochen.', 'Sign-in was cancelled.'],
  'login.error.state': [
    'Die Anmeldung konnte nicht zugeordnet werden. Bitte starte sie in diesem Fenster noch einmal.',
    'The sign-in could not be matched to this browser window. Please start it again here.',
  ],
  'login.error.invalid': [
    'Die Anmeldung wurde abgelehnt. Bitte versuch es erneut.',
    'Sign-in was rejected. Please try again.',
  ],
  'login.error.account_conflict': [
    'Für diesen Benutzernamen oder diese E-Mail-Adresse gibt es bereits ein anderes Konto. Bitte wende dich an deine Administration.',
    'Another account already uses this username or e-mail address. Please contact your administrator.',
  ],
  'login.error.disabled': [
    'Dein Konto ist deaktiviert. Bitte wende dich an deine Administration.',
    'Your account is deactivated. Please contact your administrator.',
  ],
  'login.error.second_factor_required': [
    'Für dein Konto ist ein zweiter Faktor vorgeschrieben. Richte ihn bei der Anmeldung ein und versuch es dann erneut.',
    'Your account requires a second factor. Set it up during sign-in and try again.',
  ],
  'login.error.idp_unavailable': [
    'Der Anmeldedienst ist gerade nicht erreichbar. Bitte versuch es in ein paar Minuten noch einmal.',
    'The identity provider cannot be reached right now. Please try again in a few minutes.',
  ],
} satisfies Messages;
