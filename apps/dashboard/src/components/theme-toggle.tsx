'use client';

import { useEffect, useState } from 'react';

import { Tooltip } from '@/components/ui/tooltip';
import {
  applyThemeMode,
  beginThemeTransition,
  nextThemeMode,
  prefersDark,
  readStoredMode,
  resolveDark,
  type ThemeMode,
} from '@/lib/theme';

const NEXT_LABEL: Record<ThemeMode, string> = {
  light: 'theme: light · switch to dark',
  dark: 'theme: dark · switch to system',
  system: 'theme: system · switch to light',
};

export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>('system');
  const [systemDark, setSystemDark] = useState(true);
  const [mounted, setMounted] = useState(false);

  // Hydrate from storage post-mount (the inline boot script already applied
  // the right class pre-paint, so there's no flash to correct here).
  useEffect(() => {
    setMounted(true);
    setMode(readStoredMode());
    setSystemDark(prefersDark());
  }, []);

  // When following the OS, react live to prefers-color-scheme flips (e.g. the
  // user's auto day/night schedule) without a reload.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => {
      setSystemDark(e.matches);
      if (mode === 'system') {
        // Crossfade the live OS day/night flip too -- it's a full-screen
        // palette swap the user didn't click for, so the hard cut reads worse
        // here than on a deliberate toggle.
        beginThemeTransition();
        document.documentElement.classList.toggle('dark', e.matches);
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);

  function cycle() {
    const next = nextThemeMode(mode);
    setMode(next);
    applyThemeMode(next);
  }

  // Which palette is actually showing right now drives the icon for
  // light/dark; system shows a distinct monitor glyph so the mode is legible.
  const effectiveDark = mounted ? resolveDark(mode) : true;
  const label = mounted ? NEXT_LABEL[mode] : 'theme';

  return (
    <Tooltip label={label} placement="bottom">
      <button
        aria-label={`Color theme: ${mounted ? mode : 'system'}. Click to change.`}
        onClick={cycle}
        className="inline-flex h-7 w-7 items-center justify-center rounded-sm border border-border text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg"
      >
        {!mounted ? (
          <MonitorIcon />
        ) : mode === 'system' ? (
          <MonitorIcon dark={systemDark} />
        ) : effectiveDark ? (
          <SunIcon />
        ) : (
          <MoonIcon />
        )}
      </button>
    </Tooltip>
  );
}

function SunIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />
    </svg>
  );
}

/**
 * Monitor glyph for `system` mode. A small fill dot in the lower corner hints
 * at the resolved palette (filled = currently dark, hollow = currently light)
 * so the operator can tell what the OS preference is resolving to.
 */
function MonitorIcon({ dark = true }: { dark?: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="13" rx="1.5" />
      <path d="M8 21h8M12 17v4" />
      <circle cx="17" cy="8.5" r="1.25" fill={dark ? 'currentColor' : 'none'} stroke="none" />
    </svg>
  );
}
