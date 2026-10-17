// @vitest-environment jsdom
//
// The app ships a real theme preference: light (default), dark, and system.
// These specs pin the resolve-on-read invariant at all three places a persisted
// theme reaches the document: the config parser, the runtime appearance
// applier, and the pre-hydration inline script that paints before React
// mounts. They also pin the invariant that keeps a dark OS from leaking into an
// explicit light/dark choice: the `data-theme` attribute must always be present
// unless the user chose `system`, because every JS theme reader in apps/web
// (shiki, ConnectorLogo, SketchEditor, TerminalViewer, connectorBrandColor…)
// checks the attribute first and only falls back to `prefers-color-scheme`
// when it is ABSENT, and every `@media (prefers-color-scheme: dark)` CSS block
// is gated on `html:not([data-theme])` / `html:not([data-theme="light"])`.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyAppearanceToDocument } from '../../src/state/appearance';
import { DEFAULT_CONFIG, loadConfig } from '../../src/state/config';
import type { AppConfig } from '../../src/types';

const STORAGE_KEY = 'open-design:config';
const store = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    store.delete(key);
  }),
  clear: vi.fn(() => {
    store.clear();
  }),
});

function persist(config: Partial<AppConfig>): void {
  store.set(STORAGE_KEY, JSON.stringify(config));
}

/** Pretend the OS is in dark mode, the way a dark-desktop user's browser is. */
function stubSystemPrefersDark(): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('prefers-color-scheme: dark'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe('theme preference — persisted config', () => {
  beforeEach(() => {
    store.clear();
  });

  it('defaults a fresh install to the light theme', () => {
    expect(DEFAULT_CONFIG.theme).toBe('light');
    expect(loadConfig().theme).toBe('light');
  });

  it('honors a persisted dark theme instead of coercing it back to light', () => {
    persist({ theme: 'dark', accentColor: '#4F46E5' });

    const config = loadConfig();

    expect(config.theme).toBe('dark');
    // Unrelated preferences must survive the read.
    expect(config.accentColor).toBe('#4f46e5');
  });

  it('honors a persisted system theme even when the OS prefers dark', () => {
    stubSystemPrefersDark();
    persist({ theme: 'system' });

    expect(loadConfig().theme).toBe('system');
  });

  it('rewrites a theme outside the supported set back to storage as the default', () => {
    persist({ theme: 'sepia' as unknown as AppConfig['theme'] });

    const config = loadConfig();

    expect(config.theme).toBe('light');
    const written = JSON.parse(store.get(STORAGE_KEY) ?? '{}') as Partial<AppConfig>;
    expect(written.theme).toBe('light');
  });
});

describe('theme preference — document', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  it('stamps data-theme=light when no theme is given', () => {
    applyAppearanceToDocument({ accentColor: '#059669' });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('stamps data-theme=dark for the dark theme', () => {
    applyAppearanceToDocument({ accentColor: '#059669', theme: 'dark' });

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('overwrites a dark data-theme when the light theme is applied', () => {
    document.documentElement.setAttribute('data-theme', 'dark');

    applyAppearanceToDocument({ accentColor: '#059669', theme: 'light' });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  // The one allowed absence: `system` hands the decision to the OS, which the
  // `@media (prefers-color-scheme: dark) html:not([data-theme])` rule handles.
  it('removes data-theme for the system theme so the OS preference wins', () => {
    document.documentElement.setAttribute('data-theme', 'light');

    applyAppearanceToDocument({ accentColor: '#10B981', theme: 'system' });

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('never leaves the root element without a theme for explicit choices', () => {
    stubSystemPrefersDark();

    applyAppearanceToDocument({ accentColor: '#10B981', theme: 'light' });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(true);

    applyAppearanceToDocument({ accentColor: '#10B981', theme: 'dark' });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(true);
  });
});

describe('theme preference — pre-hydration script', () => {
  const layoutPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../app/layout.tsx',
  );

  function runThemeInitScript(configInStorage: string | null): void {
    const source = readFileSync(layoutPath, 'utf8');
    const match = /const themeInitScript = `([^`]*)`;/.exec(source);
    if (!match?.[1]) throw new Error('themeInitScript not found in app/layout.tsx');
    if (configInStorage === null) {
      store.delete(STORAGE_KEY);
    } else {
      store.set(STORAGE_KEY, configInStorage);
    }
    // eslint-disable-next-line no-new-func
    new Function(match[1])();
  }

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    store.clear();
  });

  it('paints dark before hydration when the stored theme is dark', () => {
    runThemeInitScript(JSON.stringify({ theme: 'dark' }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('paints light before hydration when no config is stored', () => {
    runThemeInitScript(null);

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('paints light before hydration for an invalid stored theme', () => {
    runThemeInitScript(JSON.stringify({ theme: 'sepia' }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('applies accent variables alongside the theme even when the config is broken', () => {
    runThemeInitScript('{not json');

    // A storage read that throws must still leave an explicit theme stamped…
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    // …and land the default accent.
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#353535');
  });
});
