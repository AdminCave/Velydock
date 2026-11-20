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

  it('stay silent when there is nothing to add', () => {
    expect(auditDetail({ action: 'user.delete', details: {} }, de)).toBe('');
    expect(auditDetail({ action: 'unknown.action', details: { a: 1 } }, de)).toBe('');
    expect(auditDetail({ action: 'app.update', details: { fields: 'oops' } }, de)).toBe('');
  });
});
