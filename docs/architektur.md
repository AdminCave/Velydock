# Architektur

Velydock besteht aus vier Diensten, die mit Docker Compose gestartet werden. Nur der Reverse
Proxy ist von außen erreichbar.

```
                         Browser
                            │ HTTPS
                            ▼
   ┌──────────────────────────────────────────────────┐
   │ Traefik – TLS, Routing, Ratenbegrenzung          │
   └──────┬───────────────────┬─────────────────┬─────┘
   dock.example.com   sandbox.example.com   auth.example.com
          │                   │                 │ nur /realms/velydock und /resources
          ▼                   ▼                 ▼
   ┌────────────────────────────────┐   ┌───────────────────────┐
   │ velydock (ein Container)       │   │ Keycloak              │
   │ • Oberfläche (Svelte, statisch)│──►│ Realm "velydock"      │
   │ • REST-API /api/v1             │   │ • Benutzer, Passwörter│
   │ • Anmeldung (OIDC-Client)      │◄──│ • Organizations       │
   │ • Sandbox-Host für eigene Apps │   │ • Login-Theme         │
   └───────────────┬────────────────┘   └───────────┬───────────┘
                   ▼                                ▼
   ┌──────────────────────────────────────────────────┐
   │ PostgreSQL – Datenbank velydock │ Datenbank keycloak │
   └──────────────────────────────────────────────────┘

   velydock ──► Keycloak   Admin-API über das interne Netz (Benutzer, Organizations, Realm)
   Keycloak ──► velydock   Back-Channel-Logout über das interne Netz
   Externe Apps ─OIDC──►   Keycloak (gleicher Realm, daher eine Anmeldung für alles)
```

## Komponenten

| Dienst | Image | Aufgabe |
|---|---|---|
| `traefik` | `traefik:v3` | TLS mit Let's Encrypt, Routing nach Hostname, Ratenbegrenzung der API und der Anmeldeschritte von Keycloak je Client-Adresse. Konfiguration über Dateien im Verzeichnis `deploy/traefik/dynamic/`, das Traefik beobachtet (Änderungen gelten ohne Neustart); kein Zugriff auf den Docker-Socket. Abschaltbar, wenn ein eigener Proxy vorhanden ist. Ist ein Apps-Host eingerichtet, holt Traefik zusätzlich alle fünf Sekunden die Routen der veröffentlichten Apps bei Velydock ab (HTTP-Provider) und fragt Velydock vor jeder Anfrage an eine geschützte App (`forwardAuth`). |
| `velydock` | `ghcr.io/admincave/velydock` | Oberfläche, API, Anmeldung und die Auslieferung eigener Apps. Ein Prozess, zwei ASGI-Anwendungen (siehe unten). |
| `theme` | dasselbe Image | Läuft einmal beim Start und kopiert das Login-Theme in das Volume, aus dem Keycloak Themes lädt. |
| `keycloak` | `quay.io/keycloak/keycloak:26.x` | Identity Provider: Anmeldeseite, Passwörter, Zwei-Faktor, Sitzungen, OIDC für Velydock und angebundene Apps. |
| `postgres` | `postgres:18` | Eine Instanz mit zwei Datenbanken und je einer eigenen, unprivilegierten Rolle. |

## Aufbau des Backends

`backend/velydock/` (Python 3.13, FastAPI, SQLAlchemy 2 async, Alembic):

| Modul | Inhalt |
|---|---|
| `app.py` | Anwendungsfabrik. `HostDispatch` leitet Anfragen an den Sandbox-Hostnamen an eine eigene Mini-Anwendung, alles andere an die Hauptanwendung. |
| `api/` | Routen: `auth` (Anmeldung, Abmeldung, Back-Channel-Logout), `me` (Profil, Einstellungen, Workspace), `admin` (Mandantenverwaltung), `system` (Systemverwaltung), `proxy` (was nur Traefik aufruft – Routen und Zugriffsprüfung veröffentlichter Apps – und der Anmelde-Umweg dorthin). `deps.py` baut aus dem Session-Cookie den `Principal` und setzt den Datenbankkontext. |
| `policy.py` | Alle Berechtigungsentscheidungen als reine Funktionen ohne Ein-/Ausgabe. |
| `services/` | Fachlogik: Benutzer, Gruppen, Apps, Mandanten, Einstellungen, Audit, Einbettungsprüfung, Aufbereitung eigener Apps, Veröffentlichen über den Proxy (`proxy.py`: was veröffentlicht werden darf, die Routen, die Zugriffsprüfung). |
| `security/` | OIDC-Client (`oidc.py`), Sessions, CSRF-Prüfung und Sicherheits-Header, signierte Kurzzeit-Tokens. |
| `idp/` | Schnittstelle zum Identity Provider (`base.py`) und die Keycloak-Umsetzung inklusive Realm-Einrichtung (`keycloak.py`). |
| `sandbox.py` | Die Anwendung für den Sandbox-Host: liefert ausschließlich eigene Apps aus. |
| `db.py`, `models.py`, `migrations/` | Datenbankzugriff, Row-Level-Security-Kontext, Modelle, Migrationen. |
| `cli.py` | Das Kommando `velydock` mit den Befehlen `run`, `serve`, `migrate`, `bootstrap`, `setup-admin`, `keycloak-admin`, `install-theme`, `version` und `openapi`. |

