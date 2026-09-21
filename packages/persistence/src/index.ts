import type { GameStore, RealtimeStore } from './entities';
import { MemoryGameStore, MemoryRealtime } from './memory';
import { MysqlGameStore } from './mysql';
import { RedisRealtime } from './redis';

export interface Persistence {
  store: GameStore;
  realtime: RealtimeStore;
  kind: 'memory' | 'sql';
}

/**
 * 按环境创建持久化：设置 DATABASE_URL + REDIS_URL 时用 MySQL + Redis（生产/联调），
 * 否则回退内存实现（单元测试 / 本地无 Docker）。与 IdentityProvider 同款可插拔策略。
 */
export async function createPersistence(env: NodeJS.ProcessEnv = process.env): Promise<Persistence> {
  if (env.DATABASE_URL && env.REDIS_URL) {
    return {
      store: MysqlGameStore.create(env.DATABASE_URL),
      realtime: RedisRealtime.create(env.REDIS_URL),
      kind: 'sql',
    };
  }
  return { store: new MemoryGameStore(), realtime: new MemoryRealtime(), kind: 'memory' };
}

export * from './entities';
export * from './replayBundle';
export * from './memory';
export * from './mysql';
export * from './redis';
export * from './admin/index';
