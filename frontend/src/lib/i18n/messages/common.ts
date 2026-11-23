// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Messages } from '../dictionaries';

// Each entry: key → [German, English]. German addresses the user informally ("du").
export const common = {
  // ── Actions ──────────────────────────────────────────────────────────
  'action.save': ['Speichern', 'Save'],
  'action.cancel': ['Abbrechen', 'Cancel'],
  'action.confirm': ['Bestätigen', 'Confirm'],
  'action.delete': ['Löschen', 'Delete'],
  'action.edit': ['Bearbeiten', 'Edit'],
  'action.close': ['Schließen', 'Close'],
  'action.retry': ['Erneut versuchen', 'Try again'],

  // ── Generic UI ───────────────────────────────────────────────────────
  'ui.search': ['Suchen', 'Search'],
  'ui.clear': ['Eingabe löschen', 'Clear input'],
  'ui.select': ['Auswählen …', 'Select …'],
  'state.loading': ['Lädt …', 'Loading …'],
  'confirm.title': ['Bitte bestätigen', 'Please confirm'],
  'dialog.discard.title': ['Eingaben verwerfen?', 'Discard your input?'],
  'dialog.discard.question': [
    'Du hast in diesem Dialog etwas eingegeben, das noch nicht gespeichert ist.',
    'You have entered something in this dialog that has not been saved yet.',
  ],
  'dialog.discard.confirm': ['Verwerfen', 'Discard'],
  'dialog.discard.keep': ['Weiter bearbeiten', 'Keep editing'],
  'toast.copied': ['Kopiert.', 'Copied.'],
  'toast.copyFailed': [
    'Kopieren hat nicht geklappt. Bitte markier den Text und kopier ihn von Hand.',
    'Copying failed. Please select the text and copy it by hand.',
  ],

  // ── Field labels (also used to name fields in validation errors and the audit log) ──
  'field.name': ['Name', 'Name'],
  'field.username': ['Benutzername', 'Username'],
  'field.email': ['E-Mail-Adresse', 'E-mail address'],
  'field.first_name': ['Vorname', 'First name'],
  'field.last_name': ['Nachname', 'Last name'],
  'field.role': ['Rolle', 'Role'],
  'field.groups': ['Gruppen', 'Groups'],
  'field.group_ids': ['Gruppen', 'Groups'],
  'field.user_ids': ['Personen', 'People'],
  'field.member_ids': ['Mitglieder', 'Members'],
  'field.status': ['Status', 'Status'],
  'field.active': ['Status', 'Status'],
  'field.last_login': ['Letzte Anmeldung', 'Last sign-in'],
  'field.actions': ['Aktionen', 'Actions'],
  'field.description': ['Beschreibung', 'Description'],
  'field.type': ['Typ', 'Type'],
  'field.url': ['Adresse (URL)', 'Address (URL)'],
  'field.icon': ['Symbol', 'Icon'],
  'field.enabled': ['Aktiv', 'Enabled'],
  'field.visible_to_all': ['Sichtbarkeit', 'Visibility'],
  'field.frame_permissions': ['Browser-Funktionen', 'Browser features'],
  'field.custom_html': ['HTML', 'HTML'],
  'field.custom_css': ['CSS', 'CSS'],
  'field.custom_js': ['JavaScript', 'JavaScript'],
  'field.custom_allow_network': ['Netzwerkzugriff', 'Network access'],
  'field.slug': ['Kurzname', 'Short name'],
  'field.confirm_slug': ['Kurzname', 'Short name'],
  'field.instance_name': ['Name der Installation', 'Instance name'],
  'field.default_nav_position': ['Standardposition des Docks', 'Default dock position'],
  'field.default_theme': ['Standard-Design', 'Default theme'],
  'field.default_language': ['Standardsprache', 'Default language'],
  'field.require_admin_2fa': ['Zwei-Faktor für Administratoren', 'Two-factor for administrators'],
  'field.smtp': ['E-Mail-Versand', 'E-mail delivery'],

  // ── Status ───────────────────────────────────────────────────────────
  'status.active': ['Aktiv', 'Active'],
  'status.inactive': ['Deaktiviert', 'Deactivated'],
  'status.enabled': ['Aktiv', 'Enabled'],
  'status.disabled': ['Deaktiviert', 'Disabled'],

  // ── Roles ────────────────────────────────────────────────────────────
  'role.member': ['Mitglied', 'Member'],
  'role.user_manager': ['Benutzerverwaltung', 'User manager'],
  'role.tenant_admin': ['Administration', 'Administrator'],
  'role.system_admin': ['Systemadministration', 'System administrator'],
  'role.none': ['kein Mitglied', 'not a member'],

  // ── Navigation positions ─────────────────────────────────────────────
  'nav.position.left': ['Links', 'Left'],
  'nav.position.right': ['Rechts', 'Right'],
  'nav.position.top': ['Oben', 'Top'],
  'nav.position.bottom': ['Unten', 'Bottom'],
  'nav.position.systemDefault': ['Systemstandard', 'System default'],
  'appBar.top': ['Oben', 'Top'],
  'appBar.bottom': ['Unten', 'Bottom'],
  'appBar.hidden': ['Ausgeblendet', 'Hidden'],

  // ── Accent colour ────────────────────────────────────────────────────
  'accent.custom': ['Eigene Farbe', 'Own colour'],
  'accent.custom.pick': ['Farbe auswählen', 'Pick a colour'],
  'accent.custom.invalid': [
    'Eine Farbe sieht so aus: #c2410c – ein # und sechs Zeichen aus 0–9 und a–f.',
    'A colour looks like this: #c2410c – a # and six characters from 0–9 and a–f.',
  ],
  'accent.color.blue': ['Blau', 'Blue'],
  'accent.color.cyan': ['Petrol', 'Cyan'],
  'accent.color.teal': ['Türkis', 'Teal'],
  'accent.color.green': ['Grün', 'Green'],
  'accent.color.amber': ['Bernstein', 'Amber'],
  'accent.color.orange': ['Orange', 'Orange'],
  'accent.color.pink': ['Pink', 'Pink'],
  'accent.color.violet': ['Violett', 'Violet'],

  // ── Validation in forms ──────────────────────────────────────────────
  'validation.required': ['Dieses Feld wird gebraucht.', 'This field is required.'],
  'validation.email': [
    'Das ist keine gültige E-Mail-Adresse.',
    'This is not a valid e-mail address.',
  ],
  'validation.personName': [
    'Nicht erlaubt sind die Zeichen < > & " $ % ! # ? § ; * ~ / \\ | ^ = [ ] { } ( ) und Steuerzeichen.',
    'These characters are not allowed: < > & " $ % ! # ? § ; * ~ / \\ | ^ = [ ] { } ( ) and control characters.',
  ],
  'validation.invalid': ['Diese Eingabe wurde nicht angenommen.', 'This input was not accepted.'],
  'validation.maxLength': [
    'Mehr als {max} Zeichen sind hier nicht möglich.',
    'No more than {max} characters fit here.',
  ],
  'validation.username': [
    '3–64 Zeichen: Kleinbuchstaben, Ziffern, Punkt, Bindestrich oder Unterstrich; am Anfang und am Ende ein Buchstabe oder eine Ziffer.',
    '3–64 characters: lowercase letters, digits, dot, dash or underscore, starting and ending with a letter or digit.',
  ],

  // ── Pagination and pickers ───────────────────────────────────────────
  'pagination.label': ['Seiten', 'Pages'],
  'pagination.range': ['{from}–{to} von {total}', '{from}–{to} of {total}'],
  'pagination.page': ['Seite {page}/{pages}', 'Page {page}/{pages}'],
  'pagination.previous': ['Vorherige Seite', 'Previous page'],
  'pagination.next': ['Nächste Seite', 'Next page'],
  'picker.count': ['{count} von {total} ausgewählt', '{count} of {total} selected'],
  'picker.empty': ['Nichts zur Auswahl.', 'Nothing to choose from.'],
  'picker.noMatch': ['Kein Treffer.', 'No match.'],
  'picker.remove': ['{name} entfernen', 'Remove {name}'],
  'picker.more': ['und {count} weitere', 'and {count} more'],
  'picker.less': ['Weniger anzeigen', 'Show fewer'],

  // ── Document titles ──────────────────────────────────────────────────
  'title.login': ['Anmelden', 'Sign in'],
  'title.dashboard': ['Start', 'Home'],
  'title.profile': ['Profil', 'Profile'],
  'title.settings': ['Einstellungen', 'Settings'],

  // ── Start-up, 404, no access ─────────────────────────────────────────
  'startup.error.title': ['Velydock ist gerade nicht erreichbar', 'Velydock cannot be reached'],
  'startup.error.text': [
    'Der Server hat nicht geantwortet. Meist hilft: kurz warten, neu laden. Der Kaffee ist bis dahin auch fertig.',
    'The server did not answer. Usually it helps to wait a moment and reload. Time for a coffee.',
  ],
  'notFound.title': ['Seite nicht gefunden', 'Page not found'],
  'notFound.text': [
    'Diese Adresse führt ins Leere. Tippfehler, alter Link – oder jemand hat aufgeräumt.',
    'This address leads nowhere. A typo, an old link – or somebody tidied up.',
  ],
  'notFound.back': ['Zur Startseite', 'Back to the start page'],
  'forbidden.title': ['Kein Zugriff', 'No access'],
  'forbidden.text': [
    'Für diese Seite fehlt dir die Berechtigung. Wenn das ein Irrtum ist, frag deine Administration.',
    'You lack the permission for this page. If that is a mistake, ask your administrator.',
  ],
} satisfies Messages;
