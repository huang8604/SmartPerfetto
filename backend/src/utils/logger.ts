/**
 * Simple Logger Utility
 *
 * Controls log verbosity via LOG_LEVEL environment variable:
 * - error: Only errors
 * - warn: Errors + warnings
 * - info: Errors + warnings + info (default)
 * - debug: All logs including verbose SQL queries
 */

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function getCurrentLevel(): number {
  const level = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
  return LOG_LEVELS[level] ?? LOG_LEVELS.info;
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
