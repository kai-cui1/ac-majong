import { and, asc, count, desc, eq, gte, inArray, like, lte, or } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import type { Action, RoundSnapshot, TileId } from '@ac-majong/engine';
import type { RoomSettings } from '@ac-majong/protocol';
import type {
  ActionRow,
  EndType,
  GameRow,
  InitialStateRow,
  MemberEventRow,
  RoomRow,
  ScoreMap,
  UserRow,
} from '../entities';
import type { ReplaySource } from '../replayBundle';
import { gameActions, gameInitialStates, games, roomMemberEvents, rooms, users } from './gameSchema';
import type {
  AdminGameQueries,
  GameFilter,
  GameSummary,
  Page,
  RoomFilter,
  RoomSummary,
  UserFilter,
} from './types';

const DEFAULT_SIZE = 20;
const MAX_SIZE = 200;

function clampPage(q?: { page?: number; size?: number }): { page: number; size: number; offset: number } {
  const page = Math.max(1, q?.page ?? 1);
  const size = Math.min(MAX_SIZE, Math.max(1, q?.size ?? DEFAULT_SIZE));
  return { page, size, offset: (page - 1) * size };
}

// ---- 行映射（Drizzle JSON 列为 unknown，映射到 entities 契约类型）----
const mapUser = (r: typeof users.$inferSelect): UserRow => ({
  openid: r.openid,
  nickname: r.nickname,
  avatarUrl: r.avatarUrl,
  passHash: r.passHash ?? null,
  createdAt: r.createdAt,
  lastLoginAt: r.lastLoginAt ?? null,
});
const mapRoom = (r: typeof rooms.$inferSelect): RoomRow => ({
  roomId: r.roomId,
  hostOpenid: r.hostOpenid,
  maxRounds: r.maxRounds,
  initialScore: r.initialScore as ScoreMap,
  memberScores: (r.memberScores as ScoreMap | null) ?? null,
  settings: (r.settings as RoomSettings | null) ?? null,
  seating: r.seating ?? null,
  finalScore: (r.finalScore as ScoreMap | null) ?? null,
  status: r.status,
  createdAt: r.createdAt,
  closedAt: r.closedAt ?? null,
});
const mapGame = (r: typeof games.$inferSelect): GameRow => ({
  gameId: r.gameId,
  roomId: r.roomId,
  roundNo: r.roundNo,
  dealerSeat: r.dealerSeat,
  seed: Number(r.seed),
  endType: (r.endType as EndType | null) ?? null,
  result: r.result ?? null,
  startedAt: r.startedAt,
  endedAt: r.endedAt ?? null,
});
const mapMemberEvent = (r: typeof roomMemberEvents.$inferSelect): MemberEventRow => ({
  roomId: r.roomId,
  openid: r.openid,
  seat: r.seat ?? null,
  event: r.event,
  at: r.at,
});
const mapInitialState = (r: typeof gameInitialStates.$inferSelect): InitialStateRow => ({
  gameId: r.gameId,
  wall: r.wall as TileId[],
  hands: r.hands as RoundSnapshot['players'],
  lianzhuangCount: r.lianzhuangCount,
  layout: (r.layout as TileId[][] | null) ?? null,
  breakGroup: r.breakGroup ?? null,
});
const mapAction = (r: typeof gameActions.$inferSelect): ActionRow => ({
  gameId: r.gameId,
  seq: r.seq,
  seat: r.seat ?? null,
  actionType: r.actionType,
  payload: r.payload as Action,
  at: r.at,
});

/** 供 buildReplayBundle 使用的 Drizzle 只读数据源（仅实现 ReplaySource 的 6 个读方法）。 */
export class DrizzleReplaySource implements ReplaySource {
  constructor(private readonly db: MySql2Database) {}

