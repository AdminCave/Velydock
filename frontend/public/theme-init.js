// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Applies the stored theme and accent colour before the first paint, so nobody sees a
// flash of the wrong theme or of the built-in blue. A file, not an inline script: the
// Content Security Policy only allows script-src 'self'. Keep the logic in step with
// src/lib/theme.ts (resolveTheme, setAccentColor, applyAccent).
// Stored theme: "light", "dark" or "system"; nothing stored counts as "system".
(function () {
  var root = document.documentElement;
  // Nobody is signed in on the login page: what an organization set for its members (its
  // theme, its accent) does not apply there, only what the user chose for themselves.
  var login = /^\/login\/?$/.test(window.location.pathname);
  var theme = 'dark';
  try {
    // On the login page: the own choice, else the default of the installation as the
    // login page last learned it.
    var stored = login
      ? localStorage.getItem('velydock-theme-own') || localStorage.getItem('velydock-theme-public')
      : localStorage.getItem('velydock-theme');
    if (stored === 'light' || stored === 'dark') {
      theme = stored;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      theme = 'light';
    }
  } catch (e) {
    /* storage unavailable (private mode, blocked site data): stay on the dark default */
  }
  root.dataset.theme = theme;
  try {
    // {"color":"#rrggbb","light":{"--accent":…},"dark":{…}}: the tokens the app derived
    // from the colour the last time it ran. Anything that does not look like that is left
    // alone; the app sets the real values as soon as it knows the user.
    var accent = login ? null : JSON.parse(localStorage.getItem('velydock-accent') || 'null');
    var tokens = accent && accent[theme];
    var names = [
      '--accent',
      '--accent-hover',
      '--accent-muted',
      '--accent-border',
      '--link',
      '--info',
      '--info-bg',
      '--info-border',
      '--ring',
    ];
    var value = /^(#[0-9a-f]{6}|rgba\(\d{1,3},\d{1,3},\d{1,3},(0|1|0?\.\d{1,3})\))$/;
    if (tokens && typeof accent.color === 'string' && /^#[0-9a-f]{6}$/.test(accent.color)) {
      var valid = names.every(function (name) {
        return typeof tokens[name] === 'string' && value.test(tokens[name]);
      });
      if (valid) {
        names.forEach(function (name) {
          root.style.setProperty(name, tokens[name]);
        });
        root.dataset.accent = accent.color;
      }
    }
  } catch (e) {
    /* nothing stored, or not what this version stores: the built-in accent until the app runs */
  }
  try {
    var lang = localStorage.getItem('velydock-language');
    if (lang === 'de' || lang === 'en') root.lang = lang;
  } catch (e) {
    /* keep the lang attribute of index.html */
  }
})();
