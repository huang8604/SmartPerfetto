/**
 * Simple Logger Utility
 *
 * Controls log verbosity via LOG_LEVEL environment variable:
 * - error: Only errors
 * - warn: Errors + warnings
 * - info: Errors + warnings + info (default)
 * - debug: All logs including verbose SQL queries
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

let runtimeLevel: LogLevel | null = null;
const envLevel: LogLevel = parseLevel(process.env.LOG_LEVEL);

function parseLevel(raw?: string | null): LogLevel {
  const level = (raw || 'info').toLowerCase();
  return (level in LOG_LEVELS) ? level as LogLevel : 'info';
}

/** Get the current effective log level. */
export function getLogLevel(): LogLevel {
  return runtimeLevel ?? envLevel;
}

function getCurrentLevel(): number {
  return LOG_LEVELS[getLogLevel()];
}

/** Set log level at runtime. Pass null to revert to env var default. */
export function setLogLevel(level: LogLevel | null): void {
  if (level !== null && !(level in LOG_LEVELS)) {
    throw new Error(`Invalid log level: ${level}. Valid: ${Object.keys(LOG_LEVELS).join(', ')}`);
  }
  runtimeLevel = level;
}

export const logger = {
  error: (tag: string, message: string, ...args: any[]) => {
    console.error(`[${tag}] ${message}`, ...args);
  },

  warn: (tag: string, message: string, ...args: any[]) => {
    if (getCurrentLevel() >= LOG_LEVELS.warn) {
      console.warn(`[${tag}] ${message}`, ...args);
    }
  },

  info: (tag: string, message: string, ...args: any[]) => {
    if (getCurrentLevel() >= LOG_LEVELS.info) {
      console.log(`[${tag}] ${message}`, ...args);
    }
  },

  debug: (tag: string, message: string, ...args: any[]) => {
    if (getCurrentLevel() >= LOG_LEVELS.debug) {
      console.log(`[${tag}] ${message}`, ...args);
    }
  },

  /** Log SQL queries only in debug mode */
  sql: (tag: string, sql: string, durationMs?: number) => {
    if (getCurrentLevel() >= LOG_LEVELS.debug) {
      const truncated = sql.length > 200 ? sql.substring(0, 200) + '...' : sql;
      if (durationMs !== undefined) {
        console.log(`[${tag}] SQL (${durationMs}ms): ${truncated}`);
      } else {
        console.log(`[${tag}] SQL: ${truncated}`);
      }
    }
  },
};

export default logger;
