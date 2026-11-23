// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { translate } from '$lib/i18n';
import { translations } from '$lib/i18n/dictionaries';
import { AUDIT_ACTIONS, auditActionLabel, auditDetail } from './audit';

const de = (key: string, vars?: Record<string, string | number | null | undefined>) =>
  translate('de', key, vars);

describe('audit log texts', () => {
  it('have a readable label for every action the backend records', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(translations.de[`audit.action.${action}`], action).toBeTruthy();
      expect(translations.en[`audit.action.${action}`], action).toBeTruthy();
      expect(auditActionLabel(action, de)).not.toBe(action);
    }
  });

  it('show an unknown action as its code', () => {
    expect(auditActionLabel('robot.uprising', de)).toBe('robot.uprising');
  });

  it('describe what changed', () => {
    expect(
      auditDetail(
        { action: 'user.create', details: { role: 'member', invited_by_email: true } },
        de,
      ),
    ).toBe('Rolle: Mitglied · Einladung per E-Mail');
    expect(
      auditDetail(
        {
          action: 'user.update',
          details: { role: { from: 'member', to: 'tenant_admin' }, active: false, groups: 2 },
        },
        de,
      ),
    ).toBe('Rolle: Mitglied → Administration · deaktiviert · Gruppen: 2');
    expect(
      auditDetail({ action: 'user.set_system_admin', details: { is_system_admin: true } }, de),
    ).toBe('erteilt');
    expect(
      auditDetail({ action: 'group.update', details: { renamed_from: 'Alt', members: 3 } }, de),
    ).toBe('vorher: Alt · Mitglieder: 3');
    expect(auditDetail({ action: 'app.create', details: { type: 'external' } }, de)).toBe(
      'Typ: Neuer Tab',
    );
    expect(auditDetail({ action: 'app.update', details: { fields: ['name', 'url'] } }, de)).toBe(
      'Geändert: Name, Adresse (URL)',
    );
    expect(
      auditDetail({ action: 'tenant.delete', details: { slug: 'acme', deleted_users: 4 } }, de),
    ).toBe('Kurzname: acme · gelöschte Konten: 4');
    expect(
      auditDetail(
        {
          action: 'tenant.settings',
          details: { default_nav_position: null, nav_position_locked: true },
        },
        de,
      ),
    ).toBe('Standardposition: Systemstandard · Position festgelegt');
  });

  it('say what an organization changed about its appearance, each setting with its new value', () => {
    const detail = (details: Record<string, unknown>, t = de) =>
      auditDetail({ action: 'tenant.settings', details }, t);
    expect(detail({ accent_color: '#c2410c', theme_locked: true, logo: 'changed' })).toBe(
      'Logo geändert · Design festgelegt · Akzentfarbe: #c2410c',
    );
    expect(detail({ logo: 'removed' })).toBe('Logo entfernt');
    expect(detail({ default_theme: 'light' })).toBe('Standard-Design: Hell');
    expect(detail({ default_theme: 'system', theme_locked: false })).toBe(
      'Standard-Design: System · Design freigegeben',
    );
    expect(detail({ default_app_bar: 'hidden', app_bar_locked: true })).toBe(
      'App-Leiste: Ausgeblendet · App-Leiste festgelegt',
    );
    expect(detail({ accent_locked: true })).toBe('Akzentfarbe festgelegt');
    expect(
      detail({ accent_locked: false, app_bar_locked: false, nav_position_locked: false }),
    ).toBe('Akzentfarbe freigegeben · Position freigegeben · App-Leiste freigegeben');
    // A default that was removed is sent as null.
    expect(
      detail({
        default_theme: null,
        accent_color: null,
        default_app_bar: null,
        default_nav_position: null,
      }),
    ).toBe(
      'Standard-Design: Keine Vorgabe · Akzentfarbe: Keine Vorgabe · Standardposition: Systemstandard · App-Leiste: Keine Vorgabe',
    );
    // Every change of one save in one line, and in English as well.
    expect(
      detail(
        {
          default_theme: 'dark',
          theme_locked: true,
          accent_color: '#0f766e',
          accent_locked: true,
          default_nav_position: 'top',
          nav_position_locked: true,
          default_app_bar: 'bottom',
          app_bar_locked: true,
          logo: 'changed',
        },
        (key, vars) => translate('en', key, vars),
      ),
    ).toBe(
      'Logo changed · Default theme: Dark · Theme fixed · Accent colour: #0f766e · Accent colour fixed · Default position: Top · Position fixed · App bar: Bottom · App bar fixed',
    );
    // A value this version does not know is shown as it came.
    expect(detail({ default_app_bar: 'floating' })).toBe('App-Leiste: floating');
  });

  it('say which way a setting was changed, not only that it was', () => {
    expect(
      auditDetail(
        {
          action: 'system.settings',
          details: { fields: ['require_admin_2fa'], values: { require_admin_2fa: false } },
        },
        de,
      ),
    ).toBe('Zwei-Faktor für Administratoren: aus');
    expect(
      auditDetail(
        {
          action: 'system.settings',
          details: {
            fields: ['instance_name', 'default_nav_position', 'default_theme', 'smtp'],
            values: {
              instance_name: 'Stadtwerke',
              default_nav_position: 'top',
              default_theme: 'dark',
              default_language: 'en',
              require_admin_2fa: true,
            },
          },
        },
        de,
      ),
    ).toBe(
      'Name der Installation: Stadtwerke · Standardposition des Docks: Oben · Standard-Design: Dunkel · Standardsprache: English · Zwei-Faktor für Administratoren: an · Geändert: E-Mail-Versand',
    );
    // An entry from before the values were recorded still names the fields.
    expect(
      auditDetail({ action: 'system.settings', details: { fields: ['require_admin_2fa'] } }, de),
    ).toBe('Geändert: Zwei-Faktor für Administratoren');
    expect(
      auditDetail(
        { action: 'system.settings', details: { values: { require_admin_2fa: true } } },
        (key, vars) => translate('en', key, vars),
      ),
    ).toBe('Two-factor for administrators: on');
  });

  it('stay silent when there is nothing to add', () => {
    expect(auditDetail({ action: 'user.delete', details: {} }, de)).toBe('');
    expect(auditDetail({ action: 'unknown.action', details: { a: 1 } }, de)).toBe('');
    expect(auditDetail({ action: 'app.update', details: { fields: 'oops' } }, de)).toBe('');
  });
});
