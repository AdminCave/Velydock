# Velydock

**Ein Arbeitsplatz für alle Web-Anwendungen – eine Anmeldung, eine Oberfläche, sauber getrennte
Organisationen.**

Velydock ist eine selbst gehostete Workspace-Plattform. Benutzer melden sich einmal an und öffnen
die ihnen zugewiesenen Anwendungen – Nextcloud, Webmail, OpenProject, eigene kleine Werkzeuge –
aus einer gemeinsamen Navigation, wo möglich direkt in der Oberfläche. Administratoren verwalten
Benutzer, Gruppen und Anwendungen an einer Stelle. Dienstleister betreiben mehrere voneinander
getrennte Kunden in einer Installation.

Teil von [Admin Cave](https://admincave.com). Lizenz: GPL-3.0-or-later.

## Was Velydock kann

- **Workspace:** Dashboard und Navigationsleiste (Dock) an einem der vier Bildschirmränder,
  helles und dunkles Design, Deutsch und Englisch, auch auf dem Telefon bedienbar.
- **Drei Arten von Apps:** eingebettet im Frame, im neuen Tab, oder als eigene App aus HTML, CSS
  und JavaScript in einer abgeschotteten Sandbox.
- **Apps veröffentlichen:** interne Anwendungen über den eingebauten Proxy unter einer
  öffentlichen Adresse bereitstellen (`apps.example.com/name/` oder eigene Subdomain) –
  geschützt durch die Velydock-Anmeldung oder öffentlich, mit Vorlagen für die
  Proxy-Einstellungen.
- **Erscheinungsbild:** Logo, Design, Akzentfarbe, Dock-Position und App-Leiste je Organisation
  und je Benutzer; die Organisation kann jede Einstellung für alle festlegen.
- **Mandanten:** beliebig viele Organisationen mit eigenen Benutzern, Gruppen, Apps und
  Administratoren. Die Trennung wird in der API und zusätzlich in der Datenbank erzwungen.
- **Benutzerverwaltung in der Oberfläche:** anlegen, bearbeiten, sperren, suchen, Gruppen und
  Rollen zuweisen – ohne eigene Passwortverwaltung.
- **Single Sign-On:** Anmeldung über Keycloak (OpenID Connect) mit eigenem Login-Design,
  Zwei-Faktor-Pflicht für Administratoren, sofortiger Abmeldung bei Sperre.
- **Betrieb:** vier Container mit Docker Compose, automatische TLS-Zertifikate, ein Installer und
  der Befehl `velydock` für Update, Backup, Wiederherstellung und Diagnose.

## Schnellstart

Voraussetzungen: ein Linux-Server (x86_64) und drei DNS-Namen, die auf ihn zeigen.

```bash
curl -fsSL https://github.com/AdminCave/Velydock/releases/latest/download/install.sh | sudo bash
```

Der Installer prüft den Server, richtet unter Debian und Ubuntu auf Wunsch Docker ein, fragt nach
Hostnamen, Zertifikaten und dem ersten Administrator, startet alles und zeigt am Ende Adresse,
Benutzername und ein Einmalpasswort. Danach gibt es auf dem Server den Befehl `velydock`
(`velydock status`, `update`, `backup`, `doctor`, `help`). Ausführlich:
[docs/installation.md](docs/installation.md).

**Diese Zeile braucht ein veröffentlichtes Release, und noch gibt es keines** – das erste entsteht
mit dem Tag `v0.1.0`. Bis dahin geht es von Hand aus dem Quelltext:

```bash
git clone https://github.com/AdminCave/Velydock.git && cd Velydock
docker build -t ghcr.io/admincave/velydock:latest .
./scripts/install.sh dock.example.com auth.example.com sandbox.example.com admin@example.com
docker compose up -d --wait    # kehrt zurück, sobald alles bereit ist (erster Start: ein bis zwei Minuten)
docker compose exec velydock velydock setup-admin --username admin --email admin@example.com
```

Der letzte Befehl zeigt ein Einmalpasswort. Danach `https://dock.example.com` öffnen und anmelden.

Zum Ausprobieren auf dem eigenen Rechner ohne DNS und Zertifikate:
[docs/entwicklung.md](docs/entwicklung.md#der-entwicklungs-stack).

## Dokumentation

| Thema | Dokument |
|---|---|
| Installation, Konfiguration, erste Einrichtung | [docs/installation.md](docs/installation.md) |
| Administratorhandbuch: Benutzer, Organisationen, Gruppen, Apps | [docs/administration.md](docs/administration.md) |
| Anwendungen integrieren (Einbettung, Cookies, eigene Apps) | [docs/anwendungsintegration.md](docs/anwendungsintegration.md) |
| SSO-Konzept und Anbindung von Apps per OIDC | [docs/sso.md](docs/sso.md) |
| Betrieb: Updates, Backup, Wiederherstellung, eigener Proxy | [docs/betrieb.md](docs/betrieb.md) |
| Architektur | [docs/architektur.md](docs/architektur.md) |
| Architekturentscheidungen | [docs/entscheidungen.md](docs/entscheidungen.md) |
| Sicherheitskonzept | [docs/sicherheit.md](docs/sicherheit.md) |
| Tests | [docs/tests.md](docs/tests.md) |
| Entwicklungsumgebung | [docs/entwicklung.md](docs/entwicklung.md) |
| Erweiterungskonzept | [docs/erweiterung.md](docs/erweiterung.md) |
| Bekannte Einschränkungen | [docs/einschraenkungen.md](docs/einschraenkungen.md) |

## Architektur in einem Bild

```
Browser ──HTTPS──► Traefik ─┬─► velydock  (Oberfläche, API, Anmeldung, Sandbox-Host)
                            └─► Keycloak  (Anmeldeseite, Passwörter, Zwei-Faktor)
                                   velydock und Keycloak ──► PostgreSQL
```

Technik: Python (FastAPI, SQLAlchemy), Svelte 5, PostgreSQL, Keycloak, Traefik.

## Stand

Version 0.1 – die erste vollständige Fassung. Was noch fehlt, steht in
[docs/einschraenkungen.md](docs/einschraenkungen.md). Sicherheitslücken bitte nicht als
öffentliches Issue melden, sondern wie in [SECURITY.md](SECURITY.md) beschrieben.
