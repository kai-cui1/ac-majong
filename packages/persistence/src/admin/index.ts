import mysql from 'mysql2/promise';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import { DrizzleAdminStore } from './adminStore';
import { DrizzleAdminGameQueries, DrizzleReplaySource } from './gameQueries';
import type { AdminGameQueries, AdminStore } from './types';

/**
 * Admin 数据访问单一入口（BL-015 / Admin 技术方案 §3.1）。
 * **唯一 Drizzle/mysql2 客户端在此构造**——admin-server 不自持 drizzle/mysql2，只消费返回的 admin/game 命名空间。
 * P2-a：admin 自有表读写走 Drizzle；游戏 6 表只读镜像（不产迁移，写路径仍归 game-server）。
 */
export interface AdminPersistence {
  db: MySql2Database;
  /** admin 自有表（admins/arbitrations/admin_audit_logs）读写 */
  admin: AdminStore;
  /** 游戏数据只读检索 + 回放数据源 */
  game: AdminGameQueries;
  close(): Promise<void>;
}

/** admin 仅支持 MySQL（不回落内存）：无 DATABASE_URL 直接抛错，避免误用。 */
export async function createAdminPersistence(env: NodeJS.ProcessEnv = process.env): Promise<AdminPersistence> {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('createAdminPersistence 需要 DATABASE_URL（admin 仅 MySQL，不回落内存）');
  const pool = mysql.createPool(url);
  const db = drizzle(pool);
  return {
    db,
    admin: new DrizzleAdminStore(db),
    game: new DrizzleAdminGameQueries(db),
    close: async () => {
      await pool.end();
    },
  };
}

export * from './types';
export { DrizzleAdminStore } from './adminStore';
export { DrizzleAdminGameQueries, DrizzleReplaySource } from './gameQueries';
