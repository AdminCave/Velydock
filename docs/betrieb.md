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
# Steht in .env eine feste Version: VELYDOCK_IMAGE dort jetzt auf die neue Version setzen
docker compose pull           # neues Image
docker compose up -d
```

Wer das Image selbst baut (kein veröffentlichtes Release): statt `docker compose pull` erneut
`docker build -t ghcr.io/admincave/velydock:latest .` ausführen.

Beim Start wendet Velydock ausstehende Datenbankmigrationen an und gleicht Keycloak mit dem
eigenen Stand ab:

- **Realm-Einstellungen**, die Velydock braucht (Anmeldeablauf, Themes, Sprache, die beiden
  Clients). Passwort-Richtlinie und Schwellen des Brute-Force-Schutzes gehören dem Betreiber und
  bleiben unangetastet – außer die Richtlinie ist noch genau der Ausgangswert einer früheren
  Velydock-Version.
- **Organizations:** Zu jedem Mandanten gehört eine Organization mit dessen Kurznamen als Alias.
  Fehlt sie (in Keycloak gelöscht), wird sie mit ihren Mitgliedern neu angelegt; wurde sie dort
  umbenannt, deaktiviert oder reaktiviert, gilt wieder Velydocks Stand. Mitglieder, die jemand in
  Keycloak von Hand hinzugefügt hat, bleiben.
- Lässt sich eine Organization nicht in Ordnung bringen (etwa weil in Keycloak eine andere mit
  demselben Namen angelegt wurde), startet Velydock trotzdem und schreibt eine Zeile `ERROR …
  could not be brought in line with Keycloak` ins Log; betroffen ist dann nur dieser Mandant.
- **Konten** gleicht der Start nicht ab. Ein in Keycloak gelöschtes Konto erscheint im Log als
  `could not add … to organization` und bleibt in Velydock sichtbar, bis es dort gelöscht wird
  ([administration.md](administration.md#aktionen-je-benutzer)).

**Checkout und Image gehören zusammen.** Ein Update besteht immer aus beidem, und keines der
beiden meldet, wenn das andere fehlt – alle Dienste starten und sind „healthy“:

- Ohne `git pull` läuft das neue Image mit der alten Compose-Datei und den alten Routing-Regeln.
  Korrekturen, die dort liegen (Ratenbegrenzung, abgewiesene Pfade, Health-Checks), fehlen dann.
- Ohne neues Image läuft der alte Stand weiter. Das betrifft vor allem eine feste Version in
  `.env`: `docker compose pull` holt nichts Neues, solange `VELYDOCK_IMAGE` nicht angehoben ist.

Welches Image läuft, zeigt `docker compose ps` in der Spalte IMAGE.

**Wartungsfenster einplanen:** Jedes neue Velydock-Image startet auch Keycloak neu, nicht nur
eines mit geändertem Login-Theme. Der Dienst `theme` verwendet dasselbe Image wie `velydock`;
wird er neu angelegt, startet Compose Keycloak neu, und der neue `velydock`-Container startet
erst, wenn Keycloak wieder bereit ist. Anmeldung und Oberfläche sind bei jedem Update etwa eine
Minute lang nicht erreichbar.

**Routing-Regeln:** Traefik liest das Verzeichnis `deploy/traefik/dynamic/` aus dem Checkout und
beobachtet es. Geänderte Regeln gelten deshalb schon wenige Sekunden nach `git pull`, ohne
Neustart von Traefik – die drei Befehle also zusammen ausführen.

Auf Servern mit restriktiver umask (027, 077) nach `git pull` und **vor** `docker compose up -d`
die Leserechte wiederherstellen: `chmod -R o+rX deploy`. Was sonst geschieht, hängt davon ab, ob
Traefik gerade läuft:

- Kann ein laufender Traefik eine geänderte Datei nicht lesen, behält es die bisherigen Regeln
  und meldet den Fehler in `docker compose logs traefik`.
- Startet Traefik, während es das Verzeichnis nicht lesen kann, hat es gar keine Regeln: Alle
  Adressen antworten mit 404, im Log steht `Cannot start the provider`. Das `chmod` allein
  bemerkt Traefik dann nicht mehr – danach `docker compose restart traefik` ausführen.

Empfehlung: in `.env` eine feste Version eintragen (`VELYDOCK_IMAGE=ghcr.io/admincave/velydock:0.1.0`)
und vor jedem Update ein Backup anlegen.

Keycloak selbst wird über `KEYCLOAK_IMAGE` in `.env` aktualisiert
(`KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:<Version>`, danach `docker compose up -d`). Ohne die
Variable gilt die Version, mit der Velydock getestet ist; sie steht in `docker-compose.yml`. Die
Datei selbst dafür nicht ändern: Eine lokale Änderung dort lässt das nächste `git pull` scheitern.
Da Keycloak nur für die jeweils neueste Version Sicherheitskorrekturen liefert, gehören dessen
Updates zur regelmäßigen Wartung.

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

Schlägt ein Lauf fehl – zum Beispiel, weil PostgreSQL nicht läuft –, bleibt kein Verzeichnis
zurück, und das Skript endet mit einer Fehlermeldung und einem Status ungleich 0. Was
`velydock-<Zeitstempel>` heißt, ist ein vollständiges Backup.

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
chmod -R o+rX deploy                      # nur bei restriktiver umask (027, 077) nötig
docker compose up -d --wait               # legt leere Datenbanken an
./scripts/restore.sh /mnt/backup/velydock-20261120T020000Z
```

