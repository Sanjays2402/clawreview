/**
 * Theme model shared by the boot script (in the root layout) and the
 * client-side toggle. Three user-selectable modes:
 *
 *   - `light`  -> force the light palette
 *   - `dark`   -> force the dark palette
 *   - `system` -> follow the OS `prefers-color-scheme` (Linear / Raycast default)
 *
 * Persisted under the same `clawreview-theme` key the dashboard has always
 * used. Legacy stores only ever wrote `light` | `dark`, so existing users
 * keep their explicit choice; a missing key now resolves to `system`.
 */

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'clawreview-theme';

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'] as const;

/** Cycle order on the toggle button: light -> dark -> system -> light. */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === 'light') return 'dark';
  if (mode === 'dark') return 'system';
  return 'light';
}

export function isThemeMode(v: unknown): v is ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system';
}

/** Read the stored mode, treating anything unrecognized/absent as `system`. */
export function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Resolve a mode to the concrete palette that should be on the document. */
export function resolveDark(mode: ThemeMode): boolean {
  if (mode === 'light') return false;
  if (mode === 'dark') return true;
  return prefersDark();
}

/** Apply a mode to <html> and persist it. Safe to call only on the client. */
export function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', resolveDark(mode));
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* storage may be unavailable (private mode / quota); the class still applied */
  }
}
