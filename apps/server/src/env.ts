import { bool, cleanEnv, num, port, str, url } from 'envalid';

export const env = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ['development', 'test', 'production'], default: 'development' }),
  PORT: port({ default: 4000 }),
  HOST: str({ default: '0.0.0.0' }),
  LOG_LEVEL: str({ default: 'info' }),
  DATABASE_URL: str({ default: 'postgresql://clawreview:clawreview@localhost:5432/clawreview' }),
  REDIS_URL: str({ default: '' }),
  PUBLIC_URL: url({ default: 'http://localhost:4000' }),
  DASHBOARD_URL: url({ default: 'http://localhost:3000' }),

  GITHUB_APP_ID: str({ default: '' }),
  GITHUB_APP_PRIVATE_KEY: str({ default: '' }),
  GITHUB_WEBHOOK_SECRET: str({ default: '' }),
  GITHUB_APP_SLUG: str({ default: 'clawreview' }),

  LLM_OPENAI_BASE_URL: url({ default: 'https://api.openai.com/v1' }),
  LLM_OPENAI_API_KEY: str({ default: '' }),
  LLM_HERMES_BASE_URL: url({ default: 'http://127.0.0.1:8642/v1' }),
  LLM_COPILOT_BASE_URL: url({ default: 'http://127.0.0.1:4141/v1' }),
  LLM_COPILOT_API_KEY: str({ default: '' }),

  REVIEW_CONCURRENCY: num({ default: 6 }),
  DEFAULT_MONTHLY_BUDGET_USD: num({ default: 50 }),

  COOKIE_SECRET: str({ default: 'dev-cookie-secret-change-me' }),

  // Webhook author filters. Comma-separated logins are skipped before
  // enqueueing a review. REVIEW_BOT_PRS controls whether GitHub App / bot
  // accounts (login ending with `[bot]`) are reviewed at all.
  REVIEW_BOT_PRS: bool({ default: false }),
  REVIEW_SKIP_AUTHORS: str({ default: '' }),

  // Outbound notification webhook. When set, the server POSTs a JSON
  // payload with the review summary to this URL on completion (and
  // optionally on failure). NOTIFY_WEBHOOK_SECRET, if present, signs each
  // delivery with an HMAC-SHA256 header so the receiver can verify
  // authenticity. NOTIFY_WEBHOOK_MIN_SEVERITY filters out reviews whose
  // worst finding is below the threshold (defaults to 'medium').
  NOTIFY_WEBHOOK_URL: str({ default: '' }),
  NOTIFY_WEBHOOK_SECRET: str({ default: '' }),
  NOTIFY_WEBHOOK_MIN_SEVERITY: str({
    choices: ['critical', 'high', 'medium', 'low', 'nit'],
    default: 'medium',
  }),
  NOTIFY_WEBHOOK_ON_FAILURE: bool({ default: true }),
  NOTIFY_WEBHOOK_TIMEOUT_MS: num({ default: 5000 }),

  // Sentry error tracking. Leaving SENTRY_DSN empty disables the SDK
  // entirely so local development and tests do not emit network traffic.
  // SENTRY_TRACES_SAMPLE_RATE between 0 and 1 controls performance
  // sampling; defaults to 0 (errors only).
  SENTRY_DSN: str({ default: '' }),
  SENTRY_ENVIRONMENT: str({ default: '' }),
  SENTRY_RELEASE: str({ default: '' }),
  SENTRY_TRACES_SAMPLE_RATE: num({ default: 0 }),
});

export type Env = typeof env;
