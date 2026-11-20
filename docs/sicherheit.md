# Sicherheitskonzept

Jede Aussage hier ist durch einen automatisierten Test belegt, sofern nicht anders vermerkt. Die
Tests stehen in [tests.md](tests.md).

## Wovor Velydock schützt

| Bedrohung | Schutz |
|---|---|
| Ein Mandant liest oder ändert Daten eines anderen | Mandant nur aus der Session; ausdrückliche Filter; Row Level Security in PostgreSQL |
| Ein Benutzer verschafft sich höhere Rechte | Rangregeln in `policy.py`; Trigger auf geschützten Spalten |
| Gestohlene oder erratene Sitzung | Zufallswert mit 256 Bit, nur als Hash gespeichert, HttpOnly, kurze Laufzeiten, sofortiges Beenden |
| Fremde Website löst Aktionen aus (CSRF) | SameSite-Cookie, Pflicht-Header, Herkunftsprüfung |
| Eingeschleustes Skript in der Oberfläche (XSS) | Strikte Content Security Policy, keine Tokens im Browser |
| Eigene Apps greifen auf Velydock zu | Fremder Hostname, Sandbox ohne eigenen Origin, keine Cookies |
| Clickjacking | `frame-ancestors 'none'` und `X-Frame-Options: DENY` |
| Server ruft interne Adressen ab (SSRF) | Einbettungsprüfung nur gegen öffentliche Adressen, Weiterleitungen nur innerhalb desselben Hosts |
| Überlastung durch einzelne Anfragen | Größenbegrenzung für Anfragen, Zeit- und Mengenbegrenzung der Einbettungsprüfung, Rate-Limit am Proxy |
| Übernahme eines Administratorkontos | Zwei-Faktor-Pflicht, Brute-Force-Schutz, kein Standardpasswort |

## Mandantentrennung

**Schicht 1 – API.** Der Mandant einer Anfrage stammt aus der Session. Es gibt keinen Parameter,
mit dem ein Client einen Mandanten benennt; unbekannte Felder werden abgelehnt. Fremde IDs liefern
`404` – dieselbe Antwort wie für nicht vorhandene. IDs fremder Gruppen oder Benutzer in sonst
gültigen Anfragen werden als unbekannt abgewiesen.

**Schicht 2 – Datenbank.** Auf jeder Tabelle ist Row Level Security aktiv und erzwungen
(`FORCE ROW LEVEL SECURITY`). Die Richtlinien lesen drei Werte, die nur für die laufende
Transaktion gelten:

| Wert | Bedeutung |
|---|---|
| `app.scope` | `tenant` (normale Anfrage), `system` (Anmeldung, Systemverwaltung, CLI) oder leer |
| `app.tenant_id` | Mandant der Anfrage |
| `app.user_id` | handelnder Benutzer |

Ohne gesetzte Werte sind alle Tabellen leer und nicht beschreibbar. Im Mandantenkontext sind nur
Zeilen des eigenen Mandanten sichtbar; Einfügen oder Verschieben in einen anderen Mandanten wird
abgelehnt. Die Werte verschwinden am Transaktionsende und können nicht über den Verbindungspool
in eine andere Anfrage gelangen.

Der Systemkontext wird im Code nur an benannten Stellen betreten (`system_scope`): bei der
Anmeldung, in der Systemverwaltung und für die globale Eindeutigkeitsprüfung von Benutzernamen.

**Schicht 3 – Trigger.** Row Level Security schützt Zeilen, nicht Spalten. Trigger verhindern
außerhalb des Systemkontexts, dass jemand sich selbst zum Systemadministrator macht, eine Identität
einem anderen Mandanten zuschiebt oder Name, Kurzname und Status eines Mandanten ändert.

Voraussetzung: Die Anwendung verbindet sich mit einer Rolle ohne Superuser- und `BYPASSRLS`-Recht.
Das Init-Skript legt sie so an.

## Rollen und Rechte

| Rolle | Darf |
|---|---|
| Mitglied | Den Workspace und die freigegebenen Apps nutzen |
| Benutzerverwalter | Zusätzlich Benutzer und Gruppen verwalten |
| Mandantenadministrator | Zusätzlich Rollen vergeben, Apps und Mandanteneinstellungen verwalten, das Protokoll lesen |
| Systemadministrator | Alles in allen Mandanten, Mandanten anlegen und löschen, Systemeinstellungen |

Zusätzliche Regeln:

- Niemand ändert die eigene Rolle, sperrt oder entfernt sich selbst – auch Systemadministratoren
  nicht. Das eigene Passwort und die eigenen Sitzungen laufen nicht über die Benutzerverwaltung,
  sondern über Keycloaks Kontoseite und „Abmelden“.
