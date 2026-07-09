/**
 * Structured logger for postmcp.
 * Writes to stderr (safe for MCP stdio protocol — stdout is reserved for JSON-RPC).
 * Log level controlled via POSTMCP_LOG_LEVEL env var (debug|info|warn|error, default: info).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',    // gray
  info: '\x1b[36m',     // cyan
  warn: '\x1b[33m',     // yellow
  error: '\x1b[31m',    // red
};
const RESET = '\x1b[0m';

function getConfigLevel(): number {
  const env = (process.env.POSTMCP_LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[env as LogLevel] ?? LEVELS.info;
}

const currentLevel = getConfigLevel();
const ENABLE_COLORS = process.env.NO_COLOR === undefined && process.stdout.isTTY === undefined;

function formatTime(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

function log(level: LogLevel, module: string, message: string, ...args: any[]) {
  if (LEVELS[level] < currentLevel) return;
  const color = ENABLE_COLORS ? COLORS[level] : '';
  const reset = ENABLE_COLORS ? RESET : '';
  const tag = level.toUpperCase().padEnd(5);
  const extra = args.length > 0 ? ' ' + args.map(a => {
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ') : '';
  // stderr is safe for MCP — stdout carries JSON-RPC
  process.stderr.write(`${color}[${formatTime()}] [${tag}] [${module}] ${message}${extra}${reset}\n`);
}

export const logger = {
  debug: (mod: string, msg: string, ...args: any[]) => log('debug', mod, msg, ...args),
  info:  (mod: string, msg: string, ...args: any[]) => log('info',  mod, msg, ...args),
  warn:  (mod: string, msg: string, ...args: any[]) => log('warn',  mod, msg, ...args),
  error: (mod: string, msg: string, ...args: any[]) => log('error', mod, msg, ...args),

  /**
   * Track tool usage for basic telemetry.
   */
  toolCall(toolName: string, durationMs: number, success: boolean) {
    const level = success ? 'info' : 'warn';
    log(level, 'Tool', `"${toolName}" ${success ? 'completed' : 'failed'} in ${durationMs}ms`);
  },

  /**
   * Track HTTP request for telemetry.
   */
  httpRequest(method: string, url: string, status: number, durationMs: number) {
    log('debug', 'HTTP', `${method} ${url} → ${status} (${durationMs}ms)`);
  },
};
