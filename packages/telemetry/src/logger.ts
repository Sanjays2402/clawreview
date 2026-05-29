import pino, { type Logger, type LoggerOptions } from 'pino';

export interface LoggerInit {
  service: string;
  level?: string;
  pretty?: boolean;
}

export function createLogger(init: LoggerInit): Logger {
  const opts: LoggerOptions = {
    level: init.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service: init.service, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-hub-signature-256"]',
        'res.headers["set-cookie"]',
        '*.privateKey',
        '*.webhookSecret',
        '*.apiKey',
      ],
      remove: true,
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  };
  if (init.pretty) {
    opts.transport = {
      target: 'pino-pretty',
      options: { colorize: true, singleLine: true },
    };
  }
  return pino(opts);
}
