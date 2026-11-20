# SSO-Konzept

## Grundsatz

Es gibt genau einen Ort, an dem sich Benutzer anmelden: Keycloak. Velydock und jede angebundene
App sind OIDC-Clients desselben Realms `velydock`. Wer bei Velydock angemeldet ist, hat eine
Keycloak-Sitzung; öffnet er eine angebundene App, meldet Keycloak ihn dort ohne Passwortabfrage an.

Velydock kopiert keine Cookies fremder Anwendungen und speichert keine Passwörter.

## Anmeldung bei Velydock

```
Browser            Velydock                      Keycloak
   │ GET /api/auth/login │                           │
   │────────────────────►│ state, nonce, PKCE-Paar   │
   │◄── 302 + Login-Cookie (signiert, 10 min) ───────│
   │ Anmeldeseite, Passwort, ggf. zweiter Faktor     │
   │────────────────────────────────────────────────►│
   │◄── 302 /api/auth/callback?code=…&state=… ───────│
   │────────────────────►│ Code + PKCE-Verifier      │
   │                     │──────────────────────────►│  (internes Netz)
   │                     │◄── ID-Token ──────────────│
   │                     │ prüfen, Session anlegen   │
   │◄── 302 Ziel + Session-Cookie ───────────────────│
```

Was geprüft wird (`security/oidc.py`, `api/auth.py`):

- `state` aus der Antwort gegen den Wert im signierten Login-Cookie. Eine Callback-Adresse ist
  damit in einem anderen Browser wertlos.
- PKCE (S256): Keycloak verlangt es für diesen Client; ohne passenden Verifier gibt es kein Token.
- ID-Token: Signatur gegen die Schlüssel des Realms, nur asymmetrische Verfahren, Aussteller,
  Empfänger (`aud`, bei mehreren zusätzlich `azp`), Ablaufzeit, `nonce`.
- Der Aussteller in den Metadaten muss der konfigurierten öffentlichen Keycloak-Adresse entsprechen.
- Ziel nach der Anmeldung: nur lokale Pfade.

Zuordnung zur Velydock-Identität über die Keycloak-Benutzer-ID (`sub`). Name und E-Mail werden bei
jeder Anmeldung aus dem Token übernommen. Eine unbekannte Identität wird ohne Mandant angelegt –
auch ohne E-Mail-Adresse, wie sie bei Konten aus einem Verzeichnis vorkommt. Trägt sie einen
bereits vergebenen Benutzernamen oder eine vergebene E-Mail, wird die Anmeldung abgelehnt
(`account_conflict`), statt Konten stillschweigend zu verknüpfen. Namen, die länger sind als in
Velydock vorgesehen (100 Zeichen), werden gekürzt; ein Benutzername über 150 Zeichen wird
abgelehnt.

## Sessions und Abmeldung

| Ereignis | Wirkung |
|---|---|
| Leerlauf (Standard 120 min) oder Maximaldauer (Standard 12 h) | Session ungültig, nächste Anfrage erhält 401; die Anmeldeseite sagt, dass die Sitzung abgelaufen ist. |
| „Abmelden“ in Velydock | Session wird gelöscht, der Browser wird zu Keycloaks End-Session-Adresse geschickt; damit endet auch die Keycloak-Sitzung. Das gilt auch dann, wenn die Velydock-Session zu diesem Zeitpunkt schon abgelaufen war. |
| Abmeldung oder Sitzungsende in Keycloak | Keycloak ruft `POST /api/auth/backchannel-logout` mit einem signierten Logout-Token auf; Velydock beendet die zugehörige Session. |
| Administrator deaktiviert das Konto, setzt das Passwort zurück oder beendet Sitzungen | Velydock löscht die Sessions sofort und meldet den Benutzer in Keycloak ab. |
| Ein Konto erhält Verwaltungsrechte (Rolle Benutzerverwaltung oder Administration, Systemadministrator) | Velydock beendet die laufenden Sessions dieses Kontos. Die neuen Rechte gelten erst nach erneuter Anmeldung – dort greift die Zwei-Faktor-Pflicht. |

**Was als Aktivität zählt.** Jede Anfrage an die Velydock-API. Zusätzlich meldet sich die
Oberfläche alle fünf Minuten, solange das Velydock-Fenster sichtbar ist und den Fokus hat – also
auch, während jemand in einer eingebetteten App arbeitet. Ein Fenster im Hintergrund oder ein
gesperrter Bildschirm zählt nicht.

**Was der Leerlauf-Ablauf nicht ist.** Er beendet die Velydock-Session, nicht die Keycloak-Sitzung.
Solange diese besteht (bis zur Maximaldauer), genügt nach dem Ablauf ein Klick auf „Anmelden“ ohne
Passwort. Wer einen Arbeitsplatz verlässt, meldet sich ab; „Abmelden“ beendet beide Sitzungen.

Die Keycloak-Sitzung ist so lang eingestellt wie die maximale Velydock-Session. So melden sich
Apps, die später am Tag geöffnet werden, weiterhin ohne Rückfrage an.

