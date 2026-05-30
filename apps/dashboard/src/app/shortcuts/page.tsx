import { Kbd } from '@/components/ui/kbd';

const GROUPS: Array<{ name: string; items: Array<{ keys: string[]; label: string }> }> = [
  {
    name: 'global',
    items: [
      { keys: ['⌘', 'K'], label: 'open command palette' },
      { keys: ['?'], label: 'open shortcuts' },
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
      { keys: ['e'], label: 'expand / collapse focused row' },
      { keys: ['x'], label: 'dismiss focused finding' },
      { keys: ['r'], label: 'reopen focused finding' },
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

export default function ShortcutsPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="font-mono text-base font-semibold lowercase">shortcuts</h1>
      <p className="mt-1 text-xs text-fg-muted">keyboard-first. mouse optional.</p>
      <div className="mt-6 space-y-6">
        {GROUPS.map((g) => (
          <section key={g.name}>
            <h2 className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">{g.name}</h2>
            <ul className="mt-2 divide-y divide-border-subtle rounded-md border border-border">
              {g.items.map((it) => (
                <li key={it.label} className="flex items-center justify-between px-3 py-1.5 text-xs">
                  <span className="text-fg">{it.label}</span>
                  <span className="flex items-center gap-1">
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
    </main>
  );
}
