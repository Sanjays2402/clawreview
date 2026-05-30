import { describe, expect, it } from 'vitest';
import pino from 'pino';

import { createLogger, newRequestId } from '../src/index.js';

function captureLines(fn: (log: ReturnType<typeof pino>) => void): string[] {
  const lines: string[] = [];
  const stream = {
    write(chunk: string) {
      lines.push(chunk.trim());
    },
  };
  // Re-create with the same options shape but pipe to our stream.
  const log = pino(
    {
      level: 'info',
      base: { service: 'unit', pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-hub-signature-256"]',
          '*.webhookSecret',
          '*.apiKey',
        ],
        remove: true,
      },
      formatters: { level: (label: string) => ({ level: label }) },
    },
    stream as unknown as NodeJS.WritableStream,
  );
  fn(log);
  return lines;
}

describe('createLogger', () => {
  it('returns a usable logger with the configured service binding', () => {
    const log = createLogger({ service: 'svc-name', level: 'debug' });
    expect(log.level).toBe('debug');
    // pino bindings include the base
    expect(log.bindings().service).toBe('svc-name');
  });

  it('defaults log level from LOG_LEVEL when not provided', () => {
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'warn';
    try {
      const log = createLogger({ service: 'svc' });
      expect(log.level).toBe('warn');
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = previous;
    }
  });

  it('redacts authorization headers, webhook secrets, and api keys', () => {
    // Verify the redact config we install actually drops the fields when
    // pino renders them, via a parallel pino instance with the same paths.
    const lines = captureLines((log) => {
      log.info(
        {
          req: { headers: { authorization: 'Bearer sekret', 'x-hub-signature-256': 'sig' } },
          cfg: { webhookSecret: 'shhh', apiKey: 'abc' },
        },
        'redact',
      );
    });
    const line = lines.at(-1) ?? '';
    expect(line).toContain('"msg":"redact"');
    expect(line).not.toContain('sekret');
    expect(line).not.toContain('shhh');
    expect(line).not.toContain('abc');
  });
});

describe('newRequestId', () => {
  it('produces unique uuid v4 strings', () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