Das `chmod` übernimmt bei einer Neuinstallation `install.sh`, das auf diesem Weg nicht läuft: Mit
restriktiver umask geklonte Dateien unter `deploy/` können die Container nicht lesen. Ist der
erste Start daran schon gescheitert (PostgreSQL meldet `Permission denied` für
`10-init-databases.sh`, danach fehlen die Rollen `velydock` und `keycloak`), genügt das `chmod`
nicht mehr, denn das Datenverzeichnis ist dann ohne Datenbanken angelegt. Auf dem noch leeren
Server `docker compose down --volumes` ausführen und neu starten.

Das Skript prüft die Prüfsummen, fragt nach (Eingabe `restore`) und lässt PostgreSQL beide Dumps
einmal vollständig lesen. Erst danach hält es Velydock und Keycloak an, ersetzt beide Datenbanken
und startet alles wieder. Ein Backup, das eine der Prüfungen nicht besteht, lehnt es ab, bevor
etwas verändert ist („backup is damaged“ oder „Nothing was changed“).

Bricht die Wiederherstellung später doch ab, sind die Datenbanken unvollständig, und das Skript
sagt das. Den Stack dann **nicht** starten – Keycloak würde einen leeren Realm einrichten, in dem
sich niemand anmelden kann –, sondern das Skript mit einem intakten Backup erneut ausführen, bis
es „restore finished“ meldet.

Wo niemand antworten kann (kein Terminal, Aufruf aus einem anderen Programm), bricht das Skript
an der Rückfrage ab; `VELYDOCK_RESTORE_CONFIRM=yes` ersetzt sie.

Nach der Wiederherstellung gilt in allem der Stand des Backups, auch bei den Sitzungen: Wer sich
später angemeldet hat, meldet sich neu an. Sitzungen, die beim Backup bestanden, gelten dagegen
wieder – auch solche, die seither beendet wurden –, bis sie durch Leerlauf oder Höchstdauer
ablaufen. Ebenso sind Konten, die nach dem Backup gesperrt oder gelöscht wurden, wieder da.

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
keine Antwort-Header entfernen. Anfragen über 4 MB weist Velydock selbst ab. Die Pfade `/admin/`
und `/realms/master/` von Keycloak dürfen von außen nicht erreichbar sein.

`X-Forwarded-For` muss der Proxy **setzen, nicht ergänzen**: Er trägt die Adresse ein, von der
die Verbindung kommt, und verwirft, was der Client in diesem Header mitgeschickt hat. Mit nginx:

```nginx
proxy_set_header Host              $http_host;    # für VELYDOCK_HOST und SANDBOX_HOST
proxy_set_header X-Forwarded-For   $remote_addr;  # nicht $proxy_add_x_forwarded_for
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host  $http_host;
```

