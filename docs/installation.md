# Installation, Konfiguration und erste Einrichtung

## Voraussetzungen

- Ein Linux-Server mit Docker Engine und dem Compose-Plugin (`docker compose version`).
- Mindestens 2 GB freier Arbeitsspeicher; Keycloak allein belegt rund 1 GB.
- Drei DNS-Namen, die auf den Server zeigen, zum Beispiel:

  | Name | Zweck |
  |---|---|
  | `dock.example.com` | Velydock (Oberfläche und API) |
  | `auth.example.com` | Keycloak (Anmeldeseite) |
  | `sandbox.example.com` | Auslieferung eigener Apps – muss ein eigener Name sein |

- Ports 80 und 443 frei und von außen erreichbar (für Let's Encrypt). Wer einen eigenen Reverse
  Proxy betreibt, siehe [betrieb.md](betrieb.md#eigener-reverse-proxy).

**Wahl der Domain:** Apps, die in Velydock eingebettet werden sollen, funktionieren nur
zuverlässig, wenn sie unter derselben registrierbaren Domain laufen wie Velydock (z. B.
`cloud.example.com` neben `dock.example.com`). Sonst behandeln Browser ihre Cookies als
Drittanbieter-Cookies. Hintergrund in [anwendungsintegration.md](anwendungsintegration.md).

## Installation

```bash
git clone https://github.com/AdminCave/Velydock.git
cd Velydock
./scripts/install.sh dock.example.com auth.example.com sandbox.example.com admin@example.com
docker compose up -d --wait
```

**Image:** Die Compose-Datei verwendet `ghcr.io/admincave/velydock:latest`. Dieses Image wird
erst mit einem Release veröffentlicht (ein Tag `v…` löst den Workflow `release.yml` aus). Solange
es noch keines gibt, baust du es vor dem Start einmal selbst aus dem Quelltext:

```bash
docker build -t ghcr.io/admincave/velydock:latest .
```

`install.sh` legt die Datei `.env` mit zufällig erzeugten Geheimnissen an (nur für den eigenen
Benutzer lesbar). Es startet nichts und überschreibt keine vorhandene `.env`. Die Hostnamen
schreibt es klein; die vierte Angabe ist die E-Mail-Adresse für Let's Encrypt. Außerdem macht es
die Dateien unter `deploy/`, die PostgreSQL und Traefik aus dem Checkout lesen, für andere
Benutzer lesbar – nach einem `git clone` mit restriktiver umask (027, 077) könnten die Container
sie sonst nicht öffnen.

Der erste Start dauert ein bis zwei Minuten: PostgreSQL legt die Datenbanken an, Keycloak
initialisiert sich, Velydock richtet den Realm ein. Mit `--wait` kehrt der Befehl erst zurück,
wenn alle Dienste bereit sind – erst dann lässt sich der erste Administrator anlegen. Den
Fortschritt zeigt ein zweites Terminal:

```bash
docker compose ps                 # alle Dienste "healthy"?
docker compose logs -f velydock   # "Keycloak realm velydock is configured"
```

## Ersten Administrator anlegen

```bash
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
zurück, aktiviert das Konto und macht es zum Systemadministrator. Einen eingerichteten zweiten
Faktor lässt er unverändert.

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

Alle Einstellungen stehen in `.env`. Nach einer Änderung: `docker compose up -d`.

### Adressen und Proxy

| Variable | Bedeutung |
|---|---|
| `VELYDOCK_HOST`, `KEYCLOAK_HOST`, `SANDBOX_HOST` | Die drei Hostnamen (klein geschrieben, ohne `https://`). Sie müssen sich unterscheiden. |
| `ACME_EMAIL` | E-Mail-Adresse für Let's Encrypt. |
| `COMPOSE_PROFILES` | `proxy` startet den mitgelieferten Traefik. Leer lassen für einen eigenen Proxy. |
| `HTTP_BIND`, `HTTPS_BIND` | Adresse und Port, an die Traefik bindet (Standard `0.0.0.0:80` und `0.0.0.0:443`). |
| `TLS_RESOLVER` | Standard `letsencrypt`. Leer: Traefik verwendet ein selbstsigniertes Zertifikat (nur zum Testen). |
| `PUBLIC_PORT_SUFFIX` | Nur nötig, wenn Velydock nicht auf Port 443 erreichbar ist, z. B. `:8443`. |
| `VELYDOCK_IMAGE` | Image und Version, z. B. `ghcr.io/admincave/velydock:0.1.0`. |

### Geheimnisse

Von `install.sh` erzeugt; von Hand jeweils mit `openssl rand -hex 32`.

| Variable | Verwendung |
|---|---|
| `POSTGRES_PASSWORD` | Datenbank-Superuser (nur für Wartung und Backup). |
| `VELYDOCK_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD` | Die beiden Anwendungsrollen. Werden nur beim allerersten Start gesetzt. |
| `VELYDOCK_SECRET_KEY` | Signiert Login-Zustand und Links zu eigenen Apps. |
| `VELYDOCK_OIDC_CLIENT_SECRET` | Geheimnis des OIDC-Clients `velydock`. |
| `VELYDOCK_IDP_ADMIN_CLIENT_SECRET` | Geheimnis des Dienstzugangs `velydock-admin` für Keycloaks Admin-API. |
| `KEYCLOAK_BOOTSTRAP_SECRET` | Nur für den ersten Start: damit legt Velydock seinen Realm an. |

Das Geheimnis des OIDC-Clients wird bei jedem Start nach Keycloak übertragen und lässt sich
durch Ändern in `.env` und Neustart tauschen. Für das Geheimnis des Dienstzugangs gilt das nur,
solange `KEYCLOAK_BOOTSTRAP_SECRET` gesetzt ist. Die Datenbank-Passwörter lassen sich so nicht
ändern: PostgreSQL setzt sie nur beim Anlegen der Datenbank.

### Verhalten

| Variable | Standard | Bedeutung |
|---|---|---|
| `VELYDOCK_REQUIRE_ADMIN_2FA` | `true` | Zwei-Faktor-Pflicht für Rollen mit Verwaltungsrechten. Lässt sich in der Oberfläche überschreiben (System → Systemeinstellungen). |
| `VELYDOCK_SESSION_IDLE_MINUTES` | `120` | Sitzung endet nach dieser Zeit ohne Aktivität. Ein sichtbares Velydock-Fenster mit Fokus gilt als Aktivität ([sso.md](sso.md#sessions-und-abmeldung)). |
| `VELYDOCK_SESSION_MAX_HOURS` | `12` | Sitzung endet spätestens nach dieser Zeit. |
| `VELYDOCK_EMBED_CHECK_ALLOW_PRIVATE` | `false` | Erlaubt der Einbettungsprüfung, Adressen in privaten Netzen abzurufen. |
| `VELYDOCK_TRUSTED_PROXIES` | private Netze und `127.0.0.1` | Adressen und Netze (kommagetrennt), deren `X-Forwarded-For` geglaubt wird. Daraus stammt die Client-Adresse im Protokoll. Der Standard passt für den mitgelieferten Traefik und für einen Proxy auf demselben Server; nur ein Proxy mit öffentlicher Adresse muss hier eingetragen werden. |
| `VELYDOCK_LOG_LEVEL` | `INFO` | Protokollstufe des Backends. |

Weitere Einstellungen (Instanzname, Standardsprache, Standard-Design, Navigationsposition,
E-Mail-Versand) werden in der Oberfläche unter **System → Systemeinstellungen** vorgenommen.

## E-Mail-Versand

Ohne Mailserver funktioniert alles; neue Benutzer erhalten dann ein Einmalpasswort, das der
Administrator weitergibt. Mit einem unter **System → Systemeinstellungen** eingetragenen SMTP-Server
kann Velydock stattdessen einen Link zum Setzen des Passworts verschicken, und die Anmeldeseite
bietet „Passwort vergessen“ an. Die SMTP-Zugangsdaten werden in Keycloak gespeichert, nicht in
Velydock.
