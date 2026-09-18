import type { Action, GameEvent, ActionKind, Meld, TableState } from '@ac-majong/engine';

// 便捷再导出，客户端无需直接依赖 engine 也能拿到这些类型
export type { Action, GameEvent, ActionKind, Meld };

/** 对局阶段（房间层） */
export type RoomPhase = 'waiting' | 'seating' | 'playing' | 'finished';

/** BL-017 房间玩法参数（建房时房主设定，开局后不可改） */
export interface RoomSettings {
  /** 牌墙模式：physical=物理牌墙固化展示 / random=随机发牌（默认） */
  wallMode: 'physical' | 'random';
  /** 摸牌位骰：每局庄家掷骰定开牌点（默认关） */
  breakDice: boolean;
}

/** BL-017 开局仪式/摸牌位骰视图（roomView 与 gameView 共用下发） */
export interface SeatingView {
  stage: 'roll' | 'pick' | 'dealerDice' | 'breakDice' | 'roundBreak';
  /** 各座位当前骰点和（未掷=null，按现座位下标） */
  rolls: (number | null)[];
  /** 同点待重掷标记 */
  reroll: boolean[];
  /** 选位顺序（点数降序的座位列表，roll 完成后下发） */
  order: number[];
  picker: number | null;
  picked: number | null;
  dealerDice: number | null;
  dealerSeat: number | null;
  breakN: number | null;
  /** roundBreak 阶段：待掷摸牌位骰的庄家 */
  roller: number | null;
}

/**
 * 按座位裁剪后的牌桌视图（服务端 → 客户端）。
 * 防透视关键：`you.concealed` 给完整暗牌；`others` 只给 `concealedCount`，绝不含具体牌。
 */
export interface ViewState {
  room: string;
  round: number;
  /** 本房间总局数上限（用于客户端判断“下一局/对局结束”与进度显示） */
  maxRounds: number;
  /** 各家展示昵称（下标=座位），供 pinfo 显示真实昵称（M-还原度） */
  names: string[];
  phase: TableState['phase'];
  dealerSeat: number;
  currentSeat: number;
  wallRemaining: number;
  lianzhuangCount: number;
  lastDiscard: { seat: number; tile: string } | null;
  /** 全局有序弃牌河（公开信息），供客户端渲染中央牌河 */
  discards: { seat: number; tile: string }[];
  you: {
    seat: number;
    concealed: Record<string, number>;
    /** 刚摸到的牌（仅自己回合 discard 相位下发，供客户端「抽出抬高」显示）；其余为 null */
    drawn: string | null;
    melds: Meld[];
    flowers: string[];
    zi: number;
    score: number;
    legal: ActionKind[];
  };
  others: {
    seat: number;
    concealedCount: number;
    melds: Meld[];
    flowersCount: number;
    zi: number;
    score: number;
  }[];
  /** BL-017 physical 模式：四边牌墙栈高（0/1/2）+ 开牌点；random 模式无此字段 */
  wallInfo?: {
    rows: { seat: number; stacks: number[] }[];
    breakSeat: number;
    breakGroups: number;
  };
  /** BL-017：局间摸牌位骰阶段（roundBreak）随 gameView 下发 */
  seating?: SeatingView;
}

/** 房间/等待页视图 */
export interface RoomView {
  room: string;
  phase: RoomPhase;
  hostUserId: string;
  maxRounds: number;
  /** BL-017 房间玩法参数 */
  settings?: RoomSettings;
  /** BL-017 开局仪式视图（phase=seating 时下发） */
  seating?: SeatingView;
  seats: ({ userId: string; seat: number; isBot?: boolean; offline?: boolean; trusteed?: boolean } | null)[];
}

/** 散场原因：打满局数上限 / 房主主动解散（不限局数时） */
export type RoomEndReason = 'maxRounds' | 'dissolve';

/** 散场最终排名（单家）：座位 + 累计积分 + 胡牌局数（散场战绩页 P8 用） */
export interface FinalStanding {
  seat: number;
  userId: string;
  isBot: boolean;
  score: number;
  wins: number;
}

