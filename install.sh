#!/usr/bin/env bash
# Velydock installer.
#
#   curl -fsSL https://github.com/AdminCave/Velydock/releases/latest/download/install.sh | sudo bash
#   sudo bash install.sh [options]                                      (see --help)
#
# It checks the server, asks a few questions (or takes every answer as an option), downloads the
# release bundle of the chosen version, verifies it against SHA256SUMS of the same release,
# unpacks it into the installation directory (default /opt/velydock), writes .env with freshly
# generated secrets, starts the stack, creates the first administrator and installs the
# management command "velydock" (scripts/velydock in the bundle).
#
# Nothing is executed from the download before its checksum has been verified. An existing .env
# and existing data are never overwritten: run on an existing installation, the installer says
# what is installed and changes nothing. A run that broke off is continued by the next one.
#
# For tests and mirrors:
#
#   VELYDOCK_RELEASE_BASE_URL   where releases are fetched from (default
#                               https://github.com/AdminCave/Velydock/releases); read are
#                               <base>/latest/download/<file> and <base>/download/v<version>/<file>
#   VELYDOCK_PULL_POLICY        "always" (default): fetch every image of the stack before the
#                               start; "missing": fetch only images the server does not have
#   --image REF                 run this image instead of the one the bundle names
#   --project-name NAME         Compose project name instead of "velydock" (kept in .env)
#
# The whole file is read before anything runs (see the last line): a download that broke off
# half-way does nothing.
set -euo pipefail

readonly DEFAULT_BASE_URL=https://github.com/AdminCave/Velydock/releases
readonly DEFAULT_DIR=/opt/velydock
readonly LAUNCHER=/usr/local/bin/velydock
readonly UNIT_DIR=/etc/systemd/system
readonly TIMER=velydock-backup.timer
readonly SERVICE=velydock-backup.service
readonly SYSTEM_LOG=/var/log/velydock-install.log
readonly MIN_MEMORY_MB=1900
readonly MIN_DOCKER_DISK_MB=3072
readonly MIN_DIR_DISK_MB=300

# Answers. Each one is an option, a question, or a default.
opt_domain="" opt_velydock_host="" opt_keycloak_host="" opt_sandbox_host="" opt_apps_host=""
apps_host_given=0
opt_tls="" opt_acme_email="" opt_cert="" opt_key=""
opt_admin_user="" opt_admin_email=""
opt_dir="" opt_version=""
opt_backup="" opt_backup_dir="" opt_backup_keep=""
opt_http_bind="" opt_https_bind="" opt_port_suffix="" opt_image="" opt_project=""
opt_yes=0 opt_install_docker=0 opt_no_system=0

ui_lang=en
work=""            # temporary directory of this run
log_file=""        # where log lines go at the moment
log_final=0        # 1 once the log is at its lasting place
changed=0          # 1 once something on the server has been changed
resume=0           # 1 when an installation that did not finish is continued
docker_missing=0   # 1 when Docker Engine is to be installed first
tool=""            # the management command of this installation
problem=""         # why the last validation failed
failures=0
pending=()         # files written under another name first; none of them may stay behind
child_pid=""       # the step that runs in the background at the moment, if any

# ---- messages --------------------------------------------------------------------------------

m() {
  TEXT_EN[$1]=$2
  TEXT_DE[$1]=$3
}

