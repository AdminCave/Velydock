# Sicherheitskonzept

Jede Aussage über einen Schutz ist durch einen automatisierten Test belegt, sofern nicht anders
vermerkt. Die Tests stehen in [tests.md](tests.md). Aussagen über Grenzen – was sich mit
Browser-Mitteln nicht verhindern lässt – stammen aus einer manuellen Sicherheitsprüfung im Browser.

## Wovor Velydock schützt

| Bedrohung | Schutz |
|---|---|
| Ein Mandant liest oder ändert Daten eines anderen | Mandant nur aus der Session; ausdrückliche Filter; Row Level Security in PostgreSQL |
| Ein Benutzer verschafft sich höhere Rechte | Rangregeln in `policy.py`; Trigger auf geschützten Spalten |
| Gestohlene oder erratene Sitzung | Zufallswert mit 256 Bit, nur als Hash gespeichert, HttpOnly, kurze Laufzeiten, sofortiges Beenden |
| Fremde Website löst Aktionen aus (CSRF) | SameSite-Cookie, Pflicht-Header, Herkunftsprüfung |
| Eingeschleustes Skript in der Oberfläche (XSS) | Strikte Content Security Policy, keine Tokens im Browser |
| Erraten von Passwörtern | Brute-Force-Schutz von Keycloak, Drosselung der Anmeldeschritte am Proxy, keine Passwort-Anmeldung am Token-Endpunkt für die mitgelieferten Clients |
| Eigene Apps greifen auf Velydock zu | Fremder Hostname, Sandbox ohne eigenen Origin, keine Cookies |
| Eine App im Hintergrund fängt Tastatureingaben ab | Nur die sichtbare App darf den Tastaturfokus halten |
| Clickjacking | `frame-ancestors 'none'` und `X-Frame-Options: DENY` |
| Server ruft interne Adressen ab (SSRF) | Einbettungsprüfung nur gegen öffentliche Adressen, Weiterleitungen nur innerhalb desselben Hosts |
| Überlastung durch einzelne Anfragen | Größenbegrenzung für Anfragen, Zeit- und Mengenbegrenzung der Einbettungsprüfung, Rate-Limit am Proxy |
| Übernahme eines Administratorkontos | Zwei-Faktor-Pflicht, Brute-Force-Schutz, kein Standardpasswort |

## Mandantentrennung

**Schicht 1 – API.** Der Mandant einer Anfrage stammt aus der Session. Es gibt keinen Parameter,
mit dem ein Client einen Mandanten benennt; unbekannte Felder werden abgelehnt. Fremde IDs liefern
`404` – dieselbe Antwort wie für nicht vorhandene. IDs fremder Gruppen oder Benutzer in sonst
gültigen Anfragen werden als unbekannt abgewiesen.

**Schicht 2 – Datenbank.** Auf jeder Tabelle ist Row Level Security aktiv und erzwungen
(`FORCE ROW LEVEL SECURITY`). Die Richtlinien lesen drei Werte, die nur für die laufende
Transaktion gelten:

| Wert | Bedeutung |
|---|---|
| `app.scope` | `tenant` (normale Anfrage), `system` (Anmeldung, Systemverwaltung, CLI) oder leer |
| `app.tenant_id` | Mandant der Anfrage |
| `app.user_id` | handelnder Benutzer |

Ohne gesetzte Werte sind alle Tabellen leer und nicht beschreibbar. Im Mandantenkontext sind nur
Zeilen des eigenen Mandanten sichtbar; Einfügen oder Verschieben in einen anderen Mandanten wird
abgelehnt. Die Werte verschwinden am Transaktionsende und können nicht über den Verbindungspool
in eine andere Anfrage gelangen.

Der Systemkontext wird im Code nur an benannten Stellen betreten (`system_scope`): bei der
Anmeldung, in der Systemverwaltung und für die globale Eindeutigkeitsprüfung von Benutzernamen.

**Schicht 3 – Trigger.** Row Level Security schützt Zeilen, nicht Spalten. Trigger verhindern
außerhalb des Systemkontexts, dass jemand sich selbst zum Systemadministrator macht, eine Identität
einem anderen Mandanten zuschiebt oder Name, Kurzname und Status eines Mandanten ändert.

Voraussetzung: Die Anwendung verbindet sich mit einer Rolle ohne Superuser- und `BYPASSRLS`-Recht.
Das Init-Skript legt sie so an.