Das Frontend (`frontend/`, Svelte 5, TypeScript, Vite) wird beim Image-Build übersetzt und vom
Backend als statische Dateien ausgeliefert. Es spricht ausschließlich mit `/api`.

## Datenmodell

```
tenants ──< memberships >── users          Mitgliedschaft mit Rolle
   │                          │
   ├──< groups ──< group_members >─┘        Gruppen eines Mandanten
   │      │
   ├──< apps ──< app_group_grants >── groups
   │       └──< app_user_grants  >── users  Freigaben einer App
   │       └──1 app_publications           öffentliche Adresse, internes Ziel, Zugriff, Vorlage
   ├──< proxy_targets                      was die Organisation veröffentlichen darf (schreibt nur das System)
   └──< audit_log

users ──1 user_settings        Design, Akzentfarbe, Dock-Position, App-Leiste, Sprache, zuletzt genutzter Mandant
users ──< sessions             serverseitige Sitzungen (nur der Hash des Cookies)
system_settings                Instanzname, Standardwerte, Zwei-Faktor-Pflicht
proxy_templates                eigene Vorlagen für Proxy-Einstellungen (für alle Organisationen)
certificates                   hochgeladene TLS-Zertifikate mit Schlüssel (nur im Systemkontext sichtbar)
```

- `users` enthält eine Zeile je Identität im gemeinsamen Keycloak-Realm. `home_tenant_id` nennt
  den Mandanten, dem die Identität gehört.
- Alle mandantenbezogenen Tabellen tragen `tenant_id`.
- Das Erscheinungsbild einer Organisation (Logo, Vorgaben und ihre Festlegung) steht in `tenants`.
  Das Logo-Bild wird nur gelesen, wenn es ausgeliefert wird: Die Mandantenzeile wird mit jeder
  Anfrage geladen.
- Icons eigener Wahl liegen als Binärdaten in `apps`, damit ein Datenbank-Dump das vollständige
  Backup ist.

## Weg einer Anfrage

1. Der Browser sendet das Session-Cookie. `get_principal` sucht (im Systemkontext) die Session,
   prüft Leerlauf- und Maximaldauer und ob das Konto aktiv ist. Alle fünf Minuten fragt es
   zusätzlich bei Keycloak nach, ob Konto und Sitzung dort noch gelten.
2. Bei schreibenden Anfragen wird die CSRF-Prüfung ausgeführt.
3. Der Mandant der Anfrage wird aus der Session bestimmt – nie aus der Anfrage selbst. Mitglieder
   können nur Mandanten betreten, in denen sie Mitglied sind.
4. Was zur Session gehört (letzte Nutzung, gebundene Organisation), wird in einer eigenen kurzen
   Transaktion gespeichert. Danach beginnt die Transaktion der Anfrage, festgelegt auf den
   Mandanten (`app.scope`, `app.tenant_id`, `app.user_id`). Ab hier sieht die Anfrage nur noch
   Zeilen ihres Mandanten.
5. Die Route prüft die nötige Berechtigung (`require(Permission.…)`) und ob der Client dieselbe
   Organisation anzeigt, in der die Session arbeitet (`X-Velydock-Tenant`); die Fachlogik prüft
   die feineren Regeln aus `policy.py` und filtert zusätzlich ausdrücklich nach Mandant.
