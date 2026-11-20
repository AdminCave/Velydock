# Tests

Vier Ebenen, alle automatisiert und in der CI. Stand der Zahlen: Version 0.1, Lauf vom 20.11.2026.

| Ebene | Werkzeug | Umfang | Braucht |
|---|---|---|---|
| Unit-Tests Backend | pytest | 185 Tests | nichts |
| Integrationstests Backend | pytest gegen PostgreSQL | 163 Tests | PostgreSQL |
| Integration mit Keycloak | pytest gegen Keycloak | 20 Tests | Keycloak |
| Unit-Tests Frontend | Vitest, Testing Library | 263 Tests | nichts |
| Browser-Tests (End-to-End) | Playwright, Chromium | 54 Tests | kompletter Stack |
| Backup und Wiederherstellung | Shell-Skript | 1 Rundlauf | kompletter Stack |

## Ausführen

```bash
# Backend (PostgreSQL und Keycloak des Entwicklungs-Stacks müssen laufen)
./scripts/dev-stack.sh up -d --no-deps --wait postgres keycloak
cd backend && .venv/bin/pytest -q

# Frontend
cd frontend && npm run check && npm run lint && npm run test:unit

# Browser-Tests: setzt den Entwicklungs-Stack zurück, baut neu, testet
./scripts/tests/e2e.sh

# Backup und Wiederherstellung am laufenden Entwicklungs-Stack
./scripts/tests/backup-restore.sh
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
  Authenticator-App.
- **Echter Stack im Browser.** Die Playwright-Tests laufen gegen die Compose-Installation mit
  Traefik und TLS. Sie richten sie ein wie ein Betreiber: `setup-admin`, erste Anmeldung mit
  Passwortwechsel, Organisationen, Benutzer, Apps. Nichts ist gemockt, mit einer Ausnahme: Für die
  Anzeige „App lässt sich nicht einbetten“ wird der Prüfstatus in der API-Antwort ersetzt.
- **Missbrauch statt nur Gutfall.** Sicherheitsregeln werden mit Tests belegt, die den Angriff
  versuchen: fremde IDs, gefälschte Tokens, eingeschleuste Felder, Selbstbeförderung.

## Die geforderten Testfälle

| Nr. | Testfall | Backend | Browser |
|---|---|---|---|
| 1 | Ein Administrator kann einen Benutzer erstellen | `test_users_api.py::TestCreate` | `05-administration`: „legt einen Benutzer an, der sich danach anmelden kann“ |
| 2 | Ein Benutzer kann sich anmelden | `test_auth_flow.py::TestSignIn`, `keycloak/…::TestBrowserSignIn` | `01-auth`: „meldet sich über Keycloak an und wieder ab“ |
| 3 | Ein Administrator kann Gruppen verwalten | `test_groups_apps_api.py::TestGroups` | `05-administration`: „verwaltet Gruppen“ |
| 4 | Anwendungen können erstellt und bearbeitet werden | `test_groups_apps_api.py::TestAppAdministration` | `05-administration`: „Apps werden angelegt, … abgeschaltet und gelöscht“, „eine eigene App wird … angelegt“ |
| 5 | Anwendungen erscheinen nur bei berechtigten Benutzern | `test_groups_apps_api.py::TestWorkspace`, `test_policy.py::TestAppVisibility` | `02-workspace`: „… sieht genau die freigegebenen Apps“ |
| 6 | Mandanten können nicht auf fremde Daten zugreifen | `test_tenant_isolation.py` (36 Tests) | `06-tenant-isolation` |
| 7 | Die Navigation funktioniert an allen vier Positionen | `test_system_settings_sandbox.py::TestSettings` | `03-navigation`: je Position Lage am Bildschirmrand gemessen |
| 8 | Benutzereinstellungen bleiben gespeichert | `TestSettings::test_personal_settings_persist` | `03-navigation`: Neuladen und frisches Browserprofil |
| 9 | Benutzerdefinierte Anwendungen werden sicher isoliert | `test_embed_and_custom_apps.py::TestCustomAppLockdown`, `…::TestSandboxHost` | `04-custom-app-isolation` (7 Tests) |
| 10 | Logout und Session-Ablauf funktionieren | `test_auth_flow.py::TestSessionLifetime`, `TestSignOut`, `TestBackChannelLogout` | `01-auth`: Abmeldung, Back-Channel-Logout, Sitzungen beenden |
| 11 | Die Docker-Installation funktioniert | – | `08-deployment`, `scripts/tests/backup-restore.sh` |

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

**Rollen und Berechtigungen** (`test_policy.py`, `test_users_api.py::TestRoles`)

- Rechte je Rolle; Rangregeln; niemand ändert die eigene Rolle.
- Ein Benutzerverwalter kann niemanden befördern und kein Administratorkonto übernehmen
  (Passwort, E-Mail, Sperre, Löschen).
- Mandantenadministratoren können Systemadministratoren nicht verändern; das Feld
  `is_system_admin` nimmt die Mandanten-API gar nicht an.
- Gastkonten: Der gastgebende Mandant kann nur die Mitgliedschaft beenden.

**Authentifizierung und Sessions** (`test_oidc.py`, `test_auth_flow.py`)

- ID-Token: falsche Signatur, unbekannter Schlüssel, `alg: none`, HMAC mit dem öffentlichen
  Schlüssel, falscher Aussteller, fremder Empfänger, abgelaufen, fehlende oder falsche `nonce`.
- Ablauf: `state` an Cookie gebunden, Code nicht wiederverwendbar, PKCE geprüft, kein Open Redirect,
  keine stillschweigende Übernahme eines vorhandenen Benutzernamens.
- Cookie-Eigenschaften; nur der Hash in der Datenbank; Leerlauf- und Maximaldauer; gestohlenes
  Cookie nach Abmeldung wertlos; deaktiviertes Konto sofort ausgesperrt.
- Back-Channel-Logout: genau die genannte Sitzung endet; gefälschte Tokens beenden nichts.
- CSRF: fehlender Header, fremde Herkunft (auch der Sandbox-Hostname), `Sec-Fetch-Site`.
- Reihenfolge: Jede Antwort wird erst nach dem Commit gesendet (`test_commit_order.py`).

**Unsichere Eingaben** (`test_tokens_and_validation.py`, `test_groups_apps_api.py`, `test_users_api.py`)

- Benutzernamen, E-Mail-Adressen, Kurznamen; unbekannte Felder; SQL-Sonderzeichen in der Suche.
- App-Adressen mit `javascript:`, `data:`, `file:`, Zugangsdaten; `http` bei eingebetteten Apps.
- Icons: falscher Inhalt trotz Bildtyp, zu groß, kein Base64; SVG mit Skript wird sandboxend
  ausgeliefert.
- Einbettungsprüfung: private Adressen, fremde Schemata, keine verfolgten Weiterleitungen – gegen
  einen lokalen Webserver geprüft.

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

## Continuous Integration

`.github/workflows/ci.yml` führt bei jedem Push drei Jobs aus:

1. **Backend:** Lint, Formatierung, Typprüfung (mypy strict), Aktualität der API-Beschreibung, alle
   Backend-Tests gegen PostgreSQL und Keycloak aus dem Entwicklungs-Stack.
2. **Frontend:** Aktualität der erzeugten API-Typen, `svelte-check`, Lint, Unit-Tests, Build.
3. **End-to-End:** Image bauen, Stack starten, Browser-Tests, Backup-Rundlauf.

`.github/workflows/release.yml` veröffentlicht bei einem Versions-Tag das Image auf GHCR.

## Was nicht getestet ist

Siehe [einschraenkungen.md](einschraenkungen.md#nicht-automatisiert-getestet).
