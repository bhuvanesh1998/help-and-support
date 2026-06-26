import { env } from '../config/env.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta ?? {}),
  };

  const line = env.isProduction ? JSON.stringify(entry) : formatPretty(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function formatPretty(entry: Record<string, unknown>): string {
  const { ts, level, message, ...rest } = entry;
  const tail = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  return `${String(ts)} ${String(level).toUpperCase().padEnd(5)} ${String(message)}${tail}`;
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => {
    if (env.isDevelopment) emit('debug', message, meta);
  },
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),
};
