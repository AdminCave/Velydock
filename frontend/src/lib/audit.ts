// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { AuditEntry } from '$lib/api/types';
import { hasMessage, type Translate } from '$lib/i18n';
import { builtinKey } from '$lib/proxy';

// Turns an audit entry into readable text: what happened, and the details that matter.

/** Actions the backend records. Each has a translation under `audit.action.<name>`. */
export const AUDIT_ACTIONS = [
  'user.create',
  'user.update',
  'user.reset_password',
  'user.end_sessions',
  'user.delete',
  'user.remove_membership',
  'user.add_membership',
  'user.set_system_admin',
  'group.create',
  'group.update',
  'group.delete',
  'app.create',
  'app.update',
  'app.delete',
  'app.reorder',
  'tenant.create',
  'tenant.update',
  'tenant.delete',
  'tenant.settings',
  'system.settings',
  'proxy.target.add',
  'proxy.target.remove',
  'proxy.template.create',
  'proxy.template.update',
  'proxy.template.delete',
] as const;

export function auditActionLabel(action: string, t: Translate): string {
  const key = `audit.action.${action}`;
  // An action this version does not know yet is shown as its code rather than hidden.
  return hasMessage(key) ? t(key) : action;
}

function label(prefix: string, value: unknown, t: Translate): string {
  const key = `${prefix}.${String(value)}`;
  return hasMessage(key) ? t(key) : String(value);
}

function fieldNames(value: unknown, t: Translate): string {
  if (!Array.isArray(value)) return '';
  return value.map((name) => label('field', name, t)).join(', ');
}

/** A new value of a setting as text: "an"/"aus" for a switch, the translated choice, the text. */
function settingValue(field: string, value: unknown, t: Translate): string {
  if (value === true) return t('audit.value.on');
  if (value === false) return t('audit.value.off');
  if (value === null || value === undefined || value === '') return t('audit.value.empty');
  if (field === 'default_nav_position') return label('nav.position', value, t);
  if (field === 'default_theme') return label('settings.theme', value, t);
  if (field === 'default_language')
    return value === 'de' ? 'Deutsch' : value === 'en' ? 'English' : String(value);
  return String(value);
}

/**
 * Changed settings with their new values where the entry has them ("Zwei-Faktor für
 * Administratoren: aus"), and the names of the remaining changed fields.
 */
function settingChanges(d: Record<string, unknown>, t: Translate): string[] {
  const parts: string[] = [];
  const values =
    typeof d.values === 'object' && d.values !== null ? (d.values as Record<string, unknown>) : {};
  for (const [field, value] of Object.entries(values)) {
    parts.push(
      t('audit.detail.value', {
        field: label('field', field, t),
        value: settingValue(field, value, t),
      }),
    );
  }
  const rest = Array.isArray(d.fields) ? d.fields.filter((name) => !(String(name) in values)) : [];
  const names = fieldNames(rest, t);
  if (names) parts.push(t('audit.detail.fields', { fields: names }));
  return parts;
}

/**
 * The template of a publication as the log can name it. A built-in one is named here, by
 * its id. For one of the system administrator's own the entry keeps the name it had
 * (`template_name`); entries from before that are only known to be such a template.
 */
function templateName(publication: Record<string, unknown>, t: Translate): string {
  const id = String(publication.template);
  const builtin = builtinKey(id);
  if (builtin !== null) {
    const key = `proxy.builtin.${builtin}.name`;
    return hasMessage(key) ? t(key) : id;
  }
  const kept = publication.template_name;
  return typeof kept === 'string' && kept ? kept : t('audit.publication.ownTemplate');
}

/**
 * What an app change says about its publication through the proxy: under which name and
 * kind of address, for whom, where it leads and with which template – or that it ended.
 */
function publicationParts(value: unknown, t: Translate): string[] {
  if (value === 'removed') return [t('audit.detail.publicationEnded')];
  if (typeof value !== 'object' || value === null) return [];
  const p = value as Record<string, unknown>;
  const parts = [
    t('audit.detail.publication', {
      name: String(p.name ?? ''),
      mode: label('audit.publication', p.mode, t),
      access: label('audit.publication', p.access, t),
      target: String(p.target ?? ''),
    }),
  ];
  if (typeof p.template === 'string' && p.template) {
    parts.push(t('audit.detail.publicationTemplate', { template: templateName(p, t) }));
  }
  return parts;
}

