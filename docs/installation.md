# Installation, Konfiguration und erste Einrichtung

## Voraussetzungen

- Ein Linux-Server mit x86_64-Prozessor (das Image gibt es nur für amd64).
- Docker Engine und das Compose-Plugin ab Version 2.17 (`docker compose version`). Unter Debian
  und Ubuntu richtet der Installer Docker auf Wunsch selbst ein.
- Mindestens 2 GB freier Arbeitsspeicher; Keycloak allein belegt rund 1 GB.
- Drei DNS-Namen, die auf den Server zeigen, zum Beispiel:

  | Name | Zweck |
  |---|---|
  | `dock.example.com` | Velydock (Oberfläche und API) |
  | `auth.example.com` | Keycloak (Anmeldeseite) |
  | `sandbox.example.com` | Auslieferung eigener Apps – muss ein eigener Name sein |

  Ein vierter (`apps.example.com`) ist optional: für Apps, die Velydocks Proxy veröffentlicht
  ([betrieb.md](betrieb.md#apps-über-den-proxy-veröffentlichen)).
- Ports 80 und 443 frei und von außen erreichbar (für Let's Encrypt). Wer einen eigenen Reverse
  Proxy betreibt, siehe [betrieb.md](betrieb.md#eigener-reverse-proxy).

**Wahl der Domain:** Apps, die in Velydock eingebettet werden sollen, funktionieren nur
zuverlässig, wenn sie unter derselben registrierbaren Domain laufen wie Velydock (z. B.
`cloud.example.com` neben `dock.example.com`). Sonst behandeln Browser ihre Cookies als
Drittanbieter-Cookies. Hintergrund in [anwendungsintegration.md](anwendungsintegration.md).

## Installation mit dem Installer

```bash
curl -fsSL https://github.com/AdminCave/Velydock/releases/latest/download/install.sh | sudo bash
```

**Diese Zeile braucht ein veröffentlichtes Release, und noch gibt es keines.** Der Installer
selbst, das Paket, das er lädt, und das Image auf GHCR entstehen erst, wenn ein Tag `v…` den
Workflow `release.yml` auslöst. Bis dahin findet schon `curl` die Datei nicht, und ein Installer
aus dem Git-Checkout meldet, dass er kein Release findet; verändert wird in beiden Fällen nichts.
So lange führt der Weg über die [Installation von Hand](#installation-von-hand).

Wer nichts ungelesen in eine Shell leiten möchte, lädt die Datei erst und startet sie dann:

```bash
curl -fsSLO https://github.com/AdminCave/Velydock/releases/latest/download/install.sh
sudo bash install.sh
```

Der Installer spricht Deutsch, wenn die Umgebung deutsch eingestellt ist, sonst Englisch
(`--lang de|en`). Er geht in dieser Reihenfolge vor:

1. **Prüfen, bevor etwas verändert wird.** Jede Prüfung ist eine Zeile:
   - root, Linux, x86_64;
   - Arbeitsspeicher (unter 2 GB nur eine Warnung);
   - Docker, das Compose-Plugin ab 2.17 und ein Daemon, der antwortet;
   - mindestens 3 GB frei im Datenverzeichnis von Docker, 300 MB im Installationsverzeichnis;
   - die Ports 80 und 443 – ist einer belegt, steht dabei, von wem;
   - kein Compose-Projekt `velydock` und kein Volume `velydock_postgres-data` einer früheren
     Installation (deren Datenbanken funktionieren nur mit ihrer alten `.env`);
   - ob die Hostnamen auf eine Adresse dieses Servers zeigen. Das ist nur eine Warnung mit den
     gefundenen Adressen: Hinter NAT oder einem Load Balancer ist eine andere Adresse richtig.
2. **Docker fehlt:** Unter Debian und Ubuntu fragt der Installer, ob er Docker Engine aus dem
   offiziellen Docker-Repository (`download.docker.com`) installieren soll. Auf anderen Systemen
   erklärt er, was fehlt, und endet.
3. **Fragen** – jede mit einer Vorgabe; eine ungültige Antwort wird erklärt und erneut erfragt.
4. **Zusammenfassung und Rückfrage.** Erst danach wird etwas geschrieben.
5. **Installieren:** Der Installer lädt das Paket `velydock-<Version>.tar.gz` und die Datei
   `SHA256SUMS` desselben Releases, prüft die Prüfsumme (vorher wird nichts daraus ausgeführt),
   entpackt nach `/opt/velydock`, schreibt `.env` mit frisch erzeugten Geheimnissen (nur für root
   lesbar), trägt dort das Image des Releases mit seinem Digest ein, lädt die Images, startet
   alles (`docker compose up -d --wait`), legt den ersten Administrator an und zeigt Adresse,
   Benutzername und Einmalpasswort – das Passwort nur dieses eine Mal.

Die Prüfsumme schützt vor einem beschädigten oder unvollständigen Download. Sie stammt aus
demselben Release wie das Paket; ein Beweis, dass das Release selbst echt ist, ist sie nicht.

### Was der Installer fragt

| Frage | Vorgabe | Option |
|---|---|---|
| Basis-Domain – daraus werden `dock.`, `auth.`, `sandbox.` und `apps.` vorgeschlagen. Leer lassen, um jeden Namen selbst einzugeben. | – | `--domain` |
| Hostname von Velydock, der Anmeldung, der Sandbox | aus der Basis-Domain | `--velydock-host`, `--keycloak-host`, `--sandbox-host` |
| Hostname für veröffentlichte Apps; `-` schaltet die Funktion ab | `apps.<Domain>`; ohne Basis-Domain: aus | `--apps-host` |
| Zertifikate: `letsencrypt`, `own` oder `selfsigned` | `letsencrypt` | `--tls` |
| E-Mail-Adresse für Let's Encrypt (nur `letsencrypt`) | – | `--acme-email` |
| Zertifikatsdatei mit Kette und Schlüsseldatei, beide PEM (nur `own`) | – | `--cert`, `--key` |
| Erster Administrator: Benutzername, E-Mail-Adresse | `admin`, die Adresse für Let's Encrypt | `--admin-user`, `--admin-email` |
| Installationsverzeichnis | `/opt/velydock` | `--dir` |
| Nächtliche Backups: ja oder nein, Zielverzeichnis, Anzahl aufbewahrter Backups | ja, `<Verzeichnis>/backups`, 14 | `--no-backup`, `--backup-dir`, `--backup-keep` |

Hostnamen werden klein geschrieben und müssen sich unterscheiden. Keiner der drei anderen darf
der Hostname für veröffentlichte Apps sein oder unter ihm liegen (`apps.example.com`, nicht
`example.com`).

Die drei Arten von Zertifikaten:

| `--tls` | Bedeutung |
|---|---|
| `letsencrypt` | Der mitgelieferte Proxy holt und erneuert die Zertifikate bei Let's Encrypt. Dafür müssen die Namen im öffentlichen DNS auf den Server zeigen und die Ports 80 und 443 aus dem Internet erreichbar sein. |
| `own` | Ein Zertifikat, das du mitbringst. Vor dem Start prüft der Installer mit `openssl`: Die Datei beginnt mit einem Zertifikat, es ist gültig (nicht abgelaufen, nicht erst künftig), der Schlüssel gehört dazu und ist nicht mit einer Passphrase geschützt, und das Zertifikat deckt jeden gewählten Hostnamen ab – ein `*` steht für genau einen Namensteil. Ein nicht abgedeckter Hostname wird genannt, und es wird nichts installiert. Nach dem Start importiert der Installer das Zertifikat. |
| `selfsigned` | Der Proxy stellt sich selbst ein Zertifikat aus. Nur zum Testen: Jeder Browser warnt. |

### Ohne Rückfragen

Jede Antwort gibt es auch als Option. Mit `--yes` fragt der Installer nichts; fehlt dann eine
Antwort, die keine Vorgabe hat, nennt er die Option und endet, ohne etwas zu verändern.

```bash
curl -fsSL https://github.com/AdminCave/Velydock/releases/latest/download/install.sh |
  sudo bash -s -- --yes --domain example.com --acme-email admin@example.com
```

Weitere Optionen:

| Option | Bedeutung |
|---|---|
| `--version 1.2.3` | Dieses Release statt des neuesten. |
| `--install-docker` | Docker ohne Rückfrage installieren, falls es fehlt (Debian, Ubuntu). |
| `--http-bind`, `--https-bind` | Woran der Proxy bindet, z. B. `127.0.0.1:8443` (Standard `0.0.0.0:80` und `0.0.0.0:443`). |
| `--public-port-suffix :8443` | Nur wenn Velydock von außen nicht über Port 443 erreichbar ist. |
| `--no-system` | Nichts außerhalb des Installationsverzeichnisses anlegen: kein Befehl in `/usr/local/bin`, kein Timer, das Protokoll liegt im Verzeichnis. Zusammen mit `--dir` auf ein eigenes Verzeichnis läuft der Installer dann auch ohne root; der Benutzer braucht Zugriff auf Docker. |
| `--lang de`, `--lang en` | Sprache. |
| `--help` | Alle Optionen. |

### Was der Installer auf dem Server hinterlässt

| Ort | Inhalt |
|---|---|
| `/opt/velydock/` | Die Programmdateien des Releases (`docker-compose.yml`, `deploy/`, `scripts/`, `VERSION`, `IMAGE`, `MANIFEST`, `LICENSE`), die Konfiguration `.env`, `backups/` und nach dem ersten Update `.previous/` mit den Programmdateien der Version davor. |
| `/usr/local/bin/velydock` | Der Verwaltungsbefehl ([betrieb.md](betrieb.md#der-befehl-velydock)). Er startet `scripts/velydock` aus dem Installationsverzeichnis; ein Update ersetzt ihn also mit. |
| `/etc/systemd/system/velydock-backup.service` und `velydock-backup.timer` | Das nächtliche Backup (02:30 Uhr, um bis zu 15 Minuten versetzt), falls gewählt. Ohne systemd richtet der Installer keinen Timer ein und sagt das. |
| `/var/log/velydock-install.log` | Das Protokoll der Installation. Es enthält weder Geheimnisse noch das Einmalpasswort. |
| Docker | Das Compose-Projekt `velydock` mit seinen Containern, Volumes und Netzen. |
| Nur wenn Docker fehlte | Docker Engine aus Dockers apt-Repository (`/etc/apt/sources.list.d/docker.sources`, `/etc/apt/keyrings/docker.asc`). |

### Erneut ausführen, abgebrochene Installation

- **Auf einer vorhandenen Installation** sagt der Installer, welche Version wo installiert ist,
  und verweist auf `velydock update` und `velydock doctor`. `.env` und Daten fasst er nicht an.
  Fehlen der Befehl in `/usr/local/bin` oder der Backup-Timer (nach `velydock uninstall`), legt
  er sie wieder an und sagt das.
- **Bricht eine Installation ab** – etwa, weil ein Image nicht geladen werden konnte –, nennt der
  Installer das Protokoll. Der nächste Lauf setzt sie mit den damaligen Antworten fort; die schon
  geschriebene `.env` bleibt. Wer stattdessen neu anfangen will:
  `/opt/velydock/scripts/velydock uninstall --purge`.
- **Ein Verzeichnis, das nicht leer ist und keine Velydock-Installation enthält,** lehnt der
  Installer ab.

## Installation von Hand

Ohne Installer, aus dem Quelltext – der Weg, solange es kein Release gibt, und für alle, die
jeden Schritt selbst ausführen wollen:

```bash
git clone https://github.com/AdminCave/Velydock.git
cd Velydock
./scripts/install.sh dock.example.com auth.example.com sandbox.example.com admin@example.com
docker compose up -d --wait
```

**Image:** Die Compose-Datei verwendet `ghcr.io/admincave/velydock:latest`. Dieses Image wird
erst mit einem Release veröffentlicht. Solange es noch keines gibt, baust du es vor dem Start
einmal selbst aus dem Quelltext:

```bash
docker build -t ghcr.io/admincave/velydock:latest .
```

`scripts/install.sh` – nicht zu verwechseln mit dem Installer `install.sh` im Wurzelverzeichnis –
legt die Datei `.env` mit zufällig erzeugten Geheimnissen an (nur für den eigenen Benutzer
lesbar). Es startet nichts und überschreibt keine vorhandene `.env`. Die Hostnamen schreibt es
klein; die vierte Angabe ist die E-Mail-Adresse für Let's Encrypt. Außerdem macht es die Dateien
unter `deploy/`, die PostgreSQL und Traefik aus dem Checkout lesen, für andere Benutzer lesbar –
nach einem `git clone` mit restriktiver umask (027, 077) könnten die Container sie sonst nicht
öffnen.

Der erste Start dauert ein bis zwei Minuten: PostgreSQL legt die Datenbanken an, Keycloak
initialisiert sich, Velydock richtet den Realm ein. Mit `--wait` kehrt der Befehl erst zurück,
wenn alle Dienste bereit sind – erst dann lässt sich der erste Administrator anlegen. Den
Fortschritt zeigt ein zweites Terminal:

```bash
docker compose ps                 # alle Dienste "healthy"?
docker compose logs -f velydock   # "Keycloak realm velydock is configured"
```

Den Verwaltungsbefehl `velydock` gibt es bei dieser Art der Installation nicht; Update, Backup
und Wiederherstellung laufen über die Befehle, die [betrieb.md](betrieb.md) jeweils daneben nennt.

## Ersten Administrator anlegen

Der Installer erledigt das am Ende selbst. Nach einer Installation von Hand – und später, um
einen Zugang wiederherzustellen:

```bash
sudo velydock admin --username admin --email admin@example.com      # nach dem Installer
docker compose exec velydock velydock setup-admin --username admin --email admin@example.com
```

Der Befehl legt – falls noch keine existiert – die erste Organisation an („Hauptorganisation“,
Kurzname `main`; änderbar mit `--tenant-name` und `--tenant-slug`) und darin den ersten
Systemadministrator. Er gibt ein **Einmalpasswort** aus, das nur dieses eine Mal angezeigt wird.

Danach:

1. `https://dock.example.com` öffnen, „Anmelden“.
2. Benutzername und Einmalpasswort eingeben; Keycloak verlangt sofort ein eigenes Passwort
   (mindestens 12 Zeichen).
3. Keycloak verlangt die Einrichtung einer Authenticator-App (Zwei-Faktor ist für
   Administratoren standardmäßig Pflicht).

**Zugang verloren?** Derselbe Befehl mit einem vorhandenen Benutzernamen setzt dessen Passwort
zurück, aktiviert das Konto und macht es zum Systemadministrator. Laufende Sitzungen des Kontos
beendet er dabei, in Velydock und in Keycloak; wer damit angemeldet war, meldet sich mit dem
Einmalpasswort neu an. Einen eingerichteten zweiten Faktor lässt er unverändert.

**Zweiten Faktor verloren?** Velydock kann einen eingerichteten zweiten Faktor nicht entfernen;
das geht nur in Keycloaks Konsole. Hat kein anderer Systemadministrator mehr Zugang, führt
dieser Weg zurück:

1. Mit einem neuen Benutzernamen ein zweites Administratorkonto anlegen, zum Beispiel
   `docker compose exec velydock velydock setup-admin --username notfall` (`--email` nur mit
   einer Adresse, die noch kein Konto verwendet). Damit anmelden und Passwort und zweiten Faktor
   einrichten.
2. Diesem Konto den Zugang zu Keycloaks Konsole geben und die Konsole öffnen
   ([betrieb.md](betrieb.md#zugang-zur-keycloak-verwaltung)).
3. In der Konsole unter *Users* das alte Konto öffnen und im Reiter *Credentials* den Eintrag
   des zweiten Faktors löschen. Ist die Zwei-Faktor-Pflicht für Administratoren eingeschaltet,
   richtet das alte Konto bei der nächsten Anmeldung einen neuen ein.
4. Den Konsolenzugang wieder entziehen und das zweite Konto löschen, wenn es nicht mehr gebraucht
   wird.

## Erste Schritte in der Oberfläche

1. **System → Organisationen:** je Kunde oder Bereich eine Organisation anlegen.
2. Über den Organisations-Umschalter in die Organisation wechseln.
3. **Verwaltung → Benutzer:** Benutzer anlegen, mindestens einen als Mandantenadministrator.
4. **Verwaltung → Gruppen** und **Verwaltung → Apps:** Gruppen bilden, Apps hinzufügen und
   freigeben.

Ausführlich in [administration.md](administration.md).

## Konfiguration

Alle Einstellungen stehen in `.env` (nach dem Installer: `/opt/velydock/.env`). Nach einer
Änderung: `sudo velydock start` oder, im Verzeichnis der Installation, `docker compose up -d`.

### Adressen und Proxy

| Variable | Bedeutung |
|---|---|
| `VELYDOCK_HOST`, `KEYCLOAK_HOST`, `SANDBOX_HOST` | Die drei Hostnamen (klein geschrieben, ohne `https://`). Sie müssen sich unterscheiden. |
| `APPS_HOST` | Optional: vierter Hostname für Apps, die Velydocks Proxy veröffentlicht ([betrieb.md](betrieb.md#apps-über-den-proxy-veröffentlichen)). Leer: Funktion aus. |
| `ACME_EMAIL` | E-Mail-Adresse für Let's Encrypt. |
| `COMPOSE_PROFILES` | `proxy` startet den mitgelieferten Traefik. Leer lassen für einen eigenen Proxy. |
| `HTTP_BIND`, `HTTPS_BIND` | Adresse und Port, an die Traefik bindet (Standard `0.0.0.0:80` und `0.0.0.0:443`). |
| `TLS_RESOLVER` | Standard `letsencrypt`. Leer: Traefik verwendet ein selbstsigniertes Zertifikat (nur zum Testen). |
| `PUBLIC_PORT_SUFFIX` | Nur nötig, wenn Velydock nicht auf Port 443 erreichbar ist, z. B. `:8443`. Die Umleitung von HTTP nach HTTPS zeigt auch dann auf Port 443. |
| `VELYDOCK_IMAGE` | Image und Version, z. B. `ghcr.io/admincave/velydock:0.1.0`. |
| `KEYCLOAK_IMAGE` | Image und Version von Keycloak. Ohne Angabe die Version, mit der Velydock getestet ist ([betrieb.md](betrieb.md#update)). |

### Verwaltungsbefehl

Diese beiden liest nur der Befehl `velydock`; der Installer trägt sie ein, wenn nächtliche
Backups gewählt wurden.

| Variable | Bedeutung |
|---|---|
| `VELYDOCK_BACKUP_DIR` | Wohin `velydock backup` schreibt, wenn kein Verzeichnis angegeben ist. Ohne die Variable: `backups/` im Installationsverzeichnis. |
| `VELYDOCK_BACKUP_KEEP` | Wie viele Backups `velydock backup` dort aufbewahrt. Ohne die Variable löscht es keine. |

### Geheimnisse

Vom Installer oder von `scripts/install.sh` erzeugt; von Hand jeweils mit `openssl rand -hex 32`.
Wer `.env` selbst aus `.env.example` anlegt, nimmt anderen Benutzern des Servers das Leserecht:
`chmod 600 .env`.

| Variable | Verwendung |
|---|---|
| `POSTGRES_PASSWORD` | Datenbank-Superuser (nur für Wartung und Backup). |
| `VELYDOCK_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD` | Die beiden Anwendungsrollen. Werden nur beim allerersten Start gesetzt. |
| `VELYDOCK_SECRET_KEY` | Signiert Login-Zustand und Links zu eigenen Apps. |
| `VELYDOCK_OIDC_CLIENT_SECRET` | Geheimnis des OIDC-Clients `velydock`. |
| `VELYDOCK_IDP_ADMIN_CLIENT_SECRET` | Geheimnis des Dienstzugangs `velydock-admin` für Keycloaks Admin-API. |
| `VELYDOCK_PROXY_SECRET` | Damit holt Traefik die Routen veröffentlichter Apps bei Velydock ab. Nur nötig mit `APPS_HOST`. |
| `KEYCLOAK_BOOTSTRAP_SECRET` | Damit legt Velydock beim ersten Start seinen Realm an. Muss danach in `.env` stehen bleiben: Keycloak startet ohne den Wert nicht, und Compose verweigert deshalb den Start. |

### Geheimnisse tauschen

| Geheimnis | So geht es |
|---|---|
| `VELYDOCK_OIDC_CLIENT_SECRET` | Neuen Wert in `.env` eintragen, `docker compose up -d`. Velydock überträgt ihn beim Start nach Keycloak. Wer angemeldet ist, bleibt es. |
| `VELYDOCK_IDP_ADMIN_CLIENT_SECRET` | Ebenso. Velydock trägt den neuen Wert über den Bootstrap-Zugang in Keycloak ein; das gelingt nur, wenn `KEYCLOAK_BOOTSTRAP_SECRET` in `.env` unverändert der Wert der Installation ist. Sonst startet `velydock` nicht mehr, bis der alte Wert wieder eingetragen ist. |
| `VELYDOCK_SECRET_KEY` | Neuen Wert in `.env` eintragen, `docker compose up -d`. Sitzungen bleiben gültig; Links zu eigenen Apps, die vorher ausgegeben wurden (fünf Minuten gültig), verfallen. |
| `KEYCLOAK_BOOTSTRAP_SECRET` | Lässt sich über `.env` nicht tauschen: Keycloak übernimmt den Wert nur beim allerersten Start. Ein geänderter Wert bewirkt in Keycloak nichts, macht aber `keycloak-admin` und den Tausch des Dienstzugang-Geheimnisses unbrauchbar („identity provider rejected the service account (401)“), bis wieder der ursprüngliche eingetragen ist. Der Zugang ist nur aus dem internen Docker-Netz nutzbar ([einschraenkungen.md](einschraenkungen.md)). |
| `POSTGRES_PASSWORD`, `VELYDOCK_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD` | Nicht durch Ändern in `.env` allein: PostgreSQL setzt Passwörter nur beim Anlegen des Datenverzeichnisses, Keycloak und Velydock kämen mit dem neuen Wert nicht mehr an die Datenbank. In vier Schritten, siehe unten. |

Datenbank-Passwörter tauschen:

```bash
# 1. Neue Werte in .env eintragen (alle drei oder einzelne)

# 2. PostgreSQL die neuen Werte übergeben. Es startet dafür kurz neu; Keycloak und Velydock
#    arbeiten mit den alten Passwörtern weiter.
docker compose up -d --wait postgres

# 3. Die Rollen auf die neuen Passwörter setzen. psql liest sie aus der Umgebung des Containers,
#    sie stehen also in keiner Befehlszeile.
docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
\getenv p POSTGRES_PASSWORD
\getenv v VELYDOCK_DB_PASSWORD
\getenv k KEYCLOAK_DB_PASSWORD
ALTER ROLE postgres PASSWORD :'p';
ALTER ROLE velydock PASSWORD :'v';
ALTER ROLE keycloak PASSWORD :'k';
SQL

# 4. Keycloak und Velydock mit den neuen Werten starten (Unterbrechung wie bei einem Update)
docker compose up -d --wait
```

Wurde nach Schritt 1 schon `docker compose up -d` ausgeführt, starten Keycloak und Velydock nicht
(`password authentication failed` im Log von PostgreSQL); die Schritte 3 und 4 holen das nach.

### Verhalten

| Variable | Standard | Bedeutung |
|---|---|---|
| `VELYDOCK_REQUIRE_ADMIN_2FA` | `true` | Zwei-Faktor-Pflicht für Rollen mit Verwaltungsrechten. Lässt sich in der Oberfläche überschreiben (System → Systemeinstellungen). |
| `VELYDOCK_SESSION_IDLE_MINUTES` | `120` | Sitzung endet nach dieser Zeit ohne Aktivität. Ein sichtbares Velydock-Fenster mit Fokus gilt als Aktivität ([sso.md](sso.md#sessions-und-abmeldung)). |
| `VELYDOCK_SESSION_MAX_HOURS` | `12` | Sitzung endet spätestens nach dieser Zeit. |
| `VELYDOCK_EMBED_CHECK_ALLOW_PRIVATE` | `false` | Erlaubt der Einbettungsprüfung, Adressen in privaten Netzen abzurufen. |
| `VELYDOCK_TRUSTED_PROXIES` | private Netze und `127.0.0.1` | Adressen und Netze (kommagetrennt), deren `X-Forwarded-For` geglaubt wird. Daraus stammt die Client-Adresse im Protokoll. Der Standard passt für den mitgelieferten Traefik und für einen Proxy auf demselben Server; nur ein Proxy mit öffentlicher Adresse muss hier eingetragen werden. Der Wert ersetzt den Standard. |
| `VELYDOCK_LOG_LEVEL` | `INFO` | Protokollstufe des Backends. |

Weitere Einstellungen (Instanzname, Standardsprache, Standard-Design, Navigationsposition,
E-Mail-Versand) werden in der Oberfläche unter **System → Systemeinstellungen** vorgenommen.

## E-Mail-Versand

Ohne Mailserver funktioniert alles; neue Benutzer erhalten dann ein Einmalpasswort, das der
Administrator weitergibt. Mit einem unter **System → Systemeinstellungen** eingetragenen SMTP-Server
kann Velydock stattdessen einen Link zum Setzen des Passworts verschicken, und die Anmeldeseite
bietet „Passwort vergessen“ an. Die SMTP-Zugangsdaten werden in Keycloak gespeichert, nicht in
Velydock.
