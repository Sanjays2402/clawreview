'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  href?: string;
  action?: () => void;
  /** Grouping bucket for the sectioned list. */
  group: 'navigate' | 'reviews';
  /** Extra haystack text for fuzzy matching (repo slug, sha, etc). */
  keywords?: string;
  /** Review status, when this command jumps to a review -- drives the dot. */
  status?: string;
}

/**
 * Status -> dot color, mirroring StatusPill's tone ladder so a review's state
 * reads the same in the palette as it does in every list. A small filled dot
 * makes running / failed reviews scannable without parsing the text hint.
 */
const STATUS_DOT: Record<string, string> = {
  completed: 'bg-emerald-400',
  resolved: 'bg-emerald-400',
  failed: 'bg-severity-critical',
  running: 'bg-accent',
  queued: 'bg-severity-medium',
  dismissed: 'bg-fg-subtle',
  open: 'bg-severity-low',
};

/**
 * Canonical status order for the help-panel dot legend -- operational priority
 * (running first, dismissed last), de-duped from STATUS_DOT (completed and
 * resolved share the same emerald dot, so the legend shows `completed` once).
 */
const STATUS_LEGEND: string[] = ['running', 'queued', 'failed', 'completed', 'open', 'dismissed'];

const ROUTES: Cmd[] = [
  { id: 'overview', label: 'go: overview', hint: 'g o', href: '/app', group: 'navigate' },
  { id: 'reviews', label: 'go: reviews', hint: 'g r', href: '/app/reviews', group: 'navigate' },
  { id: 'repos', label: 'go: repos', hint: 'g p', href: '/app/repos', group: 'navigate' },
  { id: 'installations', label: 'go: installations', hint: 'g i', href: '/app/installations', group: 'navigate' },
  { id: 'trends', label: 'go: trends', hint: 'g t', href: '/app/trends', group: 'navigate' },
  { id: 'sla', label: 'go: sla', hint: 'g s', href: '/app/sla', group: 'navigate' },
  { id: 'budget', label: 'go: budget', hint: 'g b', href: '/app/budget', group: 'navigate' },
  { id: 'audit', label: 'go: audit', hint: 'g a', href: '/app/audit', group: 'navigate' },
  { id: 'config', label: 'go: config', hint: 'g c', href: '/app/config', group: 'navigate' },
  { id: 'integrations', label: 'go: integrations', href: '/app/integrations', group: 'navigate' },
  { id: 'team', label: 'go: team', href: '/app/team', group: 'navigate' },
  { id: 'keys', label: 'go: api keys', hint: 'g k', href: '/app/api-keys', group: 'navigate' },
  { id: 'settings', label: 'go: settings', href: '/app/settings', group: 'navigate' },
  { id: 'shortcuts', label: 'shortcuts (page)', href: '/shortcuts', group: 'navigate' },
  { id: 'docs', label: 'docs', href: '/docs', group: 'navigate' },
];

const GROUP_LABEL: Record<Cmd['group'], string> = {
  navigate: 'navigate',
  reviews: 'recent reviews',
};

export interface RecentReviewEntry {
  id: string;
  owner: string;
  repo: string;
  prNumber: number;
  status: string;
}

/**
 * Subsequence fuzzy match: every char of `needle` appears in order in
 * `haystack`. Cheap and good enough for a command palette over a handful of
 * routes + recent reviews. Returns a rough score (lower = tighter match) so
 * exact substring hits float above scattered subsequence hits.
 */
function fuzzyScore(needle: string, haystack: string): number | null {
  if (!needle) return 0;
  const idx = haystack.indexOf(needle);
  if (idx >= 0) return idx; // contiguous substring: best, ranked by position
  let h = 0;
  let firstAt = -1;
  for (let n = 0; n < needle.length; n++) {
    const c = needle[n]!;
    let found = -1;
    for (; h < haystack.length; h++) {
      if (haystack[h] === c) {
        found = h;
        h++;
        break;
      }
    }
    if (found < 0) return null;
    if (firstAt < 0) firstAt = found;
  }
  // Scattered match ranks below any substring hit (offset by 1000).
  return 1000 + firstAt;
}

