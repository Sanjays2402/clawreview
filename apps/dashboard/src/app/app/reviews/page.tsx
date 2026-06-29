import Link from 'next/link';
import { GitPullRequest, X, ArrowUp, ArrowDown } from '@phosphor-icons/react/dist/ssr';

import { Card, CardBody, CardHeader, EmptyState } from '@clawreview/ui';

import { PageHeader } from '@/components/layout/page-header';
import { StatusPill } from '@/components/review/status-pill';
import { ListKeyboardNav } from '@/components/list-keyboard-nav';
import { Kbd } from '@/components/ui/kbd';
import { StickyBar } from '@/components/ui/sticky-bar';
import { EmptyStateActions } from '@/components/ui/empty-state-actions';
import { LiveRelativeTime } from '@/components/ui/live-relative-time';
import { listReviews, type ReviewListItem, type ReviewStatus } from '@/lib/data';
import { formatMs, formatUsd } from '@/lib/format';

const STATUS_TABS: Array<{ key: ReviewStatus | 'all'; label: string }> = [
  { key: 'all', label: 'all' },
  { key: 'running', label: 'running' },
  { key: 'completed', label: 'completed' },
  { key: 'failed', label: 'failed' },
  { key: 'queued', label: 'queued' },
];

// Canonical status ordering for stable display, independent of the order the
// statuses appear in the `?status=` param.
const STATUS_VALUES: ReviewStatus[] = ['running', 'completed', 'failed', 'queued'];

// Status -> dot tint, mirroring StatusPill's ladder so a multi-status chip
// reads the same here as the dots do everywhere else.
const STATUS_DOT: Record<ReviewStatus, string> = {
  running: 'bg-accent',
  completed: 'bg-emerald-400',
  failed: 'bg-severity-critical',
  queued: 'bg-severity-medium',
};

type SortKey = 'created' | 'findings' | 'duration' | 'spend';
type SortDir = 'asc' | 'desc';

interface PageProps {
  searchParams: Promise<{
    status?: string;
    owner?: string;
    repo?: string;
    sort?: string;
    dir?: string;
  }>;
}

const SORT_KEYS: SortKey[] = ['created', 'findings', 'duration', 'spend'];

function parseSort(raw: string | undefined): SortKey {
  return SORT_KEYS.includes((raw ?? 'created') as SortKey) ? (raw as SortKey) : 'created';
}
function parseDir(raw: string | undefined): SortDir {
  return raw === 'asc' ? 'asc' : 'desc';
}

/**
 * Parse the `?status=` param as a deduped, validated, canonically-ordered list
 * of review statuses. Accepts a single status (`?status=failed`) or a comma
 * list (`?status=failed,running`) so the list can scope to several at once --
 * matching the command palette's `status:failed,running` vocabulary (tick 44)
 * and letting the overview reliability card deep-link a combined
 * "needs attention" view. Unknown entries are dropped; an empty / absent param
 * yields `[]` (the implicit "all"). The result is ordered by STATUS_VALUES so
 * the tabs + chips render in a stable order regardless of the URL's order.
 */
function parseStatusList(raw: string | undefined): ReviewStatus[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const s = part.trim().toLowerCase();
    if (s) seen.add(s);
  }
  return STATUS_VALUES.filter((v) => seen.has(v));
}

function sortItems(items: ReviewListItem[], key: SortKey, dir: SortDir): ReviewListItem[] {
  const mult = dir === 'asc' ? 1 : -1;
  const copy = items.slice();
  copy.sort((a, b) => {
    let av = 0;
    let bv = 0;
    if (key === 'created') {
      av = Date.parse(a.createdAt) || 0;
      bv = Date.parse(b.createdAt) || 0;
    } else if (key === 'findings') {
      av = a.totalFindings;
      bv = b.totalFindings;
    } else if (key === 'duration') {
      av = a.durationMs ?? 0;
      bv = b.durationMs ?? 0;
    } else if (key === 'spend') {
      av = a.totalCostUsd;
      bv = b.totalCostUsd;
    }
    if (av === bv) return a.id.localeCompare(b.id);
    return (av - bv) * mult;
  });
  return copy;
}

