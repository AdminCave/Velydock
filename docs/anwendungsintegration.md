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
