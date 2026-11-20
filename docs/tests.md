# Tests

Vier Ebenen, alle automatisiert und in der CI. Stand der Zahlen: Version 0.1, Lauf vom 20.11.2026.

| Ebene | Werkzeug | Umfang | Braucht |
|---|---|---|---|
| Unit-Tests Backend | pytest | 265 Tests | nichts |
| Integrationstests Backend | pytest gegen PostgreSQL | 206 Tests | PostgreSQL |
| Integration mit Keycloak | pytest gegen Keycloak | 26 Tests | Keycloak, Mail-Empfänger |
| Unit-Tests Frontend | Vitest, Testing Library | 331 Tests | nichts |
| Browser-Tests (End-to-End) | Playwright, Chromium | 64 Tests | kompletter Stack |
| Backup und Wiederherstellung | Shell-Skript | 1 Rundlauf | kompletter Stack |
| Installation nach Anleitung | Shell-Skript und Playwright | 1 Durchlauf | Image `velydock:dev` |

## Ausführen

```bash
# Backend (PostgreSQL, Keycloak und Mail-Empfänger des Entwicklungs-Stacks müssen laufen)
./scripts/dev-stack.sh up -d --no-deps --wait postgres keycloak mail
cd backend && .venv/bin/pytest -q

# Frontend
cd frontend && npm run check && npm run lint && npm run test:unit

# Browser-Tests: setzt den Entwicklungs-Stack zurück, baut neu, testet
./scripts/tests/e2e.sh

# Backup und Wiederherstellung am laufenden Entwicklungs-Stack
./scripts/tests/backup-restore.sh

# Installation nach Anleitung mit der Produktiv-Compose-Datei (eigener, kurzlebiger Stack)
./scripts/tests/install-smoke.sh
```

Einrichtung der Umgebung: [entwicklung.md](entwicklung.md).

## Wie getestet wird

- **Echte Datenbank.** Row Level Security lässt sich nur mit PostgreSQL prüfen. Die
  Integrationstests legen je Lauf eine eigene Datenbank an, die – wie im Betrieb – einer Rolle ohne
  Superuser- und `BYPASSRLS`-Recht gehört.
- **Echte Protokolle.** Für die Anmeldung simuliert ein kleiner OpenID-Provider
  (`tests/support/mini_idp.py`) nur die Gegenseite; er signiert echte RS256-Tokens, sodass der
  produktive Prüfcode unverändert läuft.
- **Echtes Keycloak.** Eine eigene Suite richtet in einem laufenden Keycloak einen Realm ein, prüft
  die Admin-API-Anbindung und klickt sich wie ein Benutzer durch Keycloaks Anmeldeseiten bis in
  Velydocks Callback – einschließlich erzwungenem Passwortwechsel und Einrichtung einer
  Authenticator-App. Sie prüft außerdem, dass Velydocks eigene Eingaberegeln (Benutzernamen,
  Zeichen in Namen) mit denen von Keycloak übereinstimmen.
- **Echte E-Mail.** Der Entwicklungs-Stack enthält einen Mail-Empfänger (Mailpit). Die Tests
  lassen Keycloak die Einladung dorthin schicken, lesen sie aus und folgen dem Link wie die
  eingeladene Person: Passwort setzen, zurück zu Velydock, anmelden.
- **Echter Stack im Browser.** Die Playwright-Tests laufen gegen die Compose-Installation mit
  Traefik und TLS. Sie richten sie ein wie ein Betreiber: `setup-admin`, erste Anmeldung mit
  Passwortwechsel, Organisationen, Benutzer, Apps. Nichts ist gemockt, mit einer Ausnahme: Für die
  Anzeige „App lässt sich nicht einbetten“ wird der Prüfstatus in der API-Antwort ersetzt.
- **Missbrauch statt nur Gutfall.** Sicherheitsregeln werden mit Tests belegt, die den Angriff
  versuchen: fremde IDs, gefälschte Tokens, eingeschleuste Felder, Selbstbeförderung.

## Die geforderten Testfälle

