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
    'Deine Sitzung ist beendet. Bitte melde dich erneut an.',
    'Your session has ended. Please sign in again.',
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
  'error.tenant_changed': [
    'Die aktive Organisation hat sich inzwischen geändert. Es wurde nichts ausgeführt – prüf die Ansicht und versuch es noch einmal.',
    'The active organization has changed in the meantime. Nothing was done – check the view and try again.',
  ],
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
  'error.email_failed': [
    'Die E-Mail konnte nicht verschickt werden, deshalb wurde nichts geändert. Prüf die SMTP-Einstellungen unter System → Systemeinstellungen oder bitte die Systemadministration darum.',
    'The e-mail could not be sent, so nothing was changed. Check the SMTP settings under System → System settings, or ask the system administrator to.',
  ],
  'error.smtp_password_required': [
    'Gib das SMTP-Passwort noch einmal ein: Die Verbindungsdaten haben sich geändert, und das gespeicherte Passwort gilt nur für die bisherigen.',
    'Enter the SMTP password again: the connection settings have changed, and the stored password only goes with the previous ones.',
  ],
  'error.managed_by_idp': [
    'Die Zugehörigkeit dieses Kontos zur Organisation verwaltet der Anmeldedienst selbst (das Konto kam über einen externen Identitätsanbieter oder eine Einladung der Organisation in Keycloak). Das lässt sich nur dort ändern.',
    'The identity provider manages this account’s membership of the organization itself (the account came in through an external identity provider or an invitation of the organization in Keycloak). This can only be changed there.',
  ],
  'error.missing_at_idp': [
    'Dieses Konto gibt es im Anmeldedienst (Keycloak) nicht mehr – es wurde dort gelöscht. Hier kannst du es nur noch deaktivieren oder löschen.',
    'This account no longer exists at the identity provider (Keycloak) – it was deleted there. All you can still do here is deactivate or delete it.',
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
  // ── Publishing through the proxy ─────────────────────────────────────
  'error.proxy_disabled': [
    'Veröffentlichen über den Proxy ist auf dieser Installation nicht eingerichtet.',
    'Publishing through the proxy is not set up on this installation.',
  ],
  'error.proxy_target_invalid': [
    'Diese Adresse ist keine, an die der Proxy weiterleiten kann.',
    'This is no address the proxy can forward to.',
  ],
  'error.proxy_target_not_allowed': [
    'Diese interne Adresse ist für deine Organisation nicht freigegeben. Freigeben kann sie der Systemadministrator.',
    'This internal address is not released for your organization. The system administrator can release it.',
  ],
  'error.proxy_target_reserved': [
    'Dieser Name gehört zur Installation selbst und lässt sich nicht freigeben.',
    'This name belongs to the installation itself and cannot be released.',
  ],
  'error.proxy_target_exists': [
    'Diese Adresse ist für die Organisation schon freigegeben.',
    'This address is released for the organization already.',
  ],
  'error.proxy_template_unknown': [
    'Diese Vorlage gibt es nicht (mehr). Wähl eine andere.',
    'This template does not exist (any more). Choose another one.',
  ],
  'error.proxy_options_invalid': [
    'Eine der Proxy-Einstellungen wurde nicht angenommen.',
    'One of the proxy settings was not accepted.',
  ],
  'error.publication_type': [
    'Veröffentlichen lassen sich nur eingebettete Apps und Apps im neuen Tab.',
    'Only embedded apps and apps in a new tab can be published.',
  ],
  'error.publication_name_invalid': [
    'Der Name in der Adresse besteht aus Kleinbuchstaben, Ziffern und Bindestrichen (2 bis 40 Zeichen) und darf kein reserviertes Wort sein.',
    'The name in the address consists of lower-case letters, digits and hyphens (2 to 40 characters) and must not be a reserved word.',
  ],
  'error.publication_name_taken': [
    'Dieser Name ist schon vergeben – Namen sind über alle Organisationen eindeutig. Nimm einen anderen.',
    'This name is taken already – names are unique across all organizations. Take another one.',
  ],
  'error.publication_mode_not_allowed': [
    'Deine Organisation veröffentlicht Apps nur unter einer Subdomain. Wähl „Subdomain“.',
    'Your organization publishes apps under a sub-domain only. Choose “Sub-domain”.',
  ],
  'error.template_in_use': [
    'Diese Vorlage wird von veröffentlichten Apps verwendet. Eine Vorlage in Verwendung lässt sich nicht löschen: Stell die Apps erst auf eine andere um.',
    'This template is used by published apps. A template in use cannot be deleted: change the apps to another one first.',
  ],
  'error.name_taken': ['Diesen Namen gibt es schon.', 'This name exists already.'],
  'error.logo_invalid': [
    'Das Logo muss ein PNG-, JPEG-, GIF-, WebP- oder SVG-Bild sein.',
    'The logo must be a PNG, JPEG, GIF, WebP or SVG image.',
  ],
  'error.logo_too_large': [
    'Das Logo darf höchstens 256 KB groß sein. Nimm eine kleinere Datei, zum Beispiel eine verkleinerte oder als SVG gespeicherte Fassung.',
    'The logo must be at most 256 KB. Take a smaller file, for example a scaled-down version or one saved as SVG.',
  ],
  'error.order_mismatch': [
    'Die App-Liste hat sich inzwischen geändert. Die Reihenfolge wurde neu geladen.',
    'The list of apps has changed in the meantime. The order was reloaded.',
  ],
  'error.not_embedded': [
    'Nur eingebettete Apps können geprüft werden.',
    'Only embedded apps can be checked.',
  ],
  'error.unavailable': [
    'Velydock kann gerade nicht arbeiten, weil seine Datenbank nicht erreichbar ist. Es wurde nichts geändert – versuch es gleich noch einmal.',
    'Velydock cannot work right now because its database cannot be reached. Nothing was changed – try again in a moment.',
  ],
  'error.try_again': [
    'Zwei Änderungen sind sich in die Quere gekommen. Es wurde nichts geändert – versuch es einfach noch einmal.',
    'Two changes got in each other’s way. Nothing was changed – just try again.',
  ],
  'error.too_large': [
    'Die Anfrage ist zu groß. Bei einer eigenen App hilft es, HTML, CSS oder JavaScript zu kürzen.',
    'The request is too large. For a custom app it helps to shorten the HTML, CSS or JavaScript.',
  ],
  'error.rate_limited': [
    'Zu viele Anfragen in kurzer Zeit. Warte einen Moment und versuch es noch einmal.',
    'Too many requests in a short time. Wait a moment and try again.',
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
  'login.error.account_unsupported': [
    'Der Benutzername dieses Kontos ist länger, als Velydock unterstützt (höchstens 150 Zeichen). Bitte wende dich an deine Administration.',
    'The user name of this account is longer than Velydock supports (150 characters at most). Please contact your administrator.',
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