load_messages() {
  declare -gA TEXT_EN TEXT_DE
  m title "Velydock installer" "Velydock-Installer"
  m opt_unknown "Unknown option: %s (see --help)" "Unbekannte Option: %s (siehe --help)"
  m opt_value "Option %s needs a value." "Die Option %s braucht einen Wert."
  m opt_bad "%s (option %s)" "%s (Option %s)"
  m opt_missing "With --yes every answer must be given: %s is missing." \
    "Mit --yes muss jede Antwort angegeben sein: Es fehlt %s."
  m not_linux "Velydock runs on Linux; this is %s." "Velydock läuft unter Linux; das hier ist %s."
  m not_amd64 "The Velydock image is built for x86_64 (amd64) only; this server is %s." \
    "Das Velydock-Image gibt es nur für x86_64 (amd64); dieser Server ist %s."
  m need_root "The installer must run as root: sudo bash install.sh (without root only with --no-system and --dir pointing to a directory of your own)." \
    "Der Installer muss als root laufen: sudo bash install.sh (ohne root nur mit --no-system und --dir auf ein eigenes Verzeichnis)."
  m dir_not_owned "Without root, %s (or the directory it is created in) must belong to you and be writable." \
    "Ohne root muss %s (oder das Verzeichnis, in dem es angelegt wird) dir gehören und beschreibbar sein."
  m no_terminal "There is no terminal to ask questions on. Run the installer with --yes and give the answers as options (see --help)." \
    "Es gibt kein Terminal für die Fragen. Starte den Installer mit --yes und gib die Antworten als Optionen an (siehe --help)."
  m no_answer "No answer could be read; aborted. Nothing was changed." \
    "Es konnte keine Antwort gelesen werden; abgebrochen. Es wurde nichts verändert."
  m checking "Checking this server" "Prüfe diesen Server"
  m checking_answers "Checking host names and directory" "Prüfe Hostnamen und Verzeichnis"
  m chk_platform "Linux on x86_64" "Linux auf x86_64"
  m chk_memory_ok "memory: %s MB" "Arbeitsspeicher: %s MB"
  m chk_memory_low "memory: only %s MB. Velydock needs about 2 GB (Keycloak alone takes 1 GB); expect slow starts or failures." \
    "Arbeitsspeicher: nur %s MB. Velydock braucht etwa 2 GB (Keycloak allein belegt 1 GB); rechne mit langsamen Starts oder Abbrüchen."
  m chk_tool_missing "%s is missing; install it and run the installer again." \
    "%s fehlt; installiere es und starte den Installer erneut."
  m chk_download_missing "curl or wget is missing; install one of them (for example: apt-get install curl)." \
    "curl oder wget fehlt; installiere eines davon (zum Beispiel: apt-get install curl)."
  m chk_docker_ok "Docker %s with Compose %s" "Docker %s mit Compose %s"
  m chk_docker_missing "Docker is not installed." "Docker ist nicht installiert."
  m chk_docker_will_install "Docker is not installed; Docker Engine will be installed from Docker's official repository." \
    "Docker ist nicht installiert; Docker Engine wird aus dem offiziellen Docker-Repository installiert."
  m docker_explain "Velydock runs in containers and needs Docker Engine with the Compose plugin. On Debian and Ubuntu this installer can set it up (--install-docker); elsewhere install it as described at https://docs.docker.com/engine/install/ and run the installer again." \
    "Velydock läuft in Containern und braucht Docker Engine mit dem Compose-Plugin. Unter Debian und Ubuntu kann dieser Installer es einrichten (--install-docker); sonst installiere es wie unter https://docs.docker.com/engine/install/ beschrieben und starte den Installer erneut."
  m q_install_docker "Install Docker Engine from Docker's official repository (download.docker.com) now?" \
    "Docker Engine jetzt aus dem offiziellen Docker-Repository (download.docker.com) installieren?"
  m docker_declined "Without Docker nothing can be installed. Nothing was changed." \
    "Ohne Docker lässt sich nichts installieren. Es wurde nichts verändert."
  m docker_need_root "Installing Docker needs root." "Für die Installation von Docker braucht es root."
  m chk_daemon "The Docker daemon does not answer. Start it (systemctl start docker) and run the installer again." \
    "Der Docker-Daemon antwortet nicht. Starte ihn (systemctl start docker) und starte den Installer erneut."
  m chk_daemon_user "The Docker daemon does not answer for this user. Is it running, and are you in the group docker?" \
    "Der Docker-Daemon antwortet diesem Benutzer nicht. Läuft er, und bist du in der Gruppe docker?"
  m chk_compose_missing "The Docker Compose plugin is missing (docker compose version). With Docker's repository: apt-get install docker-compose-plugin." \
    "Das Docker-Compose-Plugin fehlt (docker compose version). Mit dem Docker-Repository: apt-get install docker-compose-plugin."
  m chk_compose_old "Docker Compose %s is too old; version 2.17 or newer is needed." \
    "Docker Compose %s ist zu alt; gebraucht wird Version 2.17 oder neuer."
  m chk_disk_ok "free disk space: %s MB in %s" "freier Speicherplatz: %s MB in %s"
  m chk_disk_low "Only %s MB free in %s; at least %s MB are needed." \
    "Nur %s MB frei in %s; gebraucht werden mindestens %s MB."
  m chk_port_free "port %s is free" "Port %s ist frei"
  m chk_port_used "Port %s is already in use: %s" "Port %s ist bereits belegt: %s"
  m chk_port_hint "Velydock's proxy needs both ports. Stop the other service, or use --http-bind/--https-bind for other addresses." \
    "Velydocks Proxy braucht beide Ports. Beende den anderen Dienst oder nimm mit --http-bind/--https-bind andere Adressen."
  m chk_project_exists "A Compose project named \"%s\" already has containers on this server, and %s holds no installation they could belong to. Remove them first; they and this installation would get in each other's way." \
    "Ein Compose-Projekt namens \"%s\" hat auf diesem Server bereits Container, und %s enthält keine Installation, zu der sie gehören könnten. Entferne sie zuerst; sie und diese Installation kämen einander in die Quere."
  m chk_volume_exists "The Docker volume %s of an earlier installation still exists. Its databases only work with the .env they were created with. If the data is still needed, put the old installation directory back to %s (program files and .env) and run the installer again; if not, remove the volume (docker volume rm %s)." \
    "Das Docker-Volume %s einer früheren Installation existiert noch. Seine Datenbanken funktionieren nur mit der .env, mit der sie angelegt wurden. Werden die Daten noch gebraucht, lege das alte Installationsverzeichnis wieder nach %s (Programmdateien und .env) und starte den Installer erneut; wenn nicht, entferne das Volume (docker volume rm %s)."
  m chk_volume_reused "The Docker volume %s of an earlier installation still exists and will be used again, with the certificates in it. If that is not wanted, remove it first: docker volume rm %s" \
    "Das Docker-Volume %s einer früheren Installation existiert noch und wird wieder verwendet, mit den Zertifikaten darin. Ist das nicht gewollt, entferne es vorher: docker volume rm %s"
  m chk_launcher_other "%s already belongs to another Velydock installation (%s)." \
    "%s gehört bereits zu einer anderen Velydock-Installation (%s)."
  m chk_release "release to install: %s" "Release, das installiert wird: %s"
  m no_release "No release could be found at %s. The one-line installation needs a published release." \
    "Unter %s wurde kein Release gefunden. Die Installation mit einer Zeile braucht ein veröffentlichtes Release."
  m checks_failed "The server does not meet the requirements above. Nothing was changed." \
    "Der Server erfüllt die Voraussetzungen oben nicht. Es wurde nichts verändert."
  m dns_ok "%s points to this server (%s)" "%s zeigt auf diesen Server (%s)"
  m dns_none "%s does not resolve to an address yet." "%s lässt sich noch nicht auflösen."
  m dns_elsewhere "%s resolves to %s, which is no address of this server (this server: %s). Fine behind NAT or a load balancer." \
    "%s zeigt auf %s, und das ist keine Adresse dieses Servers (dieser Server: %s). In Ordnung hinter NAT oder einem Load Balancer."
  m dns_acme "Let's Encrypt can only issue certificates once these names point to this server and ports 80 and 443 are reachable from the internet." \
    "Let's Encrypt stellt erst Zertifikate aus, wenn diese Namen auf diesen Server zeigen und die Ports 80 und 443 aus dem Internet erreichbar sind."

  m sec_hosts "Host names" "Hostnamen"
  m hosts_intro "Velydock needs three host names that point to this server; a fourth is optional." \
    "Velydock braucht drei Hostnamen, die auf diesen Server zeigen; ein vierter ist optional."
  m q_domain "Base domain, e.g. example.com (empty: enter each host name yourself)" \
    "Basis-Domain, z. B. example.com (leer: jeden Hostnamen selbst eingeben)"
  m q_velydock_host "Velydock (interface)" "Velydock (Oberfläche)"
  m q_keycloak_host "Sign-in (Keycloak)" "Anmeldung (Keycloak)"
  m q_sandbox_host "Sandbox for own apps" "Sandbox für eigene Apps"
  m q_apps_host "Published apps (\"-\": do not publish apps through the proxy)" \
    "Veröffentlichte Apps (\"-\": keine Apps über den Proxy veröffentlichen)"
  m bad_host "\"%s\" is not a host name (lower-case letters, digits, \".\" and \"-\"; no https://, no path)." \
    "\"%s\" ist kein Hostname (Kleinbuchstaben, Ziffern, \".\" und \"-\"; kein https://, kein Pfad)."
  m hosts_differ "The host names must differ: own apps and the sign-in are kept apart by their own names." \
    "Die Hostnamen müssen sich unterscheiden: Eigene Apps und die Anmeldung werden durch eigene Namen getrennt."
  m apps_parent "%s must not be or lie below the host for published apps (%s). Take a name of its own, e.g. apps.example.com." \
    "%s darf nicht der Hostname für veröffentlichte Apps (%s) sein oder unter ihm liegen. Nimm einen eigenen Namen, z. B. apps.example.com."
  m sec_tls "TLS certificates" "TLS-Zertifikate"
  m tls_choices "  1) letsencrypt   free certificates, issued and renewed automatically (needs public DNS)\n  2) own           a certificate you bring along (file with chain, key file)\n  3) selfsigned    a self-signed certificate - for testing only, browsers warn" \
    "  1) letsencrypt   kostenlose Zertifikate, automatisch ausgestellt und erneuert (braucht öffentliches DNS)\n  2) own           ein Zertifikat, das du mitbringst (Datei mit Kette, Schlüsseldatei)\n  3) selfsigned    ein selbstsigniertes Zertifikat – nur zum Testen, Browser warnen"
  m q_tls "Choice" "Auswahl"
  m bad_tls "Choose letsencrypt, own or selfsigned (or 1, 2, 3)." "Wähle letsencrypt, own oder selfsigned (oder 1, 2, 3)."
  m selfsigned_note "Self-signed is for testing only: every browser shows a warning, and other programs refuse the connection." \
    "Selbstsigniert ist nur zum Testen: Jeder Browser zeigt eine Warnung, andere Programme lehnen die Verbindung ab."
  m q_acme_email "E-mail address for Let's Encrypt (expiry notices)" "E-Mail-Adresse für Let's Encrypt (Hinweise zum Ablauf)"
  m bad_email "\"%s\" cannot be used as an e-mail address here (before the @: letters, digits, \".\", \"_\", \"+\" and \"-\")." \
    "\"%s\" geht hier nicht als E-Mail-Adresse (vor dem @: Buchstaben, Ziffern, \".\", \"_\", \"+\" und \"-\")."
  m q_cert "Certificate file (PEM, with its chain)" "Zertifikatsdatei (PEM, mit ihrer Kette)"
  m q_key "Key file (PEM)" "Schlüsseldatei (PEM)"
  m need_openssl "openssl is needed to check the certificate; install it and run the installer again." \
    "Zum Prüfen des Zertifikats wird openssl gebraucht; installiere es und starte den Installer erneut."
  m file_unreadable "%s cannot be read (give the full path)." "%s lässt sich nicht lesen (gib den vollen Pfad an)."
  m cert_not_pem "%s does not start with a certificate in PEM format." "%s beginnt nicht mit einem Zertifikat im PEM-Format."
  m cert_expired "The certificate expired on %s." "Das Zertifikat ist am %s abgelaufen."
  m cert_not_yet "The certificate is not valid before %s." "Das Zertifikat gilt erst ab %s."
  m cert_no_names "The certificate names no host (subjectAltName is missing); browsers reject such certificates." \
    "Das Zertifikat nennt keinen Hostnamen (subjectAltName fehlt); Browser lehnen solche Zertifikate ab."
  m cert_not_covering "The certificate does not cover %s. It names: %s (a \"*\" stands for exactly one label)." \
    "Das Zertifikat deckt %s nicht ab. Es nennt: %s (ein \"*\" steht für genau einen Namensteil)."
  m key_unreadable "%s holds no private key that can be read (PEM, without passphrase)." \
    "%s enthält keinen lesbaren privaten Schlüssel (PEM, ohne Passphrase)."
  m key_mismatch "The key does not belong to the certificate." "Der Schlüssel gehört nicht zum Zertifikat."
  m sec_admin "First administrator" "Erster Administrator"
  m q_admin_user "User name" "Benutzername"
  m bad_user "\"%s\" cannot be a user name: 3 to 64 characters, lower-case letters, digits, \".\", \"_\" and \"-\", starting and ending with a letter or digit." \
    "\"%s\" geht nicht als Benutzername: 3 bis 64 Zeichen, Kleinbuchstaben, Ziffern, \".\", \"_\" und \"-\", am Anfang und Ende ein Buchstabe oder eine Ziffer."
  m q_admin_email "E-mail address" "E-Mail-Adresse"
  m sec_dir "Installation" "Installation"
  m q_dir "Installation directory" "Installationsverzeichnis"
  m bad_dir "\"%s\" cannot be the directory: an absolute path of letters, digits, \".\", \"_\", \"+\", \"-\" and \"/\" is needed." \
    "\"%s\" geht nicht als Verzeichnis: Gebraucht wird ein absoluter Pfad aus Buchstaben, Ziffern, \".\", \"_\", \"+\", \"-\" und \"/\"."
  m dir_foreign "%s is not empty and holds no Velydock installation. Choose an empty or new directory." \
    "%s ist nicht leer und enthält keine Velydock-Installation. Wähle ein leeres oder neues Verzeichnis."
  m dir_link "%s is a symbolic link. Velydock is installed where it points to: %s" \
    "%s ist ein symbolischer Link. Velydock wird dorthin installiert, wohin er zeigt: %s"
  m dir_dangling "%s is a symbolic link that points to no directory." \
    "%s ist ein symbolischer Link, der auf kein Verzeichnis zeigt."
  m dir_will_secure "%s belongs to %s and has mode %s. Programs in this directory are run as %s later, so the installer will give it to %s and take write access from everybody else." \
    "%s gehört %s und hat den Modus %s. Programme in diesem Verzeichnis laufen später als %s; der Installer übergibt es deshalb an %s und nimmt allen anderen das Schreibrecht."
  m dir_secured "%s now belongs to %s, and nobody else can write to it." \
    "%s gehört jetzt %s, und niemand sonst kann darin schreiben."
  m dir_unsafe "%s cannot be made safe: it must belong to %s and must not be writable by its group or by others. Choose another directory." \
    "%s lässt sich nicht absichern: Es muss %s gehören und darf weder für die Gruppe noch für andere schreibbar sein. Wähle ein anderes Verzeichnis."
  m dir_taken "%s already holds a Velydock installation; start the installer with --dir %s to see it." \
    "%s enthält bereits eine Velydock-Installation; starte den Installer mit --dir %s, um sie zu sehen."
  m sec_backup "Backups" "Backups"
  m q_backup "Back up every night?" "Jede Nacht sichern?"
  m q_backup_dir "Target directory" "Zielverzeichnis"
  m q_backup_keep "How many backups to keep" "Wie viele Backups aufbewahrt werden"
  m bad_keep "Give a number from 1 to 999." "Gib eine Zahl von 1 bis 999 an."
  m bad_yes_no "Answer y or n." "Antworte mit j oder n."
  m bad_bind "\"%s\" is not an address to bind to (for example 0.0.0.0:443 or 127.0.0.1:8443)." \
    "\"%s\" ist keine Adresse zum Binden (zum Beispiel 0.0.0.0:443 oder 127.0.0.1:8443)."
  m bad_suffix "\"%s\" is not a port suffix (for example :8443)." "\"%s\" ist kein Port-Zusatz (zum Beispiel :8443)."
  m bad_version "\"%s\" is not a version (for example 1.2.3)." "\"%s\" ist keine Version (zum Beispiel 1.2.3)."
  m bad_image "\"%s\" is not an image reference." "\"%s\" ist keine Image-Angabe."
  m bad_project "\"%s\" cannot be a Compose project name (lower-case letters, digits, \"_\" and \"-\")." \
    "\"%s\" geht nicht als Compose-Projektname (Kleinbuchstaben, Ziffern, \"_\" und \"-\")."

  m sec_summary "Summary" "Zusammenfassung"
  m sum_version "Version" "Version"
  m sum_version_later "the latest release (looked up once Docker's packages are installed)" \
    "das neueste Release (wird ermittelt, sobald Dockers Pakete installiert sind)"
  m sum_address "Address" "Adresse"
  m sum_keycloak "Sign-in" "Anmeldung"
  m sum_sandbox "Sandbox" "Sandbox"
  m sum_apps "Published apps" "Apps (Proxy)"
  m sum_apps_off "off" "aus"
  m sum_tls "Certificates" "Zertifikate"
  m sum_tls_le "Let's Encrypt (%s)" "Let's Encrypt (%s)"
  m sum_tls_own "own certificate %s, valid until %s" "eigenes Zertifikat %s, gültig bis %s"
  m sum_tls_self "self-signed (testing only)" "selbstsigniert (nur zum Testen)"
  m sum_admin "Administrator" "Administrator"
  m sum_dir "Directory" "Verzeichnis"
  m sum_backup "Backups" "Backups"
  m sum_backup_on "every night to %s, keeping the last %s" "jede Nacht nach %s, die letzten %s bleiben"
  m sum_backup_manual "to %s, keeping the last %s; without a timer (--no-system): schedule \"%s backup\" yourself" \
    "nach %s, die letzten %s bleiben; ohne Timer (--no-system): \"%s backup\" selbst einplanen"
  m sum_backup_off "none scheduled" "keine eingeplant"
  m sum_docker "Docker" "Docker"
  m sum_docker_install "Docker Engine will be installed from download.docker.com" \
    "Docker Engine wird von download.docker.com installiert"
  m sum_system "System" "System"
  m sum_system_on "command %s, log %s" "Befehl %s, Protokoll %s"
  m sum_system_off "nothing outside %s (--no-system)" "nichts außerhalb von %s (--no-system)"
  m q_go "Install now?" "Jetzt installieren?"
  m q_resume "Continue this installation now?" "Diese Installation jetzt fortsetzen?"
  m aborted "Aborted. Nothing was changed." "Abgebrochen. Es wurde nichts verändert."
  m interrupted "Interrupted." "Unterbrochen."
  m interrupted_clean "Interrupted. Nothing was changed." "Unterbrochen. Es wurde nichts verändert."

  m resume_changed "The installation in %s was begun with Velydock %s and did not finish then, but it has been changed since: it is at version %s now. The installer does not continue it - it would put the files of the old version back. If Velydock works, remove the leftover file %s (\"%s doctor\" shows the state of the installation); to start over: %s uninstall --purge" \
    "Die Installation in %s wurde mit Velydock %s begonnen und damals nicht abgeschlossen, ist aber seither verändert worden: Sie steht jetzt bei Version %s. Der Installer setzt sie nicht fort - er würde die Dateien der alten Version zurücklegen. Läuft Velydock, entferne die übrig gebliebene Datei %s (\"%s doctor\" zeigt den Zustand der Installation); für einen Neuanfang: %s uninstall --purge"
  m resume_note "The installation of Velydock %s in %s did not finish. It is continued with the answers given then; the configuration in .env stays as it is." \
    "Die Installation von Velydock %s in %s wurde nicht abgeschlossen. Sie wird mit den damaligen Antworten fortgesetzt; die Konfiguration in .env bleibt, wie sie ist."
  m installed_note "Velydock %s is already installed in %s (%s). Configuration and data were not touched." \
    "Velydock %s ist in %s bereits installiert (%s). Konfiguration und Daten wurden nicht angefasst."
  m installed_hint "  Update:  %s update\n  Check:   %s doctor\n  Start:   %s start" \
    "  Aktualisieren:  %s update\n  Prüfen:         %s doctor\n  Starten:        %s start"
  m repaired_launcher "The command %s was missing and has been restored." "Der Befehl %s fehlte und wurde wiederhergestellt."
  m repaired_timer "The backup timer was missing and has been restored." "Der Backup-Timer fehlte und wurde wiederhergestellt."

  m step_docker "Installing Docker Engine" "Installiere Docker Engine"
  m docker_unsupported "Docker can only be installed by this installer on Debian and Ubuntu (found: %s)." \
    "Docker kann dieser Installer nur unter Debian und Ubuntu installieren (gefunden: %s)."
  m docker_install_failed "Docker could not be installed." "Docker ließ sich nicht installieren."
  m docker_installed_not_running "Docker was installed, but its daemon does not answer. Start it (systemctl start docker) and run the installer again." \
    "Docker wurde installiert, aber der Daemon antwortet nicht. Starte ihn (systemctl start docker) und starte den Installer erneut."
  m step_download "Downloading and verifying Velydock %s" "Lade Velydock %s und prüfe es"
  m download_failed "%s could not be downloaded." "%s ließ sich nicht herunterladen."
  m checksum_failed "The checksum of %s does not match SHA256SUMS of the release. Nothing of it was used." \
    "Die Prüfsumme von %s passt nicht zu SHA256SUMS des Releases. Nichts davon wurde verwendet."
  m bundle_bad "The bundle is not what a Velydock release looks like: %s" \
    "Das Paket sieht nicht aus wie ein Velydock-Release: %s"
  m step_files "Writing the program files to %s" "Schreibe die Programmdateien nach %s"
  m step_env "Writing the configuration (.env) with new secrets" "Schreibe die Konfiguration (.env) mit neuen Geheimnissen"
  m env_kept "The existing configuration (.env) is kept." "Die vorhandene Konfiguration (.env) bleibt."
  m step_start "Fetching the images and starting (the first start takes a few minutes)" \
    "Lade die Images und starte (der erste Start dauert einige Minuten)"
  m start_failed "Velydock did not start. The last lines of the log:" "Velydock ist nicht gestartet. Die letzten Zeilen des Protokolls:"
  m step_cert "Importing the certificate" "Importiere das Zertifikat"
  m cert_failed "The certificate could not be imported. Velydock runs, with a self-signed certificate for now. Once the cause is fixed: %s cert add %s %s" \
    "Das Zertifikat ließ sich nicht importieren. Velydock läuft, vorerst mit einem selbstsignierten Zertifikat. Wenn die Ursache behoben ist: %s cert add %s %s"
  m cert_kept "This installation already holds certificates (%s cert list); the one given at the first run is not stored again. To replace one: %s cert add %s %s --replace" \
    "Diese Installation enthält bereits Zertifikate (%s cert list); das beim ersten Lauf angegebene wird nicht erneut gespeichert. Um eines zu ersetzen: %s cert add %s %s --replace"
  m accounts_unknown "Could not find out whether this installation already has accounts, so no administrator is created (creating one would reset the password of an existing account of that name). Once Velydock runs: %s admin --username NAME" \
    "Es ließ sich nicht feststellen, ob diese Installation schon Konten hat; deshalb wird kein Administrator angelegt (das würde das Passwort eines vorhandenen Kontos dieses Namens zurücksetzen). Sobald Velydock läuft: %s admin --username NAME"
  m admin_exists "This installation already has accounts (%s): no administrator is created and no password is changed. Lost access? %s admin --username NAME restores it." \
    "Diese Installation hat bereits Konten (%s): Es wird kein Administrator angelegt und kein Passwort geändert. Zugang verloren? %s admin --username NAME stellt ihn wieder her."
  m step_admin "Creating the first administrator" "Lege den ersten Administrator an"
  m admin_failed "The first administrator could not be created:" "Der erste Administrator ließ sich nicht anlegen:"
  m step_launcher "Installing the command %s" "Installiere den Befehl %s"
  m launcher_skipped "%s exists and is not from Velydock; it was left alone. Use %s instead." \
    "%s existiert und stammt nicht von Velydock; es bleibt unverändert. Nimm stattdessen %s."
  m step_timer "Scheduling the nightly backup (systemd timer %s)" "Plane das nächtliche Backup ein (systemd-Timer %s)"
  m timer_no_systemd "systemd does not run here: no backup timer was installed. Schedule \"%s backup\" yourself." \
    "Hier läuft kein systemd: Es wurde kein Backup-Timer eingerichtet. Plane \"%s backup\" selbst ein."
  m ok "ok" "ok"
  m failed "failed" "fehlgeschlagen"
  m half_way "The installation did not finish. Run the installer again to continue it, or remove what is there with: %s uninstall --purge" \
    "Die Installation wurde nicht abgeschlossen. Starte den Installer erneut, um sie fortzusetzen, oder entferne das Vorhandene mit: %s uninstall --purge"
  m half_way_early "The installation did not finish. Run the installer again to continue it." \
    "Die Installation wurde nicht abgeschlossen. Starte den Installer erneut, um sie fortzusetzen."
  m log_at "Log: %s" "Protokoll: %s"

  m done_title "Velydock %s is running." "Velydock %s läuft."
  m done_address "Address" "Adresse"
  m done_user "User name" "Benutzername"
  m done_password "One-time password" "Einmalpasswort"
  m done_password_note "The one-time password is shown only now. At the first sign-in you choose a password of your own and set up an authenticator app." \
    "Das Einmalpasswort wird nur jetzt angezeigt. Bei der ersten Anmeldung vergibst du ein eigenes Passwort und richtest eine Authenticator-App ein."
  m done_selfsigned "The certificate is self-signed: your browser will warn. For testing only." \
    "Das Zertifikat ist selbstsigniert: Dein Browser wird warnen. Nur zum Testen."
  m done_letsencrypt "Let's Encrypt issues the certificates at the first requests; until then browsers warn for a moment." \
    "Let's Encrypt stellt die Zertifikate bei den ersten Aufrufen aus; bis dahin warnen Browser kurz."
  m done_manage "Manage" "Verwalten"
  m done_manage_cmds "%s status | doctor | backup | update | help" "%s status | doctor | backup | update | help"
  m done_config "Configuration" "Konfiguration"
  m done_config_note "%s (holds every secret; belongs into every backup)" "%s (enthält alle Geheimnisse; gehört in jedes Backup)"
  m done_backup "Backups" "Backups"
  m done_backup_note "%s - copy them to another machine, they hold every secret" \
    "%s – kopiere sie auf einen anderen Rechner, sie enthalten alle Geheimnisse"
}

