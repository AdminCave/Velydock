// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Messages } from '../dictionaries';

// Publishing apps through the bundled reverse proxy: the section in the app dialog, the
// markers in the app list, the releases per organization and the templates page.
export const proxy = {
  // ── App dialog ───────────────────────────────────────────────────────
  'proxy.publish.label': ['Über den Proxy veröffentlichen', 'Publish through the proxy'],
  'proxy.publish.text': [
    'Für Anwendungen, die nur im internen Netz liegen: Der Proxy von Velydock stellt sie unter einer öffentlichen Adresse bereit und leitet die Anfragen an die interne weiter.',
    'For applications that live in the internal network only: Velydock’s proxy serves them under a public address and forwards the requests to the internal one.',
  ],
  'proxy.publish.unavailable': [
    'Veröffentlichen ist auf dieser Installation nicht eingerichtet; die App ist deshalb nicht erreichbar. Einrichten kann es der Betreiber der Installation. Du kannst die Veröffentlichung auch beenden und der App wieder eine eigene Adresse geben.',
    'Publishing is not set up on this installation, so the app cannot be reached. The operator of the installation can set it up. You can also end the publication and give the app an address of its own again.',
  ],
  'proxy.publish.ended': [
    'Ohne Veröffentlichung braucht die App wieder eine eigene Adresse; die öffentliche gibt es dann nicht mehr.',
    'Without the publication the app needs an address of its own again; the public one is gone then.',
  ],
  'proxy.target.label': ['Interne Adresse', 'Internal address'],
  'proxy.target.hint': [
    'Wohin der Proxy weiterleitet, zum Beispiel http://10.20.0.7:8080. Ohne Pfad.',
    'Where the proxy forwards to, for example http://10.20.0.7:8080. Without a path.',
  ],
  'proxy.target.released': ['Für deine Organisation freigegeben', 'Released for your organization'],
  'proxy.target.releasedHint': [
    'Möglich ist nur, was hier steht. Ein Hostname geht nur, wenn genau dieser Name freigegeben ist.',
    'Only what is listed here is possible. A host name works only if exactly this name is released.',
  ],
  'proxy.target.none.title': ['Noch nichts freigegeben', 'Nothing released yet'],
  'proxy.target.none.text': [
    'Zum Veröffentlichen muss der Systemadministrator erst freigeben, welche internen Adressen deine Organisation erreichen darf (System → Organisationen). Vorher lässt sich keine Veröffentlichung speichern.',
    'Before anything can be published, the system administrator has to release the internal addresses your organization may reach (System → Organizations). Until then no publication can be saved.',
  ],
  'proxy.target.invalid': [
    'Eine interne Adresse sieht so aus: http://10.20.0.7:8080 oder https://nas.intern.',
    'An internal address looks like this: http://10.20.0.7:8080 or https://nas.intern.',
  ],
  'proxy.target.path': [
    'Die interne Adresse darf keinen Pfad enthalten: Der Proxy hängt den Pfad jeder Anfrage selbst an.',
    'The internal address must not contain a path: the proxy adds the path of each request itself.',
  ],
  'proxy.address.label': ['Adresse', 'Address'],
  'proxy.mode.path': ['Pfad', 'Path'],
  'proxy.mode.subdomain': ['Subdomain', 'Sub-domain'],
  'proxy.mode.path.text': [
    'Braucht keinen weiteren DNS-Eintrag. Die Anwendung muss damit zurechtkommen, nicht an der Wurzel der Adresse zu liegen, und alle Apps mit Pfad-Adresse teilen sich im Browser einen Ursprung.',
    'Needs no further DNS entry. The application has to cope with not sitting at the root of the address, and all apps with a path address share one origin in the browser.',
  ],
  'proxy.mode.subdomain.text': [
    'Eine eigene Adresse je App, im Browser von allen anderen getrennt. Braucht einen DNS-Eintrag für den Namen.',
    'An address of its own per app, separated from all others in the browser. Needs a DNS entry for the name.',
  ],
  'proxy.mode.subdomainOnly': [
    'Der Systemadministrator erlaubt deiner Organisation nur Subdomains.',
    'The system administrator allows your organization sub-domains only.',
  ],
  'proxy.mode.pathOff': [
    'Diese App ist unter einer Pfad-Adresse veröffentlicht, Pfad-Adressen sind für deine Organisation aber abgeschaltet – der Systemadministrator erlaubt nur Subdomains. Wähl „Subdomain“, damit die App wieder erreichbar ist.',
    'This app is published under a path address, but path addresses are switched off for your organization – the system administrator allows sub-domains only. Choose “Sub-domain” to make the app reachable again.',
  ],
  'proxy.name.label': ['Name in der Adresse', 'Name in the address'],
  'proxy.name.hint': [
    'Kleinbuchstaben, Ziffern und Bindestriche, 2 bis 40 Zeichen. Der Name ist über alle Organisationen eindeutig.',
    'Lower-case letters, digits and hyphens, 2 to 40 characters. The name is unique across all organizations.',
  ],
  'proxy.name.invalid': [
    'Der Name besteht aus Kleinbuchstaben, Ziffern und Bindestrichen, hat 2 bis 40 Zeichen und beginnt und endet nicht mit einem Bindestrich.',
    'The name consists of lower-case letters, digits and hyphens, has 2 to 40 characters and neither begins nor ends with a hyphen.',
  ],
  'proxy.name.reserved': [
    'Dieser Name ist reserviert. Nimm einen anderen.',
    'This name is reserved. Take another one.',
  ],
  'proxy.preview.label': ['Öffentliche Adresse', 'Public address'],
  'proxy.preview.empty': ['Ergibt sich aus dem Namen.', 'Follows from the name.'],
  'proxy.access.label': ['Zugriff', 'Access'],
  'proxy.access.protected': ['Geschützt', 'Protected'],
  'proxy.access.public': ['Öffentlich', 'Public'],
  'proxy.access.protected.text': [
    'Nur angemeldete Benutzer, denen die App freigegeben ist. Wer die Adresse ohne Anmeldung öffnet, landet bei der Anmeldung von Velydock und danach in der App.',
    'Signed-in users with whom the app is shared, and nobody else. Whoever opens the address without being signed in lands at Velydock’s sign-in and in the app after that.',
  ],
  'proxy.access.public.title': ['Ohne Anmeldung erreichbar', 'Reachable without signing in'],
  'proxy.access.public.text': [
    'Jeder, der die Adresse kennt, erreicht die App – ohne sich anzumelden und ohne dass Velydock prüft, wem sie freigegeben ist.',
    'Everybody who knows the address reaches the app – without signing in, and without Velydock checking with whom it is shared.',
  ],
  'proxy.template.label': ['Vorlage', 'Template'],
  'proxy.template.hint': [
    'Ein Satz von Proxy-Einstellungen. Einzelne lassen sich darunter abweichend setzen.',
    'A set of proxy settings. Single ones can be set differently below.',
  ],
  'proxy.template.missing': ['Vorlage nicht mehr vorhanden', 'Template no longer exists'],
  'proxy.template.missingText': [
    'Die Vorlage dieser Veröffentlichung gibt es nicht mehr. Wähl eine andere.',
    'The template of this publication no longer exists. Choose another one.',
  ],
  'proxy.custom.kept': [
    'Für diese App hat ein Systemadministrator eigene Traefik-Middlewares hinterlegt ({names}). Sie bleiben bei allem erhalten, was du hier änderst; ändern oder entfernen kann sie nur ein Systemadministrator.',
    'A system administrator has added Traefik middlewares of their own to this app ({names}). They are kept whatever you change here; only a system administrator can change or remove them.',
  ],
  'proxy.custom.forbidden': [
    'Eigene Traefik-Middlewares kann nur ein Systemadministrator setzen oder ändern.',
    'Only a system administrator can set or change own Traefik middlewares.',
  ],
  'proxy.custom.appHint': [
    'Nur für Systemadministratoren. Als JSON: je Name genau eine Middleware. Sie kommen zu denen der Vorlage hinzu – bei gleichem Namen gilt die der App – und wirken nach der Anmeldeprüfung in der Reihenfolge ihrer Namen. Die Organisation kann sie weder ändern noch entfernen.',
    'For system administrators only. As JSON: exactly one middleware per name. They add to those of the template – where both use a name, the app’s applies – and are applied after the sign-in check in the order of their names. The organization can neither change nor remove them.',
  ],

  // ── Built-in templates (by their id) ─────────────────────────────────
  'proxy.builtin.standard.name': ['Standard', 'Standard'],
  'proxy.builtin.standard.text': [
    'Leitet Anfragen unverändert weiter.',
    'Forwards requests as they are.',
  ],
  'proxy.builtin.embeddable.name': ['In Velydock einbettbar', 'Embeddable in Velydock'],
  'proxy.builtin.embeddable.text': [
    'Entfernt X-Frame-Options aus den Antworten der Anwendung, damit sie sich in Velydock anzeigen lässt.',
    'Removes the application’s X-Frame-Options header so that it can be shown inside Velydock.',
  ],
  'proxy.builtin.subpath-aware.name': ['App kennt ihren Unterpfad', 'App knows its sub-path'],
  'proxy.builtin.subpath-aware.text': [
    'Für Anwendungen, die darauf eingestellt sind, unter einem Pfad zu laufen: Der Name bleibt im Pfad.',
    'For applications configured to run below a path: the name stays in the path.',
  ],
  'proxy.builtin.self-signed.name': [
    'Internes Gerät mit selbstsigniertem Zertifikat',
    'Internal device with a self-signed certificate',
  ],
  'proxy.builtin.self-signed.text': [
    'Prüft das Zertifikat der internen Adresse nicht.',
    'Does not verify the certificate of the internal address.',
  ],
  'proxy.builtin.header-login.name': ['Anmeldung per Kopfzeile', 'Sign-in by header'],
  'proxy.builtin.header-login.text': [
    'Teilt der Anwendung in Kopfzeilen mit, wer angemeldet ist (X-Velydock-User und weitere). Nur bei geschützten Apps.',
    'Tells the application in headers who is signed in (X-Velydock-User and others). Protected apps only.',
  ],

  // ── Settings (options) ───────────────────────────────────────────────
  'proxy.options.title': ['Einstellungen anpassen', 'Adjust settings'],
  'proxy.options.text': [
    'Was die Vorlage vorgibt, steht bei jeder Einstellung. Gespeichert wird nur, was du hier anders setzt.',
    'Each setting says what the template gives. Only what you set differently here is stored.',
  ],
  'proxy.options.changed': [
    '{count} abweichend von der Vorlage',
    '{count} differing from the template',
  ],
  'proxy.options.fromTemplate': ['Vorlage: {value}', 'Template: {value}'],
  'proxy.options.fromDefault': ['Standard: {value}', 'Default: {value}'],
  'proxy.options.overridden': ['abweichend', 'differs'],
  'proxy.value.on': ['an', 'on'],
  'proxy.value.off': ['aus', 'off'],
  'proxy.value.none': ['keine', 'none'],
  'proxy.value.rate': ['{average} pro Sekunde', '{average} per second'],
  'proxy.value.headers': ['{count} gesetzt', '{count} set'],
  'proxy.option.strip_prefix': ['Namen aus dem Pfad entfernen', 'Remove the name from the path'],
  'proxy.option.strip_prefix.text': [
    'Die Anwendung sieht /seite statt /name/seite. Ausschalten für Anwendungen, die darauf eingestellt sind, unter einem Pfad zu laufen.',
    'The application sees /page instead of /name/page. Switch off for applications configured to run below a path.',
  ],
  'proxy.option.allow_embedding': ['Einbettung erlauben', 'Allow embedding'],
  'proxy.option.allow_embedding.text': [
    'Entfernt X-Frame-Options aus den Antworten der Anwendung.',
    'Removes X-Frame-Options from the application’s answers.',
  ],
  'proxy.option.verify_upstream_tls': [
    'Zertifikat des Ziels nicht prüfen',
    'Do not verify the certificate of the target',
  ],
  'proxy.option.verify_upstream_tls.text': [
    'Für interne Geräte mit selbstsigniertem Zertifikat.',
    'For internal devices with a self-signed certificate.',
  ],
  'proxy.option.identity_headers': ['Anmeldung per Kopfzeile', 'Sign-in by header'],
  'proxy.option.identity_headers.text': [
    'Die Anwendung erfährt, wer angemeldet ist: X-Velydock-User, X-Velydock-Email, X-Velydock-Name. Sie muss so eingerichtet sein, dass sie diesen Kopfzeilen nur vom Proxy glaubt.',
    'The application learns who is signed in: X-Velydock-User, X-Velydock-Email, X-Velydock-Name. It has to be set up to believe these headers from the proxy only.',
  ],
  'proxy.option.pass_host_header': [
    'Öffentlichen Hostnamen weitergeben',
    'Pass on the public host name',
  ],
  'proxy.option.pass_host_header.text': [
    'Die Anwendung sieht den öffentlichen Namen als Host.',
    'The application sees the public name as Host.',
  ],
  'proxy.option.rate_limit': ['Anfragen begrenzen', 'Limit requests'],
  'proxy.option.rate_limit.text': [
    'Höchstzahl pro Sekunde je Client-Adresse.',
    'Maximum per second for each client address.',
  ],
  'proxy.rate.average.label': ['Anfragen pro Sekunde', 'Requests per second'],
  'proxy.rate.burst.label': ['Kurzzeitig höchstens', 'At most for a moment'],
  'proxy.rate.average': [
    'Zwischen 1 und 10 000 Anfragen pro Sekunde, als ganze Zahl.',
    'Between 1 and 10,000 requests per second, as a whole number.',
  ],
  'proxy.rate.burst': [
    'Mindestens so viele wie pro Sekunde und höchstens 100 000, als ganze Zahl.',
    'At least as many as per second and at most 100,000, as a whole number.',
  ],
  'proxy.option.request_headers': [
    'Zusätzliche Kopfzeilen an die Anwendung',
    'Additional headers for the application',
  ],
  'proxy.option.request_headers.text': [
    'Eine je Zeile, als „Name: Wert“ – zum Beispiel ein fester Authorization-Wert für ein Gerät ohne eigene Benutzer.',
    'One per line, as “Name: value” – for example a fixed Authorization value for a device without users of its own.',
  ],
  'proxy.option.response_headers': [
    'Zusätzliche Kopfzeilen an den Browser',
    'Additional headers for the browser',
  ],
  'proxy.option.response_headers.text': [
    'Eine je Zeile, als „Name: Wert“.',
    'One per line, as “Name: value”.',
  ],
  'proxy.option.only.path': [
    'Wirkt nur bei Pfad-Adressen.',
    'Has an effect for path addresses only.',
  ],
  'proxy.option.only.https': [
    'Wirkt nur bei Zielen mit https://.',
    'Has an effect for https:// targets only.',
  ],
  'proxy.option.only.protected': [
    'Wirkt nur bei geschützten Apps.',
    'Has an effect for protected apps only.',
  ],
  'proxy.headers.line': [
    'Diese Zeile ist keine Kopfzeile: „{detail}“. Erwartet wird „Name: Wert“.',
    'This line is no header: “{detail}”. Expected is “Name: value”.',
  ],
  'proxy.headers.fixed': [
    'Die Kopfzeile {detail} setzt der Proxy selbst; sie lässt sich nicht ändern.',
    'The header {detail} is set by the proxy itself and cannot be changed.',
  ],
  'proxy.headers.cookie': [
    'Cookies ({detail}) lassen sich über die Proxy-Einstellungen nicht setzen.',
    'Cookies ({detail}) cannot be set through the proxy settings.',
  ],
  'proxy.headers.long': [
    'Der Wert von {detail} ist zu lang (höchstens 1000 Zeichen).',
    'The value of {detail} is too long (at most 1000 characters).',
  ],
  'proxy.headers.many': ['Höchstens {detail} Kopfzeilen.', 'At most {detail} headers.'],
  'proxy.options.refused': [
    'Eine der Einstellungen wurde nicht angenommen.',
    'One of the settings was not accepted.',
  ],

  // ── App list ─────────────────────────────────────────────────────────
  'proxy.published.protected': ['Veröffentlicht · geschützt', 'Published · protected'],
  'proxy.published.public': ['Veröffentlicht · öffentlich', 'Published · public'],
  'proxy.published.title': [
    'Über den Proxy veröffentlicht unter {url}, weitergeleitet an {target}',
    'Published through the proxy at {url}, forwarded to {target}',
  ],
  'proxy.problem.target_not_allowed': [
    'Nicht erreichbar: Die interne Adresse ist für deine Organisation nicht mehr freigegeben. Freigeben kann sie der Systemadministrator.',
    'Not reachable: the internal address is no longer released for your organization. The system administrator can release it.',
  ],
  'proxy.problem.template_missing': [
    'Nicht erreichbar: Die Vorlage dieser Veröffentlichung gibt es nicht mehr. Wähl im App-Dialog eine andere.',
    'Not reachable: the template of this publication no longer exists. Choose another one in the app dialog.',
  ],
  'proxy.problem.mode_not_allowed': [
    'Nicht erreichbar: Pfad-Adressen sind für deine Organisation abgeschaltet. Stell die App im App-Dialog auf eine Subdomain um, oder bitte den Systemadministrator, Pfad-Adressen zu erlauben.',
    'Not reachable: path addresses are switched off for your organization. Change the app to a sub-domain in the app dialog, or ask the system administrator to allow path addresses.',
  ],
  'proxy.problem.proxy_disabled': [
    'Nicht erreichbar: Veröffentlichen ist auf dieser Installation nicht eingerichtet. Einrichten kann es der Betreiber; sonst beende die Veröffentlichung im App-Dialog.',
    'Not reachable: publishing is not set up on this installation. The operator can set it up; otherwise end the publication in the app dialog.',
  ],
  'proxy.problem.unknown': [
    'Nicht erreichbar ({code}). Der Systemadministrator kann sagen, woran es liegt.',
    'Not reachable ({code}). The system administrator can tell what it is about.',
  ],

  // ── System → Organizations: releases ─────────────────────────────────
  'proxyTargets.action': ['Proxy-Freigaben', 'Proxy releases'],
  'proxyTargets.open': ['Proxy-Freigaben für {name}', 'Proxy releases for {name}'],
  'proxyTargets.title': ['Proxy-Freigaben für {name}', 'Proxy releases for {name}'],
  'proxyTargets.text': [
    'Welche internen Adressen diese Organisation über den Proxy veröffentlichen darf. Ohne Freigabe lässt sich nichts veröffentlichen.',
    'Which internal addresses this organization may publish through the proxy. Without a release nothing can be published.',
  ],
  'proxyTargets.list': ['Freigegeben', 'Released'],
  'proxyTargets.done': ['Fertig', 'Done'],
  'proxyTargets.pending': [
    '{value} ist noch nicht freigegeben. Gib es mit „Freigeben“ frei oder leer das Feld.',
    '{value} is not released yet. Release it with “Release” or empty the field.',
  ],
  'proxyTargets.empty': ['Noch nichts freigegeben.', 'Nothing released yet.'],
  'proxyTargets.value': ['Netz, Adresse oder Hostname', 'Network, address or host name'],
  'proxyTargets.note': ['Notiz', 'Note'],
  'proxyTargets.note.hint': ['Wofür die Freigabe da ist.', 'What the release is for.'],
  'proxyTargets.add': ['Freigeben', 'Release'],
  'proxyTargets.remove': ['{value} nicht mehr freigeben', 'Withdraw the release of {value}'],
  'proxyTargets.forms': ['So lässt sich etwas freigeben:', 'What can be released:'],
  'proxyTargets.form.network': [
    '10.20.0.0/16 – ein Netz: jede Adresse darin',
    '10.20.0.0/16 – a network: every address in it',
  ],
  'proxyTargets.form.address': [
    '10.20.0.7 – eine einzelne Adresse',
    '10.20.0.7 – a single address',
  ],
  'proxyTargets.form.port': [
    '10.20.0.7:8080 – eine Adresse, und dort nur dieser Port',
    '10.20.0.7:8080 – an address, and only this port there',
  ],
  'proxyTargets.form.host': [
    'nas.intern – ein Hostname: genau dieser Name, kein anderer',
    'nas.intern – a host name: exactly this name, no other',
  ],
  'proxyTargets.invalid': [
    'Gib ein Netz (10.20.0.0/16), eine Adresse (10.20.0.7) oder einen Hostnamen (nas.intern) an, wahlweise mit Port (10.20.0.7:8080).',
    'Enter a network (10.20.0.0/16), an address (10.20.0.7) or a host name (nas.intern), optionally with a port (10.20.0.7:8080).',
  ],
  'proxyTargets.added': ['{value} ist für {name} freigegeben.', '{value} is released for {name}.'],
  'proxyTargets.removed': [
    'Die Freigabe {value} ist zurückgezogen.',
    'The release of {value} has been withdrawn.',
  ],
  'proxyTargets.remove.title': ['Freigabe zurückziehen', 'Withdraw release'],
  'proxyTargets.remove.question': [
    '{value} für {name} nicht mehr freigeben?',
    'Withdraw the release of {value} for {name}?',
  ],
  'proxyTargets.remove.detail': [
    'Apps, die von dort veröffentlicht sind, sind wenige Sekunden später nicht mehr erreichbar.',
    'Apps published from there cannot be reached a few seconds later.',
  ],
  'proxyTargets.remove.confirm': ['Freigabe zurückziehen', 'Withdraw release'],
  'proxyTargets.path.label': ['Pfad-Adressen erlauben', 'Allow path addresses'],
  'proxyTargets.path.text': [
    'Apps mit Pfad-Adresse teilen sich im Browser einen Ursprung – auch mit den Apps anderer Organisationen: Das Skript der einen kann die anderen mit den Rechten der Person aufrufen, die gerade davorsitzt. Ausgeschaltet gibt es für diese Organisation nur Subdomains.',
    'Apps with a path address share one origin in the browser – also with the apps of other organizations: the script of one can call the others with the rights of the person in front of it. Switched off, this organization gets sub-domains only.',
  ],
  'proxyTargets.path.off.title': ['Pfad-Adressen abschalten', 'Switch off path addresses'],
  'proxyTargets.path.off.question': [
    'Pfad-Adressen für {name} abschalten?',
    'Switch off path addresses for {name}?',
  ],
  'proxyTargets.path.off.detail': [
    'Apps dieser Organisation, die unter einer Pfad-Adresse veröffentlicht sind, sind danach nicht mehr erreichbar, bis sie auf eine Subdomain umgestellt werden.',
    'Apps of this organization that are published under a path address cannot be reached after that, until they are changed to a sub-domain.',
  ],
  'proxyTargets.path.off.confirm': ['Abschalten', 'Switch off'],
  'proxyTargets.path.on': [
    'Pfad-Adressen sind für {name} erlaubt.',
    'Path addresses are allowed for {name}.',
  ],
  'proxyTargets.path.off': [
    'Pfad-Adressen sind für {name} abgeschaltet.',
    'Path addresses are switched off for {name}.',
  ],
  'proxy.disabled.title': ['Veröffentlichen ist nicht eingerichtet', 'Publishing is not set up'],
  'proxy.disabled.text': [
    'Auf dieser Installation ist kein Apps-Host eingetragen (APPS_HOST in der Konfiguration). Solange das so ist, lässt sich nichts über den Proxy veröffentlichen.',
    'This installation has no apps host (APPS_HOST in its configuration). Until it has, nothing can be published through the proxy.',
  ],

  // ── System → Proxy templates ─────────────────────────────────────────
  'proxyTemplates.title': ['Proxy-Vorlagen', 'Proxy templates'],
  'proxyTemplates.subtitle': [
    'Sätze von Proxy-Einstellungen, aus denen Organisationen beim Veröffentlichen einer App wählen.',
    'Sets of proxy settings from which organizations choose when they publish an app.',
  ],
  'proxyTemplates.new': ['Vorlage anlegen', 'Add template'],
  'proxyTemplates.col.settings': ['Was sie setzt', 'What it sets'],
  'proxyTemplates.col.kind': ['Art', 'Kind'],
  'proxyTemplates.builtin': ['mitgeliefert', 'built-in'],
  'proxyTemplates.own': ['eigene', 'own'],
  'proxyTemplates.nothing': ['nichts – der Standard', 'nothing – the default'],
  'proxyTemplates.actions.edit': ['Vorlage {name} bearbeiten', 'Edit template {name}'],
  'proxyTemplates.actions.delete': ['Vorlage {name} löschen', 'Delete template {name}'],
  'proxyTemplates.effect': [
    'Mitgelieferte Vorlagen lassen sich nicht ändern. Änderungen an einer eigenen Vorlage wirken nach wenigen Sekunden auf alle Apps, die sie verwenden.',
    'Built-in templates cannot be changed. Changes to a template of your own take effect on all apps that use it after a few seconds.',
  ],
  'proxyTemplates.create.title': ['Vorlage anlegen', 'Add template'],
  'proxyTemplates.create.submit': ['Vorlage anlegen', 'Create template'],
  'proxyTemplates.edit.title': ['Vorlage {name} bearbeiten', 'Edit template {name}'],
  'proxyTemplates.description.hint': [
    'Steht im App-Dialog unter der Auswahl: wofür die Vorlage gedacht ist.',
    'Shown in the app dialog below the choice: what the template is meant for.',
  ],
  'proxyTemplates.options.title': ['Einstellungen', 'Settings'],
  'proxyTemplates.options.text': [
    'Was die Vorlage anders macht als der Standard. Wer eine App veröffentlicht, kann jede dieser Einstellungen für die einzelne App noch anders setzen.',
    'What the template does differently from the default. Whoever publishes an app can still set each of these differently for the single app.',
  ],
  'proxyTemplates.custom.label': ['Eigene Traefik-Middlewares', 'Own Traefik middlewares'],
  'proxyTemplates.custom.hint': [
    'Als JSON: je Name genau eine Middleware. Sie wirken nach der Anmeldeprüfung und in der Reihenfolge ihrer Namen – mit Namen wie 10-…, 20-… lässt sich die Reihenfolge festlegen.',
    'As JSON: exactly one middleware per name. They are applied after the sign-in check and in the order of their names – names like 10-…, 20-… fix the order.',
  ],
  'proxy.custom.refused': [
    'Diese Middlewares nimmt der Server nicht an. Seine Meldung steht darunter.',
    'The server does not accept these middlewares. Its message is below.',
  ],
  'proxy.custom.syntax': [
    'Das ist kein gültiges JSON: {detail}',
    'This is not valid JSON: {detail}',
  ],
  'proxy.custom.shape': [
    'Erwartet wird ein Objekt aus Name und Middleware, zum Beispiel {"10-buero": {"ipAllowList": {"sourceRange": ["203.0.113.0/24"]}}}.',
    'Expected is an object of name and middleware, for example {"10-office": {"ipAllowList": {"sourceRange": ["203.0.113.0/24"]}}}.',
  ],
  'proxy.custom.name': [
    '„{detail}“ kann kein Name einer Middleware sein: Kleinbuchstaben, Ziffern und Bindestriche, höchstens 31 Zeichen, zum Beispiel 10-buero.',
    '“{detail}” cannot be the name of a middleware: lower-case letters, digits and hyphens, at most 31 characters, for example 10-office.',
  ],
  'proxy.custom.one': [
    'Unter „{detail}“ steht nicht genau eine Middleware. Je Name eine: {"{detail}": {"ipAllowList": {…}}}.',
    '“{detail}” does not hold exactly one middleware. One per name: {"{detail}": {"ipAllowList": {…}}}.',
  ],
  'proxy.custom.many': ['Höchstens {detail} Middlewares.', 'At most {detail} middlewares.'],
  'proxyTemplates.created': ['Vorlage „{name}“ angelegt.', 'Template “{name}” created.'],
  'proxyTemplates.saved': ['Vorlage „{name}“ gespeichert.', 'Template “{name}” saved.'],
  'proxyTemplates.deleted': ['Vorlage „{name}“ gelöscht.', 'Template “{name}” deleted.'],
  'proxyTemplates.delete.title': ['Vorlage löschen', 'Delete template'],
  'proxyTemplates.delete.question': ['Vorlage „{name}“ löschen?', 'Delete template “{name}”?'],
  'proxyTemplates.delete.detail': [
    'Das geht nur, solange keine veröffentlichte App sie verwendet.',
    'This works only while no published app uses it.',
  ],
  'proxyTemplates.delete.confirm': ['Vorlage löschen', 'Delete template'],
  'proxyTemplates.inUse.title': [
    'Vorlage „{name}“ wird noch verwendet',
    'Template “{name}” is still in use',
  ],
  'proxyTemplates.usedBy': ['Verwendet von: {apps}.', 'Used by: {apps}.'],
} satisfies Messages;
