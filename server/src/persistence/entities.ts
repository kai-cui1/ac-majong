import type { Action, RoundSnapshot, TileId } from '@ac-majong/engine';

/** 存储实体（对应 MySQL 6 表）+ 持久/热存储契约。见架构文档 §11.3。 */

export type ScoreMap = Record<number, number>;
export type RoomStatus = 'idle' | 'playing' | 'closed';
export type EndType = 'win' | 'exhaustive';
export type MemberEventType = 'create' | 'join' | 'leave' | 'ready';

export interface UserRow {
  openid: string;
  nickname: string;
  avatarUrl: string;
  createdAt?: Date;
  lastLoginAt?: Date | null;
}

export interface RoomRow {
  roomId: string;
  hostOpenid: string;
  maxRounds: number;
  initialScore: ScoreMap;
  finalScore: ScoreMap | null;
  status: RoomStatus;
  createdAt?: Date;
  closedAt?: Date | null;
}

export interface MemberEventRow {
  roomId: string;
  openid: string;
  seat: number | null;
  event: MemberEventType;
  at?: Date;
}

export interface GameRow {
  gameId: string;
  roomId: string;
  roundNo: number;
  dealerSeat: number;
  seed: number;
  endType: EndType | null;
  result: unknown | null;
  startedAt?: Date;
  endedAt?: Date | null;
}

export interface InitialStateRow {
  gameId: string;
  wall: TileId[];
  hands: RoundSnapshot['players'];
  lianzhuangCount: number;
}

export interface ActionRow {
  gameId: string;
  seq: number;
  seat: number | null;
  actionType: string;
  payload: Action;
  at?: Date;
}

export interface SessionData {
  openid: string;
  createdAt: number;
}

/** 持久（MySQL）存储契约：用户 / 房间 / 成员事件 / 对局 / 初始快照 / 动作日志 */
export interface GameStore {
  upsertUser(u: UserRow): Promise<void>;
  getUser(openid: string): Promise<UserRow | null>;

  createRoom(r: RoomRow): Promise<void>;
  getRoom(roomId: string): Promise<RoomRow | null>;
  closeRoom(roomId: string, finalScore: ScoreMap, closedAt: Date): Promise<void>;

  addMemberEvent(e: MemberEventRow): Promise<void>;
  listMemberEvents(roomId: string): Promise<MemberEventRow[]>;

  createGame(g: GameRow): Promise<void>;
  saveInitialState(s: InitialStateRow): Promise<void>;
  appendActions(rows: ActionRow[]): Promise<void>;
  finishGame(gameId: string, endType: EndType, result: unknown, endedAt: Date): Promise<void>;
  getGame(gameId: string): Promise<GameRow | null>;
  getInitialState(gameId: string): Promise<InitialStateRow | null>;
  listActions(gameId: string): Promise<ActionRow[]>;
  listGames(roomId: string): Promise<GameRow[]>;

  close(): Promise<void>;
}

/** 热（Redis）实时存储契约：会话 / 房间快照 / 实例路由 / 动作缓冲 */
export interface RealtimeStore {
  saveSession(token: string, data: SessionData, ttlSec: number): Promise<void>;
  getSession(token: string): Promise<SessionData | null>;
  delSession(token: string): Promise<void>;

  saveRoomSnapshot(roomId: string, viewJson: string): Promise<void>;
  getRoomSnapshot(roomId: string): Promise<string | null>;

  setRoomInstance(roomId: string, instanceId: string): Promise<void>;
  getRoomInstance(roomId: string): Promise<string | null>;

  bufferActions(gameId: string, rows: ActionRow[]): Promise<void>;
  drainActions(gameId: string): Promise<ActionRow[]>;

  close(): Promise<void>;
}

/** 由 games + game_initial_states 组装 replay 用的 RoundSnapshot（currentSeat 开局=庄家） */
export function toRoundSnapshot(g: GameRow, s: InitialStateRow): RoundSnapshot {
  return {
    wall: s.wall,
    players: s.hands,
    dealerSeat: g.dealerSeat,
    currentSeat: g.dealerSeat,
    lianzhuangCount: s.lianzhuangCount,
    round: g.roundNo,
  };
}
