# Bekannte Einschränkungen

Stand: Version 0.1. Was hier steht, ist nicht umgesetzt oder nur mit den genannten Grenzen.

## Sicherheitsrelevant

| Einschränkung | Folge | Umgang |
|---|---|---|
| **Gemeinsamer Realm: jeder Benutzer kann sich an jedem OIDC-Client anmelden.** | Eine per SSO angebundene App eines Kunden akzeptiert ohne weitere Konfiguration auch Benutzer anderer Mandanten. | Den Client auf die Organization beschränken ([sso.md](sso.md#apps-eines-einzelnen-kunden-abgrenzen)). Velydock richtet das nicht automatisch ein. |
| **Benutzernamen und E-Mail-Adressen sind über alle Mandanten eindeutig.** | Beim Anlegen erfährt ein Mandantenadministrator, dass ein Name oder eine Adresse bereits irgendwo vergeben ist. | Bei Bedarf Namensschema je Kunde verwenden (z. B. `kunde.vorname`). |
| **Eine Passwort-Richtlinie für alle Mandanten.** | Einzelne Kunden können keine strengere Richtlinie bekommen. | Die Richtlinie in Keycloak für alle anheben ([betrieb.md](betrieb.md#zugang-zur-keycloak-verwaltung)). Velydock setzt beim Anlegen des Realms nur den Ausgangswert (mindestens 12 Zeichen, keines der letzten drei Passwörter) und ändert eine vom Betreiber angepasste Richtlinie danach nicht mehr. |
| **Der Heimat-Mandant beherrscht die Identität.** | Administratoren des Heimat-Mandanten können das Passwort einer Person zurücksetzen, die in anderen Mandanten Gast ist, und damit deren Gastzugänge nutzen. | Gäste nur aus vertrauenswürdigen Mandanten zulassen; Gastmitgliedschaften vergibt nur der Systemadministrator. |
| **Zwei-Faktor wird nur für Rollen mit Verwaltungsrechten erzwungen.** | Mitglieder können sich ohne zweiten Faktor anmelden. | Für alle erzwingen: in Keycloak die Aktion „Configure OTP“ als Standard setzen. |
| **Der Leerlauf-Ablauf verlangt kein neues Passwort.** | Nach 120 Minuten ohne Aktivität endet die Velydock-Session, die Keycloak-Sitzung besteht aber bis zu 12 Stunden. Wer an einen verlassenen, nicht gesperrten Rechner kommt, ist mit einem Klick auf „Anmelden“ wieder drin – und ein sichtbares Velydock-Fenster mit Fokus hält die Session ohnehin aktiv. | Beim Verlassen des Platzes abmelden oder den Bildschirm sperren. „Abmelden“ beendet beide Sitzungen. Kürzere Zeiten: `VELYDOCK_SESSION_MAX_HOURS` senken. |
| **Der Dienstzugang von Velydock kann jedes Benutzerpasswort zurücksetzen.** | Wer den Velydock-Container übernimmt, kann alle Konten des Realms übernehmen. | Bauartbedingt für eine Benutzerverwaltung. Der Zugang ist nur im internen Netz nutzbar. |
| **Der Bootstrap-Zugang im Realm `master` bleibt nach der Installation bestehen.** | Wer `.env` lesen kann, hat volle Kontrolle über Keycloak – allerdings nur aus dem internen Netz. | `.env` schützen. Der Zugang wird für `keycloak-admin` und den Tausch des Dienstzugang-Geheimnisses gebraucht; sein eigenes Geheimnis muss in `.env` stehen bleiben und lässt sich dort nicht tauschen ([installation.md](installation.md#geheimnisse-tauschen)). |
| **Einbettungsprüfung mit `VELYDOCK_EMBED_CHECK_ALLOW_PRIVATE=true`.** | Mandantenadministratoren können erkennen, ob interne Adressen antworten und welche Framing-Header sie senden. | Standard ist `false`. |
| **Eigene Apps können täuschend echte Inhalte zeigen.** | Eine eigene App könnte eine Anmeldemaske nachbilden. | Nur Administratoren legen eigene Apps an; Änderungen stehen im Protokoll. |
| **„Netzwerkzugriff aus“ schließt nicht jeden Kanal.** | Eine eigene App ohne Netzwerkzugriff kann nichts laden, nichts per `fetch`, Formular oder Fenster senden und sich nicht auf eine fremde Adresse umleiten. Über WebRTC und Verbindungshinweise kann sie aber kleine Datenmengen nach außen geben; das lässt sich mit Browser-Mitteln nicht unterbinden. | Eigene Apps nur von Administratoren; nichts Vertrauliches in Apps eingeben, deren Code man nicht kennt. |
| **Apps unter derselben Domain können die Anmeldung beeinflussen.** | Eine böswillige oder übernommene App unter einer Schwester-Subdomain (`app.example.com` neben `dock.example.com`) kann Cookies für die ganze Domain setzen und einem Besucher so eine fremde Keycloak-Sitzung unterschieben; er wäre dann als jemand anderes angemeldet. Velydocks eigenes Session-Cookie ist davor geschützt, Keycloaks Cookies nicht. | Unter die Domain von Velydock nur Apps stellen, deren Betreiber man vertraut; fremde Apps als „Neuer Tab“ unter eigener Domain einbinden. |
| **Der Brute-Force-Schutz lässt sich gegen Benutzer wenden.** | Acht Fehlversuche sperren ein Konto für kurze Zeit. Wer einen Benutzernamen kennt, kann dieses Konto von außen wiederholt aussperren. Die Anmeldeseite verrät außerdem, wenn ein Konto deaktiviert ist. | Die Drosselung der Anmelde-Adressen am Proxy bremst massenhaftes Raten, verhindert acht Fehlversuche aber nicht. Die Schwellen lassen sich in Keycloak ändern. Für Administratoren keine erratbaren Benutzernamen verwenden. |
| **Row Level Security schützt vor Programmierfehlern, nicht vor eingeschleustem SQL.** | Die Anwendung kann den Systemkontext selbst betreten und ist Eigentümerin ihrer Tabellen. Wer über ihre Datenbankverbindung beliebiges SQL ausführen könnte, erreichte alle Mandanten. | Kein aus Eingaben zusammengesetztes SQL (durchgehend gebundene Parameter); Details in [sicherheit.md](sicherheit.md#mandantentrennung). |
| **E-Mail-Adressen sind nicht bestätigt.** | Angebundene Apps erhalten `email_verified: false`, bis die Person einem Link an die Adresse gefolgt ist. Apps, die eine bestätigte Adresse verlangen, lehnen die Anmeldung sonst ab. | Einladung per E-Mail verwenden oder in Keycloak „E-Mail bestätigen“ einschalten ([sso.md](sso.md)). |
| **Ein verschickter Einladungslink lässt sich nicht zurückziehen.** | Er bleibt drei Tage gültig, auch nach „Passwort zurücksetzen“ oder „Sitzungen beenden“. | Ungültig wird er, wenn die E-Mail-Adresse des Kontos geändert, das Konto deaktiviert oder gelöscht und neu angelegt wird. |
| **Keine Ratenbegrenzung im Backend selbst.** | Ohne den mitgelieferten Traefik fehlt die Begrenzung der API-Anfragen und der Anmeldeschritte von Keycloak. | Im eigenen Reverse Proxy einrichten; die Grenzen des mitgelieferten Traefik nennt [betrieb.md](betrieb.md#eigener-reverse-proxy). |

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
- **Eine sichtbare App darf den Tastaturfokus halten.** Zieht eine App, die gerade angezeigt
  wird, den Fokus ständig an sich (manche Terminal- und Fernwartungs-Oberflächen tun das),
  schließen sich Velydocks Menüs gleich wieder. Die Einträge im Dock – Startseite, andere Apps –
  funktionieren weiter; von dort sind die Menüs wieder benutzbar.
- **Kein eingebauter App-Proxy.** Velydock entfernt keine Framing-Verbote fremder Anwendungen und
  schützt keine Apps ohne eigene Anmeldung.
- **Vorhandene Benutzer fügt nur der Systemadministrator weiteren Organisationen hinzu.** Eine
  Einladung durch Mandantenadministratoren gibt es nicht.
- **Feste Rollen.** Eigene Rollen lassen sich nicht definieren.
- **Die Reihenfolge der Apps legt der Administrator fest.** Benutzer können sie nicht selbst ändern.
- **Eigene Apps bestehen aus einem Dokument** ohne Dateien, ohne Speicher und ohne Schnittstelle
  zu Velydock.
- **Login-Theme** und die Sprache von Keycloaks E-Mails gelten für alle Mandanten. Die Oberfläche
  gibt es auf Deutsch und Englisch. Keycloaks Anmeldeseiten folgen der in Velydock gewählten
  Sprache, seine Kontoseite der Sprache des Browsers.
- **Von Keycloak verwaltete Mitgliedschaften** (Konten aus einem Identity Provider einer
  Organization oder aus einer Einladung in Keycloak) lassen sich in Velydock nicht entfernen und
  ihre E-Mail-Adresse nicht löschen: Keycloak würde dabei das Konto löschen.
- **Änderungen direkt in Keycloak** an Namen und E-Mail-Adresse übernimmt Velydock bei der
  nächsten Anmeldung der Person, nicht sofort. Gelöschte, umbenannte oder deaktivierte
  Organizations stellt Velydock beim nächsten Start wieder her
  ([betrieb.md](betrieb.md)); von Hand hinzugefügte Mitglieder entfernt es nicht.
- **E-Mail:** Velydock selbst verschickt nichts. Passwort-Links und „Passwort vergessen“ versendet
  Keycloak, sobald ein SMTP-Server eingetragen ist.

## Betrieb

- **Eine Instanz.** Mehrere parallele `velydock`-Container und Keycloak im Cluster sind nicht
  getestet.
- **Kein Zurückrollen von Datenbankmigrationen** durch das Produkt. Vor Updates sichern.
- **Jedes Update unterbricht den Betrieb für etwa eine Minute,** weil mit dem neuen
  Velydock-Image auch Keycloak neu startet ([betrieb.md](betrieb.md#update)).
- **Keycloak-Updates** sind Aufgabe des Betreibers (`KEYCLOAK_IMAGE` in `.env`,
  [betrieb.md](betrieb.md#update)).
- **Der Zugang zu Keycloaks Konsole** führt über einen SSH-Tunnel ([betrieb.md](betrieb.md)).

## Nicht automatisiert getestet

- Die Anbindung konkreter Produkte (Nextcloud, OpenProject, mailcow, SOGo) per OIDC.
- LDAP/AD-Föderation und externe Identity Provider.
- Der Versand von E-Mails über den SMTP-Server eines Anbieters mit Anmeldung und TLS. Getestet
  ist der Weg über einen lokalen Mail-Empfänger ohne beides ([tests.md](tests.md)).
- Let's-Encrypt-Zertifikate (die Tests laufen mit Traefiks selbstsigniertem Zertifikat).
- Firefox und WebKit in der CI. Die Browser-Suite läuft auf Wunsch auch in beiden
  ([tests.md](tests.md#andere-browser)) und ist dort einmal vollständig gelaufen; die CI
  prüft nur Chromium. Safari selbst (macOS, iOS) und Edge sind nicht geprüft – WebKit unter
  Linux ist dieselbe Engine wie Safari, aber nicht derselbe Browser.
- Der Betrieb hinter einem fremden Reverse Proxy.
