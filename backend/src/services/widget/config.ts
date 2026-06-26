/**
 * config.ts — Persisted defaults for the embeddable Help widget.
 * A single "default" row backs /widget.js and the demo page; the admin edits it
 * on the Connect screen. Values are validated against fixed whitelists so an
 * unexpected value can never reach the served loader script.
 */

import { prisma } from '../../lib/prisma.js';

export interface WidgetConfigData {
  launcher: string;
  icon: string;
  label: string;
  animation: string;
  position: string;
  color: string;
  theme: string;
}

export const WIDGET_DEFAULTS: WidgetConfigData = {
  launcher: 'fab',
  icon: 'question',
  label: 'Need some help?',
  animation: 'slide',
  position: 'right',
  color: '#2e6f6a',
  theme: 'auto',
};

const LAUNCHERS = ['fab', 'tab', 'pill'];
const ICONS = ['question', 'chat', 'book', 'bulb', 'info', 'none'];
const ANIMATIONS = ['slide', 'slide-side', 'scale', 'fade', 'none'];
const POSITIONS = ['right', 'left'];
const THEMES = ['auto', 'light', 'dark'];

function pick(v: unknown, allowed: string[], def: string): string {
  return typeof v === 'string' && allowed.includes(v) ? v : def;
}

/** Coerce arbitrary client input into a safe, fully-populated config. */
export function sanitizeWidgetConfig(input: Record<string, unknown>): WidgetConfigData {
  const rawColor = typeof input['color'] === 'string' ? input['color'].trim() : '';
  const color = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(rawColor) ? rawColor : WIDGET_DEFAULTS.color;
  const rawLabel = typeof input['label'] === 'string' ? input['label'].trim().slice(0, 60) : '';
  return {
    launcher: pick(input['launcher'], LAUNCHERS, WIDGET_DEFAULTS.launcher),
    icon: pick(input['icon'], ICONS, WIDGET_DEFAULTS.icon),
    label: rawLabel || WIDGET_DEFAULTS.label,
    animation: pick(input['animation'], ANIMATIONS, WIDGET_DEFAULTS.animation),
    position: pick(input['position'], POSITIONS, WIDGET_DEFAULTS.position),
    color,
    theme: pick(input['theme'], THEMES, WIDGET_DEFAULTS.theme),
  };
}

export async function getWidgetConfig(): Promise<WidgetConfigData> {
  const row = await prisma.widgetConfig.findUnique({ where: { name: 'default' } });
  if (!row) return { ...WIDGET_DEFAULTS };
  return {
    launcher: row.launcher,
    icon: row.icon,
    label: row.label,
    animation: row.animation,
    position: row.position,
    color: row.color,
    theme: row.theme,
  };
}

export async function saveWidgetConfig(data: WidgetConfigData): Promise<WidgetConfigData> {
  const row = await prisma.widgetConfig.upsert({
    where: { name: 'default' },
    create: { name: 'default', ...data },
    update: { ...data },
  });
  return {
    launcher: row.launcher,
    icon: row.icon,
    label: row.label,
    animation: row.animation,
    position: row.position,
    color: row.color,
    theme: row.theme,
  };
}
