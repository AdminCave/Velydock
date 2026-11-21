// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Messages } from '../dictionaries';

// What the icons an app can have show, for those who cannot see them: `icon.<name>`,
// where the name is the one in lib/appIcons.ts.
export const icons = {
  'icon.app-window': ['Fenster', 'Window'],
  'icon.globe': ['Weltkugel', 'Globe'],
  'icon.house': ['Haus', 'House'],
  'icon.layout-dashboard': ['Übersicht', 'Dashboard'],
  'icon.book-open': ['Buch', 'Book'],
  'icon.file-text': ['Dokument', 'Document'],
  'icon.folder': ['Ordner', 'Folder'],
  'icon.cloud': ['Wolke', 'Cloud'],
  'icon.mail': ['Brief', 'Envelope'],
  'icon.inbox': ['Posteingang', 'Inbox'],
  'icon.message-circle': ['Sprechblase', 'Speech bubble'],
  'icon.phone': ['Telefon', 'Phone'],
  'icon.video': ['Videokamera', 'Video camera'],
  'icon.calendar': ['Kalender', 'Calendar'],
  'icon.clipboard-list': ['Klemmbrett mit Liste', 'Clipboard with list'],
  'icon.notebook-pen': ['Notizbuch', 'Notebook'],
  'icon.ticket': ['Ticket', 'Ticket'],
  'icon.life-buoy': ['Rettungsring', 'Lifebuoy'],
  'icon.users': ['Personen', 'People'],
  'icon.briefcase': ['Aktentasche', 'Briefcase'],
  'icon.graduation-cap': ['Doktorhut', 'Graduation cap'],
  'icon.chart-column': ['Säulendiagramm', 'Bar chart'],
  'icon.activity': ['Pulslinie', 'Pulse line'],
  'icon.heart-pulse': ['Herz mit Pulslinie', 'Heart with pulse line'],
  'icon.wallet': ['Geldbörse', 'Wallet'],
  'icon.credit-card': ['Kreditkarte', 'Credit card'],
  'icon.shopping-cart': ['Einkaufswagen', 'Shopping cart'],
  'icon.package': ['Paket', 'Package'],
  'icon.truck': ['Lastwagen', 'Truck'],
  'icon.map': ['Landkarte', 'Map'],
  'icon.printer': ['Drucker', 'Printer'],
  'icon.camera': ['Kamera', 'Camera'],
  'icon.image': ['Bild', 'Picture'],
  'icon.headphones': ['Kopfhörer', 'Headphones'],
  'icon.monitor': ['Bildschirm', 'Screen'],
  'icon.server': ['Server', 'Server'],
  'icon.database': ['Datenbank', 'Database'],
  'icon.code': ['Programmcode', 'Code'],
  'icon.square-terminal': ['Kommandozeile', 'Terminal'],
  'icon.flask-conical': ['Laborkolben', 'Laboratory flask'],
  'icon.wrench': ['Schraubenschlüssel', 'Wrench'],
  'icon.settings': ['Zahnrad', 'Gear'],
  'icon.key-round': ['Schlüssel', 'Key'],
  'icon.shield-check': ['Schild mit Haken', 'Shield with tick'],
  'icon.rocket': ['Rakete', 'Rocket'],
  'icon.power-off': ['Ein/Aus-Zeichen', 'Power symbol'],

  // ── What the embed check found (`embed.detail.<code>`; see lib/embedDetail.ts) ──
  'embed.detail.no_restriction': [
    'Die Seite schränkt das Einbetten nicht ein.',
    'The site does not restrict embedding.',
  ],
  'embed.detail.xfo_deny': [
    'Die Seite verbietet jedes Einbetten (X-Frame-Options: DENY).',
    'The site forbids all embedding (X-Frame-Options: DENY).',
  ],
  'embed.detail.xfo_sameorigin': [
    'Die Seite lässt sich nur unter ihrer eigenen Adresse einbetten (X-Frame-Options: SAMEORIGIN).',
    'The site can only be embedded under its own address (X-Frame-Options: SAMEORIGIN).',
  ],
  'embed.detail.xfo_conflict': [
    'Die Seite sendet widersprüchliche Angaben in X-Frame-Options; Browser blockieren das Einbetten dann.',
    'The site sends contradictory X-Frame-Options values; browsers block embedding then.',
  ],
  'embed.detail.xfo_allow_from_ignored': [
    'Die Seite nennt erlaubte Adressen auf eine veraltete Art (X-Frame-Options: ALLOW-FROM), die Browser nicht mehr beachten.',
    'The site names allowed addresses in an obsolete way (X-Frame-Options: ALLOW-FROM) that browsers no longer honour.',
  ],
  'embed.detail.frame_ancestors_allows': [
    'Die Seite erlaubt das Einbetten in Velydock ausdrücklich (Content-Security-Policy: frame-ancestors).',
    'The site explicitly allows embedding in Velydock (Content-Security-Policy: frame-ancestors).',
  ],
  'embed.detail.frame_ancestors_blocks': [
    'Die Seite erlaubt das Einbetten nur für: {value} (Content-Security-Policy: frame-ancestors).',
    'The site allows embedding only for: {value} (Content-Security-Policy: frame-ancestors).',
  ],
  'embed.detail.private_address': [
    'Die Adresse liegt in einem privaten Netz und wurde nicht geprüft.',
    'The address is in a private network and was not checked.',
  ],
  'embed.detail.unresolved': [
    'Der Name der Seite ließ sich nicht auflösen.',
    'The name of the site could not be resolved.',
  ],
  'embed.detail.unreachable': ['Die Seite war nicht erreichbar.', 'The site could not be reached.'],
  'embed.detail.redirect_other_host': [
    'Die Seite leitet auf eine andere Adresse weiter ({value}); die wurde nicht geprüft.',
    'The site redirects to another address ({value}), which was not checked.',
  ],
  'embed.detail.too_many_redirects': [
    'Die Seite leitet zu oft weiter.',
    'The site redirects too many times.',
  ],
  'embed.detail.busy': [
    'Gerade laufen zu viele Prüfungen. Versuch es gleich noch einmal.',
    'Too many checks are running right now. Try again in a moment.',
  ],
  'embed.detail.timeout': [
    'Die Seite hat nicht rechtzeitig geantwortet.',
    'The site did not answer in time.',
  ],
  'embed.detail.invalid_address': ['Die Adresse ist ungültig.', 'The address is invalid.'],
  'embed.detail.not_http': [
    'Geprüft werden nur Adressen, die mit http:// oder https:// beginnen.',
    'Only addresses that start with http:// or https:// are checked.',
  ],
  'embed.detail.credentials': [
    'Die Adresse enthält Zugangsdaten und wurde deshalb nicht geprüft.',
    'The address contains credentials and was therefore not checked.',
  ],
} satisfies Messages;
