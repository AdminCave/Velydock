// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Messages } from '../dictionaries';

// Own TLS certificates for the bundled reverse proxy: the page System → Zertifikate and
// the dialog that adds or replaces one.
export const certificates = {
  // ── The page ─────────────────────────────────────────────────────────
  'certificates.title': ['Zertifikate', 'Certificates'],
  'certificates.subtitle': [
    'Eigene TLS-Zertifikate für diese Installation. Der Proxy liefert ein hochgeladenes Zertifikat für jede Adresse aus, für die es gilt.',
    'Own TLS certificates for this installation. The proxy serves an uploaded certificate for every address it is valid for.',
  ],
  'certificates.fallback.acme': [
    'Adressen ohne eigenes Zertifikat bekommen eines von Let’s Encrypt.',
    'Addresses without an own certificate get one from Let’s Encrypt.',
  ],
  'certificates.fallback.default': [
    'Adressen ohne eigenes Zertifikat bekommen das selbstsignierte Zertifikat des Proxys – Browser warnen davor.',
    'Addresses without an own certificate get the proxy’s self-signed certificate – browsers warn about it.',
  ],
  'certificates.add': ['Zertifikat hinzufügen', 'Add certificate'],
  'certificates.unavailable.title': [
    'Eigene Zertifikate sind auf dieser Installation nicht eingerichtet',
    'Own certificates are not set up on this installation',
  ],
  'certificates.unavailable.effect': [
    'Bis das behoben ist, lässt sich kein Zertifikat hinzufügen oder ersetzen.',
    'Until that is fixed no certificate can be added or replaced.',
  ],
  'certificates.problem.no_directory': [
    'Velydock kennt kein Verzeichnis für Zertifikate: VELYDOCK_CERTS_DIR ist nicht gesetzt. Die mitgelieferte docker-compose.yml setzt es auf /certs und bindet dort das Volume velydock-certs ein, bei Velydock und beim Proxy. Übernimm das in deine Compose-Datei und starte den Stack neu.',
    'Velydock knows no directory for certificates: VELYDOCK_CERTS_DIR is not set. The bundled docker-compose.yml sets it to /certs and mounts the volume velydock-certs there, for Velydock and for the proxy. Take that over into your Compose file and restart the stack.',
  ],
  'certificates.problem.no_secret': [
    'VELYDOCK_PROXY_SECRET ist nicht gesetzt. Mit diesem Geheimnis holt der Proxy seine Konfiguration bei Velydock ab; ohne es erfährt er nichts von hochgeladenen Zertifikaten. Trag in der .env ein Geheimnis mit mindestens 16 Zeichen ein und starte den Stack neu.',
    'VELYDOCK_PROXY_SECRET is not set. With this secret the proxy fetches its configuration from Velydock; without it the proxy never learns of uploaded certificates. Enter a secret of at least 16 characters in .env and restart the stack.',
  ],
  'certificates.problem.not_writable': [
    'Velydock kann in das Verzeichnis für Zertifikate (VELYDOCK_CERTS_DIR) nicht schreiben. Prüf, ob das Volume dort eingebunden ist und ob der Benutzer des Velydock-Containers darin schreiben darf.',
    'Velydock cannot write into the directory for certificates (VELYDOCK_CERTS_DIR). Check that the volume is mounted there and that the user of the Velydock container may write into it.',
  ],
  'certificates.problem.unknown': [
    'Den Grund kennt diese Version der Oberfläche nicht ({code}). Im Log von Velydock steht mehr.',
    'This version of the interface does not know the reason ({code}). The log of Velydock says more.',
  ],
  'certificates.col.names': ['Gilt für', 'Valid for'],
  'certificates.col.key': ['Schlüssel', 'Key'],
  'certificates.issuer': ['Aussteller', 'Issuer'],
  'certificates.until': ['Gültig bis', 'Valid until'],
  'certificates.status.expires_soon': ['läuft bald ab', 'expires soon'],
  'certificates.status.expired': ['abgelaufen', 'expired'],
  'certificates.status.not_yet_valid': ['noch nicht gültig', 'not yet valid'],
  'certificates.warning.no_intermediate': [
    'Ohne Zertifikat des Ausstellers – Browser, die den Aussteller nicht kennen, lehnen die Verbindung ab. Ersetz es durch eines mit vollständiger Kette.',
    'Without the certificate of its issuer – browsers that do not know the issuer refuse the connection. Replace it by one with the complete chain.',
  ],
  'certificates.details': ['Details', 'Details'],
  'certificates.detail.subject': ['Inhaber', 'Subject'],
  'certificates.detail.chain': ['Kette', 'Chain'],
  'certificates.detail.serial': ['Seriennummer', 'Serial number'],
  'certificates.detail.fingerprint': ['Fingerabdruck (SHA-256)', 'Fingerprint (SHA-256)'],
  'certificates.detail.notBefore': ['Gültig ab', 'Valid from'],
  'certificates.detail.created': ['Gespeichert', 'Stored'],
  'certificates.detail.updated': ['Geändert', 'Changed'],
  'certificates.action.replace': ['Ersetzen', 'Replace'],
  'certificates.action.remove': ['Entfernen', 'Remove'],
  'certificates.actions.replace': ['Zertifikat {name} ersetzen', 'Replace certificate {name}'],
  'certificates.actions.remove': ['Zertifikat {name} entfernen', 'Remove certificate {name}'],
  'certificates.empty.title': ['Noch kein eigenes Zertifikat', 'No own certificate yet'],
  'certificates.empty.text': [
    'Lad ein Zertifikat mit seinem privaten Schlüssel hoch, dann liefert der Proxy es aus.',
    'Upload a certificate with its private key, and the proxy serves it.',
  ],
  'certificates.added': [
    'Zertifikat „{name}“ hinzugefügt. Der Proxy übernimmt es in wenigen Sekunden.',
    'Certificate “{name}” added. The proxy takes it over within a few seconds.',
  ],
  'certificates.replaced': [
    'Zertifikat „{name}“ ersetzt. Der Proxy übernimmt das neue in wenigen Sekunden.',
    'Certificate “{name}” replaced. The proxy takes the new one over within a few seconds.',
  ],
  'certificates.removed': ['Zertifikat „{name}“ entfernt.', 'Certificate “{name}” removed.'],
  'certificates.remove.title': ['Zertifikat entfernen', 'Remove certificate'],
  'certificates.remove.question': [
    'Zertifikat „{name}“ entfernen?',
    'Remove certificate “{name}”?',
  ],
  'certificates.remove.hosts': [
    'Diese Adressen verlieren es: {hosts}.',
    'These addresses lose it: {hosts}.',
  ],
  'certificates.remove.then.acme': [
    'Der Proxy holt für sie danach ein Zertifikat von Let’s Encrypt.',
    'The proxy then fetches a certificate from Let’s Encrypt for them.',
  ],
  'certificates.remove.then.default': [
    'Sie bekommen danach das selbstsignierte Zertifikat des Proxys – Browser warnen davor.',
    'They then get the proxy’s self-signed certificate – browsers warn about it.',
  ],
  'certificates.remove.unused': [
    'Keine Adresse dieser Installation verwendet es.',
    'No address of this installation uses it.',
  ],
  'certificates.remove.confirm': ['Zertifikat entfernen', 'Remove certificate'],

  // ── The addresses of the installation ────────────────────────────────
  'certificates.hosts.title': ['Adressen dieser Installation', 'Addresses of this installation'],
  'certificates.hosts.text': [
    'Womit der Proxy gerade für jede Adresse antwortet. „Neu prüfen“ fragt ihn noch einmal.',
    'What the proxy answers with for each address right now. “Check again” asks it once more.',
  ],
  'certificates.hosts.refresh': ['Neu prüfen', 'Check again'],
  'certificates.hosts.col.host': ['Adresse', 'Address'],
  'certificates.hosts.col.purpose': ['Verwendung', 'Used for'],
  'certificates.hosts.col.served': ['Ausgeliefert wird', 'Served'],
  'certificates.purpose.velydock': ['Velydock', 'Velydock'],
  'certificates.purpose.keycloak': ['Anmeldung', 'Sign-in'],
  'certificates.purpose.sandbox': ['Eigene Apps', 'Own apps'],
  'certificates.purpose.apps': ['Veröffentlichte Apps', 'Published apps'],
  'certificates.purpose.app': ['App „{label}“', 'App “{label}”'],
  'certificates.served.own': ['eigenes Zertifikat', 'own certificate'],
  'certificates.served.other': ['Aussteller: {issuer}', 'Issuer: {issuer}'],
  'certificates.served.otherUnnamed': ['ein anderes Zertifikat', 'another certificate'],
  'certificates.served.default': [
    'kein Zertifikat – Browser warnen',
    'no certificate – browsers warn',
  ],
  'certificates.served.unreachable': ['Proxy antwortet nicht', 'Proxy does not answer'],
  'certificates.served.unknown': ['nicht prüfbar', 'cannot be checked'],
  'certificates.served.mismatch': [
    'gilt nicht für diese Adresse – Browser warnen',
    'not valid for this address – browsers warn',
  ],
  'certificates.served.pending': [
    'Der Proxy übernimmt „{name}“ in wenigen Sekunden.',
    'The proxy takes over “{name}” within a few seconds.',
  ],
  'certificates.served.shadowed': [
    'Der Proxy hält für diesen Namen noch ein Zertifikat, das er selbst geholt hat. Welches von beiden er ausliefert, ist nicht verlässlich – auch wenn es gerade das richtige ist. Damit „{name}“ sicher gilt, muss das geholte auf dem Server entfernt werden: Betriebshandbuch, Abschnitt „Zertifikate (TLS)“.',
    'For this name the proxy still holds a certificate it fetched itself. Which of the two it serves is not reliable – even if it is the right one at the moment. For “{name}” to apply for sure, the fetched one has to be removed on the server: operations manual (Betriebshandbuch), section “Zertifikate (TLS)”.',
  ],
  'certificates.served.expected': ['Vorgesehen: „{name}“', 'Meant for it: “{name}”'],
  'certificates.hosts.unreachable.title': [
    'Der mitgelieferte Proxy antwortet nicht',
    'The bundled proxy does not answer',
  ],
  'certificates.hosts.unreachable.text': [
    'Läuft Velydock hinter einem eigenen Reverse-Proxy, wirken hochgeladene Zertifikate dort nicht: Hinterleg das Zertifikat an deinem Proxy. Sonst prüf, ob der Proxy von Velydock läuft.',
    'If Velydock runs behind a reverse proxy of your own, uploaded certificates have no effect there: install the certificate at your proxy. Otherwise check whether Velydock’s proxy is running.',
  ],
  'certificates.hosts.unknown': [
    'Nicht prüfbar heißt: Diese Installation kann den Proxy nicht fragen, weil VELYDOCK_PROXY_TLS_ADDRESS nicht gesetzt ist.',
    'Cannot be checked means: this installation cannot ask the proxy, because VELYDOCK_PROXY_TLS_ADDRESS is not set.',
  ],
  'certificates.hosts.stalled': [
    'Der Proxy liefert noch nicht überall aus, was gespeichert ist. Prüf es gleich noch einmal. Bleibt es dabei, steht im Log des Proxys, warum er ein Zertifikat nicht lädt.',
    'The proxy does not serve everywhere yet what is stored. Check again in a moment. If it stays like this, the log of the proxy says why it does not load a certificate.',
  ],

  // ── The dialog ───────────────────────────────────────────────────────
  'certificates.replace.title': ['Zertifikat „{name}“ ersetzen', 'Replace certificate “{name}”'],
  'certificates.replace.text': [
    'Das neue Zertifikat tritt an die Stelle des bisherigen, zum Beispiel nach einer Verlängerung. Der Eintrag bleibt derselbe.',
    'The new certificate takes the place of the present one, for example after a renewal. The entry stays the same.',
  ],
  'certificates.name.hint': [
    'Unter diesem Namen steht das Zertifikat in der Liste, zum Beispiel „Wildcard example.com“.',
    'The certificate is listed under this name, for example “Wildcard example.com”.',
  ],
  'certificates.format.label': ['Format', 'Format'],
  'certificates.format.pem': ['PEM (Text)', 'PEM (text)'],
  'certificates.format.pkcs12': ['PKCS#12 (.p12, .pfx)', 'PKCS#12 (.p12, .pfx)'],
  'certificates.certificate.label': ['Zertifikat', 'Certificate'],
  'certificates.certificate.hint': [
    'Als PEM, zusammen mit den Zertifikaten des Ausstellers (der Kette); die Reihenfolge ist egal. Die Datei darf auch den privaten Schlüssel enthalten – dann bleibt das nächste Feld leer.',
    'As PEM, together with the certificates of its issuer (the chain); the order does not matter. The file may also contain the private key – then the next field stays empty.',
  ],
  'certificates.certificate.file': ['Zertifikatsdatei wählen', 'Choose certificate file'],
  'certificates.key.label': ['Privater Schlüssel', 'Private key'],
  'certificates.key.hint': [
    'Als PEM. Velydock speichert ihn und zeigt ihn nie wieder an.',
    'As PEM. Velydock stores it and never shows it again.',
  ],
  'certificates.key.file': ['Schlüsseldatei wählen', 'Choose key file'],
  'certificates.passphrase.label': ['Passphrase', 'Passphrase'],
  'certificates.passphrase.hint.pem': [
    'Nur nötig, wenn der private Schlüssel mit einer Passphrase geschützt ist. Gespeichert wird sie nicht.',
    'Only needed if a passphrase protects the private key. It is not stored.',
  ],
  'certificates.passphrase.hint.needed': [
    'Dieser Schlüssel ist mit einer Passphrase geschützt: Ohne sie lässt er sich nicht lesen. Gespeichert wird sie nicht.',
    'A passphrase protects this key: it cannot be read without it. It is not stored.',
  ],
  'certificates.passphrase.hint.pkcs12': [
    'Die Passphrase der Datei. Leer lassen, wenn sie keine hat. Gespeichert wird sie nicht.',
    'The passphrase of the file. Leave empty if it has none. It is not stored.',
  ],
  'certificates.pkcs12.label': ['PKCS#12-Datei', 'PKCS#12 file'],
  'certificates.pkcs12.hint': [
    'Eine .p12- oder .pfx-Datei mit Zertifikat, Kette und privatem Schlüssel, höchstens 96 KB.',
    'A .p12 or .pfx file with certificate, chain and private key, at most 96 KB.',
  ],
  'certificates.pkcs12.file': ['Datei wählen', 'Choose file'],
  'certificates.pkcs12.chosen': ['Gewählt: {name} ({size} KB)', 'Chosen: {name} ({size} KB)'],
  'certificates.replaceOther': ['Stattdessen „{name}“ ersetzen', 'Replace “{name}” instead'],

  // ── What is wrong with an upload: `certificates.error.<code of the API>` ──
  'certificates.error.certificate_missing': [
    'Kein Zertifikat gefunden. Erwartet wird PEM: Text, der mit -----BEGIN CERTIFICATE----- beginnt.',
    'No certificate found. Expected is PEM: text that starts with -----BEGIN CERTIFICATE-----.',
  ],
  'certificates.error.certificate_missing.pkcs12': [
    'Wähl eine .p12- oder .pfx-Datei mit Zertifikat und privatem Schlüssel.',
    'Choose a .p12 or .pfx file with certificate and private key.',
  ],
  'certificates.error.certificate_unreadable': [
    'Eines der Zertifikate lässt sich nicht lesen. Prüf, ob der Text vollständig ist.',
    'One of the certificates cannot be read. Check that the text is complete.',
  ],
  'certificates.error.key_missing': [
    'Kein privater Schlüssel gefunden. Erwartet wird PEM: Text, der mit -----BEGIN PRIVATE KEY----- beginnt, hier oder beim Zertifikat.',
    'No private key found. Expected is PEM: text that starts with -----BEGIN PRIVATE KEY-----, here or with the certificate.',
  ],
  'certificates.error.key_missing.pkcs12': [
    'Die Datei enthält keinen privaten Schlüssel.',
    'The file holds no private key.',
  ],
  'certificates.error.key_unreadable': [
    'Der private Schlüssel lässt sich nicht lesen. Prüf, ob der Text vollständig ist.',
    'The private key cannot be read. Check that the text is complete.',
  ],
  'certificates.error.key_encrypted': [
    'Der private Schlüssel ist mit einer Passphrase geschützt. Gib sie hier ein.',
    'A passphrase protects the private key. Enter it here.',
  ],
  'certificates.error.passphrase_wrong': [
    'Mit dieser Passphrase lässt sich der private Schlüssel nicht öffnen.',
    'This passphrase does not open the private key.',
  ],
  'certificates.error.key_mismatch': [
    'Der private Schlüssel gehört nicht zu diesem Zertifikat.',
    'The private key does not belong to this certificate.',
  ],
  'certificates.error.key_unsupported': [
    'Diese Art von Schlüssel nehmen Browser nicht an. Möglich sind RSA mit 2048 bis 8192 Bit und ECDSA mit P-256 oder P-384.',
    'Browsers do not accept this kind of key. Possible are RSA with 2048 to 8192 bits and ECDSA with P-256 or P-384.',
  ],
  'certificates.error.several_keys': [
    'Hier steht mehr als ein privater Schlüssel. Erwartet wird genau einer.',
    'There is more than one private key here. Exactly one is expected.',
  ],
  'certificates.error.too_many_certificates': [
    'Das sind mehr als 10 Zertifikate. Gib nur das Zertifikat und die seiner Aussteller an.',
    'These are more than 10 certificates. Give the certificate and those of its issuers only.',
  ],
  'certificates.error.too_large': [
    'Zu groß für ein Zertifikat: Möglich sind hier höchstens {max} KB.',
    'Too large for a certificate: at most {max} KB are possible here.',
  ],
  'certificates.error.no_names': [
    'Das Zertifikat nennt keinen Hostnamen (kein Subject Alternative Name). Browser nehmen so ein Zertifikat nicht an.',
    'The certificate names no host (no subject alternative name). Browsers do not accept such a certificate.',
  ],
  'certificates.error.expired': [
    'Dieses Zertifikat ist am {date} abgelaufen.',
    'This certificate expired on {date}.',
  ],
  'certificates.error.expired.undated': [
    'Dieses Zertifikat ist abgelaufen.',
    'This certificate has expired.',
  ],
  'certificates.error.not_yet_valid': [
    'Dieses Zertifikat gilt erst ab dem {date}. Hinterlege es an diesem Tag: Der Proxy würde es sofort ausliefern, und Browser lehnen es bis dahin ab.',
    'This certificate is valid from {date} only. Store it on that day: the proxy would serve it at once, and browsers refuse it until then.',
  ],
  'certificates.error.not_yet_valid.undated': [
    'Dieses Zertifikat ist noch nicht gültig. Hinterlege es, sobald es gilt.',
    'This certificate is not valid yet. Store it once it is.',
  ],
  'certificates.error.common_name_not_listed': [
    'Der „Common Name“ {name} steht nicht unter den Namen, für die das Zertifikat gilt. Der Proxy würde es für {name} ausliefern, und Browser lehnten es dort ab.',
    'The common name {name} is not among the names the certificate is valid for. The proxy would serve it for {name}, and browsers would refuse it there.',
  ],
  'certificates.error.common_name_not_listed.unnamed': [
    'Der „Common Name“ des Zertifikats steht nicht unter den Namen, für die es gilt. Der Proxy würde es für diesen Namen ausliefern, und Browser lehnten es dort ab.',
    'The common name of the certificate is not among the names it is valid for. The proxy would serve it for that name, and browsers would refuse it there.',
  ],
  'certificates.error.pkcs12_unreadable': [
    'Die Datei lässt sich nicht lesen: Sie ist beschädigt, oder die Passphrase stimmt nicht.',
    'The file cannot be read: it is damaged, or the passphrase is not the right one.',
  ],
  'certificates.error.ambiguous': [
    'Entweder eine PKCS#12-Datei oder Zertifikat und Schlüssel als PEM, nicht beides.',
    'Either a PKCS#12 file or certificate and key as PEM, not both.',
  ],
  'certificates.error.validation': [
    'Diese Eingabe nimmt der Server nicht an.',
    'The server does not accept this input.',
  ],
  'certificates.error.names_taken': [
    'Für {names} ist schon das Zertifikat „{certificate}“ gespeichert. Ein Name darf nur in einem gespeicherten Zertifikat stehen: Ersetz „{certificate}“, statt ein zweites hinzuzufügen.',
    'The certificate “{certificate}” is stored for {names} already. A name may be in one stored certificate only: replace “{certificate}” instead of adding a second one.',
  ],
  'certificates.error.names_taken.unnamed': [
    'Für mindestens einen dieser Namen ist schon ein Zertifikat gespeichert. Ersetz das, statt ein zweites hinzuzufügen.',
    'A certificate is stored for at least one of these names already. Replace that one instead of adding a second one.',
  ],
  'certificates.error.certificate_exists': [
    'Genau dieses Zertifikat ist schon gespeichert.',
    'Exactly this certificate is stored already.',
  ],
  'certificates.error.name_taken': [
    'Ein Zertifikat mit diesem Namen gibt es schon.',
    'A certificate with this name exists already.',
  ],
  'certificates.error.certificates_unavailable': [
    'Diese Installation kann gerade keine eigenen Zertifikate ausliefern. Lade die Seite neu: Dort steht, was fehlt.',
    'This installation cannot serve own certificates at the moment. Reload the page: it says what is missing.',
  ],
  'certificates.error.not_pem': [
    'In dieser Datei steht kein PEM-Text (-----BEGIN …-----). Eine .p12- oder .pfx-Datei lädst du über „PKCS#12“ hoch.',
    'There is no PEM text (-----BEGIN …-----) in this file. A .p12 or .pfx file is uploaded through “PKCS#12”.',
  ],
  'certificates.error.file_unreadable': [
    'Die Datei ließ sich nicht lesen. Wähl sie noch einmal.',
    'The file could not be read. Choose it again.',
  ],
} satisfies Messages;