| Nr. | Testfall | Backend | Browser |
|---|---|---|---|
| 1 | Ein Administrator kann einen Benutzer erstellen | `test_users_api.py::TestCreate`, `keycloak/…::TestInvitationEmail` | `05-administration`: „legt einen Benutzer an, der sich danach anmelden kann“, „… setzt die neue Person ihr Passwort über den Link aus der E-Mail“ |
| 2 | Ein Benutzer kann sich anmelden | `test_auth_flow.py::TestSignIn`, `keycloak/…::TestBrowserSignIn` | `01-auth`: „meldet sich über Keycloak an und wieder ab“ |
| 3 | Ein Administrator kann Gruppen verwalten | `test_groups_apps_api.py::TestGroups` | `05-administration`: „verwaltet Gruppen“ |
| 4 | Anwendungen können erstellt und bearbeitet werden | `test_groups_apps_api.py::TestAppAdministration` | `05-administration`: „Apps werden angelegt, … abgeschaltet und gelöscht“, „eine eigene App wird … angelegt“ |
| 5 | Anwendungen erscheinen nur bei berechtigten Benutzern | `test_groups_apps_api.py::TestWorkspace`, `test_policy.py::TestAppVisibility` | `02-workspace`: „… sieht genau die freigegebenen Apps“ |
| 6 | Mandanten können nicht auf fremde Daten zugreifen | `test_tenant_isolation.py` (36 Tests) | `06-tenant-isolation` |
| 7 | Die Navigation funktioniert an allen vier Positionen | `test_system_settings_sandbox.py::TestSettings` | `03-navigation`: je Position Lage am Bildschirmrand gemessen |
| 8 | Benutzereinstellungen bleiben gespeichert | `TestSettings::test_personal_settings_persist` | `03-navigation`: Neuladen und frisches Browserprofil |
| 9 | Benutzerdefinierte Anwendungen werden sicher isoliert | `test_embed_and_custom_apps.py::TestCustomAppLockdown`, `…::TestSandboxHost` | `04-custom-app-isolation` (7 Tests) |
| 10 | Logout und Session-Ablauf funktionieren | `test_auth_flow.py::TestSessionLifetime`, `TestSignOut`, `TestBackChannelLogout`, `test_edge_cases.py::TestSignOutWithoutALiveSession` | `01-auth`: Abmeldung, Back-Channel-Logout, Sitzungen beenden, Ablauf mit Hinweis, Abmelden nach Ablauf |
| 11 | Die Docker-Installation funktioniert | – | `08-deployment`, `scripts/tests/install-smoke.sh`, `scripts/tests/backup-restore.sh` |

## Sicherheitstests im Einzelnen

**Mandantenisolation** (`test_tenant_isolation.py`, `06-tenant-isolation`)

- Listen und Suche zeigen nur den eigenen Mandanten; fremde Benutzer-, Gruppen- und App-IDs
  liefern für jede Operation `404`, und beim anderen Mandanten ändert sich nachweislich nichts.
- Fremde IDs in sonst gültigen Anfragen (Gruppe eines anderen Mandanten an eigener App) werden
  abgewiesen. Ein mitgeschicktes `tenant_id` wird abgelehnt oder ignoriert.
- Wechsel in einen fremden Mandanten: `404`. Eine manipulierte Sitzungszeile verschafft keinen
  Zugang.
- Datenbankebene: ohne Kontext ist jede Tabelle leer; im Mandantenkontext wirken `UPDATE` und
  `DELETE` nur auf eigene Zeilen; Einfügen in fremde Mandanten, in `sessions`, `tenants` und
  `system_settings` scheitert an Row Level Security.
- Trigger: Selbstbeförderung zum Systemadministrator, Verschieben einer Identität und Ändern von
  Kurzname oder Status eines Mandanten scheitern außerhalb des Systemkontexts.
- Das Protokoll lässt sich weder ändern noch löschen – auch nicht im Systemkontext.
- Jede Tabelle hat erzwungene Row Level Security; die Anwendungsrolle kann sie nicht umgehen.
- Zwei Tabs: Zeigt ein Tab noch eine andere Organisation als die Session, wird seine Änderung
  abgewiesen und landet in keiner der beiden (`test_edge_cases.py::TestExpectedOrganization`,
  `07-system`). Der Header kann keine Organisation auswählen.

**Rollen und Berechtigungen** (`test_policy.py`, `test_users_api.py::TestRoles`)

- Rechte je Rolle; Rangregeln; niemand ändert die eigene Rolle.
- Ein Benutzerverwalter kann niemanden befördern und kein Administratorkonto übernehmen
  (Passwort, E-Mail, Sperre, Löschen).
