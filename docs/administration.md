# Administratorhandbuch

Dieses Handbuch beschreibt die Verwaltung in der Oberfläche. Es gibt zwei Bereiche:

- **Verwaltung** – für die Organisation, in der du gerade arbeitest: Benutzer, Gruppen, Apps,
  Einstellungen, Protokoll. Erreichbar über das Verwaltungs-Symbol im Dock.
- **System** – für die ganze Installation: Organisationen, Alle Benutzer, Systemeinstellungen,
  Systemprotokoll. Nur für Systemadministratoren.

In der Oberfläche heißen Mandanten **Organisationen**.

## Rollen

| Rolle in der Oberfläche | Darf |
|---|---|
| **Mitglied** | Die freigegebenen Apps nutzen, das eigene Profil und die eigenen Einstellungen ändern. |
| **Benutzerverwaltung** | Zusätzlich Benutzer und Gruppen der Organisation verwalten. Kann nur Mitglieder anlegen und keine Rollen vergeben. |
| **Administration** | Zusätzlich Rollen vergeben, Apps und Einstellungen der Organisation verwalten, das Protokoll lesen. |
| **Systemadministration** | Alles in allen Organisationen; Organisationen anlegen und löschen; Systemeinstellungen. |

Grundregeln, die die Oberfläche durchsetzt:

- Niemand ändert die eigene Rolle, deaktiviert oder löscht das eigene Konto.
- Niemand verwaltet ein Konto mit höherer Rolle. Wer die Rolle „Benutzerverwaltung“ hat, kann das
  Passwort eines Administrators nicht zurücksetzen.
- Systemadministratoren können von Administratoren einer Organisation nicht verändert werden.

## Organisationen (System → Organisationen)

Jede Organisation hat einen **Namen** und einen **Kurznamen** (Kleinbuchstaben, Ziffern,
Bindestriche). Der Kurzname ist dauerhaft; er erscheint in Keycloak als Alias der Organization.

| Aktion | Wirkung |
|---|---|
| **Organisation anlegen** | Legt die Organisation und ihr Gegenstück in Keycloak an. Sie ist zunächst leer. |
| **Betreten** | Wechselt in die Organisation. Als Systemadministrator kannst du dort alles verwalten, ohne Mitglied zu sein, und siehst alle ihre Apps. |
| **Umbenennen** | Ändert den Namen; der Kurzname bleibt. |
| **Deaktivieren** | Mitglieder behalten ihr Konto, können die Organisation aber nicht mehr betreten. Wer nur dieser Organisation angehört, sieht nach der Anmeldung einen Hinweis statt des Workspace. |
| **Löschen** | Entfernt die Organisation mit Gruppen, Apps und Protokoll **und löscht alle Konten, die ihr gehören**. Gäste aus anderen Organisationen behalten ihr Konto. Zur Bestätigung muss der Kurzname eingegeben werden. Nicht umkehrbar. |

Die Organisation, der ein Systemadministrator angehört, lässt sich weder deaktivieren noch löschen.

**Eine neue Organisation einrichten:** anlegen → „Betreten“ → unter *Verwaltung → Benutzer* den
ersten Benutzer mit der Rolle „Administration“ anlegen. Ab dann kann die Organisation sich selbst
verwalten.

Zwischen Organisationen wechselst du über den Organisations-Umschalter im Dock. Er erscheint, wenn
du mehr als einer Organisation angehörst oder Systemadministrator bist.

## Benutzer (Verwaltung → Benutzer)

Die Tabelle zeigt Name, Benutzername, E-Mail-Adresse, Rolle, Gruppen, Status und letzte Anmeldung.
Die Suche durchsucht Name, Benutzername und E-Mail; daneben lässt sich nach Rolle und Status
filtern.

### Benutzer anlegen

| Feld | Hinweis |
|---|---|
| **Benutzername** | 2 bis 64 Zeichen: Kleinbuchstaben, Ziffern, Punkt, Bindestrich, Unterstrich. Lässt sich später nicht ändern. In der ganzen Installation eindeutig. |
| **Vorname**, **Nachname** | Pflicht. |
| **E-Mail-Adresse** | Optional (für Konten ohne Postfach). In der ganzen Installation eindeutig. |
| **Rolle** | Andere Rollen als „Mitglied“ kann nur vergeben, wer selbst „Administration“ hat. |
| **Gruppen** | Bestimmen, welche Apps die Person sieht. |
| **Link zum Passwort-Setzen per E-Mail senden** | Nur mit eingerichtetem E-Mail-Versand und E-Mail-Adresse. |