t() {
  local key=$1 format
  shift
  if [[ $ui_lang == de ]]; then format=${TEXT_DE[$key]-}; else format=${TEXT_EN[$key]-}; fi
  [[ -n $format ]] || format=$key
  # shellcheck disable=SC2059  # the format is one of the texts above
  printf "$format" "$@"
}

say() {
  t "$@"
  printf '\n'
}

usage() {
  if [[ $ui_lang == de ]]; then
    cat <<'USAGE'
Velydock-Installer

  sudo bash install.sh [Optionen]

Ohne Optionen fragt der Installer, was er wissen muss. Mit --yes fragt er nichts; dann muss
jede Antwort als Option angegeben sein.

Hostnamen
  --domain DOMAIN          Basis-Domain: ergibt dock.DOMAIN, auth.DOMAIN, sandbox.DOMAIN und
                           apps.DOMAIN, soweit nicht einzeln angegeben
  --velydock-host NAME     Oberfläche und API
  --keycloak-host NAME     Anmeldung
  --sandbox-host NAME      eigene Apps (muss ein eigener Name sein)
  --apps-host NAME         über den Proxy veröffentlichte Apps; "" oder - schaltet das ab

Zertifikate
  --tls MODUS              letsencrypt (Standard) | own | selfsigned
  --acme-email ADRESSE     für letsencrypt
  --cert DATEI             für own: Zertifikat mit Kette (PEM)
  --key DATEI              für own: privater Schlüssel (PEM, ohne Passphrase)

Erster Administrator
  --admin-user NAME        Standard: admin
  --admin-email ADRESSE    Standard: die Adresse von --acme-email

Installation
  --dir VERZEICHNIS        Standard: /opt/velydock
  --version VERSION        Standard: das neueste Release
  --backup-dir VERZ        Ziel der nächtlichen Backups (Standard: <Verzeichnis>/backups)
  --backup-keep ANZAHL     wie viele Backups bleiben (Standard: 14)
  --no-backup              keine nächtlichen Backups einrichten
  --install-docker         Docker Engine ohne Rückfrage installieren, falls es fehlt
                           (Debian und Ubuntu)
  --no-system              nichts außerhalb des Installationsverzeichnisses anlegen: kein
                           Befehl in /usr/local/bin, kein Timer, Protokoll im Verzeichnis
  --http-bind ADRESSE      woran der Proxy HTTP bindet (Standard: 0.0.0.0:80)
  --https-bind ADRESSE     woran der Proxy HTTPS bindet (Standard: 0.0.0.0:443)
  --public-port-suffix :P  nur wenn Velydock von außen nicht über Port 443 erreichbar ist

Ablauf
  --yes                    nichts fragen
  --lang de|en             Sprache (Standard: nach der Umgebung)
  --help                   diese Hilfe

Nach der Installation: velydock help
USAGE
  else
    cat <<'USAGE'
Velydock installer

  sudo bash install.sh [options]

Without options the installer asks what it needs to know. With --yes it asks nothing; every
answer must then be given as an option.

Host names
  --domain DOMAIN          base domain: gives dock.DOMAIN, auth.DOMAIN, sandbox.DOMAIN and
                           apps.DOMAIN unless given one by one
  --velydock-host NAME     interface and API
  --keycloak-host NAME     sign-in
  --sandbox-host NAME      own apps (must be a name of its own)
  --apps-host NAME         apps published through the proxy; "" or - switches that off

Certificates
  --tls MODE               letsencrypt (default) | own | selfsigned
  --acme-email ADDRESS     for letsencrypt
  --cert FILE              for own: certificate with its chain (PEM)
  --key FILE               for own: private key (PEM, without passphrase)

First administrator
  --admin-user NAME        default: admin
  --admin-email ADDRESS    default: the address of --acme-email

Installation
  --dir DIRECTORY          default: /opt/velydock
  --version VERSION        default: the latest release
  --backup-dir DIR         target of the nightly backups (default: <directory>/backups)
  --backup-keep NUMBER     how many backups stay (default: 14)
  --no-backup              do not set up nightly backups
  --install-docker         install Docker Engine without asking if it is missing
                           (Debian and Ubuntu)
  --no-system              create nothing outside the installation directory: no command
                           in /usr/local/bin, no timer, log inside the directory
  --http-bind ADDRESS      what the proxy binds HTTP to (default: 0.0.0.0:80)
  --https-bind ADDRESS     what the proxy binds HTTPS to (default: 0.0.0.0:443)
  --public-port-suffix :P  only if Velydock is not reached on port 443 from outside

Run
  --yes                    ask nothing
  --lang de|en             language (default: from the environment)
  --help                   this help

After the installation: velydock help
USAGE
  fi
}

# ---- output, log, errors ---------------------------------------------------------------------

log() {
  [[ -n $log_file ]] || return 0
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$log_file" 2>/dev/null || true
}

die() {
  printf '%s\n' "$*" >&2
  log "error: $*"
  exit 1
}

section() {
  printf '\n%s\n' "$(t "$@")"
}

check() {
  local level=$1
  shift
  case $level in
    ok) printf '  [ ok ] %s\n' "$*" ;;
    warn) printf '  [warn] %s\n' "$*" ;;
    fail)
      printf '  [FAIL] %s\n' "$*"
      failures=$((failures + 1))
      ;;
  esac
  log "check $level: $*"
}

