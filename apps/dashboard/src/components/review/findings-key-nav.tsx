'use client';

import { useEffect } from 'react';

// Global j/k navigation over [data-finding-row] elements.
// Also handles `gg` to focus first row.
export function FindingsKeyNav() {
  useEffect(() => {
    let lastG = 0;
    function rows(): HTMLElement[] {
      return Array.from(document.querySelectorAll<HTMLElement>('[data-finding-row]'));
    }
    function focusAt(i: number) {
      const items = rows();
      if (!items.length) return;
      const clamped = Math.max(0, Math.min(i, items.length - 1));
      items[clamped]?.focus();
      items[clamped]?.scrollIntoView({ block: 'nearest' });
    }
    function currentIdx() {
      const items = rows();
      const active = document.activeElement as HTMLElement | null;
      return items.findIndex((el) => el === active);
    }
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
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
          focusAt(0);
          lastG = 0;
        } else {
          lastG = now;
        }
      } else if (e.key === 'G') {
        e.preventDefault();
        focusAt(rows().length - 1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return null;
}