Nach „Konto anlegen“ zeigt Velydock ein **Einmalpasswort** – nur dieses eine Mal. Gib es der
Person auf sicherem Weg weiter. Bei der ersten Anmeldung muss sie ein eigenes Passwort wählen
(mindestens 12 Zeichen). Mit der E-Mail-Option erhält sie stattdessen einen Link und es wird kein
Passwort angezeigt.

Meldet Velydock, dass Benutzername oder E-Mail-Adresse vergeben sind, existiert das Konto bereits
– möglicherweise in einer anderen Organisation. Soll diese Person auch bei dir arbeiten, fügt sie
ein Systemadministrator hinzu (siehe „Gäste“).

### Aktionen je Benutzer

| Aktion | Wirkung |
|---|---|
| **Bearbeiten** | Name, E-Mail-Adresse, Rolle, Gruppen. |
| **Passwort zurücksetzen** | Zeigt ein neues Einmalpasswort und meldet die Person überall ab. |
| **Sitzungen beenden** | Meldet die Person überall ab, in Velydock und in Keycloak. |
| **Deaktivieren / Reaktivieren** | Sperrt die Anmeldung sofort und beendet laufende Sitzungen. Daten und Zuordnungen bleiben erhalten. |
| **Konto löschen** | Löscht das Konto endgültig, auch in Keycloak. |
| **Aus Organisation entfernen** | Nur bei Gästen: beendet die Mitgliedschaft; das Konto bleibt bestehen. |

Das eigene Passwort setzt man nicht hier zurück, sondern unter *Profil → Passwort & Sicherheit*.

### Gäste

Ein Konto gehört immer genau einer Organisation. Arbeitet die Person zusätzlich in einer anderen,
ist sie dort **Gast** (Kennzeichnung in der Tabelle). Bei Gästen kannst du Rolle und Gruppen
ändern und sie entfernen – Name, E-Mail-Adresse, Passwort und Sperre verwaltet die Organisation,
der das Konto gehört.

Gäste fügt ein Systemadministrator hinzu: *System → Alle Benutzer* → Aktion **Zu Organisation
hinzufügen** → Organisation und Rolle wählen.

### Konten ohne Organisation

Unter *System → Alle Benutzer* erscheinen auch Konten ohne Organisation. Sie entstehen, wenn sich
jemand anmeldet, den Velydock noch nicht kennt – etwa ein Konto aus einem angebundenen
Verzeichnis. Die Person sieht nach der Anmeldung nur einen Hinweis, bis ein Systemadministrator
sie einer Organisation hinzufügt. Die erste Organisation wird zur Eigentümerin des Kontos.

### Systemadministratoren

*System → Alle Benutzer* → **Zum Systemadministrator machen** oder **Systemadministrator-Recht
entziehen**. Das eigene Recht kann man sich nicht entziehen, und mindestens ein aktiver
Systemadministrator bleibt immer bestehen.

## Gruppen (Verwaltung → Gruppen)

Gruppen fassen Mitglieder einer Organisation zusammen, um ihnen gemeinsam Apps freizugeben. Eine
Gruppe hat Name, optionale Beschreibung und Mitglieder; die Tabelle zeigt, wie viele Mitglieder
und Apps an ihr hängen. Gruppennamen sind je Organisation eindeutig.

Wird eine Gruppe gelöscht, verlieren ihre Mitglieder die Apps, die nur über diese Gruppe
freigegeben waren. Die Apps und die Benutzer selbst bleiben.

## Apps (Verwaltung → Apps)

Die Tabelle zeigt die Apps in der Reihenfolge, in der sie im Dock erscheinen. Mit den Pfeilen
verschiebst du sie.

### App hinzufügen

