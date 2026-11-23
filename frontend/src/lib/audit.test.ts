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

  describe('about publishing through the proxy', () => {
    const en = (key: string, vars?: Record<string, string | number | null | undefined>) =>
      translate('en', key, vars);
    const publication = {
      name: 'wiki',
      mode: 'path',
      access: 'protected',
      target: 'http://10.20.0.7:8080',
      template: 'builtin:embeddable',
    };

    it('knows the actions the backend records for it', () => {
      // The list is what the test above goes through: every action in both languages.
      expect(AUDIT_ACTIONS).toEqual(
        expect.arrayContaining([
          'proxy.target.add',
          'proxy.target.remove',
          'proxy.template.create',
          'proxy.template.update',
          'proxy.template.delete',
        ]),
      );
    });

    it('says what was released for an organization, and what was withdrawn', () => {
      expect(auditActionLabel('proxy.target.add', de)).toBe('Proxy-Freigabe erteilt');
      expect(auditActionLabel('proxy.target.remove', de)).toBe('Proxy-Freigabe zurückgezogen');
      expect(
        auditDetail({ action: 'proxy.target.add', details: { value: '10.20.0.0/16' } }, de),
      ).toBe('Freigabe: 10.20.0.0/16');
      expect(
        auditDetail({ action: 'proxy.target.remove', details: { value: 'nas.intern' } }, en),
      ).toBe('Release: nas.intern');
      expect(auditDetail({ action: 'proxy.target.add', details: {} }, de)).toBe('');
    });

    it('names what was changed about a template', () => {
      expect(auditActionLabel('proxy.template.create', de)).toBe('Proxy-Vorlage angelegt');
      expect(auditActionLabel('proxy.template.delete', en)).toBe('Proxy template deleted');
      expect(
        auditDetail(
          { action: 'proxy.template.update', details: { fields: ['description', 'options'] } },
          de,
        ),
      ).toBe('Geändert: Beschreibung, Einstellungen');
      expect(auditDetail({ action: 'proxy.template.create', details: {} }, de)).toBe('');
    });

    it('says whether path addresses were allowed or switched off for an organization', () => {
      expect(
        auditDetail({ action: 'tenant.update', details: { proxy_path_allowed: false } }, de),
      ).toBe('Pfad-Adressen abgeschaltet');
      expect(
        auditDetail(
          { action: 'tenant.update', details: { name: 'Neu', proxy_path_allowed: true } },
          de,
        ),
      ).toBe('neuer Name: Neu · Pfad-Adressen erlaubt');
      expect(
        auditDetail({ action: 'tenant.update', details: { proxy_path_allowed: true } }, en),
      ).toBe('Path addresses allowed');
    });

    it('says under which address an app was published, for whom, and where it leads', () => {
      expect(
        auditDetail({ action: 'app.create', details: { type: 'embedded', publication } }, de),
      ).toBe(
        'Typ: Eingebettet · Veröffentlicht als wiki (Pfad, geschützt) → http://10.20.0.7:8080 · Vorlage: In Velydock einbettbar',
      );
      expect(
        auditDetail(
          {
            action: 'app.update',
            details: {
              fields: ['name', 'publication'],
              publication: { ...publication, mode: 'subdomain', access: 'public' },
            },
          },
          en,
        ),
      ).toBe(
        'Changed: Name, Publication · Published as wiki (sub-domain, public) → http://10.20.0.7:8080 · Template: Embeddable in Velydock',
      );
    });

    it('says that a publication was ended', () => {
      expect(
        auditDetail(
          {
            action: 'app.update',
            details: { fields: ['publication', 'url'], publication: 'removed' },
          },
          de,
        ),
      ).toBe('Geändert: Veröffentlichung, Adresse (URL) · Veröffentlichung beendet');
    });

    it('names a template of the system administrator as the entry keeps it', () => {
      const own = { ...publication, template: '7f3c-1', template_name: 'Nur aus dem Büro' };
      expect(
        auditDetail({ action: 'app.create', details: { type: 'embedded', publication: own } }, de),
      ).toBe(
        'Typ: Eingebettet · Veröffentlicht als wiki (Pfad, geschützt) → http://10.20.0.7:8080 · Vorlage: Nur aus dem Büro',
      );
      // A built-in template is named here, whatever else the entry holds.
      expect(
        auditDetail(
          {
            action: 'app.update',
            details: { fields: [], publication: { ...publication, template_name: 'Embeddable' } },
          },
          de,
        ),
      ).toContain('Vorlage: In Velydock einbettbar');
      // One this version has no name for is shown by its id rather than called an own one.
      expect(
        auditDetail(
          {
            action: 'app.update',
            details: { fields: [], publication: { ...publication, template: 'builtin:brand-new' } },
          },
          de,
        ),
      ).toContain('Vorlage: builtin:brand-new');
    });

    it('calls an own template what it is where an older entry kept its id only', () => {
      expect(
        auditDetail(
          {
            action: 'app.update',
            details: {
              fields: ['publication'],
              publication: { ...publication, template: '7f3c-1' },
            },
          },
          de,
        ),
      ).toContain('Vorlage: eigene Vorlage');
    });

    it('leaves an app change without a publication as it was', () => {
      expect(auditDetail({ action: 'app.create', details: { type: 'external' } }, de)).toBe(
        'Typ: Neuer Tab',
      );
      expect(
        auditDetail({ action: 'app.update', details: { fields: ['name'], publication: 7 } }, de),
      ).toBe('Geändert: Name');
    });
  });

  it('stay silent when there is nothing to add', () => {
    expect(auditDetail({ action: 'user.delete', details: {} }, de)).toBe('');
    expect(auditDetail({ action: 'unknown.action', details: { a: 1 } }, de)).toBe('');
    expect(auditDetail({ action: 'app.update', details: { fields: 'oops' } }, de)).toBe('');
  });
});
