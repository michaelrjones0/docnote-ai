/**
 * PHI-safe debug logging utility.
 * 
 * DEBUG mode is enabled when VITE_DEBUG === 'true'.
 * In production builds (or when DEBUG is false), sensitive data 
 * (transcripts, summaries, note content) is NEVER logged.
 */

const isDebugEnabled = (): boolean => {
  return import.meta.env.VITE_DEBUG === 'true';
};

export const DEBUG = isDebugEnabled();

/**
 * Log a debug message. Only logs if DEBUG is enabled.
 */
export function debugLog(prefix: string, ...args: unknown[]): void {
  if (DEBUG) {
    console.log(prefix, ...args);
  }
}

/**
 * Log a warning. Only logs if DEBUG is enabled.
 */
export function debugWarn(prefix: string, ...args: unknown[]): void {
  if (DEBUG) {
    console.warn(prefix, ...args);
  }
}

/**
 * Log an error. Only logs if DEBUG is enabled.
 * For production errors, use safeErrorLog instead.
 */
export function debugError(prefix: string, ...args: unknown[]): void {
  if (DEBUG) {
    console.error(prefix, ...args);
  }
}

/**
 * Safe log for operational info (non-PHI). Always logs.
 * Use for: status changes, timing, counts, configuration.
 * Do NOT use for: transcript text, summaries, note content, patient data.
 */
export function safeLog(prefix: string, ...args: unknown[]): void {
  console.log(prefix, ...args);
}

/**
 * Safe warn for operational warnings (non-PHI). Always logs.
 */
export function safeWarn(prefix: string, ...args: unknown[]): void {
  console.warn(prefix, ...args);
}

/**
 * Safe error log (non-PHI details only). Always logs.
 * Logs error type/message but NOT any PHI context.
 */
export function safeErrorLog(prefix: string, error: unknown): void {
  const errMsg = error instanceof Error ? error.message : 'Unknown error';
  console.error(prefix, errMsg);
}

/**
 * Log transcript/summary content. Only in DEBUG mode.
 * @param prefix Log prefix
 * @param content The PHI content to log
 * @param maxLength Max chars to log (default 100)
 */
export function debugLogPHI(prefix: string, content: string | null | undefined, maxLength = 100): void {
  if (DEBUG && content) {
    const truncated = content.length > maxLength ? content.slice(0, maxLength) + '...' : content;
    console.log(prefix, truncated);
  }
}