**Wogegen Schicht 2 und 3 schützen – und wogegen nicht.** Sie fangen Fehler im Anwendungscode ab:
eine Abfrage ohne Mandantenfilter liefert trotzdem nur eigene Zeilen. Sie sind keine Barriere
gegen eingeschleustes SQL. Die Anwendung kann den Systemkontext selbst betreten, und ihrer
Datenbankrolle gehören die Tabellen, sodass sie Richtlinien und Trigger auch ändern könnte. Wer
beliebiges SQL über die Verbindung der Anwendung ausführen kann, hat deshalb Zugriff auf alle
Mandanten. Dagegen stehen andere Mittel: ausschließlich gebundene Parameter, kein aus Eingaben
zusammengesetztes SQL, Schemaprüfung aller Eingaben.

## Rollen und Rechte

| Rolle | Darf |
|---|---|
| Mitglied | Den Workspace und die freigegebenen Apps nutzen |
| Benutzerverwalter | Zusätzlich Benutzer und Gruppen verwalten |
| Mandantenadministrator | Zusätzlich Rollen vergeben, Apps und Mandanteneinstellungen verwalten, das Protokoll lesen |
| Systemadministrator | Alles in allen Mandanten, Mandanten anlegen und löschen, Systemeinstellungen |

Zusätzliche Regeln:

- Niemand ändert die eigene Rolle, sperrt oder entfernt sich selbst – auch Systemadministratoren
  nicht. Das eigene Passwort und die eigenen Sitzungen laufen nicht über die Benutzerverwaltung,
  sondern über Keycloaks Kontoseite und „Abmelden“.
- Niemand vergibt eine Rolle oberhalb der eigenen und niemand verwaltet ein Konto mit höherem
  Rang. Ein Benutzerverwalter kann daher nicht das Passwort eines Administrators zurücksetzen und
  dessen Gruppen nicht ändern – weder in der Benutzerverwaltung noch über die Gruppe selbst.
- Profil, E-Mail, Passwort und Sperre einer Identität ändert nur der Mandant, dem sie gehört.
- Systemadministratoren sind für Mandantenadministratoren unantastbar.
- Der letzte aktive Systemadministrator kann weder sein Recht verlieren noch gesperrt oder
  gelöscht werden – auch nicht, wenn zwei Administratoren das gleichzeitig beieinander versuchen.
  Der Mandant eines Systemadministrators kann nicht gelöscht oder deaktiviert werden.
- Wer Verwaltungsrechte neu erhält, wird abgemeldet: Die Rechte gelten erst in einer neuen
  Session, an deren Beginn die Zwei-Faktor-Pflicht geprüft wird. Das gilt auch für
  `velydock setup-admin` auf ein vorhandenes Konto.
- Änderungen an einem Konto laufen nacheinander. Velydock schreibt jede Änderung an zwei Stellen
  (Keycloak und eigene Datenbank), und Keycloak führt gleichzeitige Änderungen an einem Konto
  nicht zusammen: Ohne Reihenfolge könnte eine Sperre von einer gleichzeitigen Profiländerung
  überschrieben werden. An Keycloak gehen außerdem nur die Felder, die sich ändern.

## Sitzungen

- Cookie `__Host-velydock_session`: HttpOnly, Secure, SameSite=Lax, ohne Domain. Das Präfix
  `__Host-` verhindert, dass ein anderer Hostname derselben Domain das Cookie überschreibt.
- In der Datenbank steht nur der SHA-256 des Cookie-Werts.
- Leerlauf- und Maximaldauer, Back-Channel-Logout, sofortiges Beenden bei Sperre oder
  Passwort-Reset ([sso.md](sso.md)).
- Was Keycloak nicht meldet (Konto dort deaktiviert oder gelöscht, Sitzung dort beendet oder
  abgelaufen), bemerkt Velydock durch Nachfragen: spätestens fünf Minuten später ist die Session
  beendet.
- „Abmelden“ beendet die Keycloak-Sitzung auch dann, wenn die Velydock-Session schon abgelaufen ist.
- Nach der Abmeldung zeigt der Zurück-Knopf des Browsers keine alte Seite mit Daten: Die
  Oberfläche lädt neu, sobald der Browser sie aus seinem Seitenspeicher wiederherstellt.
