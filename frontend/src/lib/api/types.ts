// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Short names for the generated schema types (schema.d.ts, `npm run gen:api`).
import type { components } from './schema';

type S = components['schemas'];

export type Role = S['Role'];
export type AppType = S['AppType'];
export type NavPosition = S['NavPosition'];
export type ThemePreference = S['Theme'];
export type AppBar = S['AppBar'];
export type EmbedStatus = S['EmbedStatus'];
export type Language = 'de' | 'en';

export type Me = S['MeOut'];
export type MeUser = S['MeUser'];
export type TenantRef = S['TenantRef'];
export type Membership = S['MembershipOut'];
export type EffectiveSettings = S['EffectiveSettings'];
export type OwnSettings = S['OwnSettings'];
export type SettingsUpdate = S['SettingsUpdate'];
export type PublicInfo = S['PublicInfo'];

export type WorkspaceApp = S['WorkspaceApp'];
export type LaunchOut = S['LaunchOut'];

export type User = S['UserOut'];
export type UserPage = S['UserPage'];
export type UserCreate = S['UserCreate'];
export type UserCreated = S['UserCreated'];
export type UserUpdate = S['UserUpdate'];
export type GroupRef = S['GroupRef'];

export type Group = S['GroupOut'];
export type GroupDetail = S['GroupDetail'];
export type GroupCreate = S['GroupCreate'];
export type GroupUpdate = S['GroupUpdate'];

export type AdminApp = S['AppOut'];
export type AppCreate = S['AppCreate'];
export type AppUpdate = S['AppUpdate'];
export type IconIn = S['IconIn'];
export type EmbedCheck = S['EmbedCheckOut'];

export type ProxyInfo = S['ProxyInfo'];
export type ProxyTemplate = S['ProxyTemplateOut'];
export type ProxyTarget = S['ProxyTargetOut'];
export type Publication = S['PublicationOut'];

export type Certificate = S['CertificateOut'];
export type CertificateHost = S['CertificateHost'];
export type ServedCertificate = S['ServedCertificate'];
export type CertificatesOverview = S['CertificatesOut'];
export type CertificateUpload = S['CertificateIn'];
export type CertificateReplacement = S['CertificateReplace'];

export type TenantSettings = S['TenantSettingsOut'];
export type TenantSettingsUpdate = S['TenantSettingsUpdate'];
export type AuditEntry = S['AuditEntry'];
export type AuditPage = S['AuditPage'];

export type Tenant = S['TenantOut'];
export type SystemUser = S['SystemUserOut'];
export type SystemUserPage = S['SystemUserPage'];
export type SystemSettings = S['SystemSettingsOut'];
export type SystemSettingsUpdate = S['SystemSettingsUpdate'];
export type SmtpSettings = S['SmtpSettings'];

export type Permission =
  | 'workspace:use'
  | 'users:read'
  | 'users:write'
  | 'groups:read'
  | 'groups:write'
  | 'roles:assign'
  | 'apps:manage'
  | 'tenant:settings'
  | 'audit:read'
  | 'system:admin';

export const ROLES: readonly Role[] = ['member', 'user_manager', 'tenant_admin'];
export const NAV_POSITIONS: readonly NavPosition[] = ['left', 'right', 'top', 'bottom'];
export const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];
export const LANGUAGES: readonly Language[] = ['de', 'en'];
export const FRAME_PERMISSIONS = [
  'camera',
  'microphone',
  'clipboard-read',
  'clipboard-write',
  'fullscreen',
  'display-capture',
] as const;
export type FramePermission = (typeof FRAME_PERMISSIONS)[number];