- Mandantenadministratoren können Systemadministratoren nicht verändern; das Feld
  `is_system_admin` nimmt die Mandanten-API gar nicht an.
- Gastkonten: Der gastgebende Mandant kann nur die Mitgliedschaft beenden.
- Die Rangregel gilt auch für Gruppenmitgliedschaften, die über die Gruppe geändert werden.
- Niemand ändert die eigene Rolle; eigenes Passwort und eigene Sitzungen laufen nicht über die
  Benutzerverwaltung.
- Der letzte aktive Systemadministrator bleibt – auch bei zwei gleichzeitigen Anfragen.
- Neue Verwaltungsrechte beenden die laufenden Sessions des Kontos (`TestNewRightsNeedANewSession`,
  `01-auth`).

**Authentifizierung und Sessions** (`test_oidc.py`, `test_auth_flow.py`)

- ID-Token: falsche Signatur, unbekannter Schlüssel, `alg: none`, HMAC mit dem öffentlichen
  Schlüssel, falscher Aussteller, fremder Empfänger, abgelaufen, fehlende oder falsche `nonce`.
- Ablauf: `state` an Cookie gebunden, Code nicht wiederverwendbar, PKCE geprüft, kein Open Redirect,
  keine stillschweigende Übernahme eines vorhandenen Benutzernamens.
- Cookie-Eigenschaften; nur der Hash in der Datenbank; Leerlauf- und Maximaldauer; gestohlenes
  Cookie nach Abmeldung wertlos; deaktiviertes Konto sofort ausgesperrt.
- Back-Channel-Logout: genau die genannte Sitzung endet; gefälschte Tokens beenden nichts –
  auch nicht solche, die den echten Schlüssel mit einem anderen Verfahren benennen.
- Abmelden nach abgelaufener Session liefert weiterhin Keycloaks End-Session-Adresse.
- Anmeldung mit ungewöhnlichen Identitäten: ohne E-Mail-Adresse, mit überlangen Namen, zweimal
  gleichzeitig, mit einem Benutzernamen, den noch eine andere Zeile hält.
- CSRF: fehlender Header, fremde Herkunft (auch der Sandbox-Hostname), `Sec-Fetch-Site`.
- Reihenfolge: Jede Antwort wird erst nach dem Commit gesendet (`test_commit_order.py`).
- Halb fehlgeschlagene Änderungen (`TestHalfFailedChanges`): Eine Sperre gilt auch, wenn Keycloak
  die Sitzungen nicht beenden konnte; eine Profiländerung wird zurückgenommen, wenn der folgende
  Schritt scheitert; ein Konto, das nach dem Anlegen in Keycloak nicht gespeichert werden konnte,
  wird dort wieder entfernt; eine verwaiste Organization wird übernommen statt den Namen zu sperren.

**Unsichere Eingaben** (`test_tokens_and_validation.py`, `test_groups_apps_api.py`, `test_users_api.py`)

- Benutzernamen, E-Mail-Adressen, Kurznamen; unbekannte Felder; SQL-Sonderzeichen in der Suche.
- App-Adressen mit `javascript:`, `data:`, `file:`, Zugangsdaten; `http` bei eingebetteten Apps.
- Icons: falscher Inhalt trotz Bildtyp, zu groß, kein Base64; SVG mit Skript wird sandboxend
  ausgeliefert.
- Einbettungsprüfung, gegen einen lokalen Webserver geprüft: private Adressen, fremde Schemata,
  Weiterleitungen nur innerhalb des Hosts, mehrere Richtlinien und Header-Werte wie im Browser,
  Abbruch nach der Gesamtfrist bei einer tröpfelnden Antwort, Obergrenze gleichzeitiger Prüfungen.
- Anfragen (`test_request_guard.py`): Größenbegrenzung mit und ohne Längenangabe, NUL-Zeichen,
  unmögliche Dateinamen, Schreibweisen des Sandbox-Hostnamens, Client-Adresse aus dem Proxy-Header.
- Eingaben, die früher in einem Serverfehler endeten (`TestInputThatUsedToEndInAnError`).

**Isolation eigener Apps** (`04-custom-app-isolation`, im Browser)

- Der Frame ist eine Sandbox ohne `allow-same-origin`, kommt vom Sandbox-Host und hat kein
  `allow`-Attribut.