cleanup() {
  local status=$? file
  trap - EXIT
  # Nothing interrupts the tidying up; and it comes before the last words, which cannot be
  # written any more when the terminal is gone.
  trap '' INT TERM HUP
  for file in "${pending[@]}"; do
    if [[ -e $file ]]; then rm -f -- "$file"; fi
  done
  if (( status != 0 && changed )); then
    {
      printf '\n'
      if [[ -n $tool && -x $tool ]]; then
        say half_way "$tool"
      else
        say half_way_early
      fi
      if (( log_final )); then say log_at "$log_file"; fi
    } >&2 || true
  fi
  if [[ -n $work && -d $work ]]; then rm -rf -- "$work"; fi
  exit "$status"
}

# Ctrl-C, a closed terminal or a "kill": the step that is running is ended with everything it
# started, and the installer says where it stopped (see cleanup).
interrupted() {
  local signal=$1 pid=$child_pid watchdog
  trap '' INT TERM HUP
  child_pid=""
  if [[ -n $pid ]]; then
    # The step is a process group of its own (see run_logged); without setsid it is one process.
    # What does not end when asked to is ended ten seconds later.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    ( sleep 10; kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null ) >/dev/null 2>&1 &
    watchdog=$!
    wait "$pid" 2>/dev/null || true
    kill "$watchdog" 2>/dev/null || true
  fi
  log "interrupted by signal $signal"
  if (( changed )); then
    printf '\n%s\n' "$(t interrupted)" >&2 || true
  else
    printf '\n%s\n' "$(t interrupted_clean)" >&2 || true
  fi
  exit $((128 + signal))
}

# Moves the log to its lasting place; until then it is collected in the temporary directory.
settle_log() {
  local target=$1
  (( ! log_final )) || return 0
  ( umask 077 && touch -- "$target" ) 2>/dev/null || return 0
  chmod 600 -- "$target" 2>/dev/null || true
  cat -- "$log_file" >> "$target" 2>/dev/null || true
  log_file=$target
  log_final=1
}

# Runs a command with its output in the log; on a terminal a dot every few seconds shows life.
# The command runs in the background as a session of its own: a Ctrl-C at the terminal reaches
# the installer alone, which then ends the command and all it started (see "interrupted"). Left
# in the foreground, or started with a plain "&", it would either outlive the installer or keep
# the installer from noticing the interruption until it is done.
run_logged() {
  local status=0
  log "run: $*"
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >> "$log_file" 2>&1 </dev/null &
  else
    "$@" >> "$log_file" 2>&1 </dev/null &
  fi
  child_pid=$!
  if [[ -t 1 ]]; then
    while kill -0 "$child_pid" 2>/dev/null; do
      printf '.'
      sleep 3
    done
  fi
  wait "$child_pid" || status=$?
  child_pid=""
  log "status: $status"
  return "$status"
}

step() {
  printf '%s ' "$(t "$@")"
  log "step: $(t "$@")"
}

step_ok() {
  say ok
}

step_failed() {
  say failed
}

# ---- questions -------------------------------------------------------------------------------

open_terminal() {
  if [[ -t 0 ]]; then
    exec 3<&0
  elif ( exec 3</dev/tty ) 2>/dev/null; then
    exec 3</dev/tty
  else
    return 1
  fi
}

trim() {
  local value=$1
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  printf '%s' "$value"
}

# ask VARIABLE "question" "default" [validator] [lower]
# Asks until the validator accepts the answer; the validator explains itself in $problem.
# (The names of the local variables are odd on purpose: VARIABLE must not be one of them.)
ask() {
  local ask_variable=$1 ask_question=$2 ask_default=$3 ask_validator=${4:-} ask_lower=${5:-} ask_reply
  while :; do
    if [[ -n $ask_default ]]; then
      printf '%s [%s]: ' "$ask_question" "$ask_default"
    else
      printf '%s: ' "$ask_question"
    fi
    IFS= read -r ask_reply <&3 || {
      printf '\n'
      die "$(t no_answer)"
    }
    ask_reply=$(trim "$ask_reply")
    [[ -n $ask_reply ]] || ask_reply=$ask_default
    [[ -z $ask_lower ]] || ask_reply=${ask_reply,,}
    problem=""
    if [[ -z $ask_validator ]] || "$ask_validator" "$ask_reply"; then break; fi
    printf '  %s\n' "$problem"
  done
  printf -v "$ask_variable" '%s' "$ask_reply"
}

# ask_yes_no "question" y|n  - true for yes
ask_yes_no() {
  local question=$1 default=$2 answer hint="[y/N]"
  if [[ $ui_lang == de ]]; then
    hint="[j/N]"
    [[ $default != y ]] || hint="[J/n]"
  else
    [[ $default != y ]] || hint="[Y/n]"
  fi
  while :; do
    printf '%s %s ' "$question" "$hint"
    IFS= read -r answer <&3 || {
      printf '\n'
      die "$(t no_answer)"
    }
    answer=$(trim "${answer,,}")
    [[ -n $answer ]] || answer=$default
    case $answer in
      y | yes | j | ja) return 0 ;;
      n | no | nein) return 1 ;;
    esac
    printf '  %s\n' "$(t bad_yes_no)"
  done
}

# ---- validation ------------------------------------------------------------------------------

v_host() {
  local host=$1
  if [[ ${#host} -gt 253 || ! $host =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ || $host == *..* ]]; then
    problem=$(t bad_host "$host")
    return 1
  fi
}

v_domain() {
  [[ -n $1 ]] || return 0
  v_host "$1"
}

# A host name for Velydock, the sign-in or the sandbox, next to the ones chosen so far.
v_new_host() {
  local host=$1 other
  v_host "$host" || return 1
  for other in "$opt_velydock_host" "$opt_keycloak_host" "$opt_sandbox_host"; do
    if [[ -n $other && $other == "$host" ]]; then
      problem=$(t hosts_differ)
      return 1
    fi
  done
  if [[ -n $opt_apps_host && ( $host == "$opt_apps_host" || $host == *".$opt_apps_host" ) ]]; then
    problem=$(t apps_parent "$host" "$opt_apps_host")
    return 1
  fi
}

v_new_apps_host() {
  local host=$1 other
  [[ -n $host && $host != - ]] || return 0
  v_host "$host" || return 1
  for other in "$opt_velydock_host" "$opt_keycloak_host" "$opt_sandbox_host"; do
    if [[ -n $other && ( $other == "$host" || $other == *".$host" ) ]]; then
      problem=$(t apps_parent "$other" "$host")
      return 1
    fi
  done
}

# All host names together, as the backend checks them at its start.
v_host_set() {
  local host
  for host in "$opt_velydock_host" "$opt_keycloak_host" "$opt_sandbox_host"; do
    v_host "$host" || return 1
  done
  if [[ $opt_velydock_host == "$opt_keycloak_host" || $opt_velydock_host == "$opt_sandbox_host" ||
    $opt_keycloak_host == "$opt_sandbox_host" ]]; then
    problem=$(t hosts_differ)
    return 1
  fi
  [[ -n $opt_apps_host ]] || return 0
  v_host "$opt_apps_host" || return 1
  for host in "$opt_velydock_host" "$opt_keycloak_host" "$opt_sandbox_host"; do
    if [[ $host == "$opt_apps_host" || $host == *".$opt_apps_host" ]]; then
      problem=$(t apps_parent "$host" "$opt_apps_host")
      return 1
    fi
  done
}

v_tls() {
  case $1 in
    1 | 2 | 3 | letsencrypt | own | selfsigned) return 0 ;;
  esac
  problem=$(t bad_tls)
  return 1
}

tls_mode() {
  case $1 in
    1) printf letsencrypt ;;
    2) printf own ;;
    3) printf selfsigned ;;
    *) printf '%s' "$1" ;;
  esac
}

# Plain addresses only: the one for Let's Encrypt is written to .env, where Compose would
# expand a "$" and read quotes.
v_email() {
  if [[ ! $1 =~ ^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ ]]; then
    problem=$(t bad_email "$1")
    return 1
  fi
}

# The rule of the backend (backend/velydock/schemas.py); it has the last word.
v_user() {
  if [[ ! $1 =~ ^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$ ]]; then
    problem=$(t bad_user "$1")
    return 1
  fi
}

