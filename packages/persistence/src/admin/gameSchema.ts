import { sql } from 'drizzle-orm';
import { bigint, datetime, int, json, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

/**
 * 游戏 6 表的 Drizzle **只读镜像**（BL-015 / Admin 技术方案 §3.1-3.2）。
 * 列严格对齐 deploy/schema.sql；**不产出任何迁移**（drizzle.config 只指向 schema.ts），避免误改现网结构。
 * admin 对这些表只 SELECT，写路径仍归 game-server。
 */

export const users = mysqlTable('users', {
  openid: varchar('openid', { length: 64 }).primaryKey(),
  nickname: varchar('nickname', { length: 64 }).notNull().default(''),
  avatarUrl: varchar('avatar_url', { length: 512 }).notNull().default(''),
  passHash: varchar('pass_hash', { length: 255 }),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  lastLoginAt: datetime('last_login_at', { mode: 'date', fsp: 3 }),
});

export const rooms = mysqlTable('rooms', {
  roomId: varchar('room_id', { length: 16 }).primaryKey(),
  hostOpenid: varchar('host_openid', { length: 64 }).notNull(),
  maxRounds: int('max_rounds').notNull(),
  initialScore: json('initial_score').notNull(),
  memberScores: json('member_scores'),
  settings: json('settings'),
  seating: json('seating'),
  finalScore: json('final_score'),
  status: mysqlEnum('status', ['idle', 'playing', 'closed']).notNull().default('idle'),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  closedAt: datetime('closed_at', { mode: 'date', fsp: 3 }),
});

export const roomMemberEvents = mysqlTable('room_member_events', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  roomId: varchar('room_id', { length: 16 }).notNull(),
  openid: varchar('openid', { length: 64 }).notNull(),
  seat: int('seat'),
  event: mysqlEnum('event', ['create', 'join', 'leave', 'ready']).notNull(),
  at: datetime('at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const games = mysqlTable('games', {
  gameId: varchar('game_id', { length: 24 }).primaryKey(),
  roomId: varchar('room_id', { length: 16 }).notNull(),
  roundNo: int('round_no').notNull(),
  dealerSeat: int('dealer_seat').notNull(),
  seed: bigint('seed', { mode: 'number' }).notNull(),
  endType: mysqlEnum('end_type', ['win', 'exhaustive']),
  result: json('result'),
  startedAt: datetime('started_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  endedAt: datetime('ended_at', { mode: 'date', fsp: 3 }),
});

export const gameInitialStates = mysqlTable('game_initial_states', {
  gameId: varchar('game_id', { length: 24 }).primaryKey(),
  wall: json('wall').notNull(),
  hands: json('hands').notNull(),
  layout: json('layout'),
  breakGroup: int('break_group'),
  lianzhuangCount: int('lianzhuang_count').notNull().default(0),
});

export const gameActions = mysqlTable('game_actions', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  gameId: varchar('game_id', { length: 24 }).notNull(),
  seq: int('seq').notNull(),
  seat: int('seat'),
  actionType: varchar('action_type', { length: 24 }).notNull(),
  payload: json('payload').notNull(),
  at: datetime('at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});
