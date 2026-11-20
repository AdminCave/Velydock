// SPDX-FileCopyrightText: 2026 Kevin Stenzel
//
// SPDX-License-Identifier: GPL-3.0-or-later

import type { Component } from 'svelte';
import Activity from '@lucide/svelte/icons/activity';
import AppWindow from '@lucide/svelte/icons/app-window';
import BookOpen from '@lucide/svelte/icons/book-open';
import Briefcase from '@lucide/svelte/icons/briefcase';
import Calendar from '@lucide/svelte/icons/calendar';
import Camera from '@lucide/svelte/icons/camera';
import ChartColumn from '@lucide/svelte/icons/chart-column';
import ClipboardList from '@lucide/svelte/icons/clipboard-list';
import Cloud from '@lucide/svelte/icons/cloud';
import Code from '@lucide/svelte/icons/code';
import CreditCard from '@lucide/svelte/icons/credit-card';
import Database from '@lucide/svelte/icons/database';
import FileText from '@lucide/svelte/icons/file-text';
import FlaskConical from '@lucide/svelte/icons/flask-conical';
import Folder from '@lucide/svelte/icons/folder';
import Globe from '@lucide/svelte/icons/globe';
import GraduationCap from '@lucide/svelte/icons/graduation-cap';
import Headphones from '@lucide/svelte/icons/headphones';
import HeartPulse from '@lucide/svelte/icons/heart-pulse';
import House from '@lucide/svelte/icons/house';
import Image from '@lucide/svelte/icons/image';
import Inbox from '@lucide/svelte/icons/inbox';
import KeyRound from '@lucide/svelte/icons/key-round';
import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
import LifeBuoy from '@lucide/svelte/icons/life-buoy';
import Mail from '@lucide/svelte/icons/mail';
import Map from '@lucide/svelte/icons/map';
import MessageCircle from '@lucide/svelte/icons/message-circle';
import Monitor from '@lucide/svelte/icons/monitor';
import NotebookPen from '@lucide/svelte/icons/notebook-pen';
import Package from '@lucide/svelte/icons/package';
import Phone from '@lucide/svelte/icons/phone';
import PowerOff from '@lucide/svelte/icons/power-off';
import Printer from '@lucide/svelte/icons/printer';
import Rocket from '@lucide/svelte/icons/rocket';
import Server from '@lucide/svelte/icons/server';
import Settings from '@lucide/svelte/icons/settings';
import ShieldCheck from '@lucide/svelte/icons/shield-check';
import ShoppingCart from '@lucide/svelte/icons/shopping-cart';
import SquareTerminal from '@lucide/svelte/icons/square-terminal';
import Ticket from '@lucide/svelte/icons/ticket';
import Truck from '@lucide/svelte/icons/truck';
import Users from '@lucide/svelte/icons/users';
import Video from '@lucide/svelte/icons/video';
import Wallet from '@lucide/svelte/icons/wallet';
import Wrench from '@lucide/svelte/icons/wrench';

export type IconComponent = Component<{ size?: number }>;

// The icons an administrator can pick for an app. The key is the kebab-case Lucide name
// and is what the API stores in `icon.name`. Icons are imported one by one so the bundle
// only contains this curated set, not all of Lucide.
export const APP_ICONS: Readonly<Record<string, IconComponent>> = {
  'app-window': AppWindow,
  globe: Globe,
  house: House,
  'layout-dashboard': LayoutDashboard,
  'book-open': BookOpen,
  'file-text': FileText,
  folder: Folder,
  cloud: Cloud,
  mail: Mail,
  inbox: Inbox,
  'message-circle': MessageCircle,
  phone: Phone,
  video: Video,
  calendar: Calendar,
  'clipboard-list': ClipboardList,
  'notebook-pen': NotebookPen,
  ticket: Ticket,
  'life-buoy': LifeBuoy,
  users: Users,
  briefcase: Briefcase,
  'graduation-cap': GraduationCap,
  'chart-column': ChartColumn,
  activity: Activity,
  'heart-pulse': HeartPulse,
  wallet: Wallet,
  'credit-card': CreditCard,
  'shopping-cart': ShoppingCart,
  package: Package,
  truck: Truck,
  map: Map,
  printer: Printer,
  camera: Camera,
  image: Image,
  headphones: Headphones,
  monitor: Monitor,
  server: Server,
  database: Database,
  code: Code,
  'square-terminal': SquareTerminal,
  'flask-conical': FlaskConical,
  wrench: Wrench,
  settings: Settings,
  'key-round': KeyRound,
  'shield-check': ShieldCheck,
  rocket: Rocket,
  'power-off': PowerOff,
};

export const APP_ICON_NAMES: readonly string[] = Object.keys(APP_ICONS);
export const DEFAULT_APP_ICON = 'app-window';

/** The component for a stored icon name; unknown or missing names get the default icon. */
export function appIcon(name: string | null | undefined): IconComponent {
  return (name && APP_ICONS[name]) || APP_ICONS[DEFAULT_APP_ICON];
}