  async getGame(gameId: string): Promise<GameRow | null> {
    const rows = await this.db.select().from(games).where(eq(games.gameId, gameId)).limit(1);
    return rows[0] ? mapGame(rows[0]) : null;
  }
  async getInitialState(gameId: string): Promise<InitialStateRow | null> {
    const rows = await this.db.select().from(gameInitialStates).where(eq(gameInitialStates.gameId, gameId)).limit(1);
    return rows[0] ? mapInitialState(rows[0]) : null;
  }
  async listActions(gameId: string): Promise<ActionRow[]> {
    const rows = await this.db.select().from(gameActions).where(eq(gameActions.gameId, gameId)).orderBy(asc(gameActions.seq));
    return rows.map(mapAction);
  }
  async listMemberEvents(roomId: string): Promise<MemberEventRow[]> {
    const rows = await this.db.select().from(roomMemberEvents).where(eq(roomMemberEvents.roomId, roomId)).orderBy(asc(roomMemberEvents.at), asc(roomMemberEvents.id));
    return rows.map(mapMemberEvent);
  }
  async getRoom(roomId: string): Promise<RoomRow | null> {
    const rows = await this.db.select().from(rooms).where(eq(rooms.roomId, roomId)).limit(1);
    return rows[0] ? mapRoom(rows[0]) : null;
  }
  async getUser(openid: string): Promise<UserRow | null> {
    const rows = await this.db.select().from(users).where(eq(users.openid, openid)).limit(1);
    return rows[0] ? mapUser(rows[0]) : null;
  }
}

/** AdminGameQueries 的 Drizzle 实现（游戏表只读检索 / 聚合）。 */
export class DrizzleAdminGameQueries implements AdminGameQueries {
  private readonly replay: DrizzleReplaySource;
  constructor(private readonly db: MySql2Database) {
    this.replay = new DrizzleReplaySource(db);
  }

  async queryUsers(filter?: UserFilter): Promise<Page<UserRow>> {
    const { page, size, offset } = clampPage(filter);
    const conds = [];
    if (filter?.q) {
      const kw = `%${filter.q}%`;
      conds.push(or(like(users.openid, kw), like(users.nickname, kw)));
    }
    if (filter?.from) conds.push(gte(users.createdAt, filter.from));
    if (filter?.to) conds.push(lte(users.createdAt, filter.to));
    const where = conds.length ? and(...conds) : undefined;
    const [totalRow, rows] = await Promise.all([
      this.db.select({ value: count() }).from(users).where(where),
      this.db.select().from(users).where(where).orderBy(desc(users.createdAt)).limit(size).offset(offset),
    ]);
    return { items: rows.map(mapUser), total: Number(totalRow[0]?.value ?? 0), page, size };
  }

  async getUserDetail(openid: string): Promise<{ profile: UserRow | null; rooms: RoomRow[]; games: GameRow[] }> {
    const profile = await this.replay.getUser(openid);
    const memberRows = await this.db.select({ roomId: roomMemberEvents.roomId }).from(roomMemberEvents).where(eq(roomMemberEvents.openid, openid));
    const memberRoomIds = [...new Set(memberRows.map((r) => r.roomId))];
    const roomCond = memberRoomIds.length
      ? or(eq(rooms.hostOpenid, openid), inArray(rooms.roomId, memberRoomIds))
      : eq(rooms.hostOpenid, openid);
    const roomRows = await this.db.select().from(rooms).where(roomCond).orderBy(desc(rooms.createdAt)).limit(MAX_SIZE);
    const mappedRooms = roomRows.map(mapRoom);
    const roomIds = mappedRooms.map((r) => r.roomId);
    const gameRows = roomIds.length
      ? await this.db.select().from(games).where(inArray(games.roomId, roomIds)).orderBy(desc(games.startedAt)).limit(MAX_SIZE)
      : [];
    return { profile, rooms: mappedRooms, games: gameRows.map(mapGame) };
  }

