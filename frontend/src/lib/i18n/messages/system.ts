// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Messages } from '../dictionaries';

// System administration: organizations, all users, system settings.
export const system = {
  // ── Organizations ────────────────────────────────────────────────────
  'tenants.title': ['Organisationen', 'Organizations'],
  'tenants.subtitle': [
    'Jede Organisation hat eigene Benutzer, Gruppen und Apps, sauber voneinander getrennt.',
    'Each organization has its own users, groups and apps, cleanly separated from the others.',
  ],
  'tenants.create': ['Organisation anlegen', 'Add organization'],
  'tenants.create.title': ['Organisation anlegen', 'Add organization'],
  'tenants.create.submit': ['Organisation anlegen', 'Create organization'],
  'tenants.rename.title': ['{name} umbenennen', 'Rename {name}'],
  'tenants.col.members': ['Mitglieder', 'Members'],
  'tenants.col.apps': ['Apps', 'Apps'],
  'tenants.current': ['du bist hier', 'you are here'],
  'tenants.actions': ['Aktionen für {name}', 'Actions for {name}'],
  'tenants.action.enter': ['Betreten', 'Enter'],
  'tenants.action.rename': ['Umbenennen', 'Rename'],
  'tenants.action.activate': ['Aktivieren', 'Activate'],
  'tenants.action.deactivate': ['Deaktivieren', 'Deactivate'],
  'tenants.name.tooShort': [
    'Der Name braucht mindestens 2 Zeichen.',
    'The name needs at least 2 characters.',
  ],
  'tenants.slug.hint': [
    '2–40 Zeichen: Kleinbuchstaben, Ziffern und Bindestriche. Der Kurzname ist die technische Kennung und lässt sich später nicht ändern.',
    '2–40 characters: lowercase letters, digits and dashes. The short name is the technical identifier and cannot be changed later.',
  ],
  'tenants.slug.fixed': [
    'Der Kurzname lässt sich nicht ändern.',
    'The short name cannot be changed.',
  ],
  'tenants.slug.format': [
    'Erlaubt sind 2–40 Zeichen: Kleinbuchstaben, Ziffern und Bindestriche, nicht am Anfang oder Ende.',
    'Allowed are 2–40 characters: lowercase letters, digits and dashes, not at the start or end.',
  ],
  'tenants.slug.reserved': [
    'Dieser Kurzname ist reserviert. Bitte wähl einen anderen.',
    'This short name is reserved. Please choose another one.',
  ],
  'tenants.created': ['Organisation {name} angelegt.', 'Organization {name} created.'],
  'tenants.renamed': [
    'Die Organisation heißt jetzt {name}.',
    'The organization is now called {name}.',
  ],
  'tenants.deleted': ['Organisation {name} gelöscht.', 'Organization {name} deleted.'],
  'tenants.entered': ['Du bist jetzt in {name}.', 'You are now in {name}.'],
  'tenants.activated': ['{name} ist wieder aktiv.', '{name} is active again.'],
  'tenants.deactivated': ['{name} ist deaktiviert.', '{name} is deactivated.'],
  'tenants.deactivate.title': ['Organisation deaktivieren', 'Deactivate organization'],
  'tenants.deactivate.question': ['{name} deaktivieren?', 'Deactivate {name}?'],
  'tenants.deactivate.detail': [
    'Niemand kann die Organisation mehr betreten, ihre Apps sind nicht erreichbar. Konten und Daten bleiben erhalten; du kannst sie jederzeit wieder aktivieren.',
    'Nobody can enter the organization any more and its apps are unreachable. Accounts and data are kept; you can activate it again at any time.',
  ],
  'tenants.delete.title': ['{name} löschen', 'Delete {name}'],
  'tenants.delete.warning.title': [
    'Das lässt sich nicht rückgängig machen',
    'This cannot be undone',
  ],
  'tenants.delete.warning.text': [
    'Mit der Organisation werden ihre Apps ({apps}), alle Gruppen und Einstellungen gelöscht – und alle Konten, die ihr gehören. Diese Personen können sich danach nirgends mehr anmelden. Gäste aus anderen Organisationen behalten ihr Konto und verlieren nur den Zugang. Mitglieder insgesamt: {members}.',
    'Together with the organization its apps ({apps}), all groups and settings are deleted – and all accounts it owns. Those people can no longer sign in anywhere. Guests from other organizations keep their account and only lose access. Members in total: {members}.',
  ],
  'tenants.delete.confirmLabel': [
    'Gib zur Bestätigung den Kurznamen „{slug}“ ein',
    'Type the short name “{slug}” to confirm',
  ],
  'tenants.delete.confirm': ['Endgültig löschen', 'Delete for good'],
  'tenants.empty.title': ['Keine Organisationen', 'No organizations'],
  'tenants.empty.text': [
    'Ohne Organisation kann niemand arbeiten. Leg die erste an.',
    'Without an organization nobody can work. Create the first one.',
  ],

  // ── All users ────────────────────────────────────────────────────────
  'systemUsers.title': ['Alle Benutzer', 'All users'],
  'systemUsers.subtitle': [
    'Alle Konten dieser Installation mit ihren Organisationen. Angelegt und bearbeitet werden Konten in der jeweiligen Organisation.',
    'All accounts of this instance with their organizations. Accounts are created and edited inside their organization.',
  ],
  'systemUsers.col.tenants': ['Organisationen', 'Organizations'],
  'systemUsers.noTenant': ['keine Organisation', 'no organization'],
  'systemUsers.action.add': ['Zu Organisation hinzufügen', 'Add to organization'],
  'systemUsers.action.grant': ['Zum Systemadministrator machen', 'Make system administrator'],
  'systemUsers.action.revoke': [
    'Systemadministrator-Recht entziehen',
    'Revoke system administrator right',
  ],
  'systemUsers.add.title': [
    '{name} zu einer Organisation hinzufügen',
    'Add {name} to an organization',
  ],
  'systemUsers.add.textGuest': [
    'Das Konto gehört weiter zu {home}. In der gewählten Organisation bekommt die Person Zugang als Gast: Dort lässt sich festlegen, was sie darf, aber nicht ihr Name oder Passwort.',
    'The account still belongs to {home}. In the chosen organization the person gets access as a guest: there you can decide what they may do, but not their name or password.',
  ],
  'systemUsers.add.textHome': [
    'Dieses Konto gehört noch zu keiner Organisation. Die gewählte Organisation wird seine Heimat und verwaltet künftig Name und Passwort.',
    'This account does not belong to an organization yet. The chosen organization becomes its home and manages name and password from now on.',
  ],
  'systemUsers.add.tenant': ['Organisation', 'Organization'],
  'systemUsers.add.choose': ['Organisation wählen …', 'Choose an organization …'],
  'systemUsers.add.none': [
    'Dieses Konto gehört bereits zu allen Organisationen.',
    'This account already belongs to all organizations.',
  ],
  'systemUsers.add.submit': ['Hinzufügen', 'Add'],
  'systemUsers.added': ['{name} gehört jetzt zu {tenant}.', '{name} now belongs to {tenant}.'],
  'systemUsers.grant.title': ['Systemadministrator ernennen', 'Appoint system administrator'],
  'systemUsers.grant.question': [
    '{name} zum Systemadministrator machen?',
    'Make {name} a system administrator?',
  ],
  'systemUsers.grant.detail': [
    'Systemadministratoren dürfen alles: jede Organisation betreten, Benutzer und Apps ändern, Organisationen löschen und dieses Recht weitergeben.',
    'System administrators may do everything: enter any organization, change users and apps, delete organizations and pass this right on.',
  ],
  'systemUsers.revoke.title': ['Recht entziehen', 'Revoke right'],
  'systemUsers.revoke.question': [
    '{name} das Systemadministrator-Recht entziehen?',
    'Revoke the system administrator right of {name}?',
  ],
  'systemUsers.revoke.detail': [
    'Die Person behält ihr Konto und ihre Rollen in den Organisationen, verliert aber den Zugriff auf Systemeinstellungen und fremde Organisationen.',
    'The person keeps their account and their roles in the organizations, but loses access to system settings and other organizations.',
  ],
  'systemUsers.granted': [
    '{name} ist jetzt Systemadministrator.',
    '{name} is now a system administrator.',
  ],
  'systemUsers.revoked': [
    '{name} ist kein Systemadministrator mehr.',
    '{name} is no longer a system administrator.',
  ],

  // ── System settings ──────────────────────────────────────────────────
  'systemSettings.title': ['Systemeinstellungen', 'System settings'],
  'systemSettings.subtitle': [
    'Gilt für die gesamte Installation und alle Organisationen.',
    'Applies to the whole instance and all organizations.',
  ],
  'systemSettings.general.title': ['Allgemein', 'General'],
  'systemSettings.general.text': [
    'Name und Vorgaben, die überall gelten, wo niemand etwas anderes einstellt.',
    'Name and defaults that apply wherever nobody sets something else.',
  ],
  'systemSettings.instanceName': ['Name der Installation', 'Instance name'],
  'systemSettings.instanceName.hint': [
    'Erscheint auf der Anmeldeseite, im Dock und im Browser-Tab.',
    'Shown on the sign-in page, in the dock and in the browser tab.',
  ],
  'systemSettings.defaultNav': ['Standardposition des Docks', 'Default dock position'],
  'systemSettings.defaultTheme': ['Standard-Design', 'Default theme'],
  'systemSettings.defaultLanguage': ['Standardsprache', 'Default language'],
  'systemSettings.defaults.hint': [
    'Organisationen können die Dock-Position überschreiben; Design und Sprache wählt jede Person selbst.',
    'Organizations can override the dock position; theme and language are chosen by each person.',
  ],
  'systemSettings.security.title': ['Sicherheit', 'Security'],
  'systemSettings.require2fa.label': [
    'Zwei-Faktor für Administratoren verlangen',
    'Require two-factor for administrators',
  ],
  'systemSettings.require2fa.text': [
    'Wer Benutzer, Organisationen oder das System verwaltet, muss bei der Anmeldung einen zweiten Faktor einrichten und nutzen. Gilt ab der jeweils nächsten Anmeldung.',
    'Whoever manages users, organizations or the system has to set up and use a second factor when signing in. Applies from the next sign-in on.',
  ],
  'systemSettings.saved': ['Systemeinstellungen gespeichert.', 'System settings saved.'],
  'systemSettings.unchanged': ['Es gibt nichts zu speichern.', 'There is nothing to save.'],
  'systemSettings.smtp.title': ['E-Mail-Versand (SMTP)', 'E-mail delivery (SMTP)'],
  'systemSettings.smtp.text': [
    'Wird für die Links zum Passwort-Setzen gebraucht. Ohne SMTP bekommen Administratoren stattdessen ein Einmalpasswort angezeigt.',
    'Needed for the links for setting a password. Without SMTP administrators are shown a one-time password instead.',
  ],
  'systemSettings.smtp.configured': ['konfiguriert', 'configured'],
  'systemSettings.smtp.notConfigured': ['nicht konfiguriert', 'not configured'],
  'systemSettings.smtp.host': ['Server', 'Server'],
  'systemSettings.smtp.port': ['Port', 'Port'],
  'systemSettings.smtp.port.invalid': [
    'Der Port muss zwischen 1 und 65535 liegen.',
    'The port must be between 1 and 65535.',
  ],
  'systemSettings.smtp.encryption': ['Verschlüsselung', 'Encryption'],
  'systemSettings.smtp.encryption.none': ['Keine', 'None'],
  'systemSettings.smtp.fromAddress': ['Absenderadresse', 'Sender address'],
  'systemSettings.smtp.fromName': ['Absendername', 'Sender name'],
  'systemSettings.smtp.username': ['Benutzername', 'Username'],
  'systemSettings.smtp.password': ['Passwort', 'Password'],
  'systemSettings.smtp.password.hint': [
    'Wird nie angezeigt. Leer lassen, um das gespeicherte Passwort zu behalten.',
    'Never shown. Leave empty to keep the stored password.',
  ],
  'systemSettings.smtp.save': ['SMTP speichern', 'Save SMTP'],
  'systemSettings.smtp.saved': ['SMTP-Einstellungen gespeichert.', 'SMTP settings saved.'],

  // ── System audit log ─────────────────────────────────────────────────
  'systemAudit.title': ['Systemprotokoll', 'System audit log'],
  'systemAudit.subtitle': [
    'Änderungen, die über den einzelnen Organisationen stehen: Organisationen, Systemeinstellungen, Systemadministrator-Rechte.',
    'Changes above the individual organizations: organizations, system settings, system administrator rights.',
  ],
} satisfies Messages;
