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

## Der Befehl `velydock`

Der Installer ([installation.md](installation.md#installation-mit-dem-installer)) richtet den
Befehl `velydock` ein. Er arbeitet immer auf der Installation, in deren Verzeichnis er liegt
(`/opt/velydock/scripts/velydock`; `/usr/local/bin/velydock` ruft ihn dort auf), und braucht
root, weil `.env` nur für root lesbar ist.

| Befehl | Was er tut |
|---|---|
| `velydock status` | Version, Adresse und der Zustand jedes Containers. Status 1, wenn etwas nicht läuft. |
| `velydock start [--pull]` | Startet alles und kehrt zurück, wenn es bereit ist. Übernimmt auch eine geänderte `.env`. Mit `--pull` werden vorher alle Images neu geholt. |
| `velydock stop` | Hält alles an. Daten bleiben. |
| `velydock restart [Dienst …]` | Startet alles oder einzelne Dienste neu und wartet, bis alles bereit ist. |
| `velydock logs [-f] [--tail N] [Dienst …]` | Protokolle; ohne Angabe die letzten 200 Zeilen jedes Dienstes. |
| `velydock update [--version X] [--no-backup] [--yes]` | [Update](#update) auf das neueste oder ein genanntes Release. |
| `velydock backup [Verzeichnis] [--keep N]` | [Backup](#backup) beider Datenbanken und der `.env`. |
| `velydock restore <Backup-Verzeichnis> [--yes]` | [Wiederherstellung](#wiederherstellung). |
| `velydock admin --username NAME [--email ADRESSE]` | Legt einen Administrator an oder stellt einen Zugang wieder her ([installation.md](installation.md#ersten-administrator-anlegen)). |
| `velydock cert list`, `cert add <Zertifikat> <Schlüssel> [--name N] [--replace]`, `cert remove <Name>` | Eigene Zertifikate. |
| `velydock doctor` | [Diagnose](#protokolle-und-diagnose), eine Zeile je Prüfung. Verändert nichts. |
| `velydock uninstall [--purge] [--yes]` | [Deinstallation](#deinstallation). |
| `velydock version`, `velydock help` | Installierte Version; alle Befehle. |

Dienste heißen `velydock`, `keycloak`, `postgres` und `traefik`. Die Meldungen des Befehls sind
englisch, wie die der Skripte und des Backends, die er aufruft.

Der Befehl liest die Konfiguration ausschließlich aus `.env`. Variablen aus der Umgebung des
Aufrufers, die Compose sonst vorziehen würde (`VELYDOCK_HOST`, `COMPOSE_PROJECT_NAME` …), haben
keine Wirkung.

Bei einer [Installation von Hand](installation.md#installation-von-hand) aus dem Git-Checkout
gibt es den Befehl nicht. Dort gelten die `docker compose`-Befehle und Skripte, die in den
folgenden Abschnitten jeweils unter „Von Hand“ stehen – sie funktionieren im
Installationsverzeichnis des Installers ebenso.

## Update

### Mit dem Befehl

```bash
sudo velydock update                     # auf das neueste Release
sudo velydock update --version 1.2.3     # auf ein bestimmtes
```

Der Befehl

1. ermittelt die Zielversion und fragt nach (`--yes` unterdrückt die Rückfrage);
2. lädt das Paket des Releases und prüft es gegen dessen `SHA256SUMS` – passt die Prüfsumme
   nicht, ist nichts verändert;
3. legt ein [Backup](#backup) an (`--no-backup` lässt es weg). Schlägt das Backup fehl, bricht
   das Update ab, bevor etwas verändert ist;
4. bewahrt die bisherigen Programmdateien in `.previous/<alte Version>/` auf und die bisherige
   Zeile `VELYDOCK_IMAGE` in `.previous/<alte Version>.image`. Es bleibt immer nur der Stand vor
   dem letzten Update;
5. ersetzt die Programmdateien an Ort und Stelle, Datei für Datei. Dateien, die das neue Release
   nicht mehr enthält, entfernt er; alles, was nicht aus einem Release stammt, bleibt
   unangetastet. Wurde eine Programmdatei auf dem Server geändert, nennt er sie – deine Fassung
   liegt dann in `.previous/`;
6. trägt das Image des neuen Releases in `.env` ein, holt die Images, startet
   (`docker compose up -d --wait`), prüft, dass alle Container laufen, und meldet
   „alte Version -> neue Version“.

Ist die gewünschte Version schon installiert, tut er nichts. Eine ältere Version lehnt er ab.

**Zurück zur vorigen Version** führt über das Backup, nicht über die alten Programmdateien
allein: Die neue Version hat beim Start womöglich die Datenbank verändert (Migrationen), und mit
diesem Stand kann die alte dann nicht arbeiten. Der Weg von Hand:

```bash
cd /opt/velydock
sudo cp -a .previous/1.2.2/. .                 # Programmdateien der vorigen Version
# das Image der vorigen Version wieder in .env eintragen
sudo sed -i "s|^VELYDOCK_IMAGE=.*|VELYDOCK_IMAGE=$(sudo cat .previous/1.2.2.image)|" .env
sudo velydock restore backups/velydock-…       # das Backup, das vor dem Update angelegt wurde
sudo velydock doctor
```

Alles, was seit dem Backup geändert wurde, ist danach verloren. Dateien, die erst die neuere
Version mitgebracht hat, bleiben beim Zurückkopieren liegen; Routing-Regeln darunter lädt der
Proxy weiterhin. `velydock doctor` nennt sie („routing rules that are not part of release …“) –
lösche, was nicht von dir stammt. Später führt `velydock update` wieder vorwärts.

Wer einen eigenen Spiegel für das Image verwendet, gibt es bei jedem Update an:
`velydock update --image registry.example.com/velydock:1.2.3`.

### Von Hand

Im Git-Checkout:

```bash
git pull                      # neue Compose-Datei, Skripte und Routing-Regeln
# Steht in .env eine feste Version: VELYDOCK_IMAGE dort jetzt auf die neue Version setzen
docker compose pull           # neues Image
docker compose up -d
```

Wer das Image selbst baut (kein veröffentlichtes Release): statt `docker compose pull` erneut
`docker build -t ghcr.io/admincave/velydock:latest .` ausführen.

### Was bei jedem Update geschieht

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

**Programmdateien und Image gehören zusammen.** `velydock update` tauscht beides in einem
Schritt. Von Hand besteht ein Update immer aus beidem, und keines der beiden meldet, wenn das
andere fehlt – alle Dienste starten und sind „healthy“:

- Ohne `git pull` läuft das neue Image mit der alten Compose-Datei und den alten Routing-Regeln.
  Korrekturen, die dort liegen (Ratenbegrenzung, abgewiesene Pfade, Health-Checks), fehlen dann.
- Ohne neues Image läuft der alte Stand weiter. Das betrifft vor allem eine feste Version in
  `.env`: `docker compose pull` holt nichts Neues, solange `VELYDOCK_IMAGE` nicht angehoben ist.

Welches Image läuft, zeigt `docker compose ps` in der Spalte IMAGE. `velydock doctor` meldet, wenn
`VELYDOCK_IMAGE` in `.env` nicht das Image des installierten Releases ist.

**Wartungsfenster einplanen:** Jedes neue Velydock-Image startet auch Keycloak neu, nicht nur
eines mit geändertem Login-Theme. Der Dienst `theme` verwendet dasselbe Image wie `velydock`;
wird er neu angelegt, startet Compose Keycloak neu, und der neue `velydock`-Container startet
erst, wenn Keycloak wieder bereit ist. Anmeldung und Oberfläche sind bei jedem Update etwa eine
Minute lang nicht erreichbar.

**Routing-Regeln:** Traefik liest das Verzeichnis `deploy/traefik/dynamic/` aus dem Checkout und
beobachtet es. Geänderte Regeln gelten deshalb schon wenige Sekunden nach `git pull`, ohne
Neustart von Traefik – die drei Befehle also zusammen ausführen.

Auf Servern mit restriktiver umask (027, 077) nach `git pull` und **vor** `docker compose up -d`
die Leserechte wiederherstellen: `chmod -R o+rX deploy` (`velydock update` setzt sie selbst). Was
sonst geschieht, hängt davon ab, ob Traefik gerade läuft:

- Kann ein laufender Traefik eine geänderte Datei nicht lesen, behält es die bisherigen Regeln
  und meldet den Fehler in `docker compose logs traefik`.
- Startet Traefik, während es das Verzeichnis nicht lesen kann, hat es gar keine Regeln: Alle
  Adressen antworten mit 404, im Log steht `Cannot start the provider`. Das `chmod` allein
  bemerkt Traefik dann nicht mehr – danach `docker compose restart traefik` ausführen.

Empfehlung für den Git-Checkout: in `.env` eine feste Version eintragen
(`VELYDOCK_IMAGE=ghcr.io/admincave/velydock:0.1.0`) und vor jedem Update ein Backup anlegen. Der
Installer und `velydock update` tragen von sich aus das Image des Releases mit seinem Digest ein.

Keycloak selbst wird über `KEYCLOAK_IMAGE` in `.env` aktualisiert
(`KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:<Version>`, danach `docker compose up -d`). Ohne die
Variable gilt die Version, mit der Velydock getestet ist; sie steht in `docker-compose.yml`. Die
Datei selbst dafür nicht ändern: Eine lokale Änderung dort lässt das nächste `git pull` scheitern.
Da Keycloak nur für die jeweils neueste Version Sicherheitskorrekturen liefert, gehören dessen
Updates zur regelmäßigen Wartung.

## Backup

```bash
sudo velydock backup                     # nach VELYDOCK_BACKUP_DIR, sonst backups/ der Installation
sudo velydock backup /mnt/backup         # anderes Zielverzeichnis
sudo velydock backup --keep 14           # danach nur die 14 neuesten Backups dort behalten
```

Von Hand, im Git-Checkout oder im Installationsverzeichnis:

```bash
./scripts/backup.sh               # schreibt nach backups/velydock-<Zeitstempel>/
./scripts/backup.sh /mnt/backup   # anderes Zielverzeichnis
```

`velydock backup` ruft dasselbe Skript auf. Ohne `--keep` gilt `VELYDOCK_BACKUP_KEEP` aus `.env`;
steht auch dort nichts, wird nichts gelöscht. Aufgeräumt wird nur nach einem gelungenen Backup,
und entfernt wird nur, was ein vollständiges Backup dieses Skripts ist: ein Verzeichnis
`velydock-<Zeitstempel>` mit `SHA256SUMS`, das nichts als die vier Dateien eines Backups enthält.
Alles andere im Zielverzeichnis bleibt liegen, auch ein Backup, in das jemand eine eigene Datei
gelegt hat.

Hat der Installer nächtliche Backups eingerichtet, startet der systemd-Timer
`velydock-backup.timer` jede Nacht `velydock backup` mit den Werten aus `.env`. Ob es lief:
`systemctl list-timers velydock-backup.timer`, `journalctl -u velydock-backup.service`;
`velydock doctor` warnt, wenn das letzte Backup älter als zwei Tage ist.

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
verschlüsselt und nicht auf denselben Server – auch die nächtlichen Backups des Installers liegen
zunächst nur auf dem Server selbst und müssen von dort weiterkopiert werden. Ohne den Timer des
Installers genügt für regelmäßige Sicherungen ein Cron-Eintrag:

```
30 2 * * *  cd /opt/velydock && ./scripts/backup.sh /mnt/backup >> /var/log/velydock-backup.log 2>&1
```

Beide Datenbanken gehören zusammen: Velydock verweist auf Keycloak-Benutzer über deren ID. Immer
beide sichern und beide zurückspielen.

## Wiederherstellung

Auf dem bestehenden Server:

```bash
sudo velydock restore /opt/velydock/backups/velydock-20261120T020000Z     # mit dem Befehl
./scripts/restore.sh backups/velydock-20261120T020000Z                    # von Hand
```

`velydock restore` ruft dasselbe Skript auf und wartet danach, bis alles wieder bereit ist;
`--yes` ersetzt die Rückfrage.

Auf einem neuen Server, mit dem Installer. Die Datenbanken des Backups funktionieren nur mit der
`.env` des alten Servers; sie muss deshalb an ihrem Platz liegen, bevor die Datenbanken angelegt
werden. Der Installer legt aber eine neue `.env` und neue, leere Datenbanken an – die werden
verworfen:

```bash
# 1. Normal installieren, und zwar die Version des Backups: Sie steht in der Zeile
#    VELYDOCK_IMAGE der Datei "env" im Backup. Hostnamen wie auf dem alten Server.
curl -fsSL https://github.com/AdminCave/Velydock/releases/latest/download/install.sh |
  sudo bash -s -- --version 1.2.3

# 2. Die eben angelegten, leeren Datenbanken verwerfen
cd /opt/velydock && sudo docker compose down --volumes

# 3. Konfiguration und Geheimnisse des alten Servers einsetzen
sudo install -m 600 /mnt/backup/velydock-20261120T020000Z/env /opt/velydock/.env

# 4. Starten (legt leere Datenbanken mit den alten Geheimnissen an), dann zurückspielen
sudo velydock start
sudo velydock restore /mnt/backup/velydock-20261120T020000Z
```

Danach gilt wieder, was in der alten `.env` stand – auch das Verzeichnis und die Anzahl der
Backups. Der Administrator, den der Installer in Schritt 1 angelegt hat, ist mit den verworfenen
Datenbanken verschwunden; es gelten die Konten des Backups.

Auf einem neuen Server, von Hand:

```bash
git clone https://github.com/AdminCave/Velydock.git && cd Velydock
cp /mnt/backup/velydock-20261120T020000Z/env .env
chmod -R o+rX deploy                      # nur bei restriktiver umask (027, 077) nötig
docker compose up -d --wait               # legt leere Datenbanken an
./scripts/restore.sh /mnt/backup/velydock-20261120T020000Z
```

Das `chmod` übernimmt bei einer Neuinstallation `scripts/install.sh`, das auf diesem Weg nicht
läuft: Mit restriktiver umask geklonte Dateien unter `deploy/` können die Container nicht lesen.
Ist der erste Start daran schon gescheitert (PostgreSQL meldet `Permission denied` für
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

## Apps über den Proxy veröffentlichen

Velydock kann interne Anwendungen über den mitgelieferten Traefik ins Internet stellen
([anwendungsintegration.md](anwendungsintegration.md#apps-über-den-proxy-veröffentlichen)). Die
Funktion ist aus, solange `APPS_HOST` in `.env` leer ist.

**Einrichten**

1. Einen vierten Hostnamen wählen, zum Beispiel `apps.example.com`. Er muss ein eigener Name
   sein, und keiner der drei anderen darf unter ihm liegen (`apps.example.com`, nicht
   `example.com`): Unter `<name>.APPS_HOST` darf sich nie die Adresse von Velydock, der Sandbox
   oder der Anmeldung bilden lassen. Velydock verweigert sonst den Start.
2. DNS: `apps.example.com` auf den Server zeigen lassen. Für Apps mit eigener Subdomain
   zusätzlich `*.apps.example.com` (Wildcard) oder je App ein eigener Eintrag.
3. In `.env` `APPS_HOST=apps.example.com` eintragen – der Installer hat das bereits getan, wenn
   bei der Installation ein Hostname für veröffentlichte Apps gewählt wurde.
   `VELYDOCK_PROXY_SECRET` haben der Installer und `scripts/install.sh` bereits erzeugt; in einer
   älteren `.env` ergänzen (`openssl rand -hex 32`).
4. `sudo velydock start` oder `docker compose up -d`.
5. Als Systemadministrator je Organisation freigeben, welche internen Adressen sie
   veröffentlichen darf (*System → Organisationen*). Ohne Freigabe lässt sich nichts
   veröffentlichen.
6. Teilen sich mehrere Organisationen die Installation, die einander nicht vertrauen: für sie
   dort die Pfad-Adressen abschalten. Apps unter `apps.example.com/name/` sind für den Browser
   *eine* Website; nur Subdomains trennen sie
   ([sicherheit.md](sicherheit.md#veröffentlichte-apps-proxy)).

**Zertifikate.** Für jeden veröffentlichten Hostnamen holt Traefik ein eigenes Zertifikat von
Let's Encrypt, sobald die App veröffentlicht ist und der DNS-Eintrag stimmt. Let's Encrypt
begrenzt die Zahl neuer Zertifikate je Domain und Woche (derzeit 50) – wer viele Apps auf
Subdomains veröffentlicht, plant das ein oder nutzt den Pfad-Modus, der mit dem einen Zertifikat
von `APPS_HOST` auskommt.

**Was der Proxy erreichen muss.** Traefik baut die Verbindung zur internen Adresse auf. Sie muss
vom Server aus erreichbar sein (Routing, Firewall). Adressen dieser Installation selbst –
Datenbank, Keycloak, Velydock, `localhost` – nimmt Velydock nie als Ziel an, auch wenn ein Netz
freigegeben wurde, in dem sie liegen.

**Wie die Routen zu Traefik kommen.** Traefik fragt Velydock alle fünf Sekunden nach den Routen
(`/internal/proxy/traefik`, nur im internen Netz und nur mit `VELYDOCK_PROXY_SECRET`). Eine
Änderung in der Oberfläche wirkt also nach wenigen Sekunden, ohne Neustart. Ist Velydock nicht
erreichbar, behält Traefik die letzten Routen; geschützte Apps antworten dann mit einem Fehler,
öffentliche laufen weiter.

**Wenn eine Änderung nicht ankommt.** `docker compose logs traefik` zeigt, was Traefik mit den
Routen gemacht hat. `Provider error` heißt, dass es das ganze Dokument abgelehnt hat und beim
alten Stand geblieben ist – Velydock prüft Eingaben so, dass das nicht vorkommen sollte; wenn
doch, ist es ein Fehler in Velydock. Eine Meldung mit `routerName=vd-…` betrifft nur diese eine
App, meist wegen eines eigenen Bausteins in ihrer Vorlage (ungültiges Netz, fehlerhafter
Ausdruck).

**Ratenbegrenzung.** Der Umweg über Velydocks Anmeldung (`/proxy/login`) fällt unter dieselbe
Begrenzung wie die API. Die veröffentlichten Apps selbst haben keine voreingestellte; sie lässt
sich je App oder Vorlage setzen („Anfragen begrenzen“).

**Eigener Reverse Proxy.** Ohne den mitgelieferten Traefik (`COMPOSE_PROFILES` leer) gibt es die
Funktion nicht: Die Routen sind in Traefiks Format.

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
sudo velydock doctor              # Diagnose, eine Zeile je Prüfung
sudo velydock status
sudo velydock logs -f velydock
```

Von Hand, im Verzeichnis der Installation:

```bash
docker compose ps
docker compose logs -f velydock
docker compose logs -f keycloak
```

Docker bewahrt je Container höchstens fünf Protokolldateien zu 10 MB auf (`logging` in
`docker-compose.yml`); ältere Zeilen fallen weg.

`velydock doctor` verändert nichts. Jede Zeile beginnt mit `[ ok ]`, `[warn]`, `[FAIL]` oder
`[info]`; der Befehl endet mit Status 1, wenn mindestens eine Prüfung fehlgeschlagen ist
(Warnungen ändern den Status nicht). Geprüft wird:

- jeder Container: läuft er, und ist er „healthy“;
- `.env` ist nur für ihren Besitzer lesbar;
- jeder Hostname lässt sich auflösen und zeigt auf eine Adresse dieses Servers (sonst Warnung);
- die Ports des Proxys antworten lokal, und Velydock antwortet durch den Proxy (`/api/health`);
- mit welchem Zertifikat jeder Hostname tatsächlich ausgeliefert wird (`openssl s_client`), bis
  wann es gilt und ob es den Namen abdeckt. Weniger als 14 Tage Restlaufzeit sind eine Warnung,
  ein abgelaufenes Zertifikat ein Fehler. Liefert der Proxy sein selbstsigniertes Zertifikat aus,
  ist das mit Let's Encrypt ein Fehler (es wurde keines ausgestellt), sonst eine Warnung;
- freier Speicherplatz für Docker, die Installation und die Backups (Warnung unter 5 GB, Fehler
  unter 1 GB);
- das letzte Backup (Warnung, wenn es fehlt oder älter als zwei Tage ist) und der Backup-Timer;
- ob die Programmdateien und das Image in `.env` die des installierten Releases sind;
- die installierte Version gegenüber dem neuesten Release.

Mit eigenem Reverse Proxy (`COMPOSE_PROFILES` ohne `proxy`) entfallen die Prüfungen der Ports
und Zertifikate.

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

## Deinstallation

```bash
sudo velydock uninstall            # Container entfernen; alle Daten bleiben
sudo velydock uninstall --purge    # alles entfernen
```

Ohne `--purge` hält der Befehl Velydock an und entfernt die Container, den Befehl in
`/usr/local/bin` und den Backup-Timer. Die Datenbanken (Docker-Volumes), `.env`, die
Programmdateien und die Backups bleiben. Zurück führt ein erneuter Lauf des Installers – er legt
Befehl und Timer wieder an und verändert sonst nichts – und danach `velydock start`.

Mit `--purge` verlangt der Befehl, dass der Hostname der Installation eingetippt wird (`--yes`
ersetzt das). Dann entfernt er zusätzlich die Volumes mit beiden Datenbanken, `.env`, die
Programmdateien, `.previous/` und die Backups im Installationsverzeichnis. Was dort liegt und
nicht von Velydock stammt, bleibt und wird genannt. Nicht angefasst werden ein
Backup-Verzeichnis außerhalb der Installation, das Protokoll `/var/log/velydock-install.log` und
Docker selbst.

Bei einer Installation von Hand: `docker compose down` beziehungsweise
`docker compose down --volumes` im Checkout.

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