/** The noteworthy details of an entry as one short line; empty if there is nothing to add. */
export function auditDetail(entry: Pick<AuditEntry, 'action' | 'details'>, t: Translate): string {
  const d = entry.details ?? {};
  const parts: string[] = [];
  const role = (value: unknown) => label('role', value, t);

  switch (entry.action) {
    case 'user.create':
      if (d.role) parts.push(t('audit.detail.role', { role: role(d.role) }));
      if (d.invited_by_email) parts.push(t('audit.detail.invited'));
      break;
    case 'user.update': {
      const change = d.role as { from?: unknown; to?: unknown } | undefined;
      if (change && typeof change === 'object') {
        parts.push(t('audit.detail.roleChange', { from: role(change.from), to: role(change.to) }));
      }
      if (d.active === true) parts.push(t('audit.detail.reactivated'));
      if (d.active === false) parts.push(t('audit.detail.deactivated'));
      if (d.email) parts.push(t('audit.detail.emailChanged'));
      if (typeof d.groups === 'number') parts.push(t('audit.detail.groups', { count: d.groups }));
      break;
    }
    case 'user.add_membership':
      if (d.role) parts.push(t('audit.detail.role', { role: role(d.role) }));
      break;
    case 'user.set_system_admin':
      parts.push(t(d.is_system_admin ? 'audit.detail.granted' : 'audit.detail.revoked'));
      break;
    case 'group.create':
    case 'group.update':
      if (typeof d.renamed_from === 'string') {
        parts.push(t('audit.detail.renamedFrom', { name: d.renamed_from }));
      }
      if (typeof d.members === 'number') {
        parts.push(t('audit.detail.members', { count: d.members }));
      }
      break;
    case 'app.create':
      if (d.type) parts.push(t('audit.detail.type', { type: label('app.type', d.type, t) }));
      parts.push(...publicationParts(d.publication, t));
      break;
    case 'app.update': {
      const names = fieldNames(d.fields, t);
      if (names) parts.push(t('audit.detail.fields', { fields: names }));
      parts.push(...publicationParts(d.publication, t));
      break;
    }
    case 'proxy.target.add':
    case 'proxy.target.remove':
      // The organization is the entry's target; what was released for it is the detail.
      if (typeof d.value === 'string') parts.push(t('audit.detail.release', { value: d.value }));
      break;
    case 'proxy.template.update': {
      const names = fieldNames(d.fields, t);
      if (names) parts.push(t('audit.detail.fields', { fields: names }));
      break;
    }
    case 'system.settings':
      parts.push(...settingChanges(d, t));
      break;
    case 'app.reorder':
      if (typeof d.count === 'number') parts.push(t('audit.detail.apps', { count: d.count }));
      break;
    case 'tenant.update':
      if (typeof d.name === 'string') parts.push(t('audit.detail.renamedTo', { name: d.name }));
      if (d.active === true) parts.push(t('audit.detail.activated'));
      if (d.active === false) parts.push(t('audit.detail.deactivated'));
      if (d.proxy_path_allowed === true) parts.push(t('audit.detail.pathAllowed'));
      if (d.proxy_path_allowed === false) parts.push(t('audit.detail.pathForbidden'));
      break;
    case 'tenant.delete':
      if (typeof d.slug === 'string') parts.push(t('audit.detail.slug', { slug: d.slug }));
      if (typeof d.deleted_users === 'number') {
        parts.push(t('audit.detail.deletedUsers', { count: d.deleted_users }));
      }
      break;
    case 'tenant.settings': {
      // Flat: each changed setting with its new value, a default that was removed as null.
      const none = t('tenantSettings.noDefault');
      const lock = (name: string, on: string, off: string) => {
        if (d[name] === true) parts.push(t(on));
        if (d[name] === false) parts.push(t(off));
      };
      if ('logo' in d) {
        parts.push(
          t(d.logo === 'removed' ? 'audit.detail.logoRemoved' : 'audit.detail.logoChanged'),
        );
      }
      if ('default_theme' in d) {
        parts.push(
          t('audit.detail.themeDefault', {
            theme: d.default_theme ? label('settings.theme', d.default_theme, t) : none,
          }),
        );
      }
      lock('theme_locked', 'audit.detail.themeLocked', 'audit.detail.themeUnlocked');
      if ('accent_color' in d) {
        parts.push(
          t('audit.detail.accentDefault', {
            color: d.accent_color ? String(d.accent_color) : none,
          }),
        );
      }
      lock('accent_locked', 'audit.detail.accentLocked', 'audit.detail.accentUnlocked');
      if ('default_nav_position' in d) {
        parts.push(
          t('audit.detail.navDefault', {
            position: d.default_nav_position
              ? label('nav.position', d.default_nav_position, t)
              : t('nav.position.systemDefault'),
          }),
        );
      }
      lock('nav_position_locked', 'audit.detail.navLocked', 'audit.detail.navUnlocked');
      if ('default_app_bar' in d) {
        parts.push(
          t('audit.detail.appBarDefault', {
            position: d.default_app_bar ? label('appBar', d.default_app_bar, t) : none,
          }),
        );
      }
      lock('app_bar_locked', 'audit.detail.appBarLocked', 'audit.detail.appBarUnlocked');
      break;
    }
  }
  return parts.join(' · ');
}
