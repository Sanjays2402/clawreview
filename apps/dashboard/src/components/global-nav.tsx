'use client';

import { useEffect } from 'react';
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

  useEffect(() => {
    let pendingAt = 0;

    function isModifierKey(key: string): boolean {
      return key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta';
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

      const armed = pendingAt > 0 && Date.now() - pendingAt <= SEQUENCE_WINDOW_MS;

      if (armed) {
        const dest = NAV_MAP[e.key];
        pendingAt = 0; // a second key always ends the sequence
        if (dest) {
          e.preventDefault();
          router.push(dest as never);
        }
        return;
      }

      // Not armed yet: a lowercase `g` opens the window. Everything else is
      // a no-op here (and leaves any other handlers untouched).
      if (e.key === 'g') {
        pendingAt = Date.now();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  return null;
}
