import { createHmac } from 'node:crypto';

import { SEVERITY_ORDER, type Severity } from '@clawreview/types';

import type { ReviewRecord } from './review-store.js';

export interface NotifierConfig {
  url: string;
  secret?: string;
  /** Worst finding severity must be at or above this to fire on success. */
  minSeverity?: Severity;
  /** If true, also fire on failed reviews regardless of findings. */
  notifyOnFailure?: boolean;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Reference time for the signature header. */
  now?: () => number;
}

export interface NotifyPayload {
  event: 'review.completed' | 'review.failed';
  reviewId: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  status: ReviewRecord['status'];
  durationMs?: number;
  totalCostUsd: number;
  totalFindings: number;
  openFindings: number;
  worstSeverity: Severity | null;
  bySeverity: Record<Severity, number>;
  error?: string;
  timestamp: string;
}

export interface NotifyResult {
  delivered: boolean;
  skipped?: 'no-url' | 'below-threshold' | 'not-on-failure';
  status?: number;
  error?: string;
}

const SIGNATURE_HEADER = 'x-clawreview-signature';
const TIMESTAMP_HEADER = 'x-clawreview-timestamp';
const EVENT_HEADER = 'x-clawreview-event';

/**
 * Outbound webhook notifier. Posts a compact JSON payload describing a
 * completed (or failed) review to a configured URL. When a secret is
 * present, the body is signed with HMAC-SHA256 over `${timestamp}.${body}`
 * (same construction Stripe and GitHub use, so receivers can verify with
 * a few lines of code and reject replays).
 *
 * Designed so the worker can fire-and-forget it without blocking the PR
 * pipeline: any thrown error is caught and returned in the result.
 */
export class ReviewNotifier {
  constructor(private readonly cfg: NotifierConfig) {}

  async notify(rec: ReviewRecord): Promise<NotifyResult> {
    if (!this.cfg.url) return { delivered: false, skipped: 'no-url' };

    const event: NotifyPayload['event'] =
      rec.status === 'failed' ? 'review.failed' : 'review.completed';

    if (event === 'review.failed' && this.cfg.notifyOnFailure === false) {
      return { delivered: false, skipped: 'not-on-failure' };
    }

    const payload = buildPayload(rec, event);

    if (event === 'review.completed') {
      const threshold = this.cfg.minSeverity ?? 'medium';
      if (!meetsThreshold(payload.worstSeverity, threshold)) {
        return { delivered: false, skipped: 'below-threshold' };
      }
    }

    const body = JSON.stringify(payload);
    const timestamp = String((this.cfg.now ?? Date.now)());
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [EVENT_HEADER]: event,
      [TIMESTAMP_HEADER]: timestamp,
    };
    if (this.cfg.secret) {
      headers[SIGNATURE_HEADER] = sign(timestamp, body, this.cfg.secret);
    }

    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs ?? 5000);
    try {
      const res = await fetchImpl(this.cfg.url, {
        method: 'POST',
        headers,
        body,
        signal: ac.signal,
      });
      return {
        delivered: res.ok,
        status: res.status,
        ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
      };
    } catch (err) {
      return {
        delivered: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function buildPayload(
  rec: ReviewRecord,
  event: NotifyPayload['event'],
): NotifyPayload {
  const bySeverity: Record<Severity, number> = {
    critical: 0, high: 0, medium: 0, low: 0, nit: 0,
  };
  let open = 0;
  let worst: Severity | null = null;
  for (const f of rec.findings) {
    if (f.state !== 'open') continue;
    open += 1;
    bySeverity[f.severity] += 1;
    if (worst === null || SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[worst]) {
      worst = f.severity;
    }
  }
  return {
    event,
    reviewId: rec.id,
    owner: rec.owner,
    repo: rec.repo,
    prNumber: rec.prNumber,
    headSha: rec.headSha,
    status: rec.status,
    durationMs: rec.durationMs,
    totalCostUsd: rec.totalCostUsd,
    totalFindings: rec.totalFindings,
    openFindings: open,
    worstSeverity: worst,
    bySeverity,
    error: rec.error,
    timestamp: new Date().toISOString(),
  };
}

export function sign(timestamp: string, body: string, secret: string): string {
  const mac = createHmac('sha256', secret);
  mac.update(`${timestamp}.${body}`);
  return `sha256=${mac.digest('hex')}`;
}

export function verifySignature(
  headerValue: string,
  timestamp: string,
  body: string,
  secret: string,
): boolean {
  const expected = sign(timestamp, body, secret);
  if (expected.length !== headerValue.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ headerValue.charCodeAt(i);
  }
  return mismatch === 0;
}

function meetsThreshold(worst: Severity | null, threshold: Severity): boolean {
  if (worst === null) return false;
  return SEVERITY_ORDER[worst] <= SEVERITY_ORDER[threshold];
}

let singleton: ReviewNotifier | null = null;

/**
 * Process-wide notifier built from env. Tests can call resetNotifier() to
 * swap in a custom instance via setNotifier().
 */
export function getNotifier(): ReviewNotifier {
  if (singleton) return singleton;
  singleton = new ReviewNotifier({
    url: process.env.NOTIFY_WEBHOOK_URL ?? '',
    secret: process.env.NOTIFY_WEBHOOK_SECRET || undefined,
    minSeverity: (process.env.NOTIFY_WEBHOOK_MIN_SEVERITY as Severity) || 'medium',
    notifyOnFailure: process.env.NOTIFY_WEBHOOK_ON_FAILURE !== 'false',
    timeoutMs: Number(process.env.NOTIFY_WEBHOOK_TIMEOUT_MS) || 5000,
  });
  return singleton;
}

export function setNotifier(n: ReviewNotifier | null): void {
  singleton = n;
}
