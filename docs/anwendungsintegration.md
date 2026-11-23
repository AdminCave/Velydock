# Anwendungen integrieren

Velydock kennt drei Arten von Apps. Alle werden unter **Verwaltung → Apps** angelegt und an alle
Mitglieder, an Gruppen oder an einzelne Benutzer freigegeben.

| Typ | Was passiert | Wofür |
|---|---|---|
| **Eingebettet** | Die Adresse wird in einem Frame innerhalb von Velydock angezeigt. | Apps, die das Einbetten erlauben und unter derselben Domain laufen |
| **Neuer Tab** | Ein Klick öffnet die Adresse in einem neuen Browser-Tab. | Alles andere – funktioniert immer |
| **Eigene App** | HTML, CSS und JavaScript, die ein Administrator in Velydock eingibt. | Linklisten, Hinweise, kleine Werkzeuge |

## Eingebettete Apps

Geöffnete eingebettete Apps bleiben beim Wechsel geladen (bis zu fünf gleichzeitig), sodass
Eingaben und Position erhalten bleiben. Jede App hat in der Kopfzeile „Neu laden“ und „In neuem
Tab öffnen“. Meldet eine App nach zehn Sekunden noch nicht, dass sie geladen ist, bietet Velydock
„In neuem Tab öffnen“ in einem Hinweis an. Ob eine App wirklich etwas anzeigt, kann Velydock
nicht sehen: Auch die Fehlerseite des Browsers gilt als geladen.

### Zwei Voraussetzungen

**1. Die App muss das Einbetten erlauben.** Viele Webanwendungen verbieten es mit dem Header
`X-Frame-Options` oder der CSP-Direktive `frame-ancestors`, um Clickjacking zu verhindern. Der
Browser zeigt dann einen leeren Frame.

Velydock prüft das beim Speichern der App und mit der Schaltfläche „Einbettbarkeit prüfen“:

| Ergebnis | Bedeutung |
|---|---|
| Einbettbar | Kein Verbot gefunden, oder Velydocks Adresse ist ausdrücklich erlaubt. |
| Blockiert | Die App verbietet das Einbetten. Velydock zeigt statt eines leeren Frames einen Hinweis mit „In neuem Tab öffnen“. Empfehlung: Typ auf „Neuer Tab“ stellen oder die App umkonfigurieren. |
| Ungeprüft | Die Adresse war vom Server aus nicht prüfbar (privates Netz, nicht erreichbar, Weiterleitung auf einen anderen Host, etwa einen Anmeldedienst). Velydock versucht die Einbettung. |

Unter dem Ergebnis steht der Grund – zum Beispiel, welche Regel der App das Einbetten verbietet
oder wohin sie weiterleitet.

Die Prüfung folgt Weiterleitungen innerhalb desselben Hosts (etwa auf die eigene Anmeldeseite der
App) und beurteilt die Seite, die am Ende angezeigt würde. Leitet eine App erst nach der Anmeldung
auf eine Seite mit Verbot, bleibt das unentdeckt.

Um das Einbetten zu erlauben, muss die App (oder der Proxy davor) Velydocks Adresse zulassen:

```
Content-Security-Policy: frame-ancestors 'self' https://dock.example.com
```

und darf kein `X-Frame-Options: DENY` oder `SAMEORIGIN` senden. Bei Nextcloud, OpenProject und
ähnlichen Anwendungen geschieht das in deren Konfiguration oder im vorgeschalteten Reverse Proxy.

**2. Die App muss unter derselben Domain laufen.** Browser behandeln Cookies eines Frames als
Drittanbieter-Cookies, wenn dessen Domain eine andere ist als die der umgebenden Seite. Safari
blockiert sie, Firefox trennt sie ab, und Cookies mit `SameSite=Lax` – der heutige Standard –
werden in fremden Frames nie gesendet. Die Anmeldung der App schlägt dann fehl oder beginnt
endlos von vorn.

| Velydock | App | Ergebnis |
|---|---|---|
| `dock.example.com` | `cloud.example.com` | funktioniert (gleiche registrierbare Domain) |
| `dock.dienstleister.de` | `cloud.kunde.de` | nicht zuverlässig – Typ „Neuer Tab“ verwenden |

Für einen Dienstleister mit Kunden unter eigenen Domains heißt das: Apps der Kunden werden in
der Regel als „Neuer Tab“ eingebunden, solange Velydock nicht unter der Kundendomain erreichbar
ist.