- Die aktive Organisation gehört zur Session. Ein Tab, der noch eine andere anzeigt, wird von der
  API abgewiesen, statt in der falschen Organisation zu schreiben ([sso.md](sso.md), „Mehrere Tabs“).
- Die Client-Adresse im Protokoll stammt aus `X-Forwarded-For`. Geglaubt wird dem Header nur von
  Proxys in privaten Netzen (`VELYDOCK_TRUSTED_PROXIES`); was keine IP-Adresse ist, wird nicht
  gespeichert.

## CSRF

Schreibende Anfragen brauchen den Header `X-Velydock-CSRF: 1`. Fremde Seiten können ihn nicht
setzen, weil der Browser dafür eine CORS-Freigabe verlangt, die Velydock nie erteilt. Zusätzlich
werden `Origin` und `Sec-Fetch-Site` geprüft; auch der Sandbox-Hostname gilt als fremd.

Auch **lesende** Anfragen mit Session führt Velydock nur aus, wenn sie von der eigenen Oberfläche
kommen: Kennzeichnet der Browser eine Anfrage als fremd (`Sec-Fetch-Site: cross-site` oder
`same-site`), wird sie abgewiesen, bevor die Session überhaupt angesehen wird – sie zählt dann
auch nicht als Aktivität. Die fremde Seite könnte die Antwort zwar ohnehin nicht lesen, die
Anfrage liefe aber im Namen des Benutzers: Sie hielte seine Session am Leben, und aus Dauer oder
Erfolg der Antworten ließe sich schließen, was es gibt. `SameSite=Lax` schützt davor nicht, weil
Apps unter derselben Domain als „gleiche Site“ gelten. Chromium und Firefox schicken aus dem
abgeschotteten Frame einer eigenen App kein Cookie mit; WebKit (Safari) tut es – dort greift
diese Prüfung.

## Eigene Apps

Eigener HTML-, CSS- und JavaScript-Code wird so ausgeliefert, dass er weder auf Velydock noch auf
die Anmeldedaten zugreifen kann:

1. **Eigener Hostname.** Nur `sandbox.…` liefert eigene Apps aus. Dieser Hostname hat keine API,
   keine Oberfläche, setzt keine Cookies und ignoriert mitgeschickte.
2. **CSP-Header `sandbox`** ohne `allow-same-origin`: Der Browser gibt dem Dokument einen leeren
   Origin – auch wenn jemand die Adresse direkt öffnet.
3. **iFrame-Attribut `sandbox`** ohne `allow-same-origin`. `allow-top-navigation` fehlt: Die App
   kann die Velydock-Seite nicht durch eine andere ersetzen.
4. **Netzwerk standardmäßig zu.** Ohne „Netzwerkzugriff erlauben“ unterbindet die CSP jede
   ausgehende Verbindung des Skripts (`connect-src 'none'`, `form-action 'none'`, keine externen
   Skripte, Bilder, Schriften, Rahmen oder Objekte). Die App läuft außerdem in einem skriptlosen
   Zwischendokument, dessen `frame-src` nur den Sandbox-Host zulässt: Sie kann sich nicht selbst
   auf eine fremde Adresse umleiten. Und ohne `allow-popups` öffnet auch ein Klick kein fremdes
   Fenster. „Netzwerkzugriff erlauben“ öffnet `https:` und hebt diese Abschottung auf.
5. **Signierter Link, fünf Minuten gültig**, nur für Benutzer, denen die App freigegeben ist. Jede
   Änderung an der App macht alte Links ungültig.
