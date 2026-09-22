import type { LogLevel } from './logger';

/** Admin 服务端配置（对齐 Admin 技术方案 §8）。 */
export interface AdminConfig {
  port: number;
  /** admin 仅 MySQL；createAdminPersistence 需要 */
  databaseUrl: string;
  /** 会话存储 Redis；缺省时用内存 store（仅 dev/test） */
  redisUrl?: string;
  /** @fastify/session 签名密钥，长度须 ≥ 32 */
  sessionSecret: string;
  sessionTtlSec: number;
  /** 首个超管 bootstrap（admins 为空时创建） */
  bootstrapUsername?: string;
  bootstrapPassword?: string;
  logLevel: LogLevel;
  /** 是否启用写操作 CSRF 校验（prod true；test 可关） */
  csrf: boolean;
  /** 是否启用登录限流（prod true；test 可关避免 inject 抖动） */
  rateLimit: boolean;
  /** 会话 cookie Secure 属性；同源 nginx HTTPS 用 'auto' + trustProxy */
  cookieSecure: boolean | 'auto';
  /** FR-Admin-10：game-server 内网 inspect 端点基址（如 http://game-server:8085）；未配置则实时监控降级为已落库事实 */
  gameInternalUrl?: string;
  /** FR-Admin-10：内网预共享密钥（须与 game-server INTERNAL_TOKEN 一致）；只在服务端，绝不下发前端 */
  internalToken?: string;
}

const num = (v: string | undefined, d: number): number => (v == null || v === '' ? d : Number(v));
const bool = (v: string | undefined, d: boolean): boolean => (v == null || v === '' ? d : v === '1' || v === 'true');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('admin-server 需要 DATABASE_URL');
  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('admin-server 需要 SESSION_SECRET（长度 ≥ 32）');
  return {
    port: num(env.PORT, 8090),
    databaseUrl,
    redisUrl: env.REDIS_URL || undefined,
    sessionSecret,
    sessionTtlSec: num(env.SESSION_TTL_SEC, 8 * 3600),
    bootstrapUsername: env.ADMIN_BOOTSTRAP_USERNAME || undefined,
    bootstrapPassword: env.ADMIN_BOOTSTRAP_PASSWORD || undefined,
    logLevel: (env.LOG_LEVEL as LogLevel) || 'info',
    csrf: bool(env.CSRF_ENABLED, true),
    rateLimit: bool(env.RATE_LIMIT_ENABLED, true),
    cookieSecure: env.COOKIE_SECURE === '1' ? true : env.COOKIE_SECURE === '0' ? false : 'auto',
    gameInternalUrl: env.GAME_INTERNAL_URL || undefined,
    internalToken: env.INTERNAL_TOKEN || undefined,
  };
}
