'use client';

import { useCallback, useEffect, useState } from 'react';

import { Kbd } from '@/components/ui/kbd';

interface ShortcutItem {
  keys: string[];
  label: string;
}
interface ShortcutGroup {
  name: string;
  items: ShortcutItem[];
}

const GROUPS: ShortcutGroup[] = [
  {
    name: 'global',
    items: [
      { keys: ['⌘', 'K'], label: 'open command palette' },
      { keys: ['?'], label: 'open this overlay' },
      { keys: ['esc'], label: 'close overlay' },
    ],
  },
  {
    name: 'findings list',
    items: [
      { keys: ['j'], label: 'next finding' },
      { keys: ['k'], label: 'previous finding' },
      { keys: ['g', 'g'], label: 'jump to first' },
      { keys: ['G'], label: 'jump to last' },
      { keys: ['e'], label: 'expand / collapse focused' },
      { keys: ['x'], label: 'dismiss focused' },
      { keys: ['r'], label: 'reopen focused' },
    ],
  },
  {
    name: 'palette',
    items: [
      { keys: ['↑', '↓'], label: 'navigate results' },
      { keys: ['↵'], label: 'run command' },
      { keys: ['ctrl', 'n / p'], label: 'navigate results' },
    ],
  },
];

/**
 * Floating shortcuts overlay. Press `?` from any /app/* page to open.
 *
 * Replaces the previous behavior of routing to /shortcuts -- now you stay
 * on the page you're working on (Raycast / Linear "cheatsheet" pattern).
 * Triggered via window keydown listener that ignores typing in inputs.
 *
 * Coexists with the existing static /shortcuts page (which is still
 * useful for deep-linking from the docs site).
 */
export function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const inField =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        (target?.isContentEditable ?? false);
      if (e.key === '?' && !inField) {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[10vh] animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-labelledby="shortcuts-overlay-title"
        aria-modal="true"
        className="w-full max-w-2xl overflow-hidden rounded-md border border-border bg-bg shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
          <h2
            id="shortcuts-overlay-title"
            className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle"
          >
            keyboard shortcuts
          </h2>
          <div className="flex items-center gap-2 font-mono text-[10px] text-fg-subtle">
            <span>press</span>
            <Kbd>esc</Kbd>
            <span>to close</span>
          </div>
        </div>
        <div className="grid max-h-[70vh] gap-x-6 gap-y-4 overflow-y-auto p-4 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.name}>
              <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                {g.name}
              </h3>
              <ul className="space-y-0.5">
                {g.items.map((it) => (
                  <li
                    key={it.label}
                    className="flex items-center justify-between gap-3 rounded-sm px-1.5 py-1 text-xs hover:bg-bg-subtle/50"
                  >
                    <span className="text-fg">{it.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {it.keys.map((k, i) => (
                        <Kbd key={i}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