# The directory ends up in a launcher script and in a systemd unit: plain characters only.
v_path() {
  if [[ $1 != /* || $1 == / || ! $1 =~ ^[A-Za-z0-9._/+-]+$ || $1 == *//* || /$1/ == */../* || /$1/ == */./* ]]; then
    problem=$(t bad_dir "$1")
    return 1
  fi
}

# "new", "empty", "installed", "unfinished" or "foreign".
directory_state() {
  local path=$1
  if [[ ! -e $path && ! -L $path ]]; then
    printf new
  elif [[ ! -d $path ]]; then
    printf foreign
  elif [[ -f $path/.install-state ]]; then
    printf unfinished
  elif [[ -f $path/VERSION && -f $path/MANIFEST && -f $path/docker-compose.yml && -f $path/.env ]]; then
    printf installed
  elif [[ -z $(ls -A -- "$path" 2>/dev/null) ]]; then
    printf empty
  else
    printf foreign
  fi
}

v_dir() {
  local path=${1%/}
  v_path "$path" || return 1
  case $(directory_state "$path") in
    new | empty) return 0 ;;
    installed | unfinished) problem=$(t dir_taken "$path" "$path") ;;
    *) problem=$(t dir_foreign "$path") ;;
  esac
  return 1
}

v_keep() {
  if [[ ! $1 =~ ^[1-9][0-9]{0,2}$ ]]; then
    problem=$(t bad_keep)
    return 1
  fi
}

v_bind() {
  if [[ ! $1 =~ ^(([0-9]{1,3}\.){3}[0-9]{1,3}:|\[[0-9A-Fa-f:]+\]:)?[0-9]{1,5}$ ]]; then
    problem=$(t bad_bind "$1")
    return 1
  fi
}

v_suffix() {
  if [[ ! $1 =~ ^:[0-9]{1,5}$ ]]; then
    problem=$(t bad_suffix "$1")
    return 1
  fi
}

v_version() {
  if [[ ! $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
    problem=$(t bad_version "$1")
    return 1
  fi
}

v_image() {
  if [[ ! $1 =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]]; then
    problem=$(t bad_image "$1")
    return 1
  fi
}

v_project() {
  if [[ ! $1 =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
    problem=$(t bad_project "$1")
    return 1
  fi
}

# The DNS names of the first certificate in a file, one per line.
certificate_names() {
  openssl x509 -in "$1" -noout -ext subjectAltName 2>/dev/null | tr ',' '\n' |
    sed -nE 's/^[[:space:]]*DNS:(.*)$/\1/p'
}

# True if one of the DNS names (one per line) covers the host; "*" stands for exactly one label.
names_cover() {
  local names=$1 host=${2,,} name
  while IFS= read -r name; do
    name=${name,,}
    [[ -n $name ]] || continue
    [[ $name != "$host" ]] || return 0
    if [[ $name == \*.* && $host == *.* && ${host#*.} == "${name#\*.}" && -n ${host%%.*} ]]; then
      return 0
    fi
  done <<<"$names"
  return 1
}

certificate_end() {
  openssl x509 -in "$1" -noout -enddate 2>/dev/null | sed 's/^notAfter=//'
}

# The certificate file: readable, a certificate, valid today, and covering every host name.
v_cert() {
  local file=$1 names host start seconds
  if ! command -v openssl >/dev/null 2>&1; then
    problem=$(t need_openssl)
    return 1
  fi
  if [[ ! -f $file || ! -r $file || $file == *$'\n'* ]]; then
    problem=$(t file_unreadable "$file")
    return 1
  fi
  if ! openssl x509 -in "$file" -noout >/dev/null 2>&1; then
    problem=$(t cert_not_pem "$file")
    return 1
  fi
  if ! openssl x509 -in "$file" -noout -checkend 0 >/dev/null 2>&1; then
    problem=$(t cert_expired "$(certificate_end "$file")")
    return 1
  fi
  start=$(openssl x509 -in "$file" -noout -startdate 2>/dev/null | sed 's/^notBefore=//')
  if seconds=$(date -d "$start" +%s 2>/dev/null) && (( seconds > $(date +%s) )); then
    problem=$(t cert_not_yet "$start")
    return 1
  fi
  names=$(certificate_names "$file") || names=""
  if [[ -z $names ]]; then
    problem=$(t cert_no_names)
    return 1
  fi
  for host in "$opt_velydock_host" "$opt_keycloak_host" "$opt_sandbox_host" "$opt_apps_host"; do
    [[ -n $host ]] || continue
    if ! names_cover "$names" "$host"; then
      problem=$(t cert_not_covering "$host" "$(tr '\n' ' ' <<<"$names" | sed 's/ $//')")
      return 1
    fi
  done
}

# The key file: a private key without passphrase that belongs to the certificate.
v_key() {
  local file=$1 of_key of_cert
  if [[ ! -f $file || ! -r $file || $file == *$'\n'* ]]; then
    problem=$(t file_unreadable "$file")
    return 1
  fi
  # "-passin pass:" keeps openssl from asking for a passphrase on the terminal.
  if ! of_key=$(openssl pkey -in "$file" -passin pass: -pubout -outform DER 2>/dev/null | sha256sum); then
    problem=$(t key_unreadable "$file")
    return 1
  fi
  of_cert=$(openssl x509 -in "$opt_cert" -noout -pubkey 2>/dev/null |
    openssl pkey -pubin -outform DER 2>/dev/null | sha256sum) || of_cert=""
  if [[ -z $of_cert || $of_key != "$of_cert" ]]; then
    problem=$(t key_mismatch)
    return 1
  fi
}

# ---- options ---------------------------------------------------------------------------------

detect_language() {
  local locale=${LC_ALL:-${LC_MESSAGES:-${LANG:-}}} previous="" argument
  if [[ $locale == de* ]]; then ui_lang=de; fi
  for argument in "$@"; do
    if [[ $previous == --lang ]]; then set_language "$argument"; fi
    if [[ $argument == --lang=* ]]; then set_language "${argument#*=}"; fi
    previous=$argument
  done
}

set_language() {
  case $1 in
    de | en) ui_lang=$1 ;;
    *)
      echo "The language must be de or en. / Die Sprache muss de oder en sein." >&2
      exit 2
      ;;
  esac
}

usage_error() {
  printf '%s\n' "$*" >&2
  exit 2
}

parse_args() {
  local option
  while (($#)); do
    if [[ $1 == --*=* ]]; then
      option=${1%%=*}
      set -- "$option" "${1#*=}" "${@:2}"
    fi
    option=$1
    case $option in
      --yes | -y) opt_yes=1 ;;
      --no-backup) opt_backup=no ;;
      --install-docker) opt_install_docker=1 ;;
      --no-system) opt_no_system=1 ;;
      --help | -h)
        usage
        exit 0
        ;;
      --domain | --velydock-host | --keycloak-host | --sandbox-host | --apps-host | --tls | --acme-email | \
        --cert | --key | --admin-user | --admin-email | --dir | --version | --backup-dir | --backup-keep | \
        --lang | --http-bind | --https-bind | --public-port-suffix | --image | --project-name)
        (($# >= 2)) || usage_error "$(t opt_value "$option")"
        case $option in
          --domain) opt_domain=${2,,} ;;
          --velydock-host) opt_velydock_host=${2,,} ;;
          --keycloak-host) opt_keycloak_host=${2,,} ;;
          --sandbox-host) opt_sandbox_host=${2,,} ;;
          --apps-host)
            opt_apps_host=${2,,}
            [[ $opt_apps_host != - ]] || opt_apps_host=""
            apps_host_given=1
            ;;
          --tls) opt_tls=$2 ;;
          --acme-email) opt_acme_email=$2 ;;
          --cert) opt_cert=$2 ;;
          --key) opt_key=$2 ;;
          --admin-user) opt_admin_user=$2 ;;
          --admin-email) opt_admin_email=$2 ;;
          --dir) opt_dir=${2%/} ;;
          --version) opt_version=${2#v} ;;
          --backup-dir) opt_backup_dir=${2%/} ;;
          --backup-keep) opt_backup_keep=$2 ;;
          --lang) set_language "$2" ;;
          --http-bind) opt_http_bind=$2 ;;
          --https-bind) opt_https_bind=$2 ;;
          --public-port-suffix) opt_port_suffix=$2 ;;
          --image) opt_image=$2 ;;
          --project-name) opt_project=$2 ;;
        esac
        shift
        ;;
      *) usage_error "$(t opt_unknown "$option")" ;;
    esac
    shift
  done
}

# Checks one option's value with its validator; ends with the reason and the option's name.
option_ok() {
  local option=$1 validator=$2 value=$3
  [[ -n $value ]] || return 0
  problem=""
  "$validator" "$value" || usage_error "$(t opt_bad "$problem" "$option")"
}

# What can be said about the options as they were given, before anything else happens.
check_options() {
  option_ok --domain v_host "$opt_domain"
  option_ok --velydock-host v_host "$opt_velydock_host"
  option_ok --keycloak-host v_host "$opt_keycloak_host"
  option_ok --sandbox-host v_host "$opt_sandbox_host"
  option_ok --apps-host v_host "$opt_apps_host"
  option_ok --tls v_tls "$opt_tls"
  opt_tls=$(tls_mode "$opt_tls")
  option_ok --acme-email v_email "$opt_acme_email"
  option_ok --admin-user v_user "$opt_admin_user"
  option_ok --admin-email v_email "$opt_admin_email"
  option_ok --dir v_path "$opt_dir"
  option_ok --version v_version "$opt_version"
  option_ok --backup-dir v_path "$opt_backup_dir"
  option_ok --backup-keep v_keep "$opt_backup_keep"
  option_ok --http-bind v_bind "$opt_http_bind"
  option_ok --https-bind v_bind "$opt_https_bind"
  option_ok --public-port-suffix v_suffix "$opt_port_suffix"
  option_ok --image v_image "$opt_image"
  option_ok --project-name v_project "$opt_project"
}

# Host names that follow from the base domain, unless given one by one.
derive_hosts() {
  local base=$1
  [[ -n $base ]] || return 0
  [[ -n $opt_velydock_host ]] || opt_velydock_host=dock.$base
  [[ -n $opt_keycloak_host ]] || opt_keycloak_host=auth.$base
  [[ -n $opt_sandbox_host ]] || opt_sandbox_host=sandbox.$base
  if (( ! apps_host_given )); then opt_apps_host=apps.$base; fi
}

required() {
  [[ -n $2 ]] || usage_error "$(t opt_missing "$1")"
}

# With --yes: fills in the defaults and insists on everything that has none.
complete_unattended() {
  derive_hosts "$opt_domain"
  if [[ -z $opt_domain ]]; then
    required "--domain (or --velydock-host)" "$opt_velydock_host"
    required "--domain (or --keycloak-host)" "$opt_keycloak_host"
    required "--domain (or --sandbox-host)" "$opt_sandbox_host"
  fi
  v_host_set || usage_error "$problem"
  [[ -n $opt_tls ]] || opt_tls=letsencrypt
  case $opt_tls in
    letsencrypt) required --acme-email "$opt_acme_email" ;;
    own)
      required --cert "$opt_cert"
      required --key "$opt_key"
      v_cert "$opt_cert" || usage_error "$(t opt_bad "$problem" --cert)"
      v_key "$opt_key" || usage_error "$(t opt_bad "$problem" --key)"
      ;;
  esac
  [[ -n $opt_admin_user ]] || opt_admin_user="admin"
  [[ -n $opt_admin_email ]] || opt_admin_email=$opt_acme_email
  required --admin-email "$opt_admin_email"
  [[ -n $opt_dir ]] || opt_dir=$DEFAULT_DIR
  v_dir "$opt_dir" || usage_error "$(t opt_bad "$problem" --dir)"
  complete_backup_answers
}

complete_backup_answers() {
  [[ -n $opt_backup ]] || opt_backup=yes
  if [[ $opt_backup == yes ]]; then
    [[ -n $opt_backup_dir ]] || opt_backup_dir=$opt_dir/backups
    [[ -n $opt_backup_keep ]] || opt_backup_keep=14
  else
    opt_backup_dir=""
    opt_backup_keep=""
  fi
}

ask_questions() {
  local base="" answer

  section sec_hosts
  say hosts_intro
  if [[ -n $opt_domain ]]; then
    derive_hosts "$opt_domain"
    apps_host_given=1
  fi
  if [[ -z $opt_domain && -z $opt_velydock_host && -z $opt_keycloak_host && -z $opt_sandbox_host ]]; then
    ask base "$(t q_domain)" "" v_domain lower
  fi
  [[ -n $opt_velydock_host ]] || ask opt_velydock_host "$(t q_velydock_host)" "${base:+dock.$base}" v_new_host lower
  [[ -n $opt_keycloak_host ]] || ask opt_keycloak_host "$(t q_keycloak_host)" "${base:+auth.$base}" v_new_host lower
  [[ -n $opt_sandbox_host ]] || ask opt_sandbox_host "$(t q_sandbox_host)" "${base:+sandbox.$base}" v_new_host lower
  if (( ! apps_host_given )); then
    ask answer "$(t q_apps_host)" "${base:+apps.$base}" v_new_apps_host lower
    [[ $answer != - ]] || answer=""
    opt_apps_host=$answer
  fi
  v_host_set || die "$problem"

  if [[ -z $opt_tls ]]; then
    section sec_tls
    say tls_choices
    ask answer "$(t q_tls)" 1 v_tls lower
    opt_tls=$(tls_mode "$answer")
  fi
  case $opt_tls in
    letsencrypt)
      [[ -n $opt_acme_email ]] || ask opt_acme_email "$(t q_acme_email)" "$opt_admin_email" v_email
      ;;
    own)
      if [[ -n $opt_cert ]]; then
        v_cert "$opt_cert" || die "$(t opt_bad "$problem" --cert)"
      else
        ask opt_cert "$(t q_cert)" "" v_cert
      fi
      if [[ -n $opt_key ]]; then
        v_key "$opt_key" || die "$(t opt_bad "$problem" --key)"
      else
        ask opt_key "$(t q_key)" "" v_key
      fi
      ;;
    selfsigned) say selfsigned_note ;;
  esac

  if [[ -z $opt_admin_user || -z $opt_admin_email ]]; then
    section sec_admin
    [[ -n $opt_admin_user ]] || ask opt_admin_user "$(t q_admin_user)" admin v_user lower
    [[ -n $opt_admin_email ]] || ask opt_admin_email "$(t q_admin_email)" "$opt_acme_email" v_email
  fi

  if [[ -z $opt_dir ]]; then
    section sec_dir
    ask opt_dir "$(t q_dir)" "$DEFAULT_DIR" v_dir
    opt_dir=${opt_dir%/}
    resolve_directory
  else
    v_dir "$opt_dir" || die "$(t opt_bad "$problem" --dir)"
  fi

  if [[ -z $opt_backup && -z $opt_backup_dir && -z $opt_backup_keep ]]; then
    section sec_backup
    if ask_yes_no "$(t q_backup)" y; then opt_backup=yes; else opt_backup=no; fi
  fi
  [[ -n $opt_backup ]] || opt_backup=yes
  if [[ $opt_backup == yes ]]; then
    [[ -n $opt_backup_dir ]] || ask opt_backup_dir "$(t q_backup_dir)" "$opt_dir/backups" v_path
    opt_backup_dir=${opt_backup_dir%/}
    [[ -n $opt_backup_keep ]] || ask opt_backup_keep "$(t q_backup_keep)" 14 v_keep
  fi
  complete_backup_answers
}

# ---- checks ----------------------------------------------------------------------------------

check_platform() {
  local system machine
  system=$(uname -s)
  machine=$(uname -m)
  [[ $system == Linux ]] || die "$(t not_linux "$system")"
  [[ $machine == x86_64 || $machine == amd64 ]] || die "$(t not_amd64 "$machine")"
}

# Root, unless everything stays inside a directory of the caller's own.
check_privileges() {
  local path
  (( EUID != 0 )) || return 0
  if (( ! opt_no_system )) || [[ -z $opt_dir ]]; then die "$(t need_root)"; fi
  path=$opt_dir
  while [[ ! -e $path && $path != / ]]; do path=$(dirname -- "$path"); done
  [[ -d $path && -O $path && -w $path ]] || die "$(t dir_not_owned "$opt_dir")"
}

project_name() {
  printf '%s' "${opt_project:-velydock}"
}

# The directory our launcher in /usr/local/bin points to; empty if there is none of ours.
launcher_directory() {
  [[ -f $LAUNCHER ]] || return 0
  sed -nE "s|^exec '(/.*)/scripts/velydock' \"\\\$@\"\$|\1|p" "$LAUNCHER" 2>/dev/null | sed -n 1p
}

# The address and port a local client reaches a published port at.
bind_endpoint() {
  local bind=$1 default_port=$2 address=0.0.0.0 port
  bind=${bind:-0.0.0.0:$default_port}
  port=${bind##*:}
  if [[ $bind == *:* ]]; then address=${bind%:*}; fi
  printf '%s %s' "$address" "$port"
}

# Prints what listens where the proxy wants to bind; nothing if the port is free.
port_listener() {
  local address=$1 port=$2 probe
  if command -v ss >/dev/null 2>&1; then
    ss -H -ltnp "sport = :$port" 2>/dev/null | awk -v want="$address" '
      {
        at = $4
        sub(/:[0-9]+$/, "", at)
        any = (at == "0.0.0.0" || at == "*" || at == "[::]")
        if (want == "0.0.0.0" || want == "[::]" || any || at == want) {
          who = ""
          if (match($0, /users:\(\("[^"]+"/)) who = " (" substr($0, RSTART + 9, RLENGTH - 10) ")"
          print $4 who
          exit
        }
      }'
    return 0
  fi
  probe=$address
  case $probe in
    0.0.0.0 | "[::]") probe=127.0.0.1 ;;
  esac
  probe=${probe#[}
  probe=${probe%]}
  # shellcheck disable=SC2016  # $0 and $1 belong to the inner shell
  if timeout 3 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$probe" "$port" 2>/dev/null; then
    printf '%s:%s' "$probe" "$port"
  fi
}

check_ports() {
  local bind address port listener used=0
  # When our own proxy holds the ports (an installation that is being continued), that is fine.
  if (( resume )) && [[ -n $(project_containers) ]]; then return 0; fi
  for bind in "$(bind_endpoint "$opt_http_bind" 80)" "$(bind_endpoint "$opt_https_bind" 443)"; do
    read -r address port <<<"$bind"
    listener=$(port_listener "$address" "$port")
    if [[ -n $listener ]]; then
      check fail "$(t chk_port_used "$port" "$listener")"
      used=1
    else
      check ok "$(t chk_port_free "$port")"
    fi
  done
  if (( used )); then printf '         %s\n' "$(t chk_port_hint)"; fi
}

project_containers() {
  docker ps -aq --filter "label=com.docker.compose.project=$(project_name)" 2>/dev/null || true
}

check_memory() {
  local total
  total=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null) || total=""
  [[ -n $total ]] || return 0
  if (( total < MIN_MEMORY_MB )); then
    check warn "$(t chk_memory_low "$total")"
  else
    check ok "$(t chk_memory_ok "$total")"
  fi
}

check_tools() {
  local name
  for name in tar gzip sha256sum awk sed grep df stat mktemp install timeout; do
    command -v "$name" >/dev/null 2>&1 || check fail "$(t chk_tool_missing "$name")"
  done
  # With Docker's packages comes curl; without that step it has to be there already.
  if (( ! docker_missing )) && ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    check fail "$(t chk_download_missing)"
  fi
}

free_megabytes() {
  local path=$1
  while [[ ! -e $path && $path != / ]]; do path=$(dirname -- "$path"); done
  df -Pk -- "$path" 2>/dev/null | awk 'NR == 2 { print int($4 / 1024) }'
}

check_disk() {
  local path=$1 minimum=$2 free
  free=$(free_megabytes "$path") || free=""
  [[ -n $free ]] || return 0
  if (( free < minimum )); then
    check fail "$(t chk_disk_low "$free" "$path" "$minimum")"
  else
    check ok "$(t chk_disk_ok "$free" "$path")"
  fi
}

os_release() {
  # shellcheck disable=SC1091  # a file of the system, present on every current distribution
  ( . /etc/os-release 2>/dev/null && printf '%s' "${!1:-}" ) || true
}

# Docker is there and usable: daemon, Compose plugin, room for the images, nothing in the way.
check_docker() {
  local server compose_version major minor root
  if ! server=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || [[ -z $server ]]; then
    if (( EUID == 0 )) && [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
      systemctl start docker >/dev/null 2>&1 || true
      server=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || server=""
    fi
  fi
  if [[ -z $server ]]; then
    if (( EUID == 0 )); then check fail "$(t chk_daemon)"; else check fail "$(t chk_daemon_user)"; fi
    return 0
  fi
  if ! compose_version=$(docker compose version --short 2>/dev/null) || [[ -z $compose_version ]]; then
    check fail "$(t chk_compose_missing)"
    return 0
  fi
  compose_version=${compose_version#v}
  major=${compose_version%%.*}
  minor=${compose_version#*.}
  minor=${minor%%.*}
  if [[ ! $major =~ ^[0-9]+$ || ! $minor =~ ^[0-9]+$ ]] || (( major < 2 || (major == 2 && minor < 17) )); then
    check fail "$(t chk_compose_old "$compose_version")"
    return 0
  fi
  check ok "$(t chk_docker_ok "$server" "$compose_version")"
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || root=""
  [[ -z $root ]] || check_disk "$root" "$MIN_DOCKER_DISK_MB"
}

# Nothing of another installation is in the way of a new one.
check_conflicts() {
  local volume name
  (( ! resume )) || return 0
  if [[ -n $(project_containers) ]]; then
    check fail "$(t chk_project_exists "$(project_name)" "${opt_dir:-$DEFAULT_DIR}")"
  fi
  volume=$(project_name)_postgres-data
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    check fail "$(t chk_volume_exists "$volume" "${opt_dir:-$DEFAULT_DIR}" "$volume")"
  fi
  # These two do not stand in the way, but what they hold comes back: certificates the proxy
  # fetched for the earlier installation, and copies of the ones uploaded to it.
  for name in traefik-acme velydock-certs; do
    volume=$(project_name)_$name
    if docker volume inspect "$volume" >/dev/null 2>&1; then
      check warn "$(t chk_volume_reused "$volume" "$volume")"
    fi
  done
}

# The command in /usr/local/bin can only stand for one installation.
check_launcher() {
  local other
  (( ! opt_no_system )) || return 0
  other=$(launcher_directory)
  if [[ -n $other && $other != "$opt_dir" ]]; then
    check fail "$(t chk_launcher_other "$LAUNCHER" "$other")"
  fi
}

preflight() {
  local id
  section checking
  check ok "$(t chk_platform)"
  check_memory
  if command -v docker >/dev/null 2>&1; then
    check_tools
    check_docker
    if (( failures == 0 )); then check_conflicts; fi
  else
    docker_missing=1
    id=$(os_release ID)
    if [[ $id != debian && $id != ubuntu ]]; then
      check fail "$(t chk_docker_missing)"
      printf '\n%s\n' "$(t docker_explain)" >&2
      die "$(t checks_failed)"
    fi
    (( EUID == 0 )) || die "$(t docker_need_root)"
    if (( ! opt_install_docker )); then
      if (( opt_yes )); then
        check fail "$(t chk_docker_missing)"
        printf '\n%s\n' "$(t docker_explain)" >&2
        die "$(t checks_failed)"
      fi
      check warn "$(t chk_docker_missing)"
      open_terminal || die "$(t no_terminal)"
      ask_yes_no "$(t q_install_docker)" y || die "$(t docker_declined)"
      opt_install_docker=1
    fi
    check ok "$(t chk_docker_will_install)"
    check_tools
  fi
  check_ports
  (( failures == 0 )) || die "$(t checks_failed)"
}

# Where the host names point to. Warnings only: DNS is often set up after the server.
check_names() {
  local host resolved mine shown found address warned=0
  command -v getent >/dev/null 2>&1 || return 0
  if command -v ip >/dev/null 2>&1; then
    mine=$(ip -o addr show 2>/dev/null | awk '{ sub(/\/.*/, "", $4); print $4 }')
    shown=$(ip -o addr show scope global 2>/dev/null |
      awk '$2 !~ /^(docker|br-|veth|virbr)/ { sub(/\/.*/, "", $4); print $4 }' | sed -n 1,4p | tr '\n' ' ')
  else
    mine=$(printf '127.0.0.1\n::1\n'; hostname -I 2>/dev/null | tr ' ' '\n')
    shown=$(hostname -I 2>/dev/null || true)
  fi
  shown=${shown% }
  for host in "$opt_velydock_host" "$opt_keycloak_host" "$opt_sandbox_host" "$opt_apps_host"; do
    [[ -n $host ]] || continue
    resolved=$(getent ahosts "$host" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ') || true
    resolved=${resolved% }
    if [[ -z $resolved ]]; then
      check warn "$(t dns_none "$host")"
      warned=1
      continue
    fi
    found=0
    for address in $resolved; do
      if grep -qxF -- "$address" <<<"$mine"; then found=1; fi
    done
    if (( found )); then
      check ok "$(t dns_ok "$host" "$resolved")"
    else
      check warn "$(t dns_elsewhere "$host" "$resolved" "$shown")"
      warned=1
    fi
  done
  if (( warned )) && [[ $opt_tls == letsencrypt ]]; then printf '         %s\n' "$(t dns_acme)"; fi
}

# ---- release ---------------------------------------------------------------------------------

release_base() {
  local base=${VELYDOCK_RELEASE_BASE_URL:-$DEFAULT_BASE_URL}
  printf '%s' "${base%/}"
}

fetch() {
  local url=$1 target=$2
  log "fetch: $url"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https,http' --retry 2 --connect-timeout 20 -o "$target" -- "$url" 2>> "$log_file" </dev/null
  else
    wget -q -O "$target" -- "$url" 2>> "$log_file" </dev/null
  fi
}

# Which version to install: the one asked for, or the one the latest release consists of.
resolve_version() {
  local sums=$work/SHA256SUMS.latest found
  if [[ -n $opt_version ]]; then
    check ok "$(t chk_release "$opt_version")"
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    # Docker's packages bring curl; the version is looked up after they are installed.
    return 0
  fi
  if ! fetch "$(release_base)/latest/download/SHA256SUMS" "$sums"; then
    check fail "$(t no_release "$(release_base)")"
    die "$(t checks_failed)"
  fi
  found=$(sed -nE 's/^[0-9a-f]{64}[ *]+velydock-([0-9A-Za-z.-]+)\.tar\.gz$/\1/p' "$sums" | sed -n 1p)
  problem=""
  if ! v_version "$found"; then
    check fail "$(t no_release "$(release_base)")"
    die "$(t checks_failed)"
  fi
  opt_version=$found
  check ok "$(t chk_release "$opt_version")"
}

# Downloads the bundle, verifies it against SHA256SUMS of the same release and unpacks it into
# the temporary directory. Nothing of it is executed here.
download_bundle() {
  local base name expected actual entry kinds unpacked file found=""
  base=$(release_base)/download/v$opt_version
  name=velydock-$opt_version.tar.gz
  fetch "$base/SHA256SUMS" "$work/SHA256SUMS" || die "$(t download_failed "$base/SHA256SUMS")"
  fetch "$base/$name" "$work/$name" || die "$(t download_failed "$base/$name")"
  expected=$(awk -v file="$name" '$2 == file || $2 == "*" file { print $1; exit }' "$work/SHA256SUMS")
  actual=$(sha256sum < "$work/$name" | cut -d' ' -f1)
  if [[ -z $expected || $expected != "$actual" ]]; then die "$(t checksum_failed "$name")"; fi
  log "checksum ok: $name $actual"
  while IFS= read -r entry; do
    case $entry in
      "velydock-$opt_version" | "velydock-$opt_version/"*) ;;
      *) die "$(t bundle_bad "$entry")" ;;
    esac
    [[ /$entry/ != */../* ]] || die "$(t bundle_bad "$entry")"
  done < <(tar -tzf "$work/$name")
  kinds=$(tar -tvzf "$work/$name" | cut -c1 | sort -u | tr -d '\n')
  [[ $kinds == "-" || $kinds == "-d" ]] || die "$(t bundle_bad "$name")"
  tar -xzf "$work/$name" -C "$work" --no-same-owner --no-same-permissions
  unpacked=$work/velydock-$opt_version
  for file in VERSION IMAGE MANIFEST docker-compose.yml scripts/velydock scripts/backup.sh scripts/restore.sh; do
    [[ -f $unpacked/$file && ! -L $unpacked/$file ]] || die "$(t bundle_bad "$file")"
  done
  IFS= read -r found < "$unpacked/VERSION" || true
  [[ $found == "$opt_version" ]] || die "$(t bundle_bad "VERSION $found")"
  ( cd "$unpacked" && sha256sum --check --quiet --strict MANIFEST >/dev/null 2>&1 ) || die "$(t bundle_bad MANIFEST)"
}

# ---- installing ------------------------------------------------------------------------------

install_docker() {
  local id codename
  id=$(os_release ID)
  codename=$(os_release VERSION_CODENAME)
  if [[ $id != debian && $id != ubuntu ]] || [[ ! $codename =~ ^[a-z]+$ ]]; then
    die "$(t docker_unsupported "${id:-?} ${codename:-?}")"
  fi
  step step_docker
  changed=1
  export DEBIAN_FRONTEND=noninteractive
  if ! {
    run_logged apt-get update &&
      run_logged apt-get install -y ca-certificates curl &&
      install -m 0755 -d /etc/apt/keyrings
  }; then
    step_failed
    die "$(t docker_install_failed)"
  fi
  # Docker's repository as its documentation sets it up - unless the server already has it.
  if ! grep -rqs 'download\.docker\.com' /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null; then
    if ! run_logged curl -fsSL "https://download.docker.com/linux/$id/gpg" -o /etc/apt/keyrings/docker.asc; then
      step_failed
      die "$(t docker_install_failed)"
    fi
    chmod a+r /etc/apt/keyrings/docker.asc
    cat > /etc/apt/sources.list.d/docker.sources <<SOURCES
Types: deb
URIs: https://download.docker.com/linux/$id
Suites: $codename
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
  fi
  if ! {
    run_logged apt-get update &&
      run_logged apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  }; then
    step_failed
    die "$(t docker_install_failed)"
  fi
  step_ok
  if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now docker >> "$log_file" 2>&1 || true
  fi
  local waited=0
  until docker version --format '{{.Server.Version}}' >/dev/null 2>&1; do
    (( waited < 30 )) || die "$(t docker_installed_not_running)"
    sleep 2
    waited=$((waited + 2))
  done
  docker_missing=0
  failures=0
  check_docker
  (( failures == 0 )) || die "$(t checks_failed)"
}

secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# The answers of this run, without any secret, for a run that has to continue it.
write_state() {
  local file=$opt_dir/.install-state
  [[ ! -e $file ]] || return 0
  ( umask 077 && : > "$file" )
  cat > "$file" <<STATE
version=$opt_version
velydock_host=$opt_velydock_host
keycloak_host=$opt_keycloak_host
sandbox_host=$opt_sandbox_host
apps_host=$opt_apps_host
tls=$opt_tls
acme_email=$opt_acme_email
cert=$opt_cert
key=$opt_key
admin_user=$opt_admin_user
admin_email=$opt_admin_email
backup=$opt_backup
backup_dir=$opt_backup_dir
backup_keep=$opt_backup_keep
http_bind=$opt_http_bind
https_bind=$opt_https_bind
port_suffix=$opt_port_suffix
image=$opt_image
project=$opt_project
no_system=$opt_no_system
STATE
}

read_state() {
  local file=$opt_dir/.install-state key value
  while IFS='=' read -r key value || [[ -n $key ]]; do
    case $key in
      version) opt_version=$value ;;
      velydock_host) opt_velydock_host=$value ;;
      keycloak_host) opt_keycloak_host=$value ;;
      sandbox_host) opt_sandbox_host=$value ;;
      apps_host) opt_apps_host=$value ;;
      tls) opt_tls=$value ;;
      acme_email) opt_acme_email=$value ;;
      cert) opt_cert=$value ;;
      key) opt_key=$value ;;
      admin_user) opt_admin_user=$value ;;
      admin_email) opt_admin_email=$value ;;
      backup) opt_backup=$value ;;
      backup_dir) opt_backup_dir=$value ;;
      backup_keep) opt_backup_keep=$value ;;
      http_bind) opt_http_bind=$value ;;
      https_bind) opt_https_bind=$value ;;
      port_suffix) opt_port_suffix=$value ;;
      image) opt_image=$value ;;
      project) opt_project=$value ;;
      no_system) [[ $value != 1 ]] || opt_no_system=1 ;;
    esac
  done < "$file"
  apps_host_given=1
}

# .env: the configuration of this installation with freshly generated secrets. Written under
# another name and renamed, so there is never half a file; an existing one is left alone.
write_env() {
  local file=$opt_dir/.env tmp image
  if [[ -e $file ]]; then
    say env_kept
    return 0
  fi
  step step_env
  image=$opt_image
  [[ -n $image ]] || IFS= read -r image < "$opt_dir/IMAGE"
  problem=""
  v_image "$image" || die "$(t bundle_bad IMAGE)"
  tmp=$(mktemp "$opt_dir/.env.XXXXXX")
  pending+=("$tmp")
  {
    cat <<ENV
# Written by the Velydock installer on $(date -u +%Y-%m-%dT%H:%M:%SZ). Keep this file private and
# include it in your backups: without it the data cannot be used. Reference: docs/installation.md
VELYDOCK_HOST=$opt_velydock_host
KEYCLOAK_HOST=$opt_keycloak_host
SANDBOX_HOST=$opt_sandbox_host
# Optional fourth host for apps published through the proxy (docs/betrieb.md); empty: off.
APPS_HOST=$opt_apps_host
ACME_EMAIL=$opt_acme_email
ENV
    if [[ $opt_tls != letsencrypt ]]; then
      echo "# Empty: no Let's Encrypt. The proxy serves the certificates imported with"
      echo "# \"velydock cert add\", or its self-signed one where none of them fits."
      echo "TLS_RESOLVER="
    fi
    echo
    echo "COMPOSE_PROFILES=proxy"
    echo "# Set by the installer and by \"velydock update\" to the image of the installed release."
    echo "VELYDOCK_IMAGE=$image"
    [[ -z $opt_project ]] || echo "COMPOSE_PROJECT_NAME=$opt_project"
    [[ -z $opt_http_bind ]] || echo "HTTP_BIND=$opt_http_bind"
    [[ -z $opt_https_bind ]] || echo "HTTPS_BIND=$opt_https_bind"
    [[ -z $opt_port_suffix ]] || echo "PUBLIC_PORT_SUFFIX=$opt_port_suffix"
    cat <<ENV

POSTGRES_PASSWORD=$(secret)
VELYDOCK_DB_PASSWORD=$(secret)
KEYCLOAK_DB_PASSWORD=$(secret)
VELYDOCK_SECRET_KEY=$(secret)
VELYDOCK_OIDC_CLIENT_SECRET=$(secret)
VELYDOCK_IDP_ADMIN_CLIENT_SECRET=$(secret)
# Must stay in this file: Keycloak does not start without it.
KEYCLOAK_BOOTSTRAP_SECRET=$(secret)
VELYDOCK_PROXY_SECRET=$(secret)

VELYDOCK_REQUIRE_ADMIN_2FA=true
ENV
    if [[ $opt_backup == yes ]]; then
      echo
      echo "# Read by \"velydock backup\": where backups go and how many of them stay."
      echo "VELYDOCK_BACKUP_DIR=$opt_backup_dir"
      echo "VELYDOCK_BACKUP_KEEP=$opt_backup_keep"
    fi
  } > "$tmp"
  chmod 600 "$tmp"
  if grep -Eq '^[A-Z_]*(PASSWORD|SECRET|KEY)=$' "$tmp"; then
    rm -f -- "$tmp"
    step_failed
    die "no secret could be generated (neither openssl nor /dev/urandom works)."
  fi
  mv -fT -- "$tmp" "$file"
  step_ok
}

launcher_is_ours() {
  [[ -f $LAUNCHER ]] && grep -q '^# Velydock management command' "$LAUNCHER" 2>/dev/null
}

install_launcher() {
  local tmp
  if [[ -e $LAUNCHER || -L $LAUNCHER ]] && ! launcher_is_ours; then
    say launcher_skipped "$LAUNCHER" "$opt_dir/scripts/velydock"
    return 0
  fi
  mkdir -p -- "$(dirname -- "$LAUNCHER")"
  tmp=$(mktemp "$LAUNCHER.XXXXXX")
  pending+=("$tmp")
  cat > "$tmp" <<LAUNCHER_FILE
#!/bin/sh
# Velydock management command: runs the copy in the installation directory, which an update
# replaces. Written by the Velydock installer, removed by "velydock uninstall".
exec '$opt_dir/scripts/velydock' "\$@"
LAUNCHER_FILE
  chmod 755 "$tmp"
  mv -fT -- "$tmp" "$LAUNCHER"
  tool=$LAUNCHER
}

install_timer() {
  if [[ ! -d /run/systemd/system ]] || ! command -v systemctl >/dev/null 2>&1; then
    say timer_no_systemd "$tool"
    return 0
  fi
  step step_timer "$TIMER"
  cat > "$UNIT_DIR/$SERVICE" <<UNIT
# Written by the Velydock installer, removed by "velydock uninstall".
[Unit]
Description=Velydock backup (both databases and the configuration)
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
ExecStart=$opt_dir/scripts/velydock backup
UNIT
  cat > "$UNIT_DIR/$TIMER" <<UNIT
# Written by the Velydock installer, removed by "velydock uninstall".
[Unit]
Description=Nightly Velydock backup

[Timer]
OnCalendar=*-*-* 02:30:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  chmod 644 "$UNIT_DIR/$SERVICE" "$UNIT_DIR/$TIMER"
  if run_logged systemctl daemon-reload && run_logged systemctl enable --now "$TIMER"; then
    step_ok
  else
    step_failed
    die "systemctl enable --now $TIMER"
  fi
}

env_value() {
  local key=$1 line value=""
  [[ -r $opt_dir/.env ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == "$key="* ]] || continue
    value=${line#*=}
  done < "$opt_dir/.env"
  printf '%s' "$value"
}

# An existing installation: say what is there, put back the command and the timer if they are
# gone (after "velydock uninstall"), and touch nothing else.
report_installed() {
  local version="" url
  IFS= read -r version < "$opt_dir/VERSION" || true
  url=https://$(env_value VELYDOCK_HOST)$(env_value PUBLIC_PORT_SUFFIX)
  tool=$opt_dir/scripts/velydock
  if (( EUID == 0 )) && (( ! opt_no_system )); then
    if launcher_is_ours && [[ $(launcher_directory) == "$opt_dir" ]]; then
      tool=$LAUNCHER
    elif [[ ! -e $LAUNCHER && ! -L $LAUNCHER ]]; then
      install_launcher
      say repaired_launcher "$LAUNCHER"
    fi
    if [[ -n $(env_value VELYDOCK_BACKUP_DIR) && ! -e $UNIT_DIR/$TIMER && -d /run/systemd/system ]]; then
      install_timer
      say repaired_timer
    fi
  fi
  say installed_note "$version" "$opt_dir" "$url"
  say installed_hint "$tool" "$tool" "$tool"
}

# A symbolic link as installation directory: the installation goes where it points to, and that
# place is what the command in /usr/local/bin and the timer name - a link can be pointed
# elsewhere later.
resolve_directory() {
  local real
  [[ -n $opt_dir && -L $opt_dir ]] || return 0
  real=$(readlink -f -- "$opt_dir" 2>/dev/null) || real=""
  [[ -n $real && -d $real ]] || die "$(t dir_dangling "$opt_dir")"
  problem=""
  v_path "$real" || die "$problem"
  say dir_link "$opt_dir" "$real"
  opt_dir=$real
}

# True if the directory belongs to whoever installs and nobody else may write to it.
directory_safe() {
  local owner mode
  owner=$(stat -c %u -- "$1" 2>/dev/null) || return 1
  mode=$(stat -c %a -- "$1" 2>/dev/null) || return 1
  (( owner == EUID && (8#$mode & 8#022) == 0 ))
}

# Says before the summary what "secure_directory" is going to do.
check_directory() {
  [[ -d $opt_dir ]] || return 0
  if directory_safe "$opt_dir"; then return 0; fi
  check warn "$(t dir_will_secure "$opt_dir" "$(stat -c %U -- "$opt_dir")" "$(stat -c %a -- "$opt_dir")" "$(id -un)" "$(id -un)")"
}

# Programs in the installation directory are run by root later - through the command in
# /usr/local/bin and by the backup timer -, and root writes into it. A directory that existed
# before is therefore taken over: it belongs to whoever installs, and nobody else writes to it.
# What cannot be made so is not used.
secure_directory() {
  if directory_safe "$opt_dir"; then return 0; fi
  if (( EUID == 0 )); then chown -- 0:0 "$opt_dir" 2>/dev/null || true; fi
  chmod go-w -- "$opt_dir" 2>/dev/null || true
  directory_safe "$opt_dir" || die "$(t dir_unsafe "$opt_dir" "$(id -un)")"
  say dir_secured "$opt_dir" "$(id -un)"
  log "directory secured: $opt_dir"
}

# Looks at the place an installation would be at before any question is asked.
find_installation() {
  local candidate installed=""
  resolve_directory
  candidate=$opt_dir
  if [[ -z $candidate ]] && (( EUID == 0 )); then
    candidate=$(launcher_directory)
    [[ -n $candidate ]] || candidate=$DEFAULT_DIR
  fi
  [[ -n $candidate ]] || return 0
  case $(directory_state "$candidate") in
    installed)
      opt_dir=$candidate
      report_installed
      exit 0
      ;;
    unfinished)
      opt_dir=$candidate
      resume=1
      read_state
      # They were checked when they were given; checked again, because they come from a file.
      check_options
      v_host_set || die "$problem"
      # The file may be old: somebody finished the installation by hand and updated it since.
      # Continuing would put the old version's files under the newer image.
      if [[ -f $opt_dir/VERSION ]]; then
        IFS= read -r installed < "$opt_dir/VERSION" || true
        if [[ $installed != "$opt_version" ]]; then
          die "$(t resume_changed "$opt_dir" "$opt_version" "$installed" "$opt_dir/.install-state" "$opt_dir/scripts/velydock" "$opt_dir/scripts/velydock")"
        fi
      fi
      ;;
    foreign)
      if [[ -n $opt_dir ]]; then die "$(t dir_foreign "$candidate")"; fi
      ;;
  esac
}

show_summary() {
  local url=https://$opt_velydock_host$opt_port_suffix
  section sec_summary
  printf '  %-16s %s\n' "$(t sum_version)" "${opt_version:-$(t sum_version_later)}"
  printf '  %-16s %s\n' "$(t sum_address)" "$url"
  printf '  %-16s %s\n' "$(t sum_keycloak)" "$opt_keycloak_host"
  printf '  %-16s %s\n' "$(t sum_sandbox)" "$opt_sandbox_host"
  printf '  %-16s %s\n' "$(t sum_apps)" "${opt_apps_host:-$(t sum_apps_off)}"
  case $opt_tls in
    letsencrypt) printf '  %-16s %s\n' "$(t sum_tls)" "$(t sum_tls_le "$opt_acme_email")" ;;
    own) printf '  %-16s %s\n' "$(t sum_tls)" "$(t sum_tls_own "$opt_cert" "$(certificate_end "$opt_cert")")" ;;
    *) printf '  %-16s %s\n' "$(t sum_tls)" "$(t sum_tls_self)" ;;
  esac
  printf '  %-16s %s <%s>\n' "$(t sum_admin)" "$opt_admin_user" "$opt_admin_email"
  printf '  %-16s %s\n' "$(t sum_dir)" "$opt_dir"
  if [[ $opt_backup != yes ]]; then
    printf '  %-16s %s\n' "$(t sum_backup)" "$(t sum_backup_off)"
  elif (( opt_no_system )); then
    printf '  %-16s %s\n' "$(t sum_backup)" "$(t sum_backup_manual "$opt_backup_dir" "$opt_backup_keep" "$opt_dir/scripts/velydock")"
  else
    printf '  %-16s %s\n' "$(t sum_backup)" "$(t sum_backup_on "$opt_backup_dir" "$opt_backup_keep")"
  fi
  if (( docker_missing )); then printf '  %-16s %s\n' "$(t sum_docker)" "$(t sum_docker_install)"; fi
  if (( opt_no_system )); then
    printf '  %-16s %s\n' "$(t sum_system)" "$(t sum_system_off "$opt_dir")"
  else
    printf '  %-16s %s\n' "$(t sum_system)" "$(t sum_system_on "$LAUNCHER" "$SYSTEM_LOG")"
  fi
  log "answers: version=$opt_version hosts=$opt_velydock_host,$opt_keycloak_host,$opt_sandbox_host,$opt_apps_host tls=$opt_tls admin=$opt_admin_user dir=$opt_dir backup=$opt_backup"
}

perform() {
  local unpacked output password="" errors accounts=""

  if (( docker_missing )); then
    install_docker
    if [[ -z $opt_version ]]; then resolve_version; fi
  fi

  step step_download "$opt_version"
  download_bundle
  unpacked=$work/velydock-$opt_version
  step_ok

  changed=1
  ( umask 022 && mkdir -p -- "$opt_dir" )
  secure_directory
  if (( opt_no_system )); then settle_log "$opt_dir/install.log"; fi
  step step_files "$opt_dir"
  write_state
  tool=$opt_dir/scripts/velydock
  if ! run_logged bash "$unpacked/scripts/velydock" __place-files "$opt_dir" "$unpacked"; then
    step_failed
    die "$(t bundle_bad "scripts/velydock __place-files")"
  fi
  step_ok

  write_env

  if (( ! opt_no_system )); then
    step step_launcher "$LAUNCHER"
    install_launcher
    step_ok
  fi

  step step_start
  if ! run_logged "$opt_dir/scripts/velydock" start --pull; then
    step_failed
    say start_failed >&2
    tail -n 25 -- "$log_file" >&2 || true
    exit 1
  fi
  step_ok

  if [[ $opt_tls == own ]]; then
    # A run that continues an earlier one may come long after it: a certificate stored in the
    # meantime, perhaps a renewed one, is not replaced by the file of the first run.
    if (( resume )) && "$opt_dir/scripts/velydock" cert list 2>/dev/null </dev/null | grep -q $'\t'; then
      say cert_kept "$tool" "$tool" "$opt_cert" "$opt_key"
    else
      step step_cert
      if ! run_logged "$opt_dir/scripts/velydock" cert add "$opt_cert" "$opt_key" --replace; then
        step_failed
        tail -n 5 -- "$log_file" >&2 || true
        die "$(t cert_failed "$tool" "$opt_cert" "$opt_key")"
      fi
      step_ok
    fi
  fi

  # The first administrator is created in an installation without accounts only. With an
  # account of that name present, the command would reset its password and end its sessions -
  # which is what happens when a run of long ago is continued on an installation in use.
  accounts=$("$opt_dir/scripts/velydock" __accounts 2>> "$log_file" </dev/null) || accounts=""
  [[ $accounts =~ ^[0-9]+$ ]] || die "$(t accounts_unknown "$tool")"
  if (( accounts > 0 )); then
    log "accounts present: $accounts; no administrator created"
  else
    step step_admin
    errors=$work/admin.err
    log "run: velydock admin --username $opt_admin_user --email $opt_admin_email"
    # The output holds the one-time password: it goes to the terminal once, never into the log.
    if ! output=$("$opt_dir/scripts/velydock" admin --username "$opt_admin_user" --email "$opt_admin_email" 2> "$errors" </dev/null); then
      step_failed
      cat -- "$errors" >> "$log_file" 2>/dev/null || true
      say admin_failed >&2
      grep -i 'error' "$errors" >&2 || tail -n 5 -- "$errors" >&2 || true
      exit 1
    fi
    password=$(sed -nE 's/.*One-time password:[[:space:]]+([^[:space:]]+).*/\1/p' <<<"$output" | sed -n 1p)
    if [[ -z $password ]]; then
      step_failed
      die "$(t admin_failed)"
    fi
    step_ok
  fi

  if [[ $opt_backup == yes ]] && (( ! opt_no_system )); then install_timer; fi

  rm -f -- "$opt_dir/.install-state"
  log "installation finished"
  changed=0

  printf '\n%s\n\n' "$(t done_title "$opt_version")"
  printf '  %-18s %s\n' "$(t done_address)" "https://$opt_velydock_host$opt_port_suffix"
  if [[ -n $password ]]; then
    printf '  %-18s %s\n' "$(t done_user)" "$opt_admin_user"
    printf '  %-18s %s\n\n' "$(t done_password)" "$password"
    say done_password_note
  else
    printf '\n'
    say admin_exists "$accounts" "$tool"
  fi
  case $opt_tls in
    selfsigned) say done_selfsigned ;;
    letsencrypt) say done_letsencrypt ;;
  esac
  printf '\n  %-18s %s\n' "$(t done_manage)" "$(t done_manage_cmds "$tool")"
  printf '  %-18s %s\n' "$(t done_config)" "$(t done_config_note "$opt_dir/.env")"
  if [[ $opt_backup == yes ]]; then
    printf '  %-18s %s\n' "$(t done_backup)" "$(t done_backup_note "$opt_backup_dir")"
  fi
  if (( log_final )); then printf '  %-18s %s\n' "$(t sum_system)" "$(t log_at "$log_file")"; fi
}

