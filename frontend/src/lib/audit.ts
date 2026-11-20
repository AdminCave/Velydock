// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { AuditEntry } from '$lib/api/types';
import { hasMessage, type Translate } from '$lib/i18n';

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
      break;
    case 'app.update':
    case 'system.settings': {
      const names = fieldNames(d.fields, t);
      if (names) parts.push(t('audit.detail.fields', { fields: names }));
      break;
    }
    case 'app.reorder':
      if (typeof d.count === 'number') parts.push(t('audit.detail.apps', { count: d.count }));
      break;
    case 'tenant.update':
      if (typeof d.name === 'string') parts.push(t('audit.detail.renamedTo', { name: d.name }));
      if (d.active === true) parts.push(t('audit.detail.activated'));
      if (d.active === false) parts.push(t('audit.detail.deactivated'));
      break;
    case 'tenant.delete':
      if (typeof d.slug === 'string') parts.push(t('audit.detail.slug', { slug: d.slug }));
      if (typeof d.deleted_users === 'number') {
        parts.push(t('audit.detail.deletedUsers', { count: d.deleted_users }));
      }
      break;
    case 'tenant.settings':
      if ('default_nav_position' in d) {
        parts.push(
          t('audit.detail.navDefault', {
            position: d.default_nav_position
              ? label('nav.position', d.default_nav_position, t)
              : t('nav.position.systemDefault'),
          }),
        );
      }
      if (d.nav_position_locked === true) parts.push(t('audit.detail.navLocked'));
      if (d.nav_position_locked === false) parts.push(t('audit.detail.navUnlocked'));
      break;
  }
  return parts.join(' · ');
}