/**
 * Spend / findings anomaly counts over a page of reviews. Shared by the page
 * body (which renders the per-row rings + header pills) and generateMetadata
 * (which folds the count into the document title) so the two never drift. Same
 * dual-gate thresholds as the per-column markers: a spike is >= 1.6x mean AND
 * above an absolute floor; an above-baseline review is >= 1.8x mean AND >= mean
 * + 3 findings. Detectors are off below 2 rows / zero mean.
 */
function anomalyCounts(items: ReviewListItem[]): { spikes: number; jumps: number; both: number } {
  const spendMean =
    items.length > 0 ? items.reduce((sum, r) => sum + r.totalCostUsd, 0) / items.length : 0;
  const spendFloor = Math.max(spendMean * 1.6, 0.05);
  const spendOn = items.length >= 2 && spendMean > 0;
  const isSpike = (r: ReviewListItem) => spendOn && r.totalCostUsd >= spendFloor;
  const spikes = items.filter(isSpike).length;
  const fMean =
    items.length > 0 ? items.reduce((sum, r) => sum + r.totalFindings, 0) / items.length : 0;
  const fRatio = fMean * 1.8;
  const fGap = fMean + 3;
  const fOn = items.length >= 2 && fMean > 0;
  const isJump = (r: ReviewListItem) => fOn && r.totalFindings >= fRatio && r.totalFindings >= fGap;
  const jumps = items.filter(isJump).length;
  // Doubly-anomalous reviews -- expensive AND finding-heavy -- are the highest
  // signal: a budget-burner that's also a quality outlier. Count the overlap so
  // the tab title can lead with it (e.g. "2 spikes, 5 above baseline, 1 both").
  const both = items.filter((r) => isSpike(r) && isJump(r)).length;
  return { spikes, jumps, both };
}

export async function generateMetadata({ searchParams }: PageProps) {
  const sp = await searchParams;
  const statuses = parseStatusList(sp.status);
  const { items } = await listReviews({
    limit: 50,
    status: statuses.length === 1 ? statuses[0] : undefined,
    owner: sp.owner?.trim() || undefined,
    repo: sp.repo?.trim() || undefined,
  });
  const scoped = statuses.length >= 2 ? items.filter((r) => statuses.includes(r.status)) : items;
  const { spikes, jumps, both } = anomalyCounts(scoped);
  const parts: string[] = [];
  if (spikes > 0) parts.push(`${spikes} cost spike${spikes === 1 ? '' : 's'}`);
  if (jumps > 0) parts.push(`${jumps} above baseline`);
  // A review can be both a spike AND above baseline -- the highest-signal case.
  // Fold its overlap count in so a doubly-anomalous page reads as such in the
  // tab; only when there's a mix (both spikes and jumps) does it add signal.
  if (both > 0 && spikes > 0 && jumps > 0) parts.push(`${both} both`);
  // Surface the anomaly count in the browser tab so a runaway page reads as
  // "needs a look" before the operator scans a single row. Quiet when nothing
  // is anomalous (just the page name). Cap at two clauses + an "and N more"
  // tail so a triple ("2 cost spikes, 5 above baseline, 1 both") stays legible
  // in a narrow pinned tab instead of truncating mid-phrase.
  if (parts.length === 0) return { title: 'reviews' };
  const shown = parts.slice(0, 2);
  const overflow = parts.length - shown.length;
  const summary = overflow > 0 ? `${shown.join(', ')} +${overflow} more` : shown.join(', ');
  return { title: `reviews · ${summary}` };
}

