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
- **Mandanten:** beliebig viele Organisationen mit eigenen Benutzern, Gruppen, Apps und
  Administratoren. Die Trennung wird in der API und zusätzlich in der Datenbank erzwungen.
- **Benutzerverwaltung in der Oberfläche:** anlegen, bearbeiten, sperren, suchen, Gruppen und
  Rollen zuweisen – ohne eigene Passwortverwaltung.
- **Single Sign-On:** Anmeldung über Keycloak (OpenID Connect) mit eigenem Login-Design,
  Zwei-Faktor-Pflicht für Administratoren, sofortiger Abmeldung bei Sperre.
- **Betrieb:** vier Container mit Docker Compose, automatische TLS-Zertifikate, Skripte für
  Installation, Backup und Wiederherstellung.

## Schnellstart

Voraussetzungen: Docker mit Compose und drei DNS-Namen, die auf den Server zeigen.

```bash
git clone https://github.com/AdminCave/Velydock.git && cd Velydock
docker build -t ghcr.io/admincave/velydock:latest .    # nur solange kein Release veröffentlicht ist
./scripts/install.sh dock.example.com auth.example.com sandbox.example.com admin@example.com
docker compose up -d --wait    # kehrt zurück, sobald alles bereit ist (erster Start: ein bis zwei Minuten)
docker compose exec velydock velydock setup-admin --username admin --email admin@example.com
```

Der letzte Befehl zeigt ein Einmalpasswort. Danach `https://dock.example.com` öffnen und anmelden.
Ausführlich: [docs/installation.md](docs/installation.md).

Ein fertiges Image gibt es erst mit dem ersten Release (Tag `v0.1.0`); bis dahin baut die zweite
Zeile es lokal aus dem Quelltext.

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