  async queryRooms(filter?: RoomFilter): Promise<Page<RoomSummary>> {
    const { page, size, offset } = clampPage(filter);
    const conds = [];
    if (filter?.roomId) conds.push(eq(rooms.roomId, filter.roomId));
    if (filter?.host) conds.push(eq(rooms.hostOpenid, filter.host));
    if (filter?.status) conds.push(eq(rooms.status, filter.status));
    if (filter?.from) conds.push(gte(rooms.createdAt, filter.from));
    if (filter?.to) conds.push(lte(rooms.createdAt, filter.to));
    const where = conds.length ? and(...conds) : undefined;
    const [totalRow, rows] = await Promise.all([
      this.db.select({ value: count() }).from(rooms).where(where),
      this.db.select().from(rooms).where(where).orderBy(desc(rooms.createdAt)).limit(size).offset(offset),
    ]);
    const mapped = rows.map(mapRoom);
    const items = await this.decorateRooms(mapped);
    return { items, total: Number(totalRow[0]?.value ?? 0), page, size };
  }

  /** 批量补房主昵称 + 局数（避免 N+1） */
  private async decorateRooms(list: RoomRow[]): Promise<RoomSummary[]> {
    if (list.length === 0) return [];
    const hostIds = [...new Set(list.map((r) => r.hostOpenid))];
    const roomIds = list.map((r) => r.roomId);
    const [hostRows, countRows] = await Promise.all([
      this.db.select({ openid: users.openid, nickname: users.nickname }).from(users).where(inArray(users.openid, hostIds)),
      this.db.select({ roomId: games.roomId, c: count() }).from(games).where(inArray(games.roomId, roomIds)).groupBy(games.roomId),
    ]);
    const nick = new Map(hostRows.map((h) => [h.openid, h.nickname]));
    const gc = new Map(countRows.map((r) => [r.roomId, Number(r.c)]));
    return list.map((room) => ({ room, hostNickname: nick.get(room.hostOpenid) ?? null, gameCount: gc.get(room.roomId) ?? 0 }));
  }

  async getRoomDetail(roomId: string): Promise<{ room: RoomRow | null; memberEvents: MemberEventRow[]; games: GameRow[] }> {
    const room = await this.replay.getRoom(roomId);
    const [memRows, gameRows] = await Promise.all([
      this.db.select().from(roomMemberEvents).where(eq(roomMemberEvents.roomId, roomId)).orderBy(asc(roomMemberEvents.at), asc(roomMemberEvents.id)),
      this.db.select().from(games).where(eq(games.roomId, roomId)).orderBy(asc(games.roundNo)),
    ]);
    return { room, memberEvents: memRows.map(mapMemberEvent), games: gameRows.map(mapGame) };
  }

  async queryGames(filter?: GameFilter): Promise<Page<GameSummary>> {
    const { page, size, offset } = clampPage(filter);
    const conds = [];
    if (filter?.roomId) conds.push(eq(games.roomId, filter.roomId));
    if (filter?.from) conds.push(gte(games.startedAt, filter.from));
    if (filter?.to) conds.push(lte(games.startedAt, filter.to));
    const where = conds.length ? and(...conds) : undefined;
    const [totalRow, rows] = await Promise.all([
      this.db.select({ value: count() }).from(games).where(where),
      this.db.select().from(games).where(where).orderBy(desc(games.startedAt)).limit(size).offset(offset),
    ]);
    const mapped = rows.map(mapGame);
    const ids = mapped.map((g) => g.gameId);
    const countRows = ids.length
      ? await this.db.select({ gameId: gameActions.gameId, c: count() }).from(gameActions).where(inArray(gameActions.gameId, ids)).groupBy(gameActions.gameId)
      : [];
    const ac = new Map(countRows.map((r) => [r.gameId, Number(r.c)]));
    return { items: mapped.map((game) => ({ game, actionCount: ac.get(game.gameId) ?? 0 })), total: Number(totalRow[0]?.value ?? 0), page, size };
  }

  async getGameDetail(gameId: string): Promise<{ game: GameRow | null; actionCount: number }> {
    const game = await this.replay.getGame(gameId);
    const rows = await this.db.select({ value: count() }).from(gameActions).where(eq(gameActions.gameId, gameId));
    return { game, actionCount: Number(rows[0]?.value ?? 0) };
  }

  replaySource(): ReplaySource {
    return this.replay;
  }
}