/** 单局回顾（散场战绩页局数列表用）：胡牌则记赢家/台数/最高番种/自摸，荒庄则 winnerSeat=null */
export interface RoundReview {
  round: number;
  endType: 'win' | 'exhaustive';
  winnerSeat: number | null;
  tai: number;
  topFan: string | null;
  zimo: boolean;
}

/** 用户展示资料：昵称/头像由客户端上报，身份（openid）由服务端校验（微信下 openid 权威） */
export interface UserProfile {
  nickname: string;
  avatarUrl: string;
}

/** BL-012：回放列表——单局摘要 */
export interface ReplayRoundSummary {
  gameId: string;
  roundNo: number;
  endType: 'win' | 'exhaustive';
  winnerSeats: number[];
  /** 座位号 → 赢牌台数（荒庄为空） */
  taiBySeat: Record<number, number>;
  /** 结束时间 ISO */
  at: string | null;
}
/** BL-012：回放列表——房间级（房间→局） */
export interface ReplayRoomSummary {
  roomId: string;
  createdAt: string;
  status: string;
  /** 座位号 → 昵称（列表行显示赢家用，机器人为空） */
  seatNames: Record<number, string>;
  rounds: ReplayRoundSummary[];
}
/** BL-012：起始快照（与引擎 RoundSnapshot 同构，避免协议包依赖 engine） */
export interface ReplaySnapshot {
  wall: string[];
  players: { seat: number; concealed: Record<string, number>; melds: unknown[]; flowers: string[]; zi: number; score: number }[];
  dealerSeat: number;
  currentSeat: number;
  lianzhuangCount: number;
  round: number;
}
/** BL-012：回放的单个动作行（action 为引擎 Action 的 JSON，客户端自行断言） */
export interface ReplayActionRow {
  seq: number;
  seat: number | null;
  action: unknown;
}

/** 客户端 → 服务端 */
export type ClientMsg =
  | { t: 'auth'; seq: number; token?: string; account?: { username: string; password: string }; profile?: UserProfile }
  | { t: 'create'; seq: number; maxRounds?: number; settings?: RoomSettings }
  | { t: 'join'; seq: number; room: string }
  | { t: 'leave'; seq: number }
  | { t: 'start'; seq: number }
  | { t: 'roll'; seq: number }              // BL-017：掷骰（选位/定庄/摸牌位，语境由服务端阶段决定）
  | { t: 'pickSeat'; seq: number; seat: number } // BL-017：选位最大者选座
  | { t: 'addBot'; seq: number; count?: number }
  | { t: 'removeBot'; seq: number; seat: number }
  | { t: 'nextRound'; seq: number }
  | { t: 'dissolve'; seq: number }
  | { t: 'action'; seq: number; action: Action }
  | { t: 'replayList'; seq: number }                // BL-012：战绩/回放列表（房间→局）
  | { t: 'replayLoad'; seq: number; gameId: string } // BL-012：加载单局回放（参赛四方可看，D-29）
  | { t: 'ping'; seq: number };

/** 服务端 → 客户端 */
export type ServerMsg =
  | { t: 'authOk'; userId: string; profile: UserProfile; session?: string }
  | { t: 'roomView'; room: RoomView }
  | { t: 'gameView'; view: ViewState }
  | { t: 'event'; events: GameEvent[] }
  | { t: 'roomEnd'; room: string; reason: RoomEndReason; standings: FinalStanding[]; rounds: RoundReview[] }
  | { t: 'legal'; seat: number; actions: ActionKind[] }
  | { t: 'ack'; seq: number; ok: boolean; reason?: string }
  /** BL-012：回放列表（仅本人参赛房间；房间→局两级） */
  | { t: 'replayList'; rooms: ReplayRoomSummary[] }
  /** BL-012：单局回放数据（起始快照+动作序列；names=座号→昵称；客户端 rehydrate+applyAction 确定性重演） */
  | { t: 'replayData'; gameId: string; snapshot: ReplaySnapshot; actions: ReplayActionRow[]; names: Record<number, string>; viewSeat: number }
  | { t: 'pong' }
  | { t: 'error'; reason: string };