- Niemand vergibt eine Rolle oberhalb der eigenen und niemand verwaltet ein Konto mit höherem
  Rang. Ein Benutzerverwalter kann daher nicht das Passwort eines Administrators zurücksetzen und
  dessen Gruppen nicht ändern – weder in der Benutzerverwaltung noch über die Gruppe selbst.
- Profil, E-Mail, Passwort und Sperre einer Identität ändert nur der Mandant, dem sie gehört.
- Systemadministratoren sind für Mandantenadministratoren unantastbar.
- Der letzte aktive Systemadministrator kann weder sein Recht verlieren noch gesperrt oder
  gelöscht werden – auch nicht, wenn zwei Administratoren das gleichzeitig beieinander versuchen.
  Der Mandant eines Systemadministrators kann nicht gelöscht oder deaktiviert werden.
- Wer Verwaltungsrechte neu erhält, wird abgemeldet: Die Rechte gelten erst in einer neuen
  Session, an deren Beginn die Zwei-Faktor-Pflicht geprüft wird.

## Sitzungen

- Cookie `__Host-velydock_session`: HttpOnly, Secure, SameSite=Lax, ohne Domain. Das Präfix
  `__Host-` verhindert, dass ein anderer Hostname derselben Domain das Cookie überschreibt.
- In der Datenbank steht nur der SHA-256 des Cookie-Werts.
- Leerlauf- und Maximaldauer, Back-Channel-Logout, sofortiges Beenden bei Sperre oder
  Passwort-Reset ([sso.md](sso.md)).
- „Abmelden“ beendet die Keycloak-Sitzung auch dann, wenn die Velydock-Session schon abgelaufen ist.
- Nach der Abmeldung zeigt der Zurück-Knopf des Browsers keine alte Seite mit Daten: Die
  Oberfläche lädt neu, sobald der Browser sie aus seinem Seitenspeicher wiederherstellt.
- Die aktive Organisation gehört zur Session. Ein Tab, der noch eine andere anzeigt, wird von der
  API abgewiesen, statt in der falschen Organisation zu schreiben ([sso.md](sso.md), „Mehrere Tabs“).
- Die Client-Adresse im Protokoll stammt aus `X-Forwarded-For`. Geglaubt wird dem Header nur von
  Proxys in privaten Netzen (`VELYDOCK_TRUSTED_PROXIES`); was keine IP-Adresse ist, wird nicht
  gespeichert.

## CSRF

Schreibende Anfragen brauchen den Header `X-Velydock-CSRF: 1`. Fremde Seiten können ihn nicht
setzen, weil der Browser dafür eine CORS-Freigabe verlangt, die Velydock nie erteilt. Zusätzlich
werden `Origin` und `Sec-Fetch-Site` geprüft; auch der Sandbox-Hostname gilt als fremd.

## Eigene Apps

Eigener HTML-, CSS- und JavaScript-Code wird so ausgeliefert, dass er weder auf Velydock noch auf
die Anmeldedaten zugreifen kann:

1. **Eigener Hostname.** Nur `sandbox.…` liefert eigene Apps aus. Dieser Hostname hat keine API,
   keine Oberfläche, setzt keine Cookies und ignoriert mitgeschickte.
2. **CSP-Header `sandbox`** ohne `allow-same-origin`: Der Browser gibt dem Dokument einen leeren
   Origin – auch wenn jemand die Adresse direkt öffnet.
3. **iFrame-Attribut `sandbox`** mit denselben Rechten. `allow-top-navigation` fehlt: Die App kann
   die Velydock-Seite nicht durch eine andere ersetzen.
4. **Netzwerk standardmäßig zu** (`connect-src 'none'`, keine externen Skripte). „Netzwerkzugriff
   erlauben“ öffnet ausschließlich `https:`.
5. **Signierter Link, fünf Minuten gültig**, nur für Benutzer, denen die App freigegeben ist. Jede
   Änderung an der App macht alte Links ungültig.

Im Browser geprüft: kein Zugriff auf Cookies, `localStorage`, das Elternfenster oder die
Velydock-API.

Restrisiko: Eine eigene App kann Inhalte anzeigen, die wie eine Anmeldemaske aussehen. Eigene Apps
dürfen deshalb nur Administratoren anlegen; jede Änderung steht im Protokoll.

## Eingebettete fremde Apps

Eingebettete Apps laufen in ihrem eigenen Origin und unterliegen der Same-Origin-Policy. Der iFrame
verbietet ihnen, die Velydock-Seite ohne Benutzeraktion zu ersetzen. Kamera, Mikrofon,
Zwischenablage, Vollbild und Bildschirmfreigabe erhält eine App nur, wenn ein Administrator es
für sie einschaltet.

