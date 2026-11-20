// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Applies the stored theme before the first paint, so nobody sees a flash of the wrong
// theme. A file, not an inline script: the Content Security Policy only allows
// script-src 'self'. Keep the logic in step with src/lib/theme.ts (resolveTheme).
// Stored value: "light", "dark" or "system"; nothing stored counts as "system".
(function () {
  var theme = 'dark';
  try {
    var stored = localStorage.getItem('velydock-theme');
    if (stored === 'light' || stored === 'dark') {
      theme = stored;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      theme = 'light';
    }
  } catch (e) {
    /* storage unavailable (private mode, blocked site data): stay on the dark default */
  }
  document.documentElement.dataset.theme = theme;
  try {
    var lang = localStorage.getItem('velydock-language');
    if (lang === 'de' || lang === 'en') document.documentElement.lang = lang;
  } catch (e) {
    /* keep the lang attribute of index.html */
  }
})();