| Feld | Hinweis |
|---|---|
| **Name**, **Beschreibung** | Erscheinen im Dock und auf der Startseite. |
| **Typ** | „Eingebettet“, „Neuer Tab“ oder „Eigene App“ – Erklärung in [anwendungsintegration.md](anwendungsintegration.md). |
| **Adresse (URL)** | Für eingebettete Apps nur `https://`. „Einbettbarkeit prüfen“ sagt, ob die Seite das Einbetten erlaubt, und bietet bei einem Verbot an, auf „Neuer Tab“ umzustellen. |
| **HTML, CSS, JavaScript** | Nur bei eigenen Apps. „Netzwerkzugriff erlauben“ nur einschalten, wenn die App Daten aus dem Internet laden muss. |
| **Symbol** | Aus der Auswahl oder ein eigenes Bild (höchstens 256 KB). |
| **Sichtbarkeit** | „Alle Mitglieder“ oder „Ausgewählte Gruppen und Personen“. Ohne Auswahl sieht niemand die App. |
| **Browser-Funktionen** | Nur bei eingebetteten Apps: Kamera, Mikrofon, Zwischenablage, Vollbild, Bildschirmfreigabe. |
| **App ist aktiv** | Abgeschaltete Apps sieht niemand; die Einstellungen bleiben erhalten. |

Änderungen wirken sofort: Wer eine App nicht mehr sehen darf, hat sie beim nächsten Laden nicht
mehr im Dock.

Die Spalte **Einbettung** zeigt bei eingebetteten Apps „Einbettbar“, „Blockiert“ oder
„Ungeprüft“. Hat sich an der App etwas geändert, löst „Einbettung erneut prüfen“ die Prüfung neu
aus.

Als Administrator siehst du im eigenen Workspace nur die Apps, die dir selbst freigegeben sind –
alle Apps der Organisation stehen in dieser Tabelle.

## Einstellungen der Organisation (Verwaltung → Einstellungen)

- **Standardposition** der Navigation: Links, Rechts, Oben, Unten oder „Systemstandard“. Gilt für
  alle, die keine eigene Position gewählt haben.
- **Position für alle festlegen:** Die Standardposition gilt dann für alle; die persönliche
  Einstellung ist gesperrt und wird erklärt.

Reihenfolge der Geltung: persönliche Wahl, dann Standard der Organisation, dann Systemstandard.
Eine Festlegung der Organisation überstimmt die persönliche Wahl.

## Protokoll (Verwaltung → Protokoll)

Jede Verwaltungsaktion wird mit Zeit, handelnder Person, Aktion und Ziel festgehalten: Benutzer
angelegt, geändert, deaktiviert, gelöscht; Passwörter zurückgesetzt; Gruppen und Apps angelegt,
geändert, gelöscht; Einstellungen geändert. Das Protokoll lässt sich nicht bearbeiten. Passwörter
stehen nie darin.

Aktionen, die keine einzelne Organisation betreffen (Organisationen anlegen und löschen,
Systemeinstellungen, Systemadministrator-Rechte), stehen im **Systemprotokoll**.

## Systemeinstellungen (System → Systemeinstellungen)

| Einstellung | Wirkung |
|---|---|
| **Name der Installation** | Erscheint in der Oberfläche und auf der Anmeldeseite. |
| **Standardposition des Docks**, **Standard-Design**, **Standardsprache** | Gelten, solange weder Organisation noch Benutzer etwas anderes wählen. |
| **Zwei-Faktor für Administratoren verlangen** | Wer eine Rolle mit Verwaltungsrechten hat, muss bei der Anmeldung eine Authenticator-App einrichten, falls noch keine vorhanden ist. |
| **E-Mail-Versand (SMTP)** | Server, Port, Verschlüsselung, Absender, Zugangsdaten. Danach kann Velydock Passwort-Links verschicken, und die Anmeldeseite bietet „Passwort vergessen“ an. Das Passwort wird nie wieder angezeigt; ein leeres Feld behält das gespeicherte. |

## Was Benutzer selbst tun

- **Profil:** Vor- und Nachname ändern. Die E-Mail-Adresse ändert die Administration.
- **Passwort & Sicherheit:** führt zur Kontoseite von Keycloak – Passwort ändern, zweiten Faktor
  oder Passkey einrichten, angemeldete Geräte ansehen.
- **Einstellungen:** Design (System, Hell, Dunkel), Position der Navigation, Sprache. Die Wahl
  wird am Konto gespeichert und gilt auf jedem Gerät.

## Was nur in Keycloak geht

Apps per Single Sign-On anbinden, Verzeichnisse (LDAP/AD) und externe Identity Provider
einrichten, die Passwort-Richtlinie ändern: siehe [sso.md](sso.md) und
[betrieb.md](betrieb.md#zugang-zur-keycloak-verwaltung).
