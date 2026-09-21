import { Redis } from 'ioredis';

/**
 * @fastify/session 的 Redis 存储（会话集中存 Redis，支持多实例；Admin 技术方案 §4）。
 * 结构上匹配 fastifySession.SessionStore 的回调式 set/get/destroy，注册时直接传入。
 */
export interface SimpleSessionStore {
  set(sessionId: string, session: unknown, callback: (err?: unknown) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(sessionId: string, callback: (err: unknown, result?: any) => void): void;
  destroy(sessionId: string, callback: (err?: unknown) => void): void;
}

export interface SessionStoreHandle {
  store: SimpleSessionStore;
  close(): Promise<void>;
}

/** 用 ioredis 实现会话存储；键前缀隔离游戏侧会话，TTL 与 session cookie maxAge 对齐。 */
export function createRedisSessionStore(redisUrl: string, ttlSec: number, keyPrefix = 'admin:sess:'): SessionStoreHandle {
  const redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  const key = (id: string): string => `${keyPrefix}${id}`;
  const store: SimpleSessionStore = {
    set(sessionId, session, callback) {
      redis
        .set(key(sessionId), JSON.stringify(session ?? {}), 'EX', Math.max(60, ttlSec))
        .then(() => callback(), (e: unknown) => callback(e));
    },
    get(sessionId, callback) {
      redis
        .get(key(sessionId))
        .then((v) => callback(null, v ? (JSON.parse(v) as unknown) : undefined), (e: unknown) => callback(e, undefined));
    },
    destroy(sessionId, callback) {
      redis.del(key(sessionId)).then(() => callback(), (e: unknown) => callback(e));
    },
  };
  return { store, close: async () => { await redis.quit(); } };
}
