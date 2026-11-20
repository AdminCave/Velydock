# Bekannte Einschränkungen

Stand: Version 0.1. Was hier steht, ist nicht umgesetzt oder nur mit den genannten Grenzen.

## Sicherheitsrelevant

| Einschränkung | Folge | Umgang |
|---|---|---|
| **Gemeinsamer Realm: jeder Benutzer kann sich an jedem OIDC-Client anmelden.** | Eine per SSO angebundene App eines Kunden akzeptiert ohne weitere Konfiguration auch Benutzer anderer Mandanten. | Den Client auf die Organization beschränken ([sso.md](sso.md#apps-eines-einzelnen-kunden-abgrenzen)). Velydock richtet das nicht automatisch ein. |
| **Benutzernamen und E-Mail-Adressen sind über alle Mandanten eindeutig.** | Beim Anlegen erfährt ein Mandantenadministrator, dass ein Name oder eine Adresse bereits irgendwo vergeben ist. | Bei Bedarf Namensschema je Kunde verwenden (z. B. `kunde.vorname`). |
| **Eine Passwort-Richtlinie für alle Mandanten.** | Einzelne Kunden können keine strengere Richtlinie bekommen. | Die Richtlinie in Keycloak für alle anheben. |
| **Der Heimat-Mandant beherrscht die Identität.** | Administratoren des Heimat-Mandanten können das Passwort einer Person zurücksetzen, die in anderen Mandanten Gast ist, und damit deren Gastzugänge nutzen. | Gäste nur aus vertrauenswürdigen Mandanten zulassen; Gastmitgliedschaften vergibt nur der Systemadministrator. |
| **Zwei-Faktor wird nur für Rollen mit Verwaltungsrechten erzwungen.** | Mitglieder können sich ohne zweiten Faktor anmelden. | Für alle erzwingen: in Keycloak die Aktion „Configure OTP“ als Standard setzen. |
| **Der Dienstzugang von Velydock kann jedes Benutzerpasswort zurücksetzen.** | Wer den Velydock-Container übernimmt, kann alle Konten des Realms übernehmen. | Bauartbedingt für eine Benutzerverwaltung. Der Zugang ist nur im internen Netz nutzbar. |
| **Der Bootstrap-Zugang im Realm `master` bleibt nach der Installation bestehen.** | Wer `.env` lesen kann, hat volle Kontrolle über Keycloak – allerdings nur aus dem internen Netz. | `.env` schützen. Der Zugang wird für `keycloak-admin` und den Tausch des Dienstzugang-Geheimnisses gebraucht. |
| **Einbettungsprüfung mit `VELYDOCK_EMBED_CHECK_ALLOW_PRIVATE=true`.** | Mandantenadministratoren können erkennen, ob interne Adressen antworten und welche Framing-Header sie senden. | Standard ist `false`. |
| **Eigene Apps können täuschend echte Inhalte zeigen.** | Eine eigene App könnte eine Anmeldemaske nachbilden. | Nur Administratoren legen eigene Apps an; Änderungen stehen im Protokoll. |
| **Keine Ratenbegrenzung im Backend selbst.** | Ohne den mitgelieferten Traefik fehlt die Begrenzung der API-Anfragen. | Im eigenen Reverse Proxy einrichten. |

## Funktional

- **Apps werden nicht automatisch als OIDC-Clients angelegt.** Die Anbindung per SSO geschieht in
  Keycloaks Konsole.
- **Keine Provisionierung in angebundene Apps.** Benutzer und Gruppen werden nicht nach Nextcloud,
  mailcow usw. übertragen. Gruppen stehen nicht als Token-Claim zur Verfügung.
- **LDAP/AD und externe Identity Provider** werden in Keycloak eingerichtet, nicht in Velydock.
  Daraus stammende Identitäten erscheinen bei der ersten Anmeldung ohne Organisation; die Zuordnung
  nimmt ein Systemadministrator von Hand vor.
- **Eingebettete Apps unter fremder Domain** funktionieren wegen der Cookie-Regeln der Browser
  nicht zuverlässig ([anwendungsintegration.md](anwendungsintegration.md)). Velydock ist nur unter
  einer Adresse erreichbar; mandanteneigene Adressen gibt es nicht.
- **Kein eingebauter App-Proxy.** Velydock entfernt keine Framing-Verbote fremder Anwendungen und
  schützt keine Apps ohne eigene Anmeldung.
- **Vorhandene Benutzer fügt nur der Systemadministrator weiteren Organisationen hinzu.** Eine
  Einladung durch Mandantenadministratoren gibt es nicht.
- **Feste Rollen.** Eigene Rollen lassen sich nicht definieren.
- **Die Reihenfolge der Apps legt der Administrator fest.** Benutzer können sie nicht selbst ändern.
- **Eigene Apps bestehen aus einem Dokument** ohne Dateien, ohne Speicher und ohne Schnittstelle
  zu Velydock.
- **Login-Theme und Sprache der Anmeldeseite** gelten für alle Mandanten. Die Oberfläche gibt es
  auf Deutsch und Englisch.
- **E-Mail:** Velydock selbst verschickt nichts. Passwort-Links und „Passwort vergessen“ versendet
  Keycloak, sobald ein SMTP-Server eingetragen ist.

## Betrieb

- **Eine Instanz.** Mehrere parallele `velydock`-Container und Keycloak im Cluster sind nicht
  getestet.
- **Kein Zurückrollen von Datenbankmigrationen** durch das Produkt. Vor Updates sichern.
- **Keycloak-Updates** sind Aufgabe des Betreibers (Versionsnummer in `docker-compose.yml`).
- **Der Zugang zu Keycloaks Konsole** führt über einen SSH-Tunnel ([betrieb.md](betrieb.md)).

## Nicht automatisiert getestet

- Die Anbindung konkreter Produkte (Nextcloud, OpenProject, mailcow, SOGo) per OIDC.
- LDAP/AD-Föderation und externe Identity Provider.
- Der Versand von E-Mails über einen echten SMTP-Server.
- Let's-Encrypt-Zertifikate (die Tests laufen mit Traefiks selbstsigniertem Zertifikat).
- Andere Browser als Chromium.
- Der Betrieb hinter einem fremden Reverse Proxy.