- Eigener Code läuft, hat aber den Origin `null` und scheitert an Cookies, `localStorage`,
  `sessionStorage`, dem Elternfenster und der Navigation der Velydock-Seite.
- Ohne Netzwerk-Option erreicht er nichts. Mit Netzwerk-Option verlassen Anfragen an die
  Velydock-API den Frame ohne Session-Cookie, und ein blinder Aufruf der Abmeldung bewirkt nichts.
- Direkt geöffnet bleibt das Dokument in der Sandbox. Gefälschte Links: `403`.
- Der Sandbox-Host beantwortet nichts außer signierten Links, auch nicht mit Session-Cookie.

**Deployment** (`08-deployment`)

- Dienste gesund; Sicherheits-Header; keine Inline-Skripte; keine Fehler und keine Anfragen an
  fremde Hosts beim Laden.
- Keycloaks Verwaltung, Admin-API und der Realm `master` sind von außen nicht erreichbar.
- Login-Theme aktiv und unter Inhalts-Hash ausgeliefert.
- Der Anwendungscontainer läuft als unprivilegierter Benutzer auf schreibgeschütztem Dateisystem;
  die Datenbankrolle hat keine Sonderrechte.
- Der Proxy begrenzt Anfragen an die API (nicht an die Oberfläche) und weist kodierte
  Schrägstriche ab; übergroße Anfragen werden abgewiesen; der Sandbox-Hostname mit Punkt am Ende
  bleibt Sandbox; `HEAD` wird beantwortet.

**Installation nach Anleitung** (`scripts/tests/install-smoke.sh`)

Folgt [installation.md](installation.md) mit der unveränderten Produktiv-Compose-Datei in einem
eigenen Stack: `install.sh` erzeugt `.env` (nur für den Besitzer lesbar, kein Geheimnis leer, kein
Überschreiben), `docker compose up -d --wait`, `velydock setup-admin`. Im Browser: Anmeldung mit dem
Einmalpasswort, erzwungener Passwortwechsel, erzwungene Einrichtung einer Authenticator-App, dann
Zugang als Systemadministrator; die erneute Anmeldung verlangt Passwort und Code, das
Einmalpasswort ist wertlos. Geprüft wird außerdem, dass weder Datenbank noch Keycloak einen Port
veröffentlichen.

**Backup und Wiederherstellung** (`scripts/tests/backup-restore.sh`)

Sichert, zerstört Daten in beiden Datenbanken, weist ein beschädigtes Backup ab, stellt wieder
her und vergleicht Zählungen, Prüfsumme der Benutzerdaten, Tabelleneigentümer und Anzahl der
Richtlinien mit dem Zustand vor dem Backup.

## Fehler, die die Tests gefunden haben

| Fehler | Gefunden durch |
|---|---|
| Antworten wurden gesendet, bevor die Transaktion abgeschlossen war; ein Lesezugriff direkt nach einer Änderung sah gelegentlich den alten Stand. | Durchklicken der Oberfläche; jetzt `test_commit_order.py` |
| Benutzer ohne E-Mail-Adresse ließen sich nicht bearbeiten: Keycloak lehnt eine leere Adresse bei Mitgliedern einer Organization ab. | Browser-Test gegen echtes Keycloak; jetzt `keycloak/…::test_every_email_transition_is_accepted` |
| Die Einbettungsprüfung meldete „nicht erreichbar“, wenn ein Hostname zuerst auf eine unerreichbare IPv6-Adresse auflöste. | Test gegen lokalen Webserver |
| Keycloak und Browser lieferten nach einer Theme-Änderung weiter die alte Datei aus. | Sichtprüfung per Screenshot; jetzt `test_theme_install.py` und `08-deployment` |
| Keycloak 26.8 lehnt Admin-API-Tokens ohne den Scope `kc-admin-api` ab. | Probe am echten Keycloak; jetzt `keycloak/…::TestRealmProvisioning` |
| Die Anmeldeseite war auf Bildschirmen ab 1200 px Breite nur halb so breit wie vorgesehen. | Installations-Rauchtest (Screenshot); jetzt `08-deployment` bei vier Breiten |

## Fehler, die eine unabhängige Durchsicht gefunden hat

