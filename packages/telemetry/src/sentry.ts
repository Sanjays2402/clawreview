/**
 * Thin wrapper around @sentry/node so the rest of the codebase can call
 * `captureException` and `flushSentry` without caring whether Sentry is
 * configured. When `dsn` is empty the wrapper becomes a no-op and never
 * loads the SDK, so local development and the test suite do not pay any
 * runtime cost or emit network traffic.
 *
 * The SDK is loaded lazily with a dynamic import so that consumers that
 * never call `initSentry` (e.g. unit tests, CLI tools) do not need
 * `@sentry/node` installed at runtime.
 */

export interface SentryOptions {
  dsn: string;
  environment?: string;
  release?: string;
  tracesSampleRate?: number;
  serverName?: string;
}

type SentryLike = {
  init: (opts: Record<string, unknown>) => void;
  captureException: (err: unknown, hint?: Record<string, unknown>) => string;
  flush: (timeoutMs?: number) => Promise<boolean>;
};

let client: SentryLike | null = null;
let initialised = false;

export function isSentryEnabled(): boolean {
  return client !== null;
}

export async function initSentry(opts: SentryOptions): Promise<boolean> {
  if (initialised) return client !== null;
  initialised = true;
  if (!opts.dsn) {
    client = null;
    return false;
  }
  try {
    const mod = (await import('@sentry/node')) as unknown as SentryLike;
    mod.init({
      dsn: opts.dsn,
      environment: opts.environment,
      release: opts.release,
      serverName: opts.serverName,
      tracesSampleRate: opts.tracesSampleRate ?? 0,
    });
    client = mod;
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[telemetry] failed to initialise Sentry, continuing without it:', (err as Error).message);
    client = null;
    return false;
  }
}

export function captureException(err: unknown, context?: Record<string, unknown>): string | null {
  if (!client) return null;
  try {
    return client.captureException(err, context ? { extra: context } : undefined);
  } catch {
    return null;
  }
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!client) return;
  try {
    await client.flush(timeoutMs);
  } catch {
    // best-effort flush during shutdown
  }
}

/** Test-only: forget any previously installed client. Do not call in prod. */
export function _resetSentryForTests(): void {
  client = null;
  initialised = false;
}
