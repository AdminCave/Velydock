# Architekturentscheidungen

Jede Entscheidung mit Begründung und den Folgen, die man kennen sollte. Stand: Version 0.1.

## 1. Stack: FastAPI, Svelte 5, PostgreSQL, Keycloak, Traefik, Docker Compose

**Entschieden am 20.11.2026 mit Freigabe des Auftraggebers.**

| Bereich | Wahl | Begründung |
|---|---|---|
| Backend | Python 3.13, FastAPI, SQLAlchemy 2 (async), Alembic | Automatische OpenAPI-Beschreibung; derselbe Stack wie AdminHelper. |
| Frontend | Svelte 5 (Runes), TypeScript strict, Vite, reine SPA | Ursprünglich war Vue 3 angedacht. Gewählt wurde Svelte, weil AdminHelper es bereits nutzt und beide Produkte dann Technik, Komponenten und Design System teilen. |
| Oberfläche | Eigene Komponenten nach dem AdminCave Design System | Volle Kontrolle über das Aussehen, keine Abhängigkeit von einer Komponentenbibliothek mit eigenem Stil. |
| Datenbank | PostgreSQL 18 | Keycloak braucht ohnehin PostgreSQL; Row Level Security dient der Mandantentrennung. |
| Identity Provider | Keycloak 26 | Beste AD/LDAP-Föderation, Apache-2.0, keine kostenpflichtigen Funktionen nötig, von mailcow, Nextcloud und OpenProject direkt unterstützt. |
| Reverse Proxy | Traefik 3 mit Datei-Konfiguration | Automatisches Let's Encrypt. Ohne Docker-Socket, weil die Routen feststehen. |
| Deployment | Docker Compose, ein Anwendungs-Image | Einfach zu installieren und zu sichern. |

Verworfen: Zitadel (kein LDAP-Sync, AGPL, kleineres Ökosystem), Authentik (Mandantenfähigkeit
kein Kernfeature), Go statt Python (Vorteil neben Keycloaks Speicherbedarf unerheblich), Tokens
im Browser mit `keycloak-js` (per XSS stehlbar).

## 2. Ein gemeinsamer Keycloak-Realm mit Organizations

**Entschieden vom Auftraggeber am 20.11.2026.** Empfohlen war ein Realm je Mandant; gewählt
wurde der gemeinsame Realm.

Alle Mandanten teilen sich den Realm `velydock`. Jeder Mandant ist dort eine *Organization*,
Mitglieder des Mandanten sind Mitglieder der Organization.

Vorteile: eine Anmeldeseite ohne vorherige Mandantenwahl, eine Person kann mehreren Mandanten
angehören, skaliert auf sehr viele Mandanten.

Folgen, die das Produkt abfängt:

- **Geteilte Identitäten brauchen einen Eigentümer.** Jede Identität gehört einem Mandanten
  (`home_tenant_id`). Nur dessen Administratoren dürfen Profil, E-Mail und Passwort ändern oder
  das Konto sperren. In anderen Mandanten ist die Person Gast: dort kann man sie nur aus dem
  Mandanten entfernen. Ohne diese Regel könnte ein Mandantenadministrator das Passwort eines
  Gastes zurücksetzen und so in dessen Heimat-Mandanten gelangen.
- **Vorhandene Identitäten fügt nur der Systemadministrator hinzu.** Mandantenadministratoren
  legen neue Konten an, können aber keine fremden Konten suchen.

Folgen, die bleiben (siehe [einschraenkungen.md](einschraenkungen.md)):

- Benutzernamen und E-Mail-Adressen sind über alle Mandanten hinweg eindeutig. Beim Anlegen
  erfährt ein Administrator, dass ein Name vergeben ist – nicht, wo.
- Passwort-Richtlinie und Login-Theme gelten für alle Mandanten.
- Eine App, die per OIDC am Realm hängt, akzeptiert zunächst jeden Benutzer des Realms. Apps
  einzelner Kunden müssen auf deren Organization beschränkt werden ([sso.md](sso.md)).

## 3. Autorisierung in Velydock, Authentifizierung in Keycloak