Nach Fertigstellung von Version 0.1 haben vier voneinander unabhängige Durchsichten (Anmeldung
und Websicherheit, Rechte und Mandantentrennung, Oberfläche, Deployment und Dokumentation) den
Code gegen die Dokumentation geprüft. Die bestehenden Tests waren grün; gefunden wurden Fehler
abseits der getesteten Wege. Jeder ist behoben und durch einen Test belegt.

| Fehler | Jetzt geprüft durch |
|---|---|
| Der Link zum Passwort-Setzen per E-Mail funktionierte gegen echtes Keycloak nie (abgelehnte Rücksprungadresse). | `keycloak/…::TestInvitationEmail`, `05-administration` |
| Die Anmeldung endete für Identitäten ohne E-Mail-Adresse in einem Serverfehler. | `test_edge_cases.py::TestSignInWithUnusualIdentities` |
| „Abmelden“ nach abgelaufener Velydock-Session ließ die Keycloak-Sitzung bestehen. | `TestSignOutWithoutALiveSession`, `01-auth` |
| Ein Mandantenadministrator konnte mit wenigen Einbettungsprüfungen alle Datenbankverbindungen binden. | `test_embed_and_custom_apps.py::TestEmbedCheckOverHttp` |
| Die Ratenbegrenzung der API griff in üblichen Installationen nicht (Router-Priorität). | `08-deployment` |
| Ein Tab mit veralteter Organisation schrieb in die neue Organisation. | `TestExpectedOrganization`, `07-system` |
| Wer befördert wurde, behielt seine Session ohne zweiten Faktor. | `TestNewRightsNeedANewSession`, `01-auth` |
| Jeder Start setzte eine in Keycloak verschärfte Passwort-Richtlinie zurück. | `keycloak/…::TestWhatOperatorsChangeInKeycloak` |
| Ein fehlgeschlagenes `setup-admin` blockierte jeden weiteren Versuch. | `keycloak/…::TestSetupAdmin`, `TestHalfFailedChanges` |
| Benutzerverwalter konnten über Gruppen die Zuordnung höherer Rollen ändern. | `TestRankRulesEverywhere` |
| Anfragen beliebiger Größe wurden vollständig in den Speicher gelesen. | `test_request_guard.py::TestBodyLimit`, `08-deployment` |
| Dialoge schlossen sich beim Loslassen der Maus neben dem Dialog und verwarfen die Eingaben; das Einmalpasswort verschwand mit einem Klick. | Frontend: `ui.test.ts`, `modals.test.ts` |
| Nach der Abmeldung zeigte der Zurück-Knopf die letzte Seite mit Daten. | Frontend: `stores.test.ts` |
| Die Einbettungsprüfung meldete „einbettbar“, wenn die App auf eine eigene Seite mit Framing-Verbot weiterleitete. | `TestEmbedCheckOverHttp`, `TestFramingHeaders` |
| Der Sandbox-Hostname mit Punkt am Ende lieferte die Hauptanwendung aus. | `test_request_guard.py::TestHostDispatch`, `08-deployment` |
| Die CI wäre grün geblieben, wenn Datenbank und Keycloak nicht erreichbar gewesen wären (übersprungene Tests). | `tests/conftest.py::unavailable` |

## Continuous Integration

`.github/workflows/ci.yml` führt bei jedem Push auf `main` und bei jedem Pull Request drei Jobs
aus:

1. **Backend:** Lint, Formatierung, Typprüfung (mypy strict), Aktualität der API-Beschreibung, alle
   Backend-Tests gegen PostgreSQL, Keycloak und den Mail-Empfänger aus dem Entwicklungs-Stack.
   Ist einer dieser Dienste in der CI nicht erreichbar, schlägt der Lauf fehl; auf einem
   Entwicklerrechner werden die betroffenen Tests übersprungen.
2. **Frontend:** Aktualität der erzeugten API-Typen, `svelte-check`, Lint, Unit-Tests, Build.
3. **End-to-End:** Image bauen, Stack starten, Browser-Tests, Backup-Rundlauf, Installation nach
   Anleitung.

`.github/workflows/release.yml` veröffentlicht bei einem Versions-Tag das Image auf GHCR. Das Tag
`latest` wandert nur bei einem vollständigen Release mit (`v1.2.3`), nicht bei einer Vorabversion
(`v1.3.0-rc.1`).

## Was nicht getestet ist

Siehe [einschraenkungen.md](einschraenkungen.md#nicht-automatisiert-getestet).
