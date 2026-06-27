'use client';

import { useEffect } from 'react';

import { motionScrollBehavior } from '@/lib/motion';

export interface ListKeyboardNavOptions {
  /** CSS selector for the focusable list items. Defaults to `[data-nav-item]`. */
  selector?: string;
  /** When false the listeners are detached (e.g. an empty list). Defaults to true. */
  enabled?: boolean;
}

/**
 * Generic Vim-style keyboard navigation over a flat list of focusable
 * elements matched by `selector`.
 *
 * - `j` / `k`  -> move focus down / up (clamped at the ends).
 * - `g g`      -> jump to the first item (double-tap within 500ms) when a row
 *                 is focused; otherwise scroll the WINDOW to the top.
 * - `G`        -> jump to the last item.
 *
 * The `g g` disambiguation completes the back-to-top affordance: the StickyBar
 * surfaces a mouse-only "back to top" control once pinned, and now the keyboard
 * has parity -- press `g g` with no row focused (you've scrolled past the list,
 * or focus is on the page chrome) and the page returns to the top, honoring
 * `prefers-reduced-motion` via {@link motionScrollBehavior}. With a row focused,
 * `g g` keeps its original "jump to first row" meaning, so the two never fight.
 *
 * Enter / Space are intentionally NOT handled here: the matched elements are
 * expected to be anchors (or buttons), which already activate natively on
 * Enter once focused. That keeps this hook a pure *focus mover* so any list
 * -- reviews, repos, audit -- can adopt it by tagging rows with the selector
 * attribute and mounting the hook once.
 *
 * Generalised from the findings-list `j/k/gg/G` handler so the same muscle
 * memory works across every dense table in the dashboard.
 */
export function useListKeyboardNav({
  selector = '[data-nav-item]',
  enabled = true,
}: ListKeyboardNavOptions = {}): void {
  useEffect(() => {
    if (!enabled) return;
    let lastG = 0;

    function items(): HTMLElement[] {
      return Array.from(document.querySelectorAll<HTMLElement>(selector));
    }
    function focusAt(i: number): void {
      const list = items();
      if (!list.length) return;
      const clamped = Math.max(0, Math.min(i, list.length - 1));
      list[clamped]?.focus();
      list[clamped]?.scrollIntoView({ block: 'nearest' });
    }
    function currentIdx(): number {
      const list = items();
      const active = document.activeElement as HTMLElement | null;
      return list.findIndex((el) => el === active || el.contains(active));
    }
    function onKey(e: KeyboardEvent): void {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j') {
        e.preventDefault();
        const idx = currentIdx();
        focusAt(idx < 0 ? 0 : idx + 1);
      } else if (e.key === 'k') {
        e.preventDefault();
        const idx = currentIdx();
        focusAt(idx < 0 ? 0 : idx - 1);
      } else if (e.key === 'g') {
        const now = Date.now();
        if (now - lastG < 500) {
          e.preventDefault();
          if (currentIdx() >= 0) {
            // A list row is focused: jump to the first row (original behavior).
            focusAt(0);
          } else {
            // No row focused -- bare-page `g g` scrolls the window to the top,
            // the keyboard twin of the StickyBar's mouse-only back-to-top.
            window.scrollTo({ top: 0, behavior: motionScrollBehavior() });
          }
          lastG = 0;
        } else {
          lastG = now;
        }
      } else if (e.key === 'G') {
        e.preventDefault();
        focusAt(items().length - 1);
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selector, enabled]);
}
