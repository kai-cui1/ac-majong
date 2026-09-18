/**
 * 轻量结构化日志模块（零依赖）。
 * 通过 LOG_LEVEL 环境变量控制输出粒度：
 *   silent < error < warn < info < debug < trace
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

const COLORS: Record<string, string> = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

let currentLevel: LogLevel = 'info';

/** 设置全局日志级别 */
export function setLogLevel(level: LogLevel): void {
  if (level in LEVEL_PRIORITY) {
    currentLevel = level;
  }
}

/** 获取当前日志级别 */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[currentLevel];
}

function timestamp(): string {
  const now = new Date();
  return now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
}

function fmt(level: LogLevel, tag: string, msg: string, extra?: unknown): string {
  const ts = `${COLORS.dim}${timestamp()}${COLORS.reset}`;
  const levelColor =
    level === 'error' ? COLORS.red :
    level === 'warn' ? COLORS.yellow :
    level === 'debug' ? COLORS.cyan :
    level === 'trace' ? COLORS.magenta :
    COLORS.green;
  const lvl = `${levelColor}${level.toUpperCase().padEnd(5)}${COLORS.reset}`;
  const t = `${COLORS.blue}[${tag}]${COLORS.reset}`;
  return extra !== undefined
    ? `${ts} ${lvl} ${t} ${msg} ${COLORS.dim}${JSON.stringify(extra)}${COLORS.reset}`
    : `${ts} ${lvl} ${t} ${msg}`;
}

/** 创建带命名空间的 logger 实例 */
export function createLogger(tag: string) {
  return {
    error(msg: string, extra?: unknown): void {
      if (shouldLog('error')) console.error(fmt('error', tag, msg, extra));
    },
    warn(msg: string, extra?: unknown): void {
      if (shouldLog('warn')) console.warn(fmt('warn', tag, msg, extra));
    },
    info(msg: string, extra?: unknown): void {
      if (shouldLog('info')) console.log(fmt('info', tag, msg, extra));
    },
    debug(msg: string, extra?: unknown): void {
      if (shouldLog('debug')) console.log(fmt('debug', tag, msg, extra));
    },
    trace(msg: string, extra?: unknown): void {
      if (shouldLog('trace')) console.log(fmt('trace', tag, msg, extra));
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
