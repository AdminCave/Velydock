# Entwicklungsumgebung

## Aufbau des Repositories

```
backend/     FastAPI-Dienst (Python 3.13) mit Tests
frontend/    Oberfläche (Svelte 5, TypeScript, Vite) mit Unit-Tests
e2e/         Browser-Tests (Playwright) gegen den vollständigen Stack
deploy/      Traefik-Konfiguration, PostgreSQL-Init, Keycloak-Login-Theme
scripts/     Installation, Backup, Restore, Entwicklungs-Stack, Testläufe
docs/        Diese Dokumentation
docker-compose.yml                 Produktiv-Stack
docker-compose.dev.yml             Ergänzungen für Entwicklung und Tests
docker-compose.keycloak-admin.yml  Öffnet Keycloaks Konsole auf localhost
```

## Voraussetzungen

Docker mit Compose, Python 3.13, Node.js 22.

## Der Entwicklungs-Stack

```bash
./scripts/dev-stack.sh up -d --build --wait
```

Baut das Image aus dem Arbeitsverzeichnis und startet alles unter dem Projektnamen
`velydock-dev` – getrennt von einer echten Installation auf demselben Rechner. Einstellungen
stehen in `.env.dev` (öffentliche Test-Geheimnisse, nicht für den Produktivbetrieb).

| Adresse | Inhalt |
|---|---|
| `https://dock.velydock.localhost:8443` | Velydock |
| `https://auth.velydock.localhost:8443` | Keycloak (Anmeldeseite) |
| `https://sandbox.velydock.localhost:8443` | Sandbox-Host für eigene Apps |
| `https://demo.velydock.localhost:8443` | Kleine Demo-Anwendung zum Einbetten |
| `http://localhost:18080/admin/velydock/console/` | Keycloaks Konsole |
| `127.0.0.1:15432` | PostgreSQL (Superuser `postgres`, Passwort aus `.env.dev`) |
| `http://localhost:18025` | Posteingang des Mail-Empfängers (Mailpit): fängt jede E-Mail ab, die Keycloak verschickt. In den Systemeinstellungen als Server `mail`, Port `1025`, ohne Verschlüsselung eintragen. |

`*.localhost` löst im Browser ohne DNS-Eintrag auf `127.0.0.1` auf. Das Zertifikat ist Traefiks
selbstsigniertes; der Browser warnt beim ersten Aufruf je Hostname.

Die Routing-Regeln liegen in `deploy/traefik/dynamic/`; Traefik beobachtet das Verzeichnis und
übernimmt Änderungen ohne Neustart. Die Route der Demo-Anwendung (`dev-demo.yml`) ist nur aktiv,
wenn `DEMO_HOST` gesetzt ist – das tut allein `docker-compose.dev.yml`.

Ersten Administrator anlegen:

```bash
./scripts/dev-stack.sh exec velydock velydock setup-admin --username admin --email admin@example.com
```

Zurücksetzen (löscht nur die Daten des Entwicklungs-Stacks):

```bash
./scripts/dev-stack.sh down --volumes
```

## Backend

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install --require-hashes -r requirements-dev.txt
.venv/bin/pip install --no-deps -e .

.venv/bin/ruff check . && .venv/bin/ruff format --check .
.venv/bin/mypy velydock
.venv/bin/pytest -q                  # braucht PostgreSQL und Keycloak des Entwicklungs-Stacks
.venv/bin/pytest -q tests/unit       # läuft ohne alles
```

Die Tests legen in der PostgreSQL-Instanz des Entwicklungs-Stacks eine eigene Wegwerf-Datenbank
und in Keycloak einen eigenen Realm an; sie verändern die Entwicklungsdaten nicht. Für sie genügen
drei Dienste (der Mail-Empfänger nimmt die Einladungs-Mail des Keycloak-Tests entgegen):

```bash
./scripts/dev-stack.sh up -d --no-deps --wait postgres keycloak mail
```

### Abhängigkeiten ändern

Abhängigkeiten stehen in `pyproject.toml`; die Sperrdateien mit Hashes werden erzeugt:

```bash
.venv/bin/pip-compile --generate-hashes --strip-extras -o requirements.txt pyproject.toml
.venv/bin/pip-compile --generate-hashes --strip-extras --allow-unsafe --extra dev -o requirements-dev.txt pyproject.toml
```

### Datenbankänderungen

```bash
export VELYDOCK_DATABASE_URL=postgresql+asyncpg://velydock:<Passwort aus .env.dev>@127.0.0.1:15432/velydock
.venv/bin/alembic -c alembic.ini revision --autogenerate -m "kurze beschreibung"
```

Die erzeugte Migration prüfen. Neue mandantenbezogene Tabellen brauchen Row Level Security (Muster
in `migrations/versions/…_0001_initial_schema.py`); ein Test schlägt fehl, wenn eine Tabelle ohne
erzwungene Row Level Security existiert oder Modelle und Schema auseinanderlaufen.

### API ändern

Nach Änderungen an Routen oder Schemas:

```bash
.venv/bin/velydock openapi > openapi.json
cd ../frontend && npm run gen:api
```

Die CI schlägt fehl, wenn eine der beiden Dateien nicht aktuell ist.

## Frontend

```bash
cd frontend
npm ci
npm run check && npm run lint && npm run test:unit && npm run build
```

Für die Arbeit an der Oberfläche gibt es ein Backend mit simulierter Anmeldung – echte API, echte
Datenbank, kein Keycloak; die Anmeldung ist ein Klick auf einen Benutzernamen:

```bash
cd backend
.venv/bin/python -m tests.support.devserver --public-url http://localhost:5173
cd ../frontend && npm run dev           # http://localhost:5173
```

Es braucht nur die PostgreSQL des Entwicklungs-Stacks, legt bei jedem Start die Datenbank
`velydock_devui` neu an und füllt sie mit Beispieldaten (Organisationen, Benutzer aller Rollen,
Apps aller Typen). Nur für die lokale Entwicklung: Es hat keine Authentifizierung.

## Browser-Tests

```bash
./scripts/tests/e2e.sh                       # Stack zurücksetzen, neu bauen, alle Tests
./scripts/tests/e2e.sh --keep -g "Navigation"   # laufenden, frischen Stack verwenden; Auswahl
```

Die Tests richten den Stack ein wie ein Betreiber (`setup-admin`, erste Anmeldung mit
Passwortwechsel, Organisationen, Benutzer, Apps) und erwarten deshalb einen leeren Stack.

## Login-Theme

Quellen in `deploy/keycloak/theme/velydock/login/`. Das Theme erbt von Keycloaks `keycloak.v2` und
ersetzt nur Stylesheet, Texte und Logo. Nach einer Änderung:

```bash
./scripts/dev-stack.sh up -d --build      # der Dienst "theme" installiert neu, Keycloak startet neu
```

## Konventionen

- Code, Bezeichner, Kommentare und Commit-Nachrichten auf Englisch; Oberfläche Deutsch und
  Englisch; Dokumentation Deutsch.
- Commit-Nachrichten im Stil `typ(bereich): zusammenfassung`.
- Gestaltung nach dem AdminCave Design System (Tokens in `frontend/src/styles/`).
- Neue Funktionen kommen mit Tests; sicherheitsrelevante Regeln zusätzlich mit einem Test, der den
  Missbrauch versucht.
