import { DOCUMENT, Injectable, effect, inject, signal } from '@angular/core';

export type ThemeMode    = 'light' | 'dark' | 'system';
export type ThemePalette = 'cyan' | 'violet' | 'rose' | 'magenta' | 'azure' | 'spring';

export interface PaletteOption {
  key:           ThemePalette;
  label:         string;
  primaryColor:  string;
  tertiaryColor: string;
}

const MODE_KEY    = 'ha-theme';
const PALETTE_KEY = 'ha-palette';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly doc = inject(DOCUMENT);

  readonly mode    = signal<ThemeMode>(this.loadSavedMode());
  readonly palette = signal<ThemePalette>(this.loadSavedPalette());

  readonly icon = {
    light:  'light_mode',
    dark:   'dark_mode',
    system: 'brightness_auto',
  } as const;

  readonly label = {
    light:  'Light mode',
    dark:   'Dark mode',
    system: 'System mode',
  } as const;

  readonly paletteOptions: readonly PaletteOption[] = [
    { key: 'cyan',    label: 'Cyan & Orange',      primaryColor: '#006a6a', tertiaryColor: '#964900' },
    { key: 'violet',  label: 'Violet & Yellow',    primaryColor: '#7d00fa', tertiaryColor: '#626200' },
    { key: 'rose',    label: 'Rose & Azure',        primaryColor: '#ba005c', tertiaryColor: '#005cbb' },
    { key: 'magenta', label: 'Magenta & Spring',    primaryColor: '#a900a9', tertiaryColor: '#006d33' },
    { key: 'azure',   label: 'Azure & Orange',      primaryColor: '#005cbb', tertiaryColor: '#964900' },
    { key: 'spring',  label: 'Spring & Magenta',    primaryColor: '#006d33', tertiaryColor: '#a900a9' },
  ];

  constructor() {
    effect(() => {
      const m    = this.mode();
      const html = this.doc.documentElement;
      html.classList.remove('light', 'dark');
      if (m !== 'system') html.classList.add(m);
      try { localStorage.setItem(MODE_KEY, m); } catch { /* SSR / private browsing */ }
    });

    effect(() => {
      const p    = this.palette();
      const html = this.doc.documentElement;
      if (p === 'cyan') {
        html.removeAttribute('data-palette');
      } else {
        html.setAttribute('data-palette', p);
      }
      try { localStorage.setItem(PALETTE_KEY, p); } catch { /* noop */ }
    });
  }

  cycle(): void {
    const next: Record<ThemeMode, ThemeMode> = {
      system: 'light',
      light:  'dark',
      dark:   'system',
    };
    this.mode.set(next[this.mode()]);
  }

  setPalette(p: ThemePalette): void { this.palette.set(p); }

  private loadSavedMode(): ThemeMode {
    try {
      const v = localStorage.getItem(MODE_KEY);
      if (v === 'light' || v === 'dark' || v === 'system') return v;
    } catch { /* noop */ }
    // Default to light across all apps when the user has no saved preference.
    return 'light';
  }

  private loadSavedPalette(): ThemePalette {
    try {
      const v     = localStorage.getItem(PALETTE_KEY);
      const valid: ThemePalette[] = ['cyan', 'violet', 'rose', 'magenta', 'azure', 'spring'];
      if (v && valid.includes(v as ThemePalette)) return v as ThemePalette;
    } catch { /* noop */ }
    return 'cyan';
  }
}