/**
 * Pull a `status:<value>` token out of the query. The value may be a single
 * status (`status:failed`) or a comma list (`status:failed,running`) to scope
 * to several at once -- the palette ORs them, so `status:failed,running` shows
 * every review that is failed OR running. Matching is by prefix per entry, so
 * `status:fail` -> failed. The leftover text fuzzy-matches as usual -- e.g.
 * `status:failed,running api` finds failed-or-running reviews on the api repo.
 * Returns the deduped lowercased status list (or null when no token is present)
 * plus the remaining query with the token removed. The token can sit anywhere.
 */
export function parseStatusFilter(raw: string): { statusFilter: string[] | null; restQuery: string } {
  // `[a-z]+(?:,[a-z]*)*` accepts a leading status then any number of
  // comma-separated entries, tolerating a trailing comma mid-type
  // (`status:failed,` matches `failed,`, which splits to just `failed`).
  const m = raw.match(/\bstatus:([a-z]+(?:,[a-z]*)*)/i);
  if (!m || m.index === undefined) return { statusFilter: null, restQuery: raw };
  const seen = new Set<string>();
  const values = m[1]!
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !seen.has(s) && (seen.add(s), true));
  const rest = (raw.slice(0, m.index) + raw.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  return { statusFilter: values.length > 0 ? values : null, restQuery: rest };
}

/**
 * True when the query is a bare `status:` token with no value typed yet (the
 * `[a-z]+` requirement in {@link parseStatusFilter} means bare `status:` parses
 * to no filter and dead-ends in a meaningless fuzzy match). We special-case it
 * to surface a status-completion hint row instead.
 */
export function isBareStatusQuery(raw: string): boolean {
  return /^\s*status:\s*$/i.test(raw);
}

/**
 * When the query ends with a `status:` comma-list that has a TRAILING comma
 * (e.g. `status:failed,`), the operator is mid-building a multi-status filter
 * and ready to pick the next one. Return the statuses already chosen (so the
 * completion chips can exclude them) plus the `prefix` string to keep when
 * appending the next status -- everything up to and including the trailing
 * comma, e.g. `status:failed,` or `api status:failed,`. The status token must
 * sit at the END of the query, so a completed filter with trailing fuzzy text
 * (`status:failed,running api`) is NOT treated as a continuation.
 */
export function parseStatusContinuation(
  raw: string,
): { selected: string[]; prefix: string } | null {
  const m = raw.match(/^(.*?\bstatus:([a-z]+(?:,[a-z]+)*),)\s*$/i);
  if (!m) return null;
  const seen = new Set<string>();
  const selected = m[2]!
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !seen.has(s) && (seen.add(s), true));
  return { selected, prefix: m[1]! };
}

/**
 * Unified completion state for the `status:` chips: a bare `status:` offers all
 * statuses (nothing selected yet, append onto `status:`), while a trailing-comma
 * continuation offers the remaining statuses (append onto the existing list).
 * Returns null when the query is neither -- i.e. the chips should not show.
 */
export function statusCompletionState(
  raw: string,
): { prefix: string; selected: string[] } | null {
  if (isBareStatusQuery(raw)) return { prefix: 'status:', selected: [] };
  return parseStatusContinuation(raw);
}

/**
 * Distinct review statuses present in the given set, with counts, ordered by a
 * stable operational priority (running first, dismissed last) then any unknown
 * statuses alphabetically. Drives the `status:` completion hint chips.
 */
export function statusSuggestions(
  reviews: ReadonlyArray<{ status: string }>,
): Array<{ status: string; count: number }> {
  const PRIORITY = ['running', 'queued', 'failed', 'completed', 'resolved', 'open', 'dismissed'];
  const counts = new Map<string, number>();
  for (const r of reviews) {
    const s = (r.status ?? '').toLowerCase();
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.keys()]
    .sort((a, b) => {
      const ai = PRIORITY.indexOf(a);
      const bi = PRIORITY.indexOf(b);
      const ar = ai < 0 ? 999 : ai;
      const br = bi < 0 ? 999 : bi;
      return ar !== br ? ar - br : a.localeCompare(b);
    })
    .map((s) => ({ status: s, count: counts.get(s)! }));
}