export default async function ReviewsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const selectedStatuses = parseStatusList(sp.status);
  const sortKey = parseSort(sp.sort);
  const sortDir = parseDir(sp.dir);
  const owner = sp.owner?.trim() || '';
  const repo = sp.repo?.trim() || '';

  // One status -> let the server filter (identical to the old single-status
  // path). Two or more -> the list endpoint only accepts a single status, so
  // fetch the page unfiltered and OR-filter client-side. The page is capped at
  // 50 either way, so this stays a bounded preview, consistent with before.
  const { items: rawItems } = await listReviews({
    limit: 50,
    status: selectedStatuses.length === 1 ? selectedStatuses[0] : undefined,
    owner: owner || undefined,
    repo: repo || undefined,
  });
  const statusScoped =
    selectedStatuses.length >= 2
      ? rawItems.filter((r) => selectedStatuses.includes(r.status))
      : rawItems;
  const items = sortItems(statusScoped, sortKey, sortDir);

  // Spend-outlier detection over the displayed page: a review whose cost is a
  // clear spike vs the page mean gets a hollow ring + tint, so a runaway
  // review pops out of a long list without reading every number. Same idiom
  // (and threshold) as the repo-detail spend sparkline -- "at least 1.6x the
  // mean AND above an absolute floor" so a uniformly-cheap account doesn't
  // light up every tiny wobble. Membership is the same regardless of sort.
  const spendMean =
    items.length > 0 ? items.reduce((sum, r) => sum + r.totalCostUsd, 0) / items.length : 0;
  const spendFloor = Math.max(spendMean * 1.6, 0.05);
  const spendOutliersOn = items.length >= 2 && spendMean > 0;
  const isSpendOutlier = (v: number) => spendOutliersOn && v >= spendFloor;

  // Findings above-baseline markers: carry the repo-detail sparkline idiom into
  // the list's findings column. A high finding count alone isn't an anomaly --
  // but a review that JUMPS well past the page's own baseline is worth a quiet
  // flag (a big PR, or a quality regression). Here \"baseline\" is the page mean
  // (the list is account-wide, not single-repo). Same dual gate as the repo
  // sparkline: a ratio (>= 1.8x mean) AND an absolute gap (>= mean + 3), so a
  // 1 -> 2 wobble never lights up. A NEUTRAL accent ring -- deliberately not
  // the orange cost-spike alarm -- keeps the \"interesting, not urgent\" framing.
  const findingsMean =
    items.length > 0 ? items.reduce((sum, r) => sum + r.totalFindings, 0) / items.length : 0;
  const findingsRatioFloor = findingsMean * 1.8;
  const findingsGapFloor = findingsMean + 3;
  const findingsOutliersOn = items.length >= 2 && findingsMean > 0;
  const isFindingsOutlier = (v: number) =>
    findingsOutliersOn && v >= findingsRatioFloor && v >= findingsGapFloor;
  const findingsJumpCount = findingsOutliersOn
    ? items.filter((r) => isFindingsOutlier(r.totalFindings)).length
    : 0;

  // Header pill counts come from the same helper the document title uses, so
  // the tab and the in-page pills can never disagree.
  const { spikes: spikeCount } = anomalyCounts(items);

  // Combined-anomaly rollup: a review that is BOTH a cost spike AND above the
  // findings baseline is the single most interesting row in the list -- an
  // expensive review that also surfaced an unusual number of findings. The two
  // outlier rings already render independently on their columns; surface a
  // header rollup so "how many rows are doubly anomalous" reads without scanning
  // for rows that happen to carry both. Only meaningful when both detectors are
  // on AND at least one row trips both.
  const isBothOutlier = (r: ReviewListItem) =>
    isSpendOutlier(r.totalCostUsd) && isFindingsOutlier(r.totalFindings);
  const bothCount =
    spendOutliersOn && findingsOutliersOn ? items.filter(isBothOutlier).length : 0;

  function hrefWith(
    next: Partial<{ status: string; owner: string; repo: string; sort: string; dir: string }>,
  ): string {
    const qs = new URLSearchParams();
    const st = next.status ?? selectedStatuses.join(',');
    const ow = next.owner ?? owner;
    const rp = next.repo ?? repo;
    const sr = next.sort ?? sortKey;
    const dr = next.dir ?? sortDir;
    if (st) qs.set('status', st);
    if (ow) qs.set('owner', ow);
    if (rp) qs.set('repo', rp);
    if (sr && sr !== 'created') qs.set('sort', sr);
    if (dr && dr !== 'desc') qs.set('dir', dr);
    // Keep commas literal in the status list for a clean, shareable URL
    // (?status=failed,running rather than the %2C-escaped form).
    const tail = qs.toString().replace(/%2C/gi, ',');
    return `/app/reviews${tail ? `?${tail}` : ''}`;
  }

  // Toggle a status into / out of the active set, preserving the others, and
  // return the href that lands on the resulting selection. Lets the tabs act as
  // a multi-select: click `failed` then `running` to see both; click an active
  // tab again to drop it.
  function statusToggleHref(tab: ReviewStatus): string {
    const set = new Set(selectedStatuses);
    if (set.has(tab)) set.delete(tab);
    else set.add(tab);
    const next = STATUS_VALUES.filter((v) => set.has(v));
    return hrefWith({ status: next.join(',') });
  }

  function sortHref(col: SortKey): string {
    if (sortKey === col) {
      // toggle direction
      return hrefWith({ sort: col, dir: sortDir === 'desc' ? 'asc' : 'desc' });
    }
    // new column: sensible default direction (desc for numerics, desc for time)
    return hrefWith({ sort: col, dir: 'desc' });
  }

  // Build the active-filters chip row. Each selected status is its own removable
  // chip (with its dot) so a multi-status scope is legible and each status can
  // be peeled off individually -- clicking `failed` removes just it, leaving
  // `running` active.
  const chips: Array<{ key: string; node: React.ReactNode; href: string }> = [];
  for (const s of selectedStatuses) {
    const set = new Set(selectedStatuses);
    set.delete(s);
    chips.push({
      key: `status-${s}`,
      href: hrefWith({ status: STATUS_VALUES.filter((v) => set.has(v)).join(',') }),
      node: (
        <span className="inline-flex items-center gap-1">
          <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[s]}`} aria-hidden />
          <span>status: {s}</span>
        </span>
      ),
    });
  }
  if (owner) chips.push({ key: 'owner', node: `owner: ${owner}`, href: hrefWith({ owner: '' }) });
  if (repo) chips.push({ key: 'repo', node: `repo: ${repo}`, href: hrefWith({ repo: '' }) });
  if (sortKey !== 'created' || sortDir !== 'desc') {
    chips.push({
      key: 'sort',
      node: `sort: ${sortKey} ${sortDir === 'desc' ? '↓' : '↑'}`,
      href: hrefWith({ sort: 'created', dir: 'desc' }),
    });
  }

  return (
    <div className="space-y-3">
      <ListKeyboardNav selector="[data-review-row]" enabled={items.length > 0} />
      <PageHeader
        title="reviews"
        description="every review across installations you can see."
        action={
          items.length > 0 ? (
            <div className="hidden items-center gap-1.5 font-mono text-[11px] text-fg-muted sm:flex">
              <Kbd>j</Kbd>
              <Kbd>k</Kbd>
              <span>nav</span>
              <Kbd>↵</Kbd>
              <span>open</span>
            </div>
          ) : undefined
        }
      />

      <StickyBar backToTop>
        <div className="flex flex-wrap items-center gap-px font-mono text-[11px]">
          {STATUS_TABS.map((t) => {
            // `all` is active only when nothing is selected; a concrete status
            // is active when it's a member of the selected set (so several tabs
            // can be lit at once). Clicking a status toggles its membership;
            // clicking `all` clears the whole set.
            const active =
              t.key === 'all'
                ? selectedStatuses.length === 0
                : selectedStatuses.includes(t.key as ReviewStatus);
            const href =
              t.key === 'all' ? hrefWith({ status: '' }) : statusToggleHref(t.key as ReviewStatus);
            return (
              <Link
                key={t.key}
                href={href as any}
                aria-pressed={active}
                className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-2.5 py-1 lowercase transition-colors ${
                  active ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg'
                }`}
              >
                {t.key !== 'all' ? (
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[t.key as ReviewStatus]} ${
                      active ? '' : 'opacity-40'
                    }`}
                    aria-hidden
                  />
                ) : null}
                {t.label}
              </Link>
            );
          })}
        </div>
      </StickyBar>

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
          <span className="uppercase tracking-wider text-fg-subtle">active</span>
          {chips.map((c) => (
            <Link
              key={c.key}
              href={c.href as any}
              className="group inline-flex items-center gap-1 rounded-sm border border-accent/40 bg-accent/10 px-1.5 py-0.5 lowercase text-fg transition-colors hover:border-accent/70 hover:bg-accent/20"
            >
              <span>{c.node}</span>
              <X size={9} weight="bold" className="text-fg-muted group-hover:text-fg" />
            </Link>
          ))}
          {selectedStatuses.length >= 2 ? (
            <Link
              href={hrefWith({ status: '' }) as any}
              className="ml-1 text-fg-subtle hover:text-fg lowercase"
              title="remove all status filters, keep owner / repo / sort"
            >
              clear statuses
            </Link>
          ) : null}
          <Link
            href={'/app/reviews' as any}
            className="ml-1 text-fg-subtle hover:text-fg lowercase"
          >
            clear all
          </Link>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle">
            {items.length} result{items.length === 1 ? '' : 's'}
          </div>
          <div className="flex items-center gap-2.5 font-mono text-[11px] text-fg-muted">
            {spikeCount > 0 ? (
              <span className="inline-flex items-center gap-1" title={`${spikeCount} review${spikeCount === 1 ? '' : 's'} with spend >= ${spendFloor.toFixed(2)} (page mean ${spendMean.toFixed(2)})`}>
                <span
                  className="inline-block h-2 w-2 rounded-full border-[1.5px] border-severity-high"
                  aria-hidden
                />
                <span className="tabular-nums">{spikeCount}</span> cost {spikeCount === 1 ? 'spike' : 'spikes'}
              </span>
            ) : null}
            {findingsJumpCount > 0 ? (
              <span className="inline-flex items-center gap-1" title={`${findingsJumpCount} review${findingsJumpCount === 1 ? '' : 's'} with findings >= ${Math.ceil(Math.max(findingsRatioFloor, findingsGapFloor))} (page mean ${findingsMean.toFixed(1)})`}>
                <span
                  className="inline-block h-2 w-2 rounded-full border-[1.5px] border-accent"
                  aria-hidden
                />
                <span className="tabular-nums">{findingsJumpCount}</span> above baseline
              </span>
            ) : null}
            {bothCount > 0 ? (
              <span
                className="inline-flex items-center gap-1 text-fg"
                title={`${bothCount} review${bothCount === 1 ? '' : 's'} that are BOTH a cost spike and above the findings baseline`}
              >
                {/* Split dot reads as the union of the two outlier accents: a
                    severity-high (cost) left half + an accent (findings) right
                    half, so the combined marker is legible against both legends. */}
                <span
                  className="inline-flex h-2 w-2 shrink-0 overflow-hidden rounded-full"
                  aria-hidden
                >
                  <span className="h-full w-1/2 bg-severity-high" />
                  <span className="h-full w-1/2 bg-accent" />
                </span>
                <span className="tabular-nums">{bothCount}</span> both
              </span>
            ) : null}
            <span>sorted by {sortKey} {sortDir === 'desc' ? 'desc' : 'asc'}</span>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {items.length === 0 ? (
            <div className="p-3">
              <EmptyState
                icon={<GitPullRequest size={20} weight="duotone" />}
                title={chips.length > 0 ? 'no matches' : 'no reviews yet'}
                description={
                  chips.length > 0
                    ? 'no reviews match the current filters.'
                    : 'install the github app on a repo, then open a pr — the first review lands in seconds.'
                }
                action={
                  chips.length > 0 ? (
                    <EmptyStateActions
                      primary={{ label: 'clear filters', href: '/app/reviews' }}
                      secondary={{ label: 'view docs', href: '/docs', external: true }}
                    />
                  ) : (
                    <EmptyStateActions
                      primary={{ label: 'configure github app', href: '/app/installations' }}
                      secondary={{ label: 'view docs', href: '/docs', external: true }}
                    />
                  )
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] font-mono text-xs">
                <thead className="sticky top-0 z-10 border-b border-border-subtle bg-bg-subtle text-left text-[10px] uppercase tracking-wider text-fg-subtle shadow-[0_1px_2px_rgba(0,0,0,0.06)]">
                  <tr>
                    <th className="px-3 py-1.5 font-medium">pull request</th>
                    <th className="font-medium">status</th>
                    <SortableTh href={sortHref('findings')} active={sortKey === 'findings'} dir={sortDir}>
                      findings
                    </SortableTh>
                    <SortableTh href={sortHref('duration')} active={sortKey === 'duration'} dir={sortDir} numeric>
                      duration
                    </SortableTh>
                    <SortableTh href={sortHref('spend')} active={sortKey === 'spend'} dir={sortDir} numeric>
                      spend
                    </SortableTh>
                    <SortableTh
                      href={sortHref('created')}
                      active={sortKey === 'created'}
                      dir={sortDir}
                      numeric
                      align="right"
                      className="px-3"
                    >
                      created
                    </SortableTh>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {items.map((r) => (
                    <tr key={r.id} className="group/row hover:bg-bg-subtle/40 focus-within:bg-accent/[0.07]">
                      <td className="relative px-3 py-1.5">
                        {/* A doubly-anomalous row (cost spike AND above findings
                            baseline) gets a thin split left rail -- the header
                            "both" marker, scaled to a row edge -- so the rare
                            combined outlier is findable in the table, not just
                            counted up top. Quiet enough not to compete with the
                            per-column rings. The rail is aria-hidden, so the PR
                            link carries an explicit title + sr-only note giving
                            the rail meaning to pointer-hover and screen readers
                            alike, without leaning on the header legend. */}
                        {isBothOutlier(r) ? (
                          <span
                            className="absolute inset-y-0 left-0 flex w-[3px] flex-col overflow-hidden"
                            aria-hidden
                          >
                            <span className="h-1/2 w-full bg-severity-high" />
                            <span className="h-1/2 w-full bg-accent" />
                          </span>
                        ) : null}
                        <Link
                          href={`/app/reviews/${r.id}` as any}
                          data-review-row
                          title={isBothOutlier(r) ? 'cost spike + above findings baseline' : undefined}
                          className="block rounded-sm outline-none ring-accent/60 focus-visible:ring-1"
                        >
                          <div className="text-fg">
                            {r.owner}/{r.repo} <span className="text-fg-subtle">#</span>{r.prNumber}
                            {isBothOutlier(r) ? (
                              <span className="sr-only"> — cost spike and above findings baseline</span>
                            ) : null}
                          </div>
                          <div className="text-[10px] text-fg-subtle">{r.headSha.slice(0, 8)}</div>
                        </Link>
                      </td>
                      <td><StatusPill status={r.status} /></td>
                      <td className="text-fg-muted">
                        {isFindingsOutlier(r.totalFindings) ? (
                          <span
                            className="inline-flex items-center gap-1"
                            title={`above baseline: findings >= ${Math.ceil(Math.max(findingsRatioFloor, findingsGapFloor))} (page mean ${findingsMean.toFixed(1)})`}
                          >
                            <span
                              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full border-[1.5px] border-accent"
                              aria-hidden
                            />
                            <span className="tabular-nums text-fg">{r.openFindings}</span>
                            <span className="tabular-nums text-fg-subtle">/ {r.totalFindings}</span>
                          </span>
                        ) : (
                          <>
                            <span className="tabular-nums text-fg">{r.openFindings}</span>
                            <span className="tabular-nums text-fg-subtle"> / {r.totalFindings}</span>
                          </>
                        )}
                      </td>
                      <td className="tabular-nums text-fg-muted">{formatMs(r.durationMs)}</td>
                      <td className="tabular-nums">
                        {isSpendOutlier(r.totalCostUsd) ? (
                          <span
                            className="inline-flex items-center gap-1 text-severity-high"
                            title={`cost spike: >= ${spendFloor.toFixed(2)} (page mean ${spendMean.toFixed(2)})`}
                          >
                            <span
                              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full border-[1.5px] border-severity-high"
                              aria-hidden
                            />
                            {formatUsd(r.totalCostUsd)}
                          </span>
                        ) : (
                          <span className="text-fg-muted">{formatUsd(r.totalCostUsd)}</span>
                        )}
                      </td>
                      <td className="px-3 text-right tabular-nums text-fg-muted">
                        <LiveRelativeTime iso={r.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function SortableTh({
  href,
  active,
  dir,
  children,
  numeric,
  align,
  className,
}: {
  href: string;
  active: boolean;
  dir: SortDir;
  children: React.ReactNode;
  numeric?: boolean;
  align?: 'left' | 'right';
  className?: string;
}) {
  const justify = align === 'right' ? 'justify-end' : 'justify-start';
  return (
    <th className={`font-medium ${numeric ? 'tabular-nums' : ''} ${className ?? ''}`}>
      <Link
        href={href as any}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        className={`group inline-flex items-center gap-0.5 ${justify} transition-colors ${
          active ? 'text-fg' : 'hover:text-fg'
        }`}
      >
        <span>{children}</span>
        <span className={`flex h-3 w-3 items-center justify-center ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'}`}>
          {dir === 'asc' && active ? (
            <ArrowUp size={9} weight="bold" />
          ) : (
            <ArrowDown size={9} weight="bold" />
          )}
        </span>
      </Link>
    </th>
  );
}
