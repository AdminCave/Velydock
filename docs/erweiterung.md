# Erweiterungskonzept

Velydock hat kein Plugin-System. Erweiterungen entstehen an wenigen, klar begrenzten Stellen im
Code. Dieses Dokument nennt die Stellen und die Erweiterungen, für die sie gedacht sind.

## Erweiterungspunkte

### 1. Identity-Provider-Schnittstelle (`backend/velydock/idp/base.py`)

Alles, was Identitäten betrifft, läuft über das Protokoll `IdentityProvider`: Benutzer anlegen,
ändern, sperren, Passwort setzen, abmelden, Organizations pflegen. `KeycloakIdp` ist die einzige
produktive Umsetzung; die Tests verwenden eine im Speicher.

Hier setzt an:

- **Gruppen nach Keycloak spiegeln**, damit angebundene Apps sie als Token-Claim erhalten:
  Methoden für Gruppen ergänzen und aus `services/groups.py` aufrufen.
- **OIDC-Clients für Apps anlegen:** Methode `create_app_client(...)`, die einen Client mit
  Redirect-URI und dem Scope `organization` erzeugt.

### 2. Fachlogik mit Protokoll (`backend/velydock/services/`)

Jede Änderung an Benutzern, Gruppen, Apps und Mandanten geht durch genau eine Funktion und
schreibt einen Eintrag ins Protokoll (`audit.record`). Das ist die Stelle für:

- **Provisionierung in externe Apps** (Nextcloud, mailcow, SCIM): ein Konnektor je Zielsystem, der
  nach erfolgreicher Änderung aufgerufen wird. Empfohlen ist eine Auftragstabelle, die ein
  Hintergrundprozess abarbeitet, damit ein nicht erreichbares Zielsystem keine Verwaltungsaktion
  blockiert.
- **Einladungen:** eine ausstehende Mitgliedschaft, die der Benutzer bestätigt.

### 3. App-Typen (`models.AppType`, `services/apps.py`, Frontend `AppView`)

Ein neuer Typ braucht einen Wert in `AppType`, die Validierung in `services/apps.py`, die
Darstellung im Frontend und eine Migration nur, wenn neue Felder nötig sind. Denkbar:

- **Proxied App:** Velydock (oder Traefik mit Forward-Auth gegen Velydock) stellt sich vor eine App
  ohne eigene Anmeldung. Der Endpunkt für Forward-Auth würde die vorhandene Session prüfen.
- **Native Integrationen:** Kacheln mit Live-Daten (ungelesene Mails, anstehende Termine) über die
  API der jeweiligen Anwendung.

### 4. Berechtigungen (`backend/velydock/policy.py`)

Rollen sind benannte Mengen von Einzelrechten (`Permission`). Eigene Rollen je Mandant sind
möglich, indem `ROLE_PERMISSIONS` aus der Datenbank gelesen wird; die Prüfungen in den Routen
(`require(Permission.…)`) bleiben unverändert. Die Rangregeln müssten dann aus den Rechten
abgeleitet werden.

### 5. Schnittstelle für eigene Apps

Eigene Apps sind bewusst ohne Verbindung zu Velydock. Eine spätere, eng begrenzte Schnittstelle
über `postMessage` (Anzeigename, Design, Sprache) ließe sich ergänzen, ohne die Sandbox zu
öffnen: Die Velydock-Seite antwortet nur auf Nachrichten aus dem Frame einer eigenen App und gibt
nie Sitzungsdaten heraus.

### 6. Mandantenzuordnung für föderierte Identitäten (`api/auth.py`, `_find_or_provision`)

Unbekannte Identitäten werden bei der ersten Anmeldung ohne Organisation angelegt. Hier lässt sich
eine Regel ergänzen, die anhand der Keycloak-Organization oder der Föderationsquelle automatisch
zuordnet.

### 7. Mandanteneigene Adressen

`HostDispatch` (`app.py`) unterscheidet bereits nach Hostname. Für Adressen je Mandant müsste die
Hauptanwendung mehrere öffentliche Adressen kennen (Redirect-URIs, CSRF-Herkunft, Cookie je
Host) und Traefik die Hostnamen dynamisch erhalten, etwa über seinen HTTP-Provider.

## Die API als Erweiterungsweg

Die REST-API unter `/api/v1` ist vollständig in `backend/openapi.json` beschrieben; in
Entwicklungsumgebungen zusätzlich unter `/api/docs`. Sie ist die Schnittstelle der Oberfläche und
verwendet deren Session. Für Automatisierung von außen fehlen noch API-Schlüssel – eine
naheliegende Erweiterung an der Stelle, an der heute `get_principal` die Session auswertet.

## Regeln für Erweiterungen

- Jede neue mandantenbezogene Tabelle bekommt `tenant_id`, Row Level Security mit `FORCE` und die
  Richtlinie `tenant_isolation`. Ein Test stellt sicher, dass keine Tabelle ohne Schutz existiert.
- Der Mandant kommt aus der Session, nie aus der Anfrage.
- Berechtigungsentscheidungen gehören als reine Funktionen nach `policy.py` und bekommen Tests.
- Modelländerungen brauchen eine Alembic-Migration; ein Test vergleicht Modelle und Schema.
- Die OpenAPI-Beschreibung und die daraus erzeugten Frontend-Typen werden mitgeführt
  (`velydock openapi`, `npm run gen:api`); die CI prüft beides.