6. **Kein Tastaturfokus im Hintergrund.** Geöffnete Apps bleiben geladen, auch wenn sie gerade
   nicht zu sehen sind. Eine solche App darf den Tastaturfokus nicht halten – sonst könnte sie
   mitlesen, was jemand auf einer Velydock-Seite oder in einer anderen App tippt. Das gilt für
   eigene wie für eingebettete Apps. Firefox lässt eine nicht angezeigte App den Fokus gar nicht
   erst nehmen; Chromium und WebKit (Safari) lassen es zu, dort greift Velydock ein: Es holt
   den Fokus zurück und beendet die App – beim ersten Mal, einen zweiten Versuch gibt es nicht.
   - Nimmt sie ihn einer **Velydock-Seite** weg, meldet der Browser das, und Velydock handelt
     unmittelbar danach.
   - Nimmt sie ihn einer **anderen App** weg, meldet der Browser das nicht. Velydock schaut
     deshalb alle 10 ms nach. Die Eingabe in der sichtbaren App bricht dabei ab; ein Klick in
     das Feld setzt sie fort.

   Verhindern lässt sich der Griff nach dem Fokus in diesen Browsern nicht, nur bemerken – und
   das Bemerken kommt einen Augenblick danach. Ein Tastendruck, der genau in diesen Augenblick
   fällt, kann bei der App ankommen oder verloren gehen. Mehr als diesen einen Augenblick
   bekommt eine App nicht: Danach gibt es sie nicht mehr, bis jemand sie neu öffnet.

   Gemessen am 23.11.2026 ([tests.md](tests.md#andere-browser)): Mit echten Tastatureingaben in
   echten Fenstern kam in keinem Lauf ein Tastendruck bei der App an (Chromium 8 von 8, WebKit
   12 von 12), ebenso in je 20 automatisierten Läufen auf einer stark ausgelasteten Maschine; in
   einem davon ging ein Tastendruck verloren, ohne mitgelesen zu werden. Solange erst der dritte
   Versuch zum Beenden führte, kam in 8 von 12 Läufen ein Tastendruck an, wenn die App den
   Fokus einer anderen App wegnahm, und einmal in einem Lauf der Browser-Tests unter Last, als
   sie ihn einer Velydock-Seite wegnahm – deshalb die Regel ohne zweiten Versuch.

   Eine Ausnahme gilt für die App, die gerade **zu sehen** ist: Holt sie sich den Fokus aus
   einem Dialog von Velydock zurück, nimmt Velydock ihn ihr wieder weg und beendet sie erst
   beim dritten Mal innerhalb einer Minute.

Im Browser geprüft: kein Zugriff auf Cookies, `localStorage`, das Elternfenster oder die
Velydock-API; keine Anfrage, kein Fenster und keine Umleitung zu einer fremden Adresse ohne
Netzwerkzugriff.

Was ohne Netzwerkzugriff dennoch möglich ist: Über WebRTC kann eine App kleine Datenmengen an
einen STUN/TURN-Server geben; kein Antwort-Header unterbindet das in heutigen Browsern. Und
Verbindungshinweise (`preconnect`) können einen Hostnamen auflösen lassen. „Netzwerkzugriff aus“
ist also eine starke Einschränkung, aber keine Garantie gegen Datenabfluss.

Restrisiko: Eine eigene App kann Inhalte anzeigen, die wie eine Anmeldemaske aussehen, und sie
sieht, was jemand in ihr selbst eingibt. Eigene Apps dürfen deshalb nur Administratoren anlegen;
jede Änderung steht im Protokoll.

## Eingebettete fremde Apps

Eingebettete Apps laufen in ihrem eigenen Origin und unterliegen der Same-Origin-Policy. Der iFrame
verbietet ihnen, die Velydock-Seite ohne Benutzeraktion zu ersetzen. Kamera, Mikrofon,
Zwischenablage, Vollbild und Bildschirmfreigabe erhält eine App nur, wenn ein Administrator es
für sie einschaltet. Eine Ausnahme setzt der Browser: Nach einem Klick in der App kann jede
eingebettete Seite in die Zwischenablage *schreiben* (ältere Browser-Schnittstelle); das Lesen
bleibt gesperrt.

Apps unter derselben registrierbaren Domain wie Velydock und Keycloak (empfohlen, damit ihre
Cookies im Frame funktionieren) können Cookies für die ganze Domain setzen. Velydocks eigenes
Session-Cookie ist dagegen geschützt (`__Host-`), Keycloaks Cookies sind es nicht: Eine böswillige
oder übernommene App unter einer Schwester-Subdomain könnte einem Besucher eine fremde
Keycloak-Sitzung unterschieben, sodass er sich unbemerkt als jemand anderes anmeldet. Unter die
eigene Domain gehören deshalb nur Apps, denen man vertraut
([einschraenkungen.md](einschraenkungen.md)).

## Veröffentlichte Apps (Proxy)

Der eingebaute Proxy stellt interne Adressen ins Internet. Was das absichert:

| Gefahr | Schutz |
|---|---|
| Eine Organisation veröffentlicht interne Dienste des Betreibers oder einer anderen Organisation | Ziele gibt der Systemadministrator je Organisation frei (Netze, Adressen, genaue Hostnamen); die Datenbank setzt das durch (eine Organisation kann ihre Freigaben nur lesen). Adressen der Installation selbst – Datenbank, Keycloak, Velydock, `localhost`, Link-Local – sind nie ein Ziel, was auch immer freigegeben wurde; das gilt auch für IPv6-Schreibweisen, die eine solche IPv4-Adresse einpacken (IPv4-mapped, 6to4, NAT64, Teredo). Geprüft wird beim Veröffentlichen und bei jedem Aufbau der Routen: Bekommt ein Dienst der Installation später die Adresse, auf die eine App zeigt, fällt deren Route weg. |
| Ein Hostname zeigt später woandershin (DNS-Rebinding) | Hostnamen gelten nur, wenn genau dieser Name freigegeben ist; sonst sind nur IP-Adressen aus freigegebenen Netzen möglich. |
| Eine Route beansprucht Velydocks eigene Adresse | Routen werden aus einem geprüften Namen und der Art gebaut; der Apps-Host darf keiner von Velydocks Hosts sein und nicht über ihnen liegen. Freie Traefik-Bausteine gibt es nur für Systemadministratoren, nur als Middleware und nur aus einer festen Liste (kein `forwardAuth`, keine Plugins). Sie wirken nach der Anmeldeprüfung, nie an ihrer Stelle. Was der Systemadministrator einer einzelnen App mitgibt – eine Beschränkung auf bestimmte Quelladressen etwa –, kann deren Organisation weder ändern noch entfernen. |
| Eine fehlerhafte Angabe legt die Routen aller Organisationen lahm | Traefik liest alle Routen als ein Dokument; ein unbekanntes Feld oder ein Wert der falschen Art (`true` statt einer Zahl) lässt es das ganze Dokument ablehnen und beim alten Stand bleiben. Velydock nimmt deshalb nur Werte der richtigen Art an und kennt von jedem erlaubten Baustein jedes Feld mit seiner Art; die Liste ist am echten Traefik geprüft ([tests.md](tests.md)). Fehler im Inhalt (ein ungültiges Netz, ein fehlerhafter Ausdruck) treffen nur die eigene Route. |
| Eine interne App steht ungeschützt im Internet | Standard ist „geschützt“: Traefik fragt vor jeder Anfrage Velydock, ob eine Sitzung besteht und die App der Person freigegeben ist. Fällt Velydock aus, bleibt die App zu. „Öffentlich“ ist eine ausdrückliche Wahl je App und steht im Protokoll. |
| Velydocks Session-Cookie gelangt zu einer App | Es gilt nur für Velydocks eigenen Host. Die App erhält nach einem Umweg über Velydock ein eigenes Cookie (`HttpOnly`), das Velydock nur für genau diese App annimmt; das Ticket dafür gilt einmal und 60 Sekunden. |
| Jemand schiebt einem anderen die eigene Anmeldung unter (der andere arbeitet dann unbemerkt unter fremdem Namen) | Der Browser, der eine geschützte App öffnet, bekommt ein Geheimnis als Cookie; Velydock erfährt nur dessen Fingerabdruck und schreibt ihn ins Ticket. Ein Ticket löst nur der Browser ein, der das passende Geheimnis hat. Jeder andere wird zur App weitergeschickt und meldet sich dort selbst an. |
| Ein Konto wird in Keycloak gesperrt oder gelöscht | Auch auf diesem Weg fragt Velydock alle fünf Minuten bei Keycloak nach, ob Konto und Sitzung dort noch gelten – wie in der Oberfläche. Wer nur eine veröffentlichte App benutzt, behält sie also nicht bis zum Ende der Sitzung. |
| Jemand gibt sich der App gegenüber als ein anderer aus | Die Kopfzeilen `X-Velydock-User`, `-Email`, `-Name` setzt nur Velydock (und nur mit der Vorlage dafür); mitgeschickte entfernt der Proxy – bei öffentlichen Apps immer. |
| Zurückgezogene Freigabe, gelöschte Vorlage | Eine Veröffentlichung, deren Ziel nicht mehr freigegeben ist oder deren Vorlage fehlt, nimmt Velydock beim nächsten Abruf aus den Routen. Eine Vorlage in Verwendung lässt sich nicht löschen: Sie kann das sein, was eine App einschränkt. |
| Die Wege zwischen Traefik und Velydock werden von außen benutzt | Sie antworten nur unter Velydocks internem Namen; der Routen-Abruf zusätzlich nur mit einem Geheimnis. Über die öffentliche Adresse gibt es sie nicht. |

Was bleibt:

- **Im Pfad-Modus teilen sich alle Apps einen Ursprung** (`apps.example.com`). Für den Browser
  sind sie eine Website: Das Skript einer so veröffentlichten App kann die anderen so
  veröffentlichten Apps mit den Rechten der Person aufrufen, die gerade davor sitzt, und ihnen
  Cookies setzen. Dass Velydock das Cookie jeder App auf ihren Pfad beschränkt, ändert daran
  nichts – der Pfad ist im Browser keine Grenze. Das gilt auch über Organisationen hinweg. Für
  Apps und Organisationen, die einander nicht vertrauen, ist die Subdomain da; der
  Systemadministrator kann Pfad-Adressen je Organisation abschalten (*System → Organisationen*),
  und die Datenbank lässt die Organisation das nicht selbst ändern.
- Alle Apps unter derselben Domain wie Velydock können Cookies für die ganze Domain setzen
  ([einschraenkungen.md](einschraenkungen.md)).
- Eine „öffentliche“ App schützt nur sich selbst.
- Veröffentlichte Routen haben keine voreingestellte Ratenbegrenzung; sie lässt sich je App oder
  Vorlage setzen. Der Umweg über Velydocks Anmeldung (`/proxy/login`) ist wie die API begrenzt.

## Eingaben

- Alle Anfragen werden gegen ein Schema geprüft; unbekannte Felder führen zu einem Fehler.
- Anfragen über 4 MB werden abgewiesen, ohne eine Verarbeitung zu erreichen oder im Speicher zu
  landen – auch ohne Anmeldung.
- NUL-Zeichen werden in Adresse und Inhalt abgelehnt.
- Vor- und Nachnamen dürfen die Zeichen nicht enthalten, die auch Keycloak ablehnt
  (`< > & " $ % ! # ? § ; * ~ / \ | ^ = [ ] { } ( )`); Benutzernamen haben mindestens drei Zeichen.
- Folgen von Leerzeichen, Tabulatoren und Zeilenumbrüchen in Namen werden zu einem Leerzeichen:
  Zwei Namen, die sich nur darin unterscheiden, sähen gleich aus.
- Der Name der Installation darf weder `<` noch `>` noch Zeichenreferenzen wie `&lt;` enthalten.
  Keycloak gibt ihn auf seinen Seiten und in seinen E-Mails über einen HTML-Filter aus, der
  Zeichenreferenzen zuerst auflöst und Links und Bilder durchlässt; ein maskierter Link käme dort
  als Link an. Ein einfaches `&` ist erlaubt.
- App-Adressen: nur `http`/`https`, keine Zugangsdaten in der Adresse; eingebettete Apps nur `https`.
- Icons und Logos: höchstens 256 KB; der Typ wird am Inhalt erkannt, nicht an der Angabe. Sie
  werden mit einer eigenen sandboxenden CSP ausgeliefert, sodass ein Skript in einer SVG-Datei nie
  läuft. Das Logo gibt es nur unter einer Adresse ohne Organisationsangabe: Jeder erhält das der
  Organisation, in der seine Session arbeitet.
- Die Akzentfarbe ist ein Farbwert (`#rrggbb`), kein CSS: Eine Organisation kann die Oberfläche
  einfärben, aber nichts verstecken, überlagern oder nachladen.
- Datenbankzugriffe verwenden ausschließlich gebundene Parameter.

## Einbettungsprüfung (SSRF)

Die Prüfung ruft eine von Administratoren eingegebene Adresse vom Server aus ab. Dabei gilt: nur
`http`/`https`, jede aufgelöste Adresse muss öffentlich sein, die Verbindung geht an genau die
geprüfte Adresse, der Inhalt wird weder gelesen noch zurückgegeben. Weiterleitungen werden nur
innerhalb desselben Hosts verfolgt (höchstens drei, an dieselbe geprüfte Adresse) – so zählt die
Seite, die der Browser am Ende zeigt, etwa die Anmeldeseite der App. Eine Weiterleitung auf einen
anderen Host beendet die Prüfung mit „ungeprüft“.

Eine Prüfung dauert höchstens zwölf Sekunden, und es laufen höchstens drei gleichzeitig; weitere
enden sofort mit „ungeprüft“. Ohne diese Grenzen könnte eine Seite, die ihre Antwort tröpfchenweise
sendet, Datenbankverbindungen der ganzen Installation binden.

Private Netze lassen sich mit `VELYDOCK_EMBED_CHECK_ALLOW_PRIVATE=true` freigeben;
dann können Mandantenadministratoren erkennen, ob interne Adressen antworten.

## Administration

- Kein Standardpasswort. `velydock setup-admin` erzeugt ein Einmalpasswort, das einmal angezeigt
  wird und bei der ersten Anmeldung geändert werden muss. Das Einmalpasswort selbst wird dabei
  nicht als eigenes Passwort angenommen (Passwort-Historie).
- Zwei-Faktor-Pflicht für alle Rollen mit Verwaltungsrechten (abschaltbar). Es zählt die
  Authenticator-App; „Passwort vergessen“ führt nicht an ihr vorbei.
- Einmalpasswörter neuer Benutzer werden einmal angezeigt und nirgends gespeichert.
- Das Protokoll ist über die Anwendung nur anfügbar: Für Ändern und Löschen existiert keine
  Datenbank-Richtlinie.
- Keycloaks Verwaltungsoberfläche, Admin-API und der Realm `master` sind von außen nicht
  erreichbar; Traefik leitet nur `/realms/velydock/` und `/resources/` weiter.

## Keycloak

- Der Dienstzugang von Velydock hat nur die Rollen, die er braucht (Benutzer, Organizations,
  Realm-Einstellungen, eigene Clients) – nicht `realm-admin`, nicht Impersonation.
- Realm: Registrierung aus, Brute-Force-Schutz an, Passwörter mindestens 12 Zeichen, weder
  Benutzername noch E-Mail und keines der letzten drei, Anmeldeereignisse 30 Tage.
  Passwort-Richtlinie und Schwellenwerte des Brute-Force-Schutzes sind Ausgangswerte beim Anlegen
  des Realms; wer sie in Keycloak ändert, behält seine Einstellung. Nur eine Richtlinie, die noch
  genau dem Ausgangswert einer früheren Velydock-Version entspricht, wird beim Start auf den
  aktuellen gebracht.
- Die E-Mail-Adresse ändern nur Administratoren. Eine selbst geänderte Adresse könnte in
  angebundenen Apps zur Übernahme fremder Konten führen. Aus demselben Grund gilt eine von
  Administratoren eingetragene Adresse gegenüber angebundenen Apps nicht als bestätigt
  ([sso.md](sso.md)).
- Der eingebaute öffentliche Client `admin-cli` des Realms nimmt keine Passwort-Anmeldung an.
  Sonst könnte jeder Passwörter direkt am Token-Endpunkt durchprobieren.
- Die Anmeldeschritte und der Token-Endpunkt von Keycloak sind am Proxy je Client-Adresse
  gedrosselt (im Mittel 20 Anfragen je Sekunde). Das bremst massenhaftes Raten von Passwörtern;
  gegen das gezielte Aussperren eines Kontos hilft es nicht.
- Der Brute-Force-Schutz sperrt ein Konto nach acht Fehlversuchen für kurze Zeit. Die Kehrseite:
  Wer einen Benutzernamen kennt, kann dieses Konto von außen vorübergehend aussperren
  ([einschraenkungen.md](einschraenkungen.md)).

## Container

Kein Dienst läuft privilegiert, alle mit `no-new-privileges`. `velydock` läuft als eigener
Benutzer ohne Capabilities auf schreibgeschütztem Dateisystem. Der Dienst `theme` läuft bei jedem
Start einmal kurz als root und ohne Netzwerk: Er kopiert das Login-Theme in ein Volume und setzt
dort die Dateirechte. Traefik hat keinen Zugriff auf den Docker-Socket. PostgreSQL ist nur im
internen Netz erreichbar. Python-Abhängigkeiten sind mit Hashes festgeschrieben.

## Sicherheitsrelevante Einschränkungen

Siehe [einschraenkungen.md](einschraenkungen.md).
