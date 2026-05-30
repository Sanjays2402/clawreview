/**
 * Per-repository health tracker with circuit-breaker style auto-pause.
 *
 * Why: a single broken repo (bad config, exhausted LLM budget, malformed
 * fixtures) can otherwise drag the whole review queue and burn money on
 * the same failing job over and over. Tracking failures per repo lets the
 * webhook short-circuit enqueues for repos that are misbehaving, with a
 * cooldown that auto-resumes them.
 */
export interface RepoHealthState {
  repo: string; // 'owner/name'
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureAt?: string;
  lastSuccessAt?: string;
  pausedUntil?: string;
  pausedReason?: string;
  manuallyPaused: boolean;
}

export interface RepoHealthOptions {
  /** Consecutive failure threshold that trips an automatic pause. Default 5. */
  failureThreshold?: number;
  /** Cooldown duration in ms applied on auto-pause. Default 30 min. */
  cooldownMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

export class RepoHealthTracker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private state = new Map<string, RepoHealthState>();

  constructor(opts: RepoHealthOptions = {}) {
    this.threshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  private key(owner: string, repo: string): string {
    return `${owner}/${repo}`;
  }

  private getOrCreate(owner: string, repo: string): RepoHealthState {
    const k = this.key(owner, repo);
    let s = this.state.get(k);
    if (!s) {
      s = {
        repo: k,
        consecutiveFailures: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        manuallyPaused: false,
      };
      this.state.set(k, s);
    }
    return s;
  }

  recordSuccess(owner: string, repo: string): void {
    const s = this.getOrCreate(owner, repo);
    s.consecutiveFailures = 0;
    s.totalSuccesses += 1;
    s.lastSuccessAt = new Date(this.now()).toISOString();
    // A success clears auto-pause (manual pause stays sticky).
    if (s.pausedUntil && !s.manuallyPaused) {
      s.pausedUntil = undefined;
      s.pausedReason = undefined;
    }
  }

  recordFailure(owner: string, repo: string, reason?: string): void {
    const s = this.getOrCreate(owner, repo);
    s.consecutiveFailures += 1;
    s.totalFailures += 1;
    s.lastFailureAt = new Date(this.now()).toISOString();
    if (s.consecutiveFailures >= this.threshold && !s.pausedUntil) {
      s.pausedUntil = new Date(this.now() + this.cooldownMs).toISOString();
      s.pausedReason = reason
        ? `auto-pause after ${s.consecutiveFailures} failures: ${reason}`
        : `auto-pause after ${s.consecutiveFailures} failures`;
    }
  }

  pause(owner: string, repo: string, reason?: string, durationMs?: number): RepoHealthState {
    const s = this.getOrCreate(owner, repo);
    s.manuallyPaused = true;
    s.pausedUntil = durationMs
      ? new Date(this.now() + durationMs).toISOString()
      : new Date(this.now() + 365 * 86400_000).toISOString();
    s.pausedReason = reason ?? 'manually paused';
    return s;
  }

  resume(owner: string, repo: string): RepoHealthState | null {
    const s = this.state.get(this.key(owner, repo));
    if (!s) return null;
    s.manuallyPaused = false;
    s.pausedUntil = undefined;
    s.pausedReason = undefined;
    s.consecutiveFailures = 0;
    return s;
  }

  /** Returns true if enqueues for this repo should be skipped right now. */
  isPaused(owner: string, repo: string): boolean {
    const s = this.state.get(this.key(owner, repo));
    if (!s || !s.pausedUntil) return false;
    if (Date.parse(s.pausedUntil) <= this.now()) {
      // Auto-expire the cooldown unless it was manually pinned.
      if (!s.manuallyPaused) {
        s.pausedUntil = undefined;
        s.pausedReason = undefined;
        return false;
      }
    }
    return true;
  }

  get(owner: string, repo: string): RepoHealthState | null {
    const s = this.state.get(this.key(owner, repo));
    if (!s) return null;
    // Tick once on read so isPaused stays consistent with what callers see.
    this.isPaused(owner, repo);
    return { ...s };
  }

  list(): RepoHealthState[] {
    // Snapshot, then tick each to expire cooldowns lazily.
    return [...this.state.values()].map((s) => {
      const [owner, repo] = s.repo.split('/') as [string, string];
      this.isPaused(owner, repo);
      return { ...s };
    });
  }

  _resetForTests(): void {
    this.state.clear();
  }
}

let singleton: RepoHealthTracker | null = null;
export function getRepoHealth(): RepoHealthTracker {
  if (!singleton) singleton = new RepoHealthTracker();
  return singleton;
}

export function _resetRepoHealthForTests(): void {
  singleton = new RepoHealthTracker();
}
