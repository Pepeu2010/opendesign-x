import { getOpenDesignHost } from '@open-design/host';
import type { AppTheme } from '../types';

const ACCENT_VARS = [
  '--accent',
  '--accent-strong',
  '--accent-soft',
  '--accent-tint',
  '--accent-hover',
] as const;

export const DEFAULT_ACCENT_COLOR = '#353535';
export const ACCENT_SWATCHES = [
  DEFAULT_ACCENT_COLOR,
  '#202020',
  '#848484',
  '#87ea5c',
  '#0d5400',
  '#1A74FF',
  '#FFBA12',
  '#FF7528',
  '#F04142',
] as const;

export function normalizeAccentColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function resolveAccentColor(value: unknown): string {
  return normalizeAccentColor(value) ?? DEFAULT_ACCENT_COLOR;
}

function accentVars(accentColor: string): Record<(typeof ACCENT_VARS)[number], string> {
  return {
    '--accent': accentColor,
    // Keep these mix ratios in sync with the pre-hydration script in app/layout.tsx.
    '--accent-strong': `color-mix(in srgb, ${accentColor} 82%, var(--text-strong))`,
    '--accent-soft': `color-mix(in srgb, ${accentColor} 12%, var(--bg-subtle))`,
    '--accent-tint': `color-mix(in srgb, ${accentColor} 6%, var(--bg-panel))`,
    '--accent-hover': `color-mix(in srgb, ${accentColor} 86%, var(--text-strong))`,
  };
}

/**
 * The appearance OpenDesign ships by default.
 *
 * The app supports `light`, `dark`, and `system`. `light` stays the default so
 * an existing install keeps the appearance it already had; users opt into dark
 * through Settings → Appearance.
 *
 * `data-theme` must always be PRESENT, not merely non-dark, whenever the
 * resolved theme is explicit. Omitting it hands the decision to the OS in
 * several places that read the attribute directly and fall back to
 * `prefers-color-scheme` when it is missing (`shiki`, `ConnectorLogo`,
 * `SketchEditor`, `TerminalViewer`, `connectorBrandColor`, `MentionNode`).
 * Only `system` deliberately omits it, so the CSS `html:not([data-theme])`
 * rule can follow the OS.
 */
export const DEFAULT_APP_THEME = 'light' as const;

/** The theme actually written to `data-theme`, or null for `system`. */
export function resolveThemeAttribute(theme: AppTheme | null | undefined): 'light' | 'dark' | null {
  if (theme === 'dark') return 'dark';
  if (theme === 'system') return null;
  return 'light';
}

/**
 * Coerce any persisted theme to a supported one.
 *
 * An install that never touched the setting, or that carries a value written
 * by an older build, lands on the default rather than on undefined.
 */
export function resolveAppTheme(persisted?: AppTheme | null): AppTheme {
  return persisted === 'light' || persisted === 'dark' || persisted === 'system'
    ? persisted
    : DEFAULT_APP_THEME;
}

export function applyAppearanceToDocument({
  accentColor,
  theme,
}: {
  accentColor?: string;
  theme?: AppTheme | null;
}): void {
  const root = document.documentElement;
  const attribute = resolveThemeAttribute(theme);
  if (attribute === null) {
    // `system`: let the OS preference win, which the CSS media query handles.
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', attribute);
  }
  // Desktop shell: keep the native window appearance (the macOS vibrancy
  // glass material) in step with the app theme. Without this the glass
  // follows the OS appearance, so the light app over a dark OS sat on dark
  // glass and read as a muddy gray (#94). Feature-detected — browsers and
  // older host builds have no appearance capability. `system` reports
  // 'system' so the shell follows the OS itself rather than the app forcing
  // one appearance onto the native window.
  getOpenDesignHost()?.appearance?.setTheme(theme === 'system' ? 'system' : (attribute ?? 'light'));

  const normalized = resolveAccentColor(accentColor);
  const vars = accentVars(normalized);
  for (const name of ACCENT_VARS) {
    root.style.setProperty(name, vars[name]);
  }
}
