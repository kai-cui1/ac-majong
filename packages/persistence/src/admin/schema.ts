import { sql } from 'drizzle-orm';
import { bigint, datetime, index, json, mysqlEnum, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core';

/**
 * Admin 自有表（BL-015 / Admin 技术方案 §3.3）。**唯一迁移源**——drizzle.config 只指向本文件，
 * `drizzle-kit generate` 仅产出这三张表的 DDL；游戏 6 表由 deploy/schema.sql 管理，见 gameSchema.ts（只读镜像，不产迁移）。
 */

/** 管理员账号（scrypt pass_hash，复刻 accountAuth 格式；角色三档粗粒度） */
export const admins = mysqlTable('admins', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  username: varchar('username', { length: 32 }).notNull().unique(),
  passHash: varchar('pass_hash', { length: 255 }).notNull(),
  role: mysqlEnum('role', ['super', 'operator', 'viewer']).notNull(),
  status: mysqlEnum('status', ['active', 'disabled']).notNull().default('active'),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`).$onUpdate(() => new Date()),
  lastLoginAt: datetime('last_login_at', { mode: 'date', fsp: 3 }),
});

/** 仲裁记录（纯留痕，不回写游戏数据；呼应 D-32） */
export const arbitrations = mysqlTable(
  'arbitrations',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    gameId: varchar('game_id', { length: 24 }).notNull(),
    adminId: bigint('admin_id', { mode: 'number' }).notNull(),
    status: mysqlEnum('status', ['pending', 'accepted', 'rejected', 'resolved']).notNull().default('pending'),
    verdict: varchar('verdict', { length: 32 }),
    note: text('note'),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`).$onUpdate(() => new Date()),
  },
  (t) => ({
    gameIdx: index('idx_game').on(t.gameId),
    adminIdx: index('idx_admin').on(t.adminId),
  }),
);

/** 审计流水（记所有管理员写操作；只读查询不记） */
export const adminAuditLogs = mysqlTable(
  'admin_audit_logs',
  {
    id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
    adminId: bigint('admin_id', { mode: 'number' }),
    adminUsername: varchar('admin_username', { length: 32 }),
    action: varchar('action', { length: 48 }).notNull(),
    targetType: varchar('target_type', { length: 32 }),
    targetId: varchar('target_id', { length: 64 }),
    beforeJson: json('before_json'),
    afterJson: json('after_json'),
    ip: varchar('ip', { length: 64 }),
    result: mysqlEnum('result', ['success', 'fail']).notNull().default('success'),
    at: datetime('at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => ({
    adminTimeIdx: index('idx_admin_time').on(t.adminId, t.at),
    actionIdx: index('idx_action').on(t.action),
    atIdx: index('idx_at').on(t.at),
  }),
);
