# Betrieb: Deployment, Updates, Backup

## Dienste und Daten

| Dienst | Daten | Volume |
|---|---|---|
| `postgres` | Beide Datenbanken – **alles, was gesichert werden muss** | `postgres-data` |
| `keycloak` | Keine eigenen (liegt in PostgreSQL) | – |
| `velydock` | Keine eigenen (liegt in PostgreSQL) | – |
| `traefik` | Let's-Encrypt-Zertifikate (werden bei Verlust neu ausgestellt) | `traefik-acme` |
| `theme` | Login-Theme, wird bei jedem Start aus dem Image neu geschrieben | `keycloak-themes` |

Dazu kommt die Datei `.env` mit allen Geheimnissen.

Nur `traefik` veröffentlicht Ports. PostgreSQL ist ausschließlich im internen Docker-Netz
erreichbar.

## Update

```bash
git pull                      # neue Compose-Datei, Skripte und Routing-Regeln
docker compose pull           # neues Image
docker compose up -d
```

Wer das Image selbst baut (kein veröffentlichtes Release): statt `docker compose pull` erneut
`docker build -t ghcr.io/admincave/velydock:latest .` ausführen.

Beim Start wendet Velydock ausstehende Datenbankmigrationen an und gleicht die Realm-Einstellungen
in Keycloak ab.

**Wartungsfenster einplanen:** Jedes neue Velydock-Image startet auch Keycloak neu, nicht nur
eines mit geändertem Login-Theme. Der Dienst `theme` verwendet dasselbe Image wie `velydock`;
wird er neu angelegt, startet Compose Keycloak neu, und der neue `velydock`-Container startet
erst, wenn Keycloak wieder bereit ist. Anmeldung und Oberfläche sind bei jedem Update etwa eine
Minute lang nicht erreichbar.

**Routing-Regeln:** Traefik liest das Verzeichnis `deploy/traefik/dynamic/` aus dem Checkout und
beobachtet es. Geänderte Regeln gelten deshalb schon wenige Sekunden nach `git pull`, ohne
Neustart von Traefik – die drei Befehle also zusammen ausführen. Auf Servern mit restriktiver
umask (027, 077) nach `git pull` die Leserechte wiederherstellen: `chmod -R o+rX deploy`. Kann
Traefik eine geänderte Datei nicht lesen, behält es die bisherigen Regeln und meldet den Fehler
in `docker compose logs traefik`.

Empfehlung: in `.env` eine feste Version eintragen (`VELYDOCK_IMAGE=ghcr.io/admincave/velydock:0.1.0`)
und vor jedem Update ein Backup anlegen.

Keycloak selbst wird über die Versionsnummer in `docker-compose.yml` aktualisiert. Da Keycloak nur
für die jeweils neueste Version Sicherheitskorrekturen liefert, gehören dessen Updates zur
regelmäßigen Wartung.

## Backup

```bash
./scripts/backup.sh               # schreibt nach backups/velydock-<Zeitstempel>/ im Checkout
./scripts/backup.sh /mnt/backup   # anderes Zielverzeichnis
```

Das Skript sichert im laufenden Betrieb beide Datenbanken (`pg_dump`, Custom-Format) und kopiert
`.env`. Ein relativer Pfad gilt – wie bei `restore.sh` – ab dem Verzeichnis, aus dem das Skript
aufgerufen wird. Jedes Backup ist ein Verzeichnis mit Prüfsummen:

```
velydock.dump   keycloak.dump   env   SHA256SUMS
```

Das Backup enthält alle Geheimnisse und die Passwort-Hashes aller Benutzer. Es gehört
verschlüsselt und nicht auf denselben Server. Für regelmäßige Sicherungen genügt ein Cron-Eintrag:

```
30 2 * * *  cd /opt/velydock && ./scripts/backup.sh /mnt/backup >> /var/log/velydock-backup.log 2>&1
```

Beide Datenbanken gehören zusammen: Velydock verweist auf Keycloak-Benutzer über deren ID. Immer
beide sichern und beide zurückspielen.

## Wiederherstellung

Auf dem bestehenden Server:

```bash
./scripts/restore.sh backups/velydock-20261120T020000Z
```

Auf einem neuen Server:

```bash
git clone https://github.com/AdminCave/Velydock.git && cd Velydock
cp /mnt/backup/velydock-20261120T020000Z/env .env
docker compose up -d --wait               # legt leere Datenbanken an
./scripts/restore.sh /mnt/backup/velydock-20261120T020000Z
```

Das Skript prüft die Prüfsummen, fragt nach (Eingabe `restore`), hält Velydock und Keycloak an,
ersetzt beide Datenbanken und startet alles wieder. Sitzungen, die nach dem Backup entstanden
sind, existieren danach nicht mehr; alle melden sich neu an.

Die `.env` wird bewusst nicht automatisch überschrieben. Die Datenbanken funktionieren nur mit den
Geheimnissen, mit denen sie angelegt wurden – auf einem neuen Server deshalb zuerst die `env` aus
dem Backup einspielen.

Der Ablauf Backup → Datenverlust → Wiederherstellung wird in der CI gegen den vollständigen
Stack getestet (`scripts/tests/backup-restore.sh`).

## Eigener Reverse Proxy

In `.env` `COMPOSE_PROFILES=` leer setzen; Traefik startet dann nicht. Der eigene Proxy muss die
Container erreichen, zum Beispiel über veröffentlichte lokale Ports in einer
`docker-compose.override.yml`:

```yaml
services:
  velydock:
    ports: ["127.0.0.1:8000:8000"]
  keycloak:
    ports: ["127.0.0.1:8080:8080"]
```

Regeln für den Proxy:

| Hostname | Ziel | Hinweise |
|---|---|---|
| `VELYDOCK_HOST` | `velydock:8000` | `Host`-Header unverändert weitergeben |
| `SANDBOX_HOST` | `velydock:8000` | derselbe Container; er unterscheidet anhand des `Host`-Headers |
| `KEYCLOAK_HOST` | `keycloak:8080` | **nur** die Pfade `/realms/velydock/` und `/resources/` weiterleiten |

Außerdem: TLS terminieren, `X-Forwarded-For`, `X-Forwarded-Proto` und `X-Forwarded-Host` setzen,
keine Antwort-Header entfernen. Velydock glaubt `X-Forwarded-For` nur von Proxys in privaten
Netzen; steht der Proxy unter einer öffentlichen Adresse, gehört diese in
`VELYDOCK_TRUSTED_PROXIES`. Anfragen über 4 MB weist Velydock selbst ab. Die Pfade `/admin/` und `/realms/master/` von Keycloak dürfen von
außen nicht erreichbar sein.

Zwei Dinge erledigt sonst der mitgelieferte Traefik, ein eigener Proxy sollte sie übernehmen: Er
begrenzt die Anfragen an `/api/` je Client-Adresse (im Mittel 100 pro Sekunde, kurzzeitig bis 300) und
weist Anfragen ab, deren Pfad einen kodierten Schrägstrich (`%2F`) enthält. Velydock dekodiert
ihn zu `/`; ein Proxy, der Regeln nach Pfad anwendet, ließe sich sonst mit `/api%2F…` umgehen.

## Zugang zur Keycloak-Verwaltung

Für Aufgaben, die Velydock nicht abdeckt (Apps per OIDC anbinden, LDAP/AD, externe Identity
Provider, Passwort-Richtlinie), wird Keycloaks eigene Verwaltungskonsole gebraucht. Sie ist von
außen nicht erreichbar und wird nur bei Bedarf auf `localhost` des Servers geöffnet:

```bash
# 1. Konsole auf 127.0.0.1:8081 des Servers öffnen (Keycloak startet dabei neu)
docker compose -f docker-compose.yml -f docker-compose.keycloak-admin.yml up -d keycloak

# 2. Einem vorhandenen Velydock-Benutzer das Recht dafür geben
docker compose exec velydock velydock keycloak-admin --username admin

# 3. Vom eigenen Rechner aus tunneln und die Konsole öffnen
ssh -L 8081:127.0.0.1:8081 server
#    Browser: http://localhost:8081/admin/velydock/console/
```