main() {
  if [[ -z ${BASH_VERSINFO[0]:-} ]] || (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 4) )); then
    echo "bash 4.4 or newer is needed. / Es wird bash ab Version 4.4 gebraucht." >&2
    exit 1
  fi
  detect_language "$@"
  # From here on, what other programs print must not depend on the caller's language.
  export LC_ALL=C
  load_messages
  parse_args "$@"
  check_options
  check_platform
  check_privileges

  work=$(mktemp -d)
  trap cleanup EXIT
  trap 'interrupted 1' HUP
  trap 'interrupted 2' INT
  trap 'interrupted 15' TERM
  log_file=$work/install.log
  if (( EUID == 0 )) && (( ! opt_no_system )); then settle_log "$SYSTEM_LOG"; fi
  log "installer started (language $ui_lang, base $(release_base))"

  printf '%s\n' "$(t title)"
  find_installation

  if (( resume )); then
    printf '\n%s\n' "$(t resume_note "$opt_version" "$opt_dir")"
    preflight
    if (( ! opt_yes )); then
      open_terminal || die "$(t no_terminal)"
      ask_yes_no "$(t q_resume)" y || die "$(t aborted)"
    fi
  else
    if (( opt_yes )); then complete_unattended; fi
    preflight
    resolve_version
    if (( ! opt_yes )); then
      open_terminal || die "$(t no_terminal)"
      ask_questions
    fi
    section checking_answers
    check_names
    check_disk "$opt_dir" "$MIN_DIR_DISK_MB"
    check_directory
    check_launcher
    (( failures == 0 )) || die "$(t checks_failed)"
    show_summary
    if (( ! opt_yes )); then
      printf '\n'
      ask_yes_no "$(t q_go)" y || die "$(t aborted)"
    fi
  fi
  printf '\n'
  perform
}

main "$@"