export function CommandPalette({ recentReviews = [] }: { recentReviews?: RecentReviewEntry[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const router = useRouter();
  // Per-row DOM handles (keyed by flat index) so arrow-key nav can keep the
  // active row scrolled into view on a long fuzzy-filtered list.
  const rowRefs = useRef<Map<number, HTMLLIElement>>(new Map());
  // Input + chip-row handles so the `status:` completion chips are reachable by
  // keyboard: ArrowDown from the input drops into the first chip, arrows move
  // between chips, ArrowUp from the top row / Escape returns focus to the input.
  const inputRef = useRef<HTMLInputElement>(null);
  const chipRowRef = useRef<HTMLDivElement>(null);

  // Move focus into / out of the chip row. Used by both the input's ArrowDown
  // and the chip buttons' arrow handlers so the keyboard story stays one model.
  const focusChip = useCallback((dir: 1 | -1, from?: HTMLElement) => {
    const chips = Array.from(
      chipRowRef.current?.querySelectorAll<HTMLButtonElement>('[data-status-chip]') ?? [],
    );
    if (chips.length === 0) return false;
    const cur = from ? chips.indexOf(from as HTMLButtonElement) : -1;
    const next = cur < 0 ? (dir === 1 ? 0 : chips.length - 1) : cur + dir;
    if (next < 0) {
      inputRef.current?.focus();
      return true;
    }
    chips[Math.min(next, chips.length - 1)]?.focus();
    return true;
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQ('');
    setIdx(0);
    setShowHelp(false);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        close();
      }
    }
    function onClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-cmdk-trigger]')) {
        e.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClick);
    };
  }, [open, close, router]);

  // Build the full command set: static routes + a jump entry per recent review.
  const commands = useMemo<Cmd[]>(() => {
    const reviewCmds: Cmd[] = recentReviews.map((r) => ({
      id: `review-${r.id}`,
      label: `jump: ${r.owner}/${r.repo} #${r.prNumber}`,
      hint: r.status,
      href: `/app/reviews/${r.id}`,
      group: 'reviews',
      keywords: `${r.owner} ${r.repo} ${r.prNumber} #${r.prNumber} ${r.status} ${r.id}`,
      status: r.status,
    }));
    return [...ROUTES, ...reviewCmds];
  }, [recentReviews]);

  const { filtered, statusFilter } = useMemo(() => {
    // A bare `status:` (value not yet typed) is handled by the completion-hint
    // chips below, not the fuzzy list -- and `status:` as a raw needle would
    // otherwise fuzzy-match route labels that happen to contain a colon. Return
    // an empty result so the list is quiet and Enter has nothing stray to run.
    if (isBareStatusQuery(q)) return { filtered: [] as Cmd[], statusFilter: null };

    const { statusFilter: sf, restQuery } = parseStatusFilter(q);
    const needle = restQuery.trim().toLowerCase();

    // With an active status: filter, scope to review commands whose status
    // matches ANY of the requested statuses (prefix, OR-composed), then
    // fuzzy-rank the leftover text within that scope. Routes carry no status,
    // so they drop out entirely while the filter is on.
    if (sf) {
      const scoped = commands.filter(
        (c) => c.status != null && sf.some((s) => c.status!.toLowerCase().startsWith(s)),
      );
      if (!needle) return { filtered: scoped, statusFilter: sf };
      const scored: Array<{ cmd: Cmd; score: number }> = [];
      for (const cmd of scoped) {
        const hay = `${cmd.label} ${cmd.id} ${cmd.keywords ?? ''}`.toLowerCase();
        const score = fuzzyScore(needle, hay);
        if (score != null) scored.push({ cmd, score });
      }
      scored.sort((a, b) => a.score - b.score);
      return { filtered: scored.map((s) => s.cmd), statusFilter: sf };
    }

    if (!needle) return { filtered: commands, statusFilter: null };
    const scored: Array<{ cmd: Cmd; score: number }> = [];
    for (const cmd of commands) {
      const hay = `${cmd.label} ${cmd.id} ${cmd.keywords ?? ''}`.toLowerCase();
      const score = fuzzyScore(needle, hay);
      if (score != null) scored.push({ cmd, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return { filtered: scored.map((s) => s.cmd), statusFilter: null };
  }, [q, commands]);

  // The `status:` completion chips appear in two situations: a BARE `status:`
  // (nothing chosen yet -- offer every status) OR a trailing-comma continuation
  // like `status:failed,` (mid-building a multi-status filter -- offer the
  // REMAINING statuses so a click appends to the list). `completion` carries the
  // prefix to prepend and the statuses already chosen; chips exclude the latter
  // so you never pick the same status twice. Bare `status:` still empties the
  // fuzzy list (handled above); a continuation keeps showing its current scope.
  const bareStatus = isBareStatusQuery(q);
  const completion = useMemo(() => statusCompletionState(q), [q]);
  const statusOptions = useMemo(() => {
    if (!completion) return [];
    const selected = new Set(completion.selected);
    return statusSuggestions(recentReviews).filter((s) => !selected.has(s.status));
  }, [completion, recentReviews]);

  // Keep the active row visible as arrow-key / ctrl-n/p nav moves `idx`. The
  // list is a fixed-height scroll container, so `block: 'nearest'` nudges just
  // enough to reveal the row without yanking the whole palette around. Runs on
  // every idx change AND whenever the filtered set shrinks/grows under the cursor.
  useEffect(() => {
    if (!open) return;
    const el = rowRefs.current.get(idx);
    el?.scrollIntoView({ block: 'nearest' });
  }, [idx, open, filtered]);

  if (!open) return null;

  function run(cmd: Cmd) {
    close();
    if (cmd.href) router.push(cmd.href as any);
    else cmd.action?.();
  }

  // Group the (already-ordered) filtered list into sections, preserving order.
  const sections: Array<{ group: Cmd['group']; items: Array<{ cmd: Cmd; flatIndex: number }> }> = [];
  filtered.forEach((cmd, i) => {
    let sec = sections.find((s) => s.group === cmd.group);
    if (!sec) {
      sec = { group: cmd.group, items: [] };
      sections.push(sec);
    }
    sec.items.push({ cmd, flatIndex: i });
  });

  // Empty-section affordance: when a fuzzy query filters every recent-review
  // command out but the account HAS recent reviews, the "recent reviews"
  // group silently vanishes -- leaving the user unsure whether the group
  // exists or just didn't match. Surface a non-interactive placeholder so the
  // group's absence is explained ("no matching reviews") rather than mysterious.
  // Only while querying (the unfiltered list always shows the section) and only
  // when there's a non-navigate group to explain.
  //
  // The symmetric case: a query like a repo slug can match reviews but zero
  // routes, silently dropping the "navigate" group the same way. Mirror the
  // affordance so the navigate group's absence is explained too. Routes always
  // exist (ROUTES is static + non-empty), so no existence guard is needed --
  // unlike reviews, which gate on recentReviews.length.
  const querying = q.trim().length > 0;
  const reviewsMatched = sections.some((s) => s.group === 'reviews');
  const navigateMatched = sections.some((s) => s.group === 'navigate');
  const showEmptyReviews =
    querying && filtered.length > 0 && !reviewsMatched && recentReviews.length > 0;
  // When a status: filter is active, routes are intentionally excluded (they
  // carry no status), so a "no matching pages" placeholder would mislead --
  // suppress the navigate affordance for the duration of the filter.
  const showEmptyNavigate =
    querying && !statusFilter && filtered.length > 0 && !navigateMatched;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-md border border-border bg-bg shadow-2xl">
        <input
          ref={inputRef}
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
            // Typing dismisses the help overlay so it never competes with live
            // results; toggle it back with `?` on an empty query or the footer.
            if (e.target.value !== '') setShowHelp(false);
          }}
          onKeyDown={(e) => {
            const len = filtered.length;
            if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
              // When the status-completion chips are showing, ArrowDown drops
              // into the chip row (it sits between the input and the fuzzy list)
              // so they're reachable without the mouse. Otherwise step the list.
              if (completion && statusOptions.length > 0 && focusChip(1)) {
                e.preventDefault();
                return;
              }
              e.preventDefault();
              // Wrap past the last row back to the first (standard palette feel).
              setIdx((i) => (len === 0 ? 0 : (i + 1) % len));
            } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
              e.preventDefault();
              // Wrap before the first row to the last.
              setIdx((i) => (len === 0 ? 0 : (i - 1 + len) % len));
            } else if (e.key === 'Tab') {
              // Section-jump: hop the cursor to the top row of the next (or
              // previous, with Shift) section instead of stepping row-by-row.
              // Always preventDefault so Tab never escapes the modal palette.
              e.preventDefault();
              if (sections.length > 1) {
                const dir = e.shiftKey ? -1 : 1;
                const curSec = sections.findIndex((s) =>
                  s.items.some((it) => it.flatIndex === idx),
                );
                const from = curSec < 0 ? 0 : curSec;
                const target = (from + dir + sections.length) % sections.length;
                const first = sections[target]?.items[0]?.flatIndex ?? 0;
                setIdx(first);
              }
            } else if (e.key === 'Home') {
              e.preventDefault();
              setIdx(0);
            } else if (e.key === 'End') {
              e.preventDefault();
              setIdx(len === 0 ? 0 : len - 1);
            } else if (e.key === '?' && q === '') {
              // `?` on an empty query toggles the discoverability help panel
              // (g-prefix nav, status: vocabulary, the status-dot legend). Gated
              // on an empty query so a literal `?` stays typeable in a search.
              e.preventDefault();
              setShowHelp((v) => !v);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const cmd = filtered[idx];
              if (cmd) {
                run(cmd);
              } else if (statusFilter && statusFilter.length > 0) {
                // No fuzzy row selected but a status: scope is built -> commit
                // it to the reviews list deep-link the list already reads
                // (?status=failed,running). Closes the keyboard loop: build the
                // multi-status scope with chips, then Enter to jump.
                close();
                router.push(`/app/reviews?status=${statusFilter.join(',')}` as any);
              }
            }
          }}
          placeholder="jump to a page or review... (try status:failed)"
          className="w-full border-b border-border-subtle bg-bg px-3 py-2.5 font-mono text-xs text-fg outline-none placeholder:text-fg-subtle"
        />
        {/* Active status-filter pill: when a `status:<value>` token is parsed
            out of the query, show a removable chip per requested status (each
            with its matching dot) so the active scope is legible and the dots
            in the rows below have a key. Clicking the chip strips the WHOLE
            token from the query, restoring the full list. */}
        {statusFilter ? (
          <div className="flex items-center gap-2 border-b border-border-subtle/60 bg-bg-subtle/30 px-3 py-1.5 font-mono text-[10px]">
            <span className="uppercase tracking-wider text-fg-subtle">filter</span>
            <button
              type="button"
              onClick={() => {
                setQ((cur) => parseStatusFilter(cur).restQuery);
                setIdx(0);
              }}
              className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-bg px-1.5 py-0.5 text-fg-muted transition-colors hover:border-border hover:text-fg"
              title={`clear status filter (${statusFilter.join(', ')})`}
            >
              <span className="inline-flex items-center gap-1">
                <span className="text-fg-subtle">status:</span>
                {statusFilter.map((s, i) => (
                  <span key={s} className="inline-flex items-center gap-1">
                    {i > 0 ? <span className="text-fg-subtle">,</span> : null}
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[s] ?? 'bg-fg-subtle'}`}
                      aria-hidden
                    />
                    <span>{s}</span>
                  </span>
                ))}
              </span>
              <span className="text-fg-subtle" aria-hidden>
                &times;
              </span>
            </button>
            <span className="tabular-nums text-fg-subtle">
              {filtered.length} match{filtered.length === 1 ? '' : 'es'}
            </span>
            {/* Mouse parity for the Enter-to-commit (tick 48): jump straight to
                the reviews list deep-link the built status scope describes. The
                keyboard path is Enter on an empty fuzzy row; this gives pointer
                users the same single-click jump without typing/clearing first. */}
            <button
              type="button"
              onClick={() => {
                close();
                router.push(`/app/reviews?status=${statusFilter.join(',')}` as any);
              }}
              className="ml-auto inline-flex items-center gap-1 rounded-sm border border-border bg-bg px-1.5 py-0.5 text-fg-muted transition-colors hover:border-accent/60 hover:bg-accent/10 hover:text-fg"
              title={`open reviews filtered to ${statusFilter.join(', ')}`}
            >
              go to list <span aria-hidden>&rsaquo;</span>
            </button>
          </div>
        ) : null}
        {showHelp ? (
          <div className="space-y-2.5 border-b border-border-subtle bg-bg-subtle/20 px-3 py-2.5 font-mono text-[11px]">
            <div>
              <div className="mb-1 uppercase tracking-wider text-fg-subtle">navigate</div>
              <div className="mb-1.5 text-fg-muted">
                press <kbd className="rounded-sm border border-border bg-bg px-1 text-[10px] text-fg">g</kbd>{' '}
                then a page key to jump without opening this palette:
              </div>
              {/* Live g-prefix cheat-sheet: rather than describe the binding in
                  prose, list the actual `g x` chords pulled from ROUTES' hint
                  fields so the panel is a real reference. Only routes that
                  declare a hint (i.e. have a g-prefix chord) appear -- routes
                  reachable only by name stay out of the grid. */}
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-3">
                {ROUTES.filter((r) => r.hint).map((r) => {
                  // The hint is "g x"; split so each key renders as its own kbd.
                  const keys = r.hint!.split(' ');
                  // Strip the "go: " label prefix to the bare destination name.
                  const dest = r.label.replace(/^go:\s*/, '');
                  return (
                    <span key={r.id} className="inline-flex items-center gap-1.5 text-fg-muted">
                      <span className="inline-flex shrink-0 items-center gap-0.5">
                        {keys.map((k, i) => (
                          <kbd
                            key={i}
                            className="rounded-sm border border-border bg-bg px-1 text-[10px] text-fg"
                          >
                            {k}
                          </kbd>
                        ))}
                      </span>
                      <span className="truncate">{dest}</span>
                    </span>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="mb-1 uppercase tracking-wider text-fg-subtle">filter reviews</div>
              <div className="text-fg-muted">
                type{' '}
                <code className="rounded-sm bg-bg-muted px-1 text-fg">status:failed</code> to scope to
                one status, or a comma list{' '}
                <code className="rounded-sm bg-bg-muted px-1 text-fg">status:failed,running</code> for
                several. a trailing comma re-opens the chips so you can keep adding.
              </div>
            </div>
            <div>
              <div className="mb-1 uppercase tracking-wider text-fg-subtle">status dots</div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-fg-muted">
                {STATUS_LEGEND.map((s) => (
                  <span key={s} className="inline-flex items-center gap-1.5">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[s] ?? 'bg-fg-subtle'}`}
                      aria-hidden
                    />
                    <span>{s}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : null}
        <ul className="max-h-80 overflow-y-auto py-1">
          {/* `status:` completion chips. Shown for a bare `status:` (pick the
              first status) AND for a trailing-comma continuation like
              `status:failed,` (pick the NEXT status -- the chip appends onto the
              existing list via completion.prefix, and already-chosen statuses
              are filtered out of statusOptions). Clicking fills the query with
              the prefix + status + a trailing space, ready for either an
              optional fuzzy term or another comma to keep building the list. */}
          {completion && statusOptions.length > 0 ? (
            <li>
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border-subtle/50 bg-bg px-3 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                <span>
                  {completion.selected.length > 0 ? 'add another status' : 'filter by status'}
                </span>
                {completion.selected.length > 0 ? (
                  <span className="tabular-nums text-fg-subtle/70">
                    {completion.selected.length} selected
                  </span>
                ) : null}
              </div>
              <div ref={chipRowRef} className="flex flex-wrap gap-1.5 px-3 py-2">
                {statusOptions.map((s) => (
                  <button
                    key={s.status}
                    type="button"
                    data-status-chip
                    onClick={() => {
                      setQ(`${completion.prefix}${s.status} `);
                      setIdx(0);
                    }}
                    onKeyDown={(e) => {
                      // Chip-row keyboard model: Left/Right walk the chips, Up
                      // returns to the input, Down returns to the input too
                      // (so the fuzzy list resumes its normal nav). Enter/Space
                      // append the status (native button click); Escape bubbles
                      // to the global handler so it still closes the palette.
                      if (e.key === 'ArrowRight') {
                        e.preventDefault();
                        focusChip(1, e.currentTarget);
                      } else if (e.key === 'ArrowLeft') {
                        e.preventDefault();
                        focusChip(-1, e.currentTarget);
                      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        inputRef.current?.focus();
                      }
                    }}
                    className="group inline-flex items-center gap-1.5 rounded-sm border border-border bg-bg-subtle/50 px-1.5 py-0.5 font-mono text-[11px] text-fg-muted outline-none transition-colors hover:border-accent/60 hover:bg-accent/10 hover:text-fg focus-visible:border-accent focus-visible:bg-accent/10 focus-visible:text-fg"
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[s.status] ?? 'bg-fg-subtle'}`}
                      aria-hidden
                    />
                    <span>{s.status}</span>
                    <span className="tabular-nums text-fg-subtle">{s.count}</span>
                  </button>
                ))}
              </div>
            </li>
          ) : null}
          {bareStatus ? (
            // Bare `status:` with no statuses to offer (no recent reviews): the
            // chips block above renders nothing, so explain the dead-end here.
            statusOptions.length === 0 ? (
              <li className="px-3 py-2 font-mono text-xs text-fg-subtle">
                no recent reviews to filter
              </li>
            ) : null
          ) : filtered.length === 0 ? (
            <li className="px-3 py-2 font-mono text-xs text-fg-subtle">
              {statusFilter
                ? `no reviews with status: ${statusFilter.join(', ')}`
                : 'no matches'}
            </li>
          ) : (
            <>
              {/* Empty navigate-section affordance: a query that matched only
                  reviews (e.g. a repo slug) silently drops the navigate group.
                  Surface a placeholder in its usual leading position so its
                  absence is explained, mirroring the reviews placeholder below.
                  Non-interactive (no flatIndex) so arrow-key nav skips it. */}
              {showEmptyNavigate ? (
                <li>
                  <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border-subtle/50 bg-bg px-3 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                    <span>{GROUP_LABEL.navigate}</span>
                  </div>
                  <div className="px-3 py-1.5 font-mono text-xs text-fg-subtle">
                    no matching pages
                  </div>
                </li>
              ) : null}
              {sections.map((sec) => (
              <li key={sec.group}>
                {/* Sticky section header: stays pinned at the top of the scroll
                    container while its rows scroll under it, so on a long
                    fuzzy-filtered list (or after a Tab section-jump) you can
                    always see which group the active row belongs to. Opaque bg
                    so rows don't bleed through; z-10 sits above the rows. */}
                <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border-subtle/50 bg-bg px-3 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                  <span>{GROUP_LABEL[sec.group]}</span>
                  {/* Per-section match count: when a fuzzy query narrows the
                      list, this makes "2 reviews vs 8 routes" legible without
                      counting rows. Hidden when the section is a single row
                      (the count adds no information there). */}
                  {sec.items.length > 1 ? (
                    <span className="tabular-nums text-fg-subtle/70" aria-hidden>
                      {sec.items.length}
                    </span>
                  ) : null}
                </div>
                <ul>
                  {sec.items.map(({ cmd, flatIndex }) => (
                    <li
                      key={cmd.id}
                      ref={(el) => {
                        if (el) rowRefs.current.set(flatIndex, el);
                        else rowRefs.current.delete(flatIndex);
                      }}
                      onMouseEnter={() => setIdx(flatIndex)}
                      onClick={() => run(cmd)}
                      className={`flex scroll-mt-7 cursor-pointer items-center justify-between px-3 py-1.5 font-mono text-xs ${
                        flatIndex === idx ? 'bg-accent/15 text-fg' : 'text-fg-muted'
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        {cmd.status ? (
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              STATUS_DOT[cmd.status] ?? 'bg-fg-subtle'
                            }`}
                            aria-hidden
                          />
                        ) : null}
                        <span className="truncate">{cmd.label}</span>
                      </span>
                      {cmd.hint ? <span className="ml-2 shrink-0 text-fg-subtle">{cmd.hint}</span> : null}
                    </li>
                  ))}
                </ul>
              </li>
              ))}
            </>
          )}
          {/* Empty-section affordance: explain the absent "recent reviews"
              group rather than letting it vanish silently under a query that
              matched only routes. Non-interactive (no flatIndex, never the
              active row) so arrow-key nav skips it. */}
          {showEmptyReviews ? (
            <li>
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border-subtle/50 bg-bg px-3 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                <span>{GROUP_LABEL.reviews}</span>
              </div>
              <div className="px-3 py-1.5 font-mono text-xs text-fg-subtle">
                no matching reviews
              </div>
            </li>
          ) : null}
        </ul>
        <div className="flex items-center justify-between border-t border-border-subtle bg-bg-subtle/40 px-3 py-1.5 font-mono text-[10px] text-fg-subtle">
          <span>↑↓ wrap · ⇥ section · ⤒⤓ ends · ↵ select · esc close</span>
          <span className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShowHelp((v) => !v)}
              aria-pressed={showHelp}
              title="toggle help (?)"
              className={`inline-flex items-center gap-1 rounded-sm transition-colors hover:text-fg ${
                showHelp ? 'text-fg' : ''
              }`}
            >
              <kbd className="rounded-sm border border-border px-1 text-[9px]">?</kbd>
              <span>help</span>
            </button>
            <span>⌘K</span>
          </span>
        </div>
      </div>
    </div>
  );
}
