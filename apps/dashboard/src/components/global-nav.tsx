'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Two-key "go to" navigation, Linear / Vim style: press `g` then a section
 * letter to jump straight there. The command palette already advertises
 * `g o` / `g r` as hints -- this is the listener that makes every one of
 * them real.
 *
 *   g o -> overview      g i -> installations   g b -> budget
 *   g r -> reviews       g t -> trends          g a -> audit
 *   g p -> repos         g s -> sla             g c -> config
 *                                               g k -> api keys
 *
 * Design notes:
 *  - The bare `g` is NEVER preventDefault-ed, so the list keyboard hook's
 *    `g g` (jump-to-first) still works: the second `g` simply cancels the
 *    pending nav sequence and the list hook handles the jump independently.
 *  - Any non-target key (or `g` again, or a 900ms timeout) cancels the
 *    sequence, so a stray `g` can't silently arm a later navigation.
 *  - Typing in an input / textarea / select / contentEditable is ignored,
 *    and modifier-chord keys (cmd-k etc.) pass straight through.
 *  - While the sequence is armed a tiny "g …" corner toast gives the
 *    two-key nav feedback (Linear shows the pending prefix), so a user who
 *    pressed `g` knows the dashboard is waiting for the second key. It
 *    auto-dismisses on the second key or the 900ms timeout.
 */
const NAV_MAP: Record<string, string> = {
  o: '/app',
  r: '/app/reviews',
  p: '/app/repos',
  i: '/app/installations',
  t: '/app/trends',
  s: '/app/sla',
  b: '/app/budget',
  a: '/app/audit',
  c: '/app/config',
  k: '/app/api-keys',
};

const SEQUENCE_WINDOW_MS = 900;

export function GlobalNav() {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let pendingAt = 0;

    function isModifierKey(key: string): boolean {
      return key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta';
    }

    function disarm() {
      pendingAt = 0;
      if (dismissTimer.current) {
        clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
      setArmed(false);
    }

    function arm() {
      pendingAt = Date.now();
      setArmed(true);
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      // Mirror the keydown-side window so the toast clears itself even if the
      // user walks away without pressing a second key.
      dismissTimer.current = setTimeout(() => {
        pendingAt = 0;
        setArmed(false);
      }, SEQUENCE_WINDOW_MS);
    }

    function onKey(e: KeyboardEvent) {
      // Don't hijack typing or modifier chords (cmd-k, ctrl-n, etc.).
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Lone modifier keydowns (the Shift before a capital, say) must not
      // cancel an in-flight `g` sequence.
      if (isModifierKey(e.key)) return;

      const isArmed = pendingAt > 0 && Date.now() - pendingAt <= SEQUENCE_WINDOW_MS;

      if (isArmed) {
        const dest = NAV_MAP[e.key];
        disarm(); // a second key always ends the sequence
        if (dest) {
          e.preventDefault();
          router.push(dest as never);
        }
        return;
      }

      // Not armed yet: a lowercase `g` opens the window. Everything else is
      // a no-op here (and leaves any other handlers untouched).
      if (e.key === 'g') {
        arm();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    };
  }, [router]);

  if (!armed) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed bottom-4 left-4 z-40 flex items-center gap-1.5 rounded-md border border-border bg-bg/90 px-2 py-1 font-mono text-[11px] text-fg-muted shadow-lg backdrop-blur animate-fade-in"
    >
      <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-accent/40 bg-accent/15 px-1 text-[10px] font-medium text-fg">
        g
      </kbd>
      <span className="text-fg-subtle">then o · r · p · t · s · …</span>
    </div>
  );
}
