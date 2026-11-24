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

## 7. Identitätsänderungen ohne gemeinsame Transaktion

Es gibt keine Transaktion über Keycloak und die Datenbank zugleich. Die Reihenfolge ist deshalb
so gewählt, dass ein Fehler nichts hinterlässt:

- **Anlegen:** zuerst das Keycloak-Konto (Keycloak vergibt die Kennung), dann die Datenbankzeile.
  Schlägt der zweite Schritt fehl, wird das Konto wieder gelöscht.
- **Ändern, Sperren, Löschen:** zuerst die Datenbank (noch nicht abgeschlossen), dann Keycloak,
  zuletzt der Commit. Lehnt die Datenbank ab, wurde Keycloak nie angefasst; lehnt Keycloak ab,
  wird die Datenbank zurückgerollt (siehe auch Entscheidung 12).

`velydock bootstrap` gleicht beim Start zusätzlich Organizations (Name, Zustand, Mitglieder) mit
den Mandanten ab; scheitert das für einen Mandanten, startet Velydock trotzdem.

## 8. Zwei-Faktor für Administratoren über Keycloak

Hat ein Administrator bei der Anmeldung keinen zweiten Faktor, setzt Velydock in Keycloak die
Aktion „Authenticator einrichten“ und schickt den Browser erneut dorthin. Eine Session entsteht
erst, wenn der zweite Faktor existiert.

Begründung: Die Prüfung bei jeder Anmeldung greift auch, wenn jemand seinen zweiten Faktor
später wieder löscht.

Folge: Weil die Regel an der Anmeldung hängt, dürfen laufende Sessions keine Verwaltungsrechte
hinzugewinnen. Wer befördert wird, verliert deshalb seine Sessions und meldet sich neu an.

## 9. Login-Theme unter Inhalts-Hash

`velydock install-theme` legt die Theme-Dateien in ein Verzeichnis, dessen Name ein Hash ihres
Inhalts ist.

Begründung: Keycloak lässt Browser Theme-Dateien 30 Tage cachen und hält selbst komprimierte
Kopien, beides nur nach Pfad. Ohne Hash bliebe nach einem Update das alte Aussehen sichtbar.

## 10. Die aktive Organisation gehört zur Session; der Client nennt, welche er anzeigt

Die Organisation einer Anfrage stammt ausschließlich aus der Session (Entscheidung 5). Eine
Session kann aber in mehreren Tabs offen sein, und ein Wechsel in einem Tab gilt sofort für alle.
Damit ein Tab, der noch die vorige Organisation zeigt, nicht in der neuen schreibt, schickt die
Oberfläche die angezeigte Organisation als `X-Velydock-Tenant` mit; die API vergleicht sie mit
der Session und antwortet bei Abweichung mit `409 tenant_changed`.

Begründung: Der Header wählt nichts aus – er kann eine Anfrage nur scheitern lassen. Das Prinzip
„der Client benennt keinen Mandanten“ bleibt damit erhalten. Verworfen wurde, die Organisation in
die Adresse aufzunehmen (`/t/<kurzname>/…`): Dann müsste jede Anfrage einen vom Client gewählten
Mandanten gegen die Mitgliedschaft prüfen, und ein Fehler dabei wäre ein Mandantendurchgriff.

## 11. Leerlauf-Ablauf als Schutz der Session, nicht als Abmeldung

Die Velydock-Session endet nach 120 Minuten ohne Aktivität, die Keycloak-Sitzung erst nach der
Maximaldauer. Ein sichtbares Velydock-Fenster mit Fokus gilt als Aktivität, weil Benutzer
stundenlang in eingebetteten Apps arbeiten, ohne dass Velydock davon eine Anfrage sieht.