**Mehrere Tabs.** Die aktive Organisation gehört zur Session, nicht zum Tab. Wechselt sie in einem
Tab, schickt ein anderer Tab mit jeder Anfrage weiterhin die Organisation mit, die er anzeigt
(`X-Velydock-Tenant`). Stimmt sie nicht mehr, lehnt die API die Anfrage mit `409 tenant_changed`
ab, statt die Änderung in der anderen Organisation auszuführen; der Tab lädt daraufhin die neue
Organisation. Der Header kann keine Organisation auswählen, nur eine Anfrage scheitern lassen.

## Erste Anmeldung und Zwei-Faktor

- Neue Konten erhalten ein Einmalpasswort (oder einen Link per E-Mail). Keycloak erzwingt bei der
  ersten Anmeldung ein eigenes Passwort. Der Link aus der E-Mail führt auf eine Seite von Keycloak,
  auf der die Person ihr Passwort setzt; von dort geht es zurück zu Velydock.
- Ist „Zwei-Faktor für Administratoren“ aktiv, müssen Systemadministratoren,
  Mandantenadministratoren und Benutzerverwalter eine Authenticator-App einrichten, bevor sie
  hineinkommen. Mitglieder richten den zweiten Faktor freiwillig über „Passwort & Sicherheit“ ein.
  Wer befördert wird, während er angemeldet ist, wird abgemeldet und richtet den zweiten Faktor
  bei der nächsten Anmeldung ein. Wird die Pflicht eingeschaltet, gilt sie für bereits
  angemeldete Verwalter ab deren nächster Anmeldung.
- Passwort, zweiter Faktor und Passkeys verwaltet jeder Benutzer in Keycloaks Kontoseite; Velydock
  verlinkt dorthin.

## Apps per SSO anbinden

Eine App, die OIDC spricht, wird als weiterer Client im Realm `velydock` angelegt. Das geschieht in
Version 0.1 in der Keycloak-Verwaltungsoberfläche (Zugang siehe [betrieb.md](betrieb.md)); Velydock
legt Clients noch nicht selbst an.

Allgemeine Schritte:

1. In Keycloak, Realm `velydock`: *Clients → Create client*, Typ OpenID Connect, Client-ID frei
   wählbar (z. B. `nextcloud-acme`), *Client authentication* an, nur *Standard flow*.
2. Redirect-URI der App eintragen (steht in deren Dokumentation).
3. In der App: Aussteller `https://<KEYCLOAK_HOST>/realms/velydock`, Client-ID und Secret.
4. In Velydock die App anlegen (eingebettet oder neuer Tab).

Hinweise zu verbreiteten Anwendungen (nicht Teil der automatisierten Tests):

| Anwendung | Anbindung |
|---|---|
| Nextcloud | App „OpenID Connect user backend“ (`user_oidc`), Discovery-Adresse `…/realms/velydock/.well-known/openid-configuration`. |
| OpenProject | *Administration → Authentifizierung → OpenID-Provider*, benutzerdefinierter Anbieter. |
| mailcow / SOGo | *System → Konfiguration → Identity Provider*: Typ Keycloak oder generisches OIDC. Die SOGo-Anmeldung läuft über mailcow. |
| ONLYOFFICE Docs | Hat keine eigene Benutzeranmeldung; wird über Nextcloud eingebunden. |

### Apps eines einzelnen Kunden abgrenzen

Im gemeinsamen Realm kann sich zunächst jeder Benutzer an jedem Client anmelden. Für die App
eines einzelnen Kunden muss deshalb die Organization geprüft werden:

- Dem Client den Client-Scope `organization` zuweisen. Fordert die App
  `scope=openid organization` an, enthält das Token den Claim `organization` mit den Kurznamen der
  Mandanten des Benutzers. Fordert sie `organization:<kurzname>` an und der Benutzer gehört nicht
  dazu, fehlt der Claim. Dieses Verhalten ist durch einen Integrationstest gegen Keycloak belegt.
- Die App muss den Claim auswerten (z. B. Anmeldung nur mit passendem Wert) oder Keycloak muss den
  Zugriff über einen eigenen Authentifizierungsablauf für diesen Client verweigern.

Ohne eine dieser Maßnahmen legen Apps mit automatischer Kontoerstellung auch für Benutzer anderer
Mandanten ein Konto an. Das ist die wichtigste Folge des gemeinsamen Realms
([entscheidungen.md](entscheidungen.md), Punkt 2).

## Vorhandene Identity Provider und Verzeichnisse

- **Externer Login (Entra ID, Google, SAML):** in Keycloak als *Identity Provider* einrichten und
  bei Bedarf einer Organization zuordnen; Keycloak leitet dann anhand der E-Mail-Domain weiter.
- **Active Directory / LDAP:** in Keycloak als *User Federation*.

In beiden Fällen entsteht die Velydock-Identität bei der ersten Anmeldung ohne Mandant; ein
Systemadministrator ordnet sie unter *System → Alle Benutzer* zu. Eine automatische Zuordnung ist als
Erweiterung vorgesehen.