Dieselbe Domain hat eine Kehrseite: Jede App unter ihr kann Cookies für die ganze Domain setzen
und damit die Anmeldung bei Keycloak beeinflussen ([sicherheit.md](sicherheit.md#eingebettete-fremde-apps)).
Unter die Domain von Velydock gehören nur Apps, deren Betreiber man vertraut.

### Anmeldung in eingebetteten Apps

Ist die App per OIDC an Keycloak angebunden ([sso.md](sso.md)), meldet sie den Benutzer im Frame
ohne Rückfrage an, weil dessen Keycloak-Sitzung bereits besteht. Keycloaks Anmeldeseite selbst
lässt sich nicht einbetten. Verlangt die App im Frame eine neue Anmeldung (etwa nach Ablauf der
Keycloak-Sitzung), bleibt der Frame leer; „In neuem Tab öffnen“ führt dann zur Anmeldung.

### Browser-Funktionen

Kamera, Mikrofon, Zwischenablage (lesen/schreiben), Vollbild und Bildschirmfreigabe stehen einer
eingebetteten App nur zur Verfügung, wenn sie in den App-Einstellungen angehakt sind – nötig etwa
für Videokonferenzen. Eine Ausnahme macht der Browser selbst: Nach einem Klick in der App kann
jede eingebettete Seite etwas in die Zwischenablage legen, auch ohne das Häkchen. Lesen kann sie
die Zwischenablage ohne Häkchen nicht.

Eingebettete Apps können die Velydock-Seite nicht von sich aus durch eine andere ersetzen.

Geöffnete Apps bleiben im Hintergrund geladen, damit der Wechsel zwischen ihnen schnell geht.
Tastatureingaben erhält aber nur die App, die gerade zu sehen ist: Zieht eine App im Hintergrund
den Tastaturfokus an sich, nimmt Velydock ihn zurück und beendet die App sofort – einen zweiten
Versuch gibt es nicht ([sicherheit.md](sicherheit.md#eigene-apps)). Eine App, die sich im
Hintergrund selbst den Fokus holt (etwa ein Suchfeld, das sich nach dem Laden aktiviert, oder
ein Terminal, das den Fokus festhält), wird deshalb geschlossen, sobald man woanders arbeitet;
ein Hinweis nennt die App und den Grund, und sie lässt sich neu öffnen.

## Apps im neuen Tab

Die Adresse wird in einem neuen Tab geöffnet; die neue Seite erhält keinen Zugriff auf das
Velydock-Fenster. `http://`-Adressen sind hier erlaubt (interne Geräte), bei eingebetteten Apps
nicht, weil Browser sie in einer `https`-Seite nicht laden.

## Apps über den Proxy veröffentlichen

Liegt eine Anwendung nur im internen Netz, kann Velydocks eingebauter Proxy sie nach außen
bereitstellen. Die App bekommt dann eine öffentliche Adresse, und Velydock leitet die Anfragen an
die interne weiter. Das gibt es für eingebettete Apps und Apps im neuen Tab, wenn der Betreiber
einen Apps-Host eingerichtet hat ([betrieb.md](betrieb.md#apps-über-den-proxy-veröffentlichen)).

Im App-Dialog unter **Über den Proxy veröffentlichen**:

| Angabe | Bedeutung |
|---|---|
| **Interne Adresse** | Wohin der Proxy weiterleitet, z. B. `http://10.20.0.7:8080`. Möglich ist nur, was der Systemadministrator für die Organisation freigegeben hat; der Dialog zeigt die Freigaben. Hostnamen gehen nur, wenn genau dieser Name freigegeben ist. |
| **Adresse** | *Pfad* (Standard): `https://apps.example.com/name/`. *Subdomain*: `https://name.apps.example.com/`. Der **Name in der Adresse** (Kleinbuchstaben, Ziffern, Bindestriche) wird aus dem Namen der App vorgeschlagen und ist über alle Organisationen eindeutig; darunter steht die **öffentliche Adresse**, die sich ergibt. Hat der Systemadministrator Pfad-Adressen für die Organisation abgeschaltet, gibt es nur die Subdomain. |
| **Zugriff** | *Geschützt* (Standard): nur angemeldete Benutzer, denen die App freigegeben ist – wer die Adresse ohne Anmeldung öffnet, landet bei Velydocks Anmeldung und danach in der App. *Öffentlich*: jeder, der die Adresse kennt. |
| **Vorlage** | Ein Satz von Proxy-Einstellungen; einzelne lassen sich darunter abweichend setzen. |

**Pfad oder Subdomain?** Der Pfad braucht keinen weiteren DNS-Eintrag, hat aber zwei Haken. Die
Anwendung muss damit zurechtkommen, nicht an der Wurzel der Adresse zu liegen: Velydock entfernt
den Namen aus dem Pfad, bevor es weiterleitet, und teilt ihn der Anwendung mit
(`X-Forwarded-Prefix`) – Anwendungen, die ihre Links trotzdem mit `/` beginnen lassen,
funktionieren so nicht (dann die Vorlage „App kennt ihren Unterpfad“ und die Anwendung
entsprechend einstellen, oder die Subdomain wählen). Und alle Apps im Pfad-Modus teilen sich im
Browser einen Ursprung: Das Skript der einen kann die anderen mit den Rechten der Person
aufrufen, die sie gerade benutzt ([sicherheit.md](sicherheit.md#veröffentlichte-apps-proxy)). Die
Subdomain hat beides nicht, braucht aber einen DNS-Eintrag.

**Vorlagen und Einstellungen**

| Einstellung | Wirkung | Mitgelieferte Vorlage |
|---|---|---|
| Namen aus dem Pfad entfernen | Nur Pfad-Modus: Die Anwendung sieht `/seite` statt `/name/seite`. Standard: an. | „App kennt ihren Unterpfad“ schaltet es aus |
| Einbettung erlauben | Entfernt `X-Frame-Options` aus den Antworten der Anwendung. | „In Velydock einbettbar“ |
| Zertifikat des Ziels nicht prüfen | Für interne Geräte mit selbstsigniertem Zertifikat (`https://`-Ziele). | „Internes Gerät mit selbstsigniertem Zertifikat“ |
| Anmeldung per Kopfzeile | Die Anwendung erfährt, wer angemeldet ist: `X-Velydock-User`, `X-Velydock-Email`, `X-Velydock-Name`. Nur bei geschützten Apps. Die Anwendung muss so eingerichtet sein, dass sie diesen Kopfzeilen nur vom Proxy glaubt. | „Anmeldung per Kopfzeile“ |
| Öffentlichen Hostnamen weitergeben | Die Anwendung sieht den öffentlichen Namen als `Host`. Standard: an. | – |
| Anfragen begrenzen | Höchstzahl pro Sekunde je Client-Adresse. | – |
| Zusätzliche Kopfzeilen | Zwei Felder, je Zeile „Name: Wert“: *an die Anwendung* (z. B. ein fester `Authorization`-Wert für ein Gerät ohne eigene Benutzer) und *an den Browser*. Nicht möglich: Kopfzeilen, die der Proxy selbst setzt (`Host`, `X-Forwarded-…`, `X-Velydock-…`), und `Set-Cookie`. | – |

Unter **Einstellungen anpassen** steht bei jeder Einstellung, was die gewählte Vorlage vorgibt;
gespeichert wird nur, was davon abweicht.

Eigene Vorlagen legt der Systemadministrator an (*System → Proxy-Vorlagen*). Nur er kann auch
Traefik-Middlewares im Wortlaut hinterlegen – in einer Vorlage oder, für eine einzelne App, im
App-Dialog –, etwa eine Beschränkung auf bestimmte Quelladressen:

```json
{
  "10-buero": { "ipAllowList": { "sourceRange": ["203.0.113.0/24"] } },
  "20-limit": { "rateLimit": { "average": 20, "burst": 40, "period": "1s" } }
}
```

- Je Name genau eine Middleware; Namen aus Kleinbuchstaben, Ziffern und Bindestrichen, höchstens
  31 Zeichen, höchstens zehn je Vorlage oder App. Erlaubt sind `addPrefix`, `basicAuth`, `buffering`, `compress`,
  `contentType`, `digestAuth`, `headers`, `inFlightReq`, `ipAllowList`, `rateLimit`,
  `redirectRegex`, `redirectScheme`, `replacePath`, `replacePathRegex`, `retry`, `stripPrefix`
  und `stripPrefixRegex` – nicht `forwardAuth`, `errors`, `chain` und Plugins.
- Sie wirken **nach** der Anmeldeprüfung und in der Reihenfolge ihrer Namen; mit Namen wie
  `10-…`, `20-…` lässt sich die Reihenfolge festlegen. Die einer App kommen zu denen ihrer
  Vorlage hinzu; bei gleichem Namen gilt die der App.
- Was der Systemadministrator einer einzelnen App mitgegeben hat, kann deren Organisation weder
  ändern noch entfernen. Sie verwaltet die App wie sonst; der Dialog weist darauf hin.
- Velydock nimmt nur Felder an, die Traefik kennt, und nur Werte der richtigen Art (Zahl,
  Ja/Nein, Text, Liste, Dauer wie `"1m30s"`). Der Grund: Traefik liest die Routen aller
  Organisationen als ein Dokument und verwirft es als Ganzes, wenn es ein Feld nicht versteht.
- Ob der Inhalt stimmt (ein gültiges Netz, ein korrekter Ausdruck), zeigt erst Traefik: Ist er
  falsch, sind die Apps mit dieser Vorlage nicht erreichbar, und Traefiks Protokoll nennt den
  Grund.

**Gut zu wissen**

- Eine veröffentlichte App hat keine frei wählbare Adresse mehr; ihre Adresse ist die öffentliche.
  Wird die Veröffentlichung beendet, braucht die App wieder eine eigene.
- Änderungen wirken nach etwa fünf Sekunden.
- Zieht der Systemadministrator eine Freigabe zurück oder schaltet er Pfad-Adressen für die
  Organisation ab, ist die App nicht mehr erreichbar; die App-Liste zeigt den Grund.
- Die Arbeit in einer geschützten App zählt als Aktivität der Velydock-Sitzung.
- Soll eine geschützte App *eingebettet* funktionieren, muss der Apps-Host unter derselben Domain
  liegen wie Velydock (siehe oben, „Die App muss unter derselben Domain laufen“): Die Anmeldung
  für die App läuft im Frame, und Browser nehmen dort nur Cookies der eigenen Domain an. Liegt
  er woanders, bleibt der Frame leer; Velydock weist dann darauf hin und bietet an, die App im
  neuen Tab zu öffnen – dort funktioniert sie.

## Eigene Apps

Eine eigene App besteht aus drei Feldern: HTML (Inhalt des `<body>`), CSS und JavaScript. Velydock
setzt daraus ein Dokument zusammen und zeigt es in einem abgeschotteten Frame.

Was eigener Code kann:

- Inhalte anzeigen, auf Eingaben reagieren, Formulare und Dialoge verwenden.
- Mit „Netzwerkzugriff erlauben“: Links in neuen Tabs öffnen (`target="_blank"`) und Daten von
  `https://`-Adressen laden (`fetch`, Bilder, Schriften, Skripte), sofern die Gegenseite das
  zulässt.
- Das Design des Benutzers übernehmen: `<html data-theme="dark|light" lang="de|en">`.

Was eigener Code nicht kann:

- Cookies, `localStorage` oder `sessionStorage` lesen oder schreiben – er hat keinen eigenen Origin.
  Zustand geht beim Neuladen verloren.
- Auf die Velydock-Seite, die Sitzung oder die API zugreifen.
- Die Velydock-Seite auf eine andere Adresse umleiten.
- Ohne die Netzwerk-Option Inhalte laden, Daten per `fetch`, Formular oder Fenster an eine
  Adresse senden, sich selbst auf eine fremde Adresse umleiten oder Links öffnen. (Zwei
  technische Ausnahmen lassen sich mit Browser-Mitteln nicht schließen; siehe
  [sicherheit.md](sicherheit.md#eigene-apps).)

Beispiel einer Linkliste – sie braucht „Netzwerkzugriff erlauben“, damit die Links aufgehen:

```html
<h1>Wichtige Links</h1>
<ul>
  <li><a href="https://status.example.com" target="_blank" rel="noopener">Systemstatus</a></li>
  <li><a href="https://wiki.example.com" target="_blank" rel="noopener">Wiki</a></li>
</ul>
```

```css
body { font: 15px/1.6 system-ui, sans-serif; margin: 2rem; }
html[data-theme="dark"] body { background: #17181b; color: #ededee; }
a { color: #4f9dff; }
```

Grenzen: HTML und JavaScript je 300 000 Zeichen, CSS 150 000. Die technischen Schutzmaßnahmen
stehen in [sicherheit.md](sicherheit.md#eigene-apps).

## Icons

Entweder eines der mitgelieferten Symbole oder ein hochgeladenes Bild (PNG, JPEG, GIF, WebP oder
SVG, höchstens 256 KB).

## Single Sign-On für angebundene Apps

Siehe [sso.md](sso.md#apps-per-sso-anbinden).