6. Änderungen an Identitäten warten, bis sie an der Reihe sind (eine Sperre je Konto), schreiben
   in die Datenbank und danach nach Keycloak – nur die geänderten Felder. Lehnt Keycloak ab,
   wird die Datenbank zurückgerollt; hat Keycloak schon einen Teil übernommen, wird er dort
   zurückgenommen. Beim Anlegen ist es umgekehrt: erst Keycloak (das die Kennung vergibt), dann
   die Datenbank; schlägt sie fehl, wird das Konto in Keycloak wieder entfernt.
7. Die Transaktion wird abgeschlossen, bevor die Antwort gesendet wird; bei einem Fehler wird
   alles verworfen.

## Anmeldung

Velydock ist ein vertraulicher OIDC-Client (Authorization Code Flow mit PKCE). Der Code wird im
Backend eingelöst; der Browser erhält nur ein Session-Cookie und sieht nie ein Token. Details in
[sso.md](sso.md).

## Zwei Hostnamen in einem Container

Eigene Apps (HTML, CSS, JavaScript von Administratoren) dürfen nie unter dem Hostnamen der
Oberfläche laufen. Der Container beantwortet deshalb zwei Hostnamen mit zwei getrennten
Anwendungen:

- `dock.…` – Oberfläche, API, Anmeldung.
- `sandbox.…` – kennt genau eine Route (`/c/<signierter Link>`), keine Session, setzt und liest
  keine Cookies.

Die Konfiguration verweigert den Start, wenn beide Hostnamen gleich sind.

## Veröffentlichte Apps

Mit einem Apps-Host (`APPS_HOST`) stellt der mitgelieferte Traefik interne Anwendungen unter
einer öffentlichen Adresse bereit. Velydock entscheidet, Traefik leitet weiter:

```
Browser ──► Traefik ──(1) darf er?──► Velydock  /internal/proxy/auth/<app>
               │                         │ 200: weiterleiten · 302: zur Anmeldung · 401/403
               └──(2)──► interne Anwendung (z. B. http://10.20.0.7:8080)

Traefik ──alle 5 s──► Velydock  /internal/proxy/traefik   (Routen aller veröffentlichten Apps)
```

- **Routen.** Velydock baut sie aus geprüften Teilen: dem Namen der Veröffentlichung, ihrer Art
  (Pfad oder Subdomain), dem internen Ziel und den Einstellungen aus Vorlage und App. Regeln als
  freien Text gibt es nicht. Eine Veröffentlichung, deren Ziel nicht mehr freigegeben ist, deren
  Vorlage fehlt oder deren Art der Organisation nicht mehr erlaubt ist, steht nicht in den
  Routen.
- **Die beiden internen Wege** antworten nur unter Velydocks Namen im Compose-Netz
  (`velydock:8000`); der Routen-Abruf verlangt zusätzlich `VELYDOCK_PROXY_SECRET`. Über die
  öffentlichen Adressen gibt es sie nicht.
- **Anmeldung an einer geschützten App.** Die App liegt unter einem anderen Host als Velydock;
  dessen Session-Cookie kommt dort nicht an. Wer ohne Anmeldung kommt, wird deshalb zu
  `/proxy/login` auf Velydocks Adresse geschickt (der Browser merkt sich dabei ein Geheimnis).
  Velydock erkennt die Session – oder verlangt die Anmeldung –, prüft die Freigabe der App und
  schickt den Browser mit einem Ticket zurück (einmal gültig, 60 Sekunden, an das Geheimnis
  gebunden). Die App-Adresse tauscht es gegen ein eigenes Cookie, das nur für diese App gilt und
  auf die Velydock-Session verweist: Endet sie, endet der Zugriff.
- **Zugriffsprüfung.** Dieselbe Regel wie im Workspace (aktive App, aktive Organisation,
  Mitglied mit Freigabe). Die Antwort wird 30 Sekunden gemerkt; alle fünf Minuten wird bei
  Keycloak nachgefragt, wie in der Oberfläche.
- **Fällt Velydock aus,** behält Traefik die letzten Routen; geschützte Apps antworten mit einem
  Fehler (die Prüfung ist nicht erreichbar), öffentliche laufen weiter.

Einrichtung in [betrieb.md](betrieb.md#apps-über-den-proxy-veröffentlichen), Bedienung in
[anwendungsintegration.md](anwendungsintegration.md#apps-über-den-proxy-veröffentlichen), Schutz
in [sicherheit.md](sicherheit.md#veröffentlichte-apps-proxy).
