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
});

export type Env = typeof env;