Begründung: Würde auch die Keycloak-Sitzung nach 120 Minuten Leerlauf enden, müssten sich
Benutzer bei jeder App, die sie später am Tag öffnen, neu anmelden – das Gegenteil von Single
Sign-On. Der Ablauf begrenzt daher, wie lange ein unbenutztes Session-Cookie gültig bleibt; er
ersetzt weder das Abmelden noch die Bildschirmsperre
([einschraenkungen.md](einschraenkungen.md#sicherheitsrelevant)).

## 12. Session-Verwaltung in eigener Transaktion, Änderungen an einem Konto nacheinander

Eine Anfrage ist eine Transaktion – mit einer Ausnahme: Was zur Session selbst gehört (letzte
Nutzung, gebundene Organisation, das Ergebnis der Nachfrage bei Keycloak), wird zu Beginn in
einer eigenen kurzen Transaktion gespeichert.

Begründung: Bliebe es Teil der Anfrage, hielte jede Anfrage eine Sperre auf ihrer eigenen
Session-Zeile, bis sie fertig ist. Wer diese Session beenden will (ein Administrator, Keycloaks
Logout-Meldung), müsste darauf warten, und zwei Administratoren, die einander gleichzeitig
sperren, blockierten sich gegenseitig.

Änderungen an einem Konto oder einer Organisation nehmen außerdem eine Sperre je Konto bzw.
Organisation (PostgreSQL Advisory Locks, immer in derselben Reihenfolge) und schreiben erst in
die Datenbank, dann nach Keycloak, zuletzt der Commit.

Begründung: Keycloak führt zwei gleichzeitige Änderungen an einem Konto nicht zusammen; die
spätere schreibt das ganze Konto zurück, wie sie es gelesen hat. Ohne Reihenfolge konnte eine
Profiländerung eine gleichzeitig gesetzte Sperre aufheben.

## 13. Keycloak wird regelmäßig gefragt, ob eine Session noch gilt

Keycloak meldet Abmeldungen (Back-Channel-Logout), aber nicht alles: Ein in der Konsole
deaktiviertes oder gelöschtes Konto, „alle Sitzungen abmelden“ für den Realm und eine dort
abgelaufene Sitzung kommen ohne Meldung. Velydock fragt deshalb für jede benutzte Session alle
fünf Minuten nach.

Begründung: Sonst gälte eine Velydock-Session bis zu zwölf Stunden weiter, obwohl der Betreiber
das Konto in Keycloak gesperrt hat. Ist Keycloak nicht erreichbar, bleibt die Session bestehen –
ein Ausfall von Keycloak soll nicht alle aus Velydock abmelden.

## 14. Eigene Apps ohne Netzwerkzugriff in einem Zwischendokument

Eine eigene App ohne Netzwerkzugriff wird nicht direkt im Frame ausgeliefert, sondern in einem
skriptlosen Zwischendokument, das sie seinerseits einbettet und dessen `frame-src` nur den
Sandbox-Host zulässt.

Begründung: Die Content Security Policy eines Dokuments kann nicht verhindern, dass es sich selbst
auf eine andere Adresse umleitet – und in der Adresse Daten mitgibt. Wohin ein Frame navigieren
darf, bestimmt das Dokument, das ihn enthält; das ist beim Zwischendokument unter Kontrolle, bei
der Velydock-Seite nicht (sie muss beliebige `https`-Apps einbetten können).

## 15. Apps über den eingebauten Proxy veröffentlichen (23.11.2026)

Velydock stellt interne Anwendungen über Traefik bereit. Drei Punkte hat der Auftraggeber
entschieden, nachdem die Folgen benannt waren:

- **Adressen:** je App eine eigene Subdomain oder ein Pfad auf einem *eigenen* Apps-Host
  (`apps.example.com/name/`, der Standard) – nie unter Velydocks eigener Adresse. Eine App dort
  liefe als Teil von Velydock: Ihre Skripte könnten mit der Sitzung jedes angemeldeten Benutzers
  auf Velydock zugreifen, über Organisationsgrenzen hinweg.
- **Wer was festlegt:** Der Systemadministrator gibt je Organisation frei, welche internen Netze
  und Hosts erreichbar sind, und pflegt die Vorlagen. Organisations-Administratoren
  veröffentlichen innerhalb dieser Grenzen. Freie Traefik-Optionen nur für den
  Systemadministrator: Ein Proxy-Ziel kann jede Adresse sein, die der Server erreicht.
- **Zugriff:** standardmäßig nur angemeldete Benutzer mit Freigabe der App; „öffentlich“ je App.

Technisch folgt daraus:

- Traefik holt die Routen bei Velydock ab (HTTP-Provider), statt dass Velydock Dateien schreibt
  oder Traefik Zugriff auf den Docker-Socket bekommt. Die Routen werden aus geprüften Teilen
  *gebaut* (ein Name, eine Art), nie als Text übernommen: Eine frei formulierte Regel könnte
  Velydocks eigene Adresse beanspruchen (im Versuch bestätigt).
- Hostnamen als Ziel gelten nur, wenn der Systemadministrator genau diesen Namen freigegeben
  hat: Ein Name ist nur so viel wert wie das, worauf er im Moment der Anfrage zeigt.
- Vor jeder Anfrage an eine geschützte App fragt Traefik Velydock (`forwardAuth`). Die Anmeldung
  läuft über Velydocks Adresse und kommt mit einem einmal gültigen Ticket zurück; die App bekommt
  ein eigenes Cookie, das nur für sie gilt. Velydocks Session-Cookie verlässt dessen Host nie.
- Der Pfad bleibt der Standard, wie entschieden. Weil sich Apps im Pfad-Modus einen Ursprung
  teilen – auch über Organisationen hinweg –, kann der Systemadministrator ihn je Organisation
  abschalten. Das kam nach einer unabhängigen Prüfung dazu, ebenso die Bindung des Tickets an
  den Browser, die Nachfrage bei Keycloak auf diesem Weg und die strenge Prüfung aller Werte, die
  an Traefik gehen (ein `true` anstelle einer Zahl hatte im Versuch die Routen aller
  Organisationen eingefroren).

## 16. Erscheinungsbild je Organisation und je Benutzer (23.11.2026)

Logo, Design, Akzentfarbe, Dock-Position und App-Leiste lassen sich je Organisation und je
Benutzer einstellen; das Logo gibt es nur je Organisation. Drei Punkte hat der Auftraggeber
entschieden:

- **Wie tief das Design geht:** hell oder dunkel und *eine* Akzentfarbe – keine eigenen
  Flächenfarben, kein freies CSS. Eine Farbe lässt sich so ableiten, dass Text in beiden Designs
  lesbar bleibt (Velydock rechnet nach, mindestens 4,5:1); mit freien Farben oder eigenem CSS
  könnte eine Organisation die Oberfläche unlesbar machen oder Teile verstecken.
- **Wer bestimmt:** Benutzer dürfen jede Einstellung selbst wählen; die Organisation gibt
  Vorgaben und kann jede einzeln für alle festlegen. Standardmäßig ist nichts festgelegt.
- **Keine Leiste an eingebetteten Apps, solange niemand sie einschaltet:** Die Leiste mit Name,
  Adresse, „Neu laden“ und „In neuem Tab öffnen“ ist ohne eigene Wahl und ohne Vorgabe der
  Organisation ausgeblendet; die App hat die ganze Fläche. Zuerst saß sie standardmäßig oben –
  das war nicht gewollt und wurde am 24.11.2026 umgestellt. Die beiden Aktionen stehen ohne Leiste
  im Benutzermenü des Docks.

Technisch folgt daraus:

- Je Einstellung gilt: festgelegt → Vorgabe der Organisation; sonst eigene Wahl, sonst Vorgabe,
  sonst Systemstandard. Die eigene Wahl bleibt beim Festlegen gespeichert und gilt wieder, wenn
  die Organisation die Festlegung aufhebt.
- Die Akzentfarbe ist ein Wert (`#rrggbb`), aus dem die Oberfläche ihre Töne ableitet. Sie färbt
  Links, Markierungen, Hinweise und den Fokusrahmen, nie eine gefüllte Schaltfläche: Deren
  Beschriftung müsste sonst mit jeder Farbe neu stimmen.
- Die Anmeldeseite übernimmt nichts von einer Organisation: Dort ist noch nicht bekannt, wer
  sich anmeldet.

## 17. Abweichungen vom freigegebenen Vorschlag

- Python 3.13 statt 3.14: identisch mit der Entwicklungs- und Testumgebung.
- Bits UI wurde nicht benötigt; die Komponenten basieren auf denen von AdminHelper.