## Eingaben

- Alle Anfragen werden gegen ein Schema geprüft; unbekannte Felder führen zu einem Fehler.
- Anfragen über 4 MB werden abgewiesen, bevor sie gelesen werden – auch ohne Anmeldung.
- NUL-Zeichen werden in Adresse und Inhalt abgelehnt.
- Vor- und Nachnamen dürfen die Zeichen nicht enthalten, die auch Keycloak ablehnt
  (`< > & " $ % ! # ? § ; * ~ / \ | ^ = [ ] { } ( )`); Benutzernamen haben mindestens drei Zeichen.
- App-Adressen: nur `http`/`https`, keine Zugangsdaten in der Adresse; eingebettete Apps nur `https`.
- Icons: höchstens 256 KB; der Typ wird am Inhalt erkannt, nicht an der Angabe. Icons werden mit
  einer eigenen sandboxenden CSP ausgeliefert, sodass ein Skript in einer SVG-Datei nie läuft.
- Datenbankzugriffe verwenden ausschließlich gebundene Parameter.

## Einbettungsprüfung (SSRF)

Die Prüfung ruft eine von Administratoren eingegebene Adresse vom Server aus ab. Dabei gilt: nur
`http`/`https`, jede aufgelöste Adresse muss öffentlich sein, die Verbindung geht an genau die
geprüfte Adresse, der Inhalt wird weder gelesen noch zurückgegeben. Weiterleitungen werden nur
innerhalb desselben Hosts verfolgt (höchstens drei, an dieselbe geprüfte Adresse) – so zählt die
Seite, die der Browser am Ende zeigt, etwa die Anmeldeseite der App. Eine Weiterleitung auf einen
anderen Host beendet die Prüfung mit „ungeprüft“.

Eine Prüfung dauert höchstens zwölf Sekunden, und es laufen höchstens drei gleichzeitig; weitere
enden sofort mit „ungeprüft“. Ohne diese Grenzen könnte eine Seite, die ihre Antwort tröpfchenweise
sendet, Datenbankverbindungen der ganzen Installation binden.

Private Netze lassen sich mit `VELYDOCK_EMBED_CHECK_ALLOW_PRIVATE=true` freigeben;
dann können Mandantenadministratoren erkennen, ob interne Adressen antworten.

## Administration

- Kein Standardpasswort. `velydock setup-admin` erzeugt ein Einmalpasswort, das einmal angezeigt
  wird und bei der ersten Anmeldung geändert werden muss.
- Zwei-Faktor-Pflicht für alle Rollen mit Verwaltungsrechten (abschaltbar).
- Einmalpasswörter neuer Benutzer werden einmal angezeigt und nirgends gespeichert.
- Das Protokoll ist nur anfügbar: Für Ändern und Löschen existiert keine Datenbank-Richtlinie.
- Keycloaks Verwaltungsoberfläche, Admin-API und der Realm `master` sind von außen nicht
  erreichbar; Traefik leitet nur `/realms/velydock/` und `/resources/` weiter.

## Keycloak

- Der Dienstzugang von Velydock hat nur die Rollen, die er braucht (Benutzer, Organizations,
  Realm-Einstellungen, eigene Clients) – nicht `realm-admin`, nicht Impersonation.
- Realm: Registrierung aus, Brute-Force-Schutz an, Passwörter mindestens 12 Zeichen und weder
  Benutzername noch E-Mail, Anmeldeereignisse 30 Tage. Passwort-Richtlinie und Schwellenwerte des
  Brute-Force-Schutzes sind Ausgangswerte beim Anlegen des Realms; wer sie in Keycloak verschärft,
  behält seine Einstellung.
- Die E-Mail-Adresse ändern nur Administratoren. Eine selbst geänderte Adresse könnte in
  angebundenen Apps zur Übernahme fremder Konten führen.

## Container

Kein Dienst läuft privilegiert, alle mit `no-new-privileges`. `velydock` läuft als eigener
Benutzer ohne Capabilities auf schreibgeschütztem Dateisystem. Der Dienst `theme` läuft bei jedem
Start einmal kurz als root und ohne Netzwerk: Er kopiert das Login-Theme in ein Volume und setzt
dort die Dateirechte. Traefik hat keinen Zugriff auf den Docker-Socket. PostgreSQL ist nur im
internen Netz erreichbar. Python-Abhängigkeiten sind mit Hashes festgeschrieben.

## Sicherheitsrelevante Einschränkungen

Siehe [einschraenkungen.md](einschraenkungen.md).