Hängt der Proxy seine Adresse nur an (in nginx-Anleitungen üblich: `$proxy_add_x_forwarded_for`),
bestimmt ein Client aus einem privaten Netz – Büro, VPN – selbst, welche Adresse im Protokoll
steht: Velydock hält private Adressen für Proxys und liest dann den Eintrag davor, den der Client
geschickt hat.

Velydock glaubt `X-Forwarded-For` nur von Proxys in privaten Netzen. Steht der Proxy unter einer
öffentlichen Adresse, gehört diese in `VELYDOCK_TRUSTED_PROXIES` in `.env`
([installation.md](installation.md#verhalten)); sonst steht im Protokoll die Adresse des Proxys
statt der des Clients.

Drei Dinge erledigt sonst der mitgelieferte Traefik, ein eigener Proxy sollte sie übernehmen:

- Er begrenzt die Anfragen an `/api/` je Client-Adresse (im Mittel 100 pro Sekunde, kurzzeitig
  bis 300).
- Er begrenzt auf dem Hostnamen von Keycloak die Anfragen an `/realms/velydock/login-actions/`
  und `/realms/velydock/protocol/openid-connect/token` je Client-Adresse (im Mittel 20 pro
  Sekunde, kurzzeitig bis 60). Dort prüft Keycloak Passwörter, Einmalcodes und
  Client-Geheimnisse. Eine Anmeldung braucht zwei bis sieben solcher Anfragen, ein Büro hinter
  einer gemeinsamen Adresse kommt damit auch morgens um neun durch. Alles Übrige von Keycloak –
  die Anmeldeseite selbst, statische Dateien, Discovery-Dokumente, Schlüssel – ist nicht
  begrenzt. Die Grenze bremst das Durchprobieren von Passwörtern von einer Adresse aus. Sie
  verhindert nicht, dass jemand ein bekanntes Konto mit wenigen falschen Passwörtern
  vorübergehend sperrt; dafür sind die Schwellenwerte von Keycloaks Brute-Force-Schutz zuständig.
- Er weist Anfragen ab, deren Pfad einen kodierten Schrägstrich (`%2F`) enthält. Velydock
  dekodiert ihn zu `/`; ein Proxy, der Regeln nach Pfad anwendet, ließe sich sonst mit
  `/api%2F…` umgehen.

Wer eine der beiden Grenzen überschreitet, erhält `429 Too Many Requests`.

Velydock hält ungenutzte Verbindungen des Proxys 120 Sekunden offen. Der Proxy sollte seine
eigenen früher schließen (Traefik: 90 s, nginx: 60 s – beides die Voreinstellung); schlösse
Velydock zuerst, träfe gelegentlich eine Anfrage auf eine gerade beendete Verbindung und der
Proxy meldete `502 Bad Gateway`.

## Zugang zur Keycloak-Verwaltung

Für Aufgaben, die Velydock nicht abdeckt (Apps per OIDC anbinden, LDAP/AD, externe Identity
Provider, Passwort-Richtlinie), wird Keycloaks eigene Verwaltungskonsole gebraucht. Sie ist von
außen nicht erreichbar und wird nur bei Bedarf auf `localhost` des Servers geöffnet:

```bash
# 1. Konsole auf 127.0.0.1:8081 des Servers öffnen. Keycloak startet dabei neu; --wait kehrt
#    zurück, sobald es wieder antwortet (etwa eine Minute) – vorher scheitert Schritt 2.
docker compose -f docker-compose.yml -f docker-compose.keycloak-admin.yml up -d --wait keycloak

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
               -f docker-compose.keycloak-admin.yml up -d --wait keycloak
```

Danach wieder schließen:

```bash
docker compose exec velydock velydock keycloak-admin --username admin --revoke
docker compose up -d
```

`keycloak-admin` vergibt die Rolle `realm-admin` des Realms `velydock`. Wer sie hat, kann in
Keycloak alles ändern – auch Passwörter aller Benutzer. Der Befehl braucht
`KEYCLOAK_BOOTSTRAP_SECRET` in `.env`, und zwar den Wert, mit dem die Installation angelegt
wurde ([installation.md](installation.md#geheimnisse-tauschen)).

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

Docker bewahrt je Container höchstens fünf Protokolldateien zu 10 MB auf (`logging` in
`docker-compose.yml`); ältere Zeilen fallen weg.

| Symptom | Ursache und Abhilfe |
|---|---|
| `velydock` startet nicht, Meldung „waiting for Keycloak“ | Keycloak braucht beim ersten Start länger; nach drei Minuten bricht Velydock ab und Compose startet es neu. |
| Anmeldung endet mit „Die Anmeldung wurde abgelehnt. Bitte versuch es erneut.“ | Velydock konnte die Antwort von Keycloak nicht prüfen. Den Grund nennt die Zeile `sign-in rejected: …` in `docker compose logs velydock`; eine falsche Uhrzeit des Servers gehört zu den Ursachen. |
| `docker compose` bricht ab mit „required variable KEYCLOAK_BOOTSTRAP_SECRET is missing a value“ | Der Wert fehlt in `.env` oder ist leer. Keycloak startet ohne ihn nicht, deshalb verweigert schon Compose den Start. Den ursprünglichen Wert wieder eintragen; er steht in der Datei `env` jedes Backups. |
| `velydock` startet immer wieder neu oder `keycloak-admin` scheitert, jeweils mit „identity provider rejected the service account (401)“ | Ein Geheimnis in `.env` passt nicht mehr zu Keycloak: `KEYCLOAK_BOOTSTRAP_SECRET` wurde geändert, oder `VELYDOCK_IDP_ADMIN_CLIENT_SECRET` wurde geändert, während das Bootstrap-Geheimnis nicht mehr stimmte. Die vorherigen Werte wieder eintragen ([installation.md](installation.md#geheimnisse-tauschen)). |
| Keycloak oder `velydock` starten immer wieder neu, im Log von PostgreSQL steht `password authentication failed` | Ein Datenbank-Passwort wurde nur in `.env` geändert. Die Schritte unter [Geheimnisse tauschen](installation.md#geheimnisse-tauschen) nachholen oder den alten Wert wieder eintragen. |
| Alle Adressen antworten mit 404 | Traefik konnte beim Start `deploy/traefik/dynamic/` nicht lesen (`Cannot start the provider` in `docker compose logs traefik`): `chmod -R o+rX deploy`, dann `docker compose restart traefik`. |
| `429 Too Many Requests` | Die Ratenbegrenzung des mitgelieferten Traefik für diese Client-Adresse hat gegriffen ([Eigener Reverse Proxy](#eigener-reverse-proxy) nennt die Grenzen); kurz warten. |
| Anmeldeseite ohne Velydock-Aussehen | Der Dienst `theme` ist fehlgeschlagen: `docker compose logs theme`. |
| Eingebettete App bleibt leer | Die App verbietet das Einbetten oder liegt unter einer fremden Domain; siehe [anwendungsintegration.md](anwendungsintegration.md). |

## Hinweise für den Produktivbetrieb

- `.env` und Backups schützen: Wer sie hat, hat alle Konten.
- `KEYCLOAK_BOOTSTRAP_SECRET` muss in `.env` stehen bleiben: Keycloak startet ohne den Wert nicht,
  und Compose verweigert deshalb den Start. Velydock selbst braucht ihn nach dem ersten Start nur
  noch für `keycloak-admin` und für den Tausch des Dienstzugang-Geheimnisses. Der zugehörige
  Zugang im Realm `master` ist von außen nicht erreichbar.
- Zwei-Faktor-Pflicht für Administratoren eingeschaltet lassen.
- Server-Uhrzeit synchron halten (Tokens haben kurze Gültigkeit).
- Keycloak und Velydock zeitnah aktualisieren.
- Velydock skaliert in dieser Version als einzelne Instanz; mehrere parallele `velydock`-Container
  sind möglich (Sitzungen liegen in der Datenbank), aber nicht getestet.