Keycloak hält Identität und Zugangsdaten. Mandanten, Mitgliedschaften, Rollen, Gruppen und
App-Freigaben liegen in der Velydock-Datenbank.

Begründung: Berechtigungen werden bei jeder Anfrage geprüft und müssen mit Row Level Security
zusammenspielen; das geht nur in der eigenen Datenbank schnell und prüfbar. Keycloak-Gruppen sind
realm-weit und kennen keine Mandanten.

Folge: Gruppen stehen angebundenen Apps noch nicht als Token-Claim zur Verfügung. Die
Synchronisation nach Keycloak ist als Erweiterung vorgesehen ([erweiterung.md](erweiterung.md)).

## 4. Tokens bleiben im Backend (Backend-for-Frontend)

Der Browser bekommt ein Session-Cookie (`__Host-`, HttpOnly, Secure, SameSite=Lax). Access- und
Refresh-Tokens werden nicht gespeichert; vom ID-Token wird nur der Wert für die Abmeldung
aufbewahrt.

Begründung: Was nicht im Browser liegt, kann dort nicht gestohlen werden. Sessions lassen sich
serverseitig sofort beenden.

## 5. Mandantentrennung doppelt: API und Row Level Security

Die API nimmt den Mandanten nur aus der Session und filtert jede Abfrage. Zusätzlich erzwingt
PostgreSQL die Trennung mit Row Level Security; ohne gesetzten Kontext liefert jede Tabelle
nichts. Spalten, die RLS nicht schützen kann (`is_system_admin`, `home_tenant_id`, Slug und
Status eines Mandanten), sichert ein Trigger.

Begründung: Ein vergessener Filter im Code darf keine fremden Daten preisgeben.

Folge: Die Anwendung muss sich als Rolle ohne Superuser- und `BYPASSRLS`-Recht verbinden. Das
Init-Skript legt sie so an; ein Test prüft es.

## 6. Eigene Apps auf eigenem Hostnamen mit Sandbox

Eigene Apps werden nur vom Sandbox-Host ausgeliefert, mit dem CSP-Header `sandbox` und in einem
iFrame ohne `allow-same-origin`. Der Zugriff läuft über einen signierten Link mit fünf Minuten
Gültigkeit.

Begründung: Der Code läuft so in einem leeren Origin ohne Cookies und Speicher. Zwei unabhängige
Schichten (Header und iFrame-Attribut) plus ein fremder Hostname schützen auch dann, wenn eine
davon versagt.

## 7. Identitätsänderungen: erst Keycloak, dann Datenbank

Beim Anlegen eines Benutzers wird zuerst das Keycloak-Konto erzeugt, dann die Datenbankzeile.
Schlägt der zweite Schritt fehl, wird das Konto wieder gelöscht.

Begründung: Es gibt keine gemeinsame Transaktion über beide Systeme. Diese Reihenfolge
hinterlässt im Fehlerfall nichts. `velydock bootstrap` gleicht beim Start zusätzlich
Organizations und Mitgliedschaften ab.

## 8. Zwei-Faktor für Administratoren über Keycloak

Hat ein Administrator bei der Anmeldung keinen zweiten Faktor, setzt Velydock in Keycloak die
Aktion „Authenticator einrichten“ und schickt den Browser erneut dorthin. Eine Session entsteht
erst, wenn der zweite Faktor existiert.

Begründung: Die Prüfung bei jeder Anmeldung greift auch, wenn jemand seinen zweiten Faktor
später wieder löscht.

## 9. Login-Theme unter Inhalts-Hash

`velydock install-theme` legt die Theme-Dateien in ein Verzeichnis, dessen Name ein Hash ihres
Inhalts ist.

Begründung: Keycloak lässt Browser Theme-Dateien 30 Tage cachen und hält selbst komprimierte
Kopien, beides nur nach Pfad. Ohne Hash bliebe nach einem Update das alte Aussehen sichtbar.

## 10. Abweichungen vom freigegebenen Vorschlag

- Python 3.13 statt 3.14: identisch mit der Entwicklungs- und Testumgebung.
- Bits UI wurde nicht benötigt; die Komponenten basieren auf denen von AdminHelper.