Die Anmeldung läuft über die normale Anmeldeseite mit den normalen Zugangsdaten (inklusive
zweitem Faktor); nur die Konsole selbst kommt durch den Tunnel. Der Port lässt sich mit
`KEYCLOAK_ADMIN_PORT` in `.env` ändern.

**Mit eigenem Reverse Proxy** die `docker-compose.override.yml` im ersten Schritt mit angeben.
Sobald `-f` verwendet wird, lädt Compose sie nicht mehr von selbst; Keycloak verlöre sonst den
Port, über den der eigene Proxy es erreicht, und die Anmeldung fiele aus, solange die Konsole
offen ist:

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml \
               -f docker-compose.keycloak-admin.yml up -d keycloak
```

Danach wieder schließen:

```bash
docker compose exec velydock velydock keycloak-admin --username admin --revoke
docker compose up -d
```

`keycloak-admin` vergibt die Rolle `realm-admin` des Realms `velydock`. Wer sie hat, kann in
Keycloak alles ändern – auch Passwörter aller Benutzer. Der Befehl braucht
`KEYCLOAK_BOOTSTRAP_SECRET` in `.env`.

Was Velydock bei jedem Start wieder auf seinen Sollzustand setzt (weil es das selbst verwaltet):
die Realm-Optionen aus `realm_settings` in `backend/velydock/idp/keycloak.py`, den Client
`velydock` und die Regel, dass nur Administratoren E-Mail-Adressen ändern.

Die Passwort-Richtlinie (mindestens 12 Zeichen, weder Benutzername noch E-Mail-Adresse) und die
Schwellenwerte des Brute-Force-Schutzes gehören nicht dazu. Velydock setzt sie nur einmal, beim
Anlegen des Realms, als Ausgangswerte. Wer sie in Keycloak verschärft, behält seine Einstellung;
Velydock setzt sie nicht zurück. Alles andere – weitere Clients, Föderationen, Identity Provider,
eigene Authentifizierungsabläufe – bleibt ebenfalls unangetastet.

## Protokolle und Diagnose

```bash
docker compose ps
docker compose logs -f velydock
docker compose logs -f keycloak
```

| Symptom | Ursache und Abhilfe |
|---|---|
| `velydock` startet nicht, Meldung „waiting for Keycloak“ | Keycloak braucht beim ersten Start länger; nach drei Minuten bricht Velydock ab und Compose startet es neu. |
| Anmeldung endet mit „Die Anmeldung wurde abgelehnt. Bitte versuch es erneut.“ | Velydock konnte die Antwort von Keycloak nicht prüfen. Den Grund nennt die Zeile `sign-in rejected: …` in `docker compose logs velydock`; eine falsche Uhrzeit des Servers gehört zu den Ursachen. |
| „The Velydock realm is not set up and no bootstrap credentials are configured“ | `KEYCLOAK_BOOTSTRAP_SECRET` fehlt beim ersten Start. |
| Anmeldeseite ohne Velydock-Aussehen | Der Dienst `theme` ist fehlgeschlagen: `docker compose logs theme`. |
| Eingebettete App bleibt leer | Die App verbietet das Einbetten oder liegt unter einer fremden Domain; siehe [anwendungsintegration.md](anwendungsintegration.md). |

## Hinweise für den Produktivbetrieb

- `.env` und Backups schützen: Wer sie hat, hat alle Konten.
- `KEYCLOAK_BOOTSTRAP_SECRET` wird nach dem ersten erfolgreichen Start nicht mehr benötigt. Der
  zugehörige Zugang im Realm `master` bleibt jedoch bestehen, bis er in Keycloak gelöscht wird;
  er ist von außen nicht erreichbar.
- Zwei-Faktor-Pflicht für Administratoren eingeschaltet lassen.
- Server-Uhrzeit synchron halten (Tokens haben kurze Gültigkeit).
- Keycloak und Velydock zeitnah aktualisieren.
- Velydock skaliert in dieser Version als einzelne Instanz; mehrere parallele `velydock`-Container
  sind möglich (Sitzungen liegen in der Datenbank), aber nicht getestet.
