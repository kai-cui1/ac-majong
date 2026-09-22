import type { Action, RoundSnapshot, TileId } from '@ac-majong/engine';
import type { RoomSettings } from '@ac-majong/protocol';

/** 存储实体（对应 MySQL 6 表）+ 持久/热存储契约。见架构文档 §11.3。 */

export type ScoreMap = Record<number, number>;
export type RoomStatus = 'idle' | 'playing' | 'closed';
export type EndType = 'win' | 'exhaustive';
export type MemberEventType = 'create' | 'join' | 'leave' | 'ready';

export interface UserRow {
  openid: string;
  nickname: string;
  avatarUrl: string;
  /** H5 账号路线：scrypt 哈希串；微信/mock 路线为 null */
  passHash?: string | null;
  createdAt?: Date;
  lastLoginAt?: Date | null;
}

export interface RoomRow {
  roomId: string;
  hostOpenid: string;
  maxRounds: number;
  initialScore: ScoreMap;
  /** 局中积分账本 {[seat]:score}：每局末更新，重进/服务重启恢复依据（BL-016） */
  memberScores?: ScoreMap | null;
  /** BL-017 房间玩法参数（建房设定，开局后不可改） */
  settings?: RoomSettings | null;
  /** BL-017 开局仪式日志（选位骰/选座/定庄骰/摸牌位骰，事件溯源可复现） */
  seating?: unknown | null;
  /** BL-031（FR-AI-11）座位→Bot 打法 personaId：重进/重启恢复 */
  botPersonas?: Record<number, string> | null;
  /** BL-031（FR-AI-11）userId→托管打法预设：重进/重启恢复 */
  trusteePersonas?: Record<string, string> | null;
  finalScore: ScoreMap | null;
  status: RoomStatus;
  createdAt?: Date;
  closedAt?: Date | null;
}

/** BL-031/FR-房间-12：房间元信息增量更新 patch（仅更新提供的字段） */
export interface RoomMetaPatch {
  maxRounds?: number;
  settings?: RoomSettings | null;
  botPersonas?: Record<number, string> | null;
  trusteePersonas?: Record<string, string> | null;
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
  /** BL-017 physical 模式：固化物理牌墙 4 排×36 张 */
  layout?: TileId[][] | null;
  /** BL-017：开牌点跳组数 */
  breakGroup?: number | null;
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
  /** BL-016：房号全局唯一——发号前对照历史表查重（永不复用） */
  roomIdExists(roomId: string): Promise<boolean>;
  /** BL-016：开局置 status='playing'（重进/重建判定依据） */
  markRoomPlaying(roomId: string): Promise<void>;
  /** BL-016：每局末写积分账本 member_scores */
  updateRoomScores(roomId: string, memberScores: ScoreMap): Promise<void>;
  /** BL-017：开局仪式结束落 seating 日志 */
  updateRoomSeating(roomId: string, seating: unknown): Promise<void>;
  /** BL-031/FR-房间-12/FR-AI-11：房间元信息增量落库（局数/玩法/Bot打法/托管预设） */
  updateRoomMeta(roomId: string, patch: RoomMetaPatch): Promise<void>;
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
  /** BL-012：按 openid 查本人参赛房间（房主或入座成员，创建时间倒序） */
  listRoomsByPlayer(openid: string): Promise<RoomRow[]>;

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
  /** BL-016：非破坏性查看未落盘动作缓冲（服务重启后事件溯源重建用） */
  peekActions(gameId: string): Promise<ActionRow[]>;

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
    layout: s.layout ?? undefined,
    breakGroups: s.breakGroup ?? undefined,
    initialWallLen: s.layout ? 144 : undefined,
  };
}
