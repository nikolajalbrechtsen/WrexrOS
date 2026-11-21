/** Structured JSON logging to stdout (one JSON object per line). */
import { config } from './config.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minimum: number = ORDER[config.logLevel] ?? ORDER.info;

export function setLogLevel(level: LogLevel): void {
  minimum = ORDER[level] ?? ORDER.info;
}

export function log(
  level: LogLevel,
  message: string,
  fields: Record<string, unknown> = {},
): void {
  if (ORDER[level] < minimum) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    pid: process.pid,
    ...fields,
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => log('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => log('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => log('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => log('error', message, fields),
};
