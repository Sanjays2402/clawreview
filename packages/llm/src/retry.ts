export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 8000;
  const jitter = opts.jitter ?? true;
  const isRetryable = opts.isRetryable ?? defaultRetryable;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isRetryable(err)) throw err;
      const exp = Math.min(max, base * 2 ** (attempt - 1));
      const delay = jitter ? Math.floor(exp * (0.5 + Math.random() / 2)) : exp;
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function defaultRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { status?: number; code?: string; name?: string };
  if (anyErr.code === 'ECONNRESET' || anyErr.code === 'ETIMEDOUT' || anyErr.code === 'EAI_AGAIN') {
    return true;
  }
  if (anyErr.name === 'AbortError') return false;
  if (typeof anyErr.status === 'number') {
    if (anyErr.status === 408 || anyErr.status === 429) return true;
    if (anyErr.status >= 500 && anyErr.status < 600) return true;
  }
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
