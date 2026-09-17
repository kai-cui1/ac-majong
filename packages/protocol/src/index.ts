import type { Action, GameEvent, ActionKind, Meld, TableState } from '@ac-majong/engine';

// 便捷再导出，客户端无需直接依赖 engine 也能拿到这些类型
export type { Action, GameEvent, ActionKind, Meld };

/** 对局阶段（房间层） */
export type RoomPhase = 'waiting' | 'playing' | 'finished';

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
}

/** 房间/等待页视图 */
export interface RoomView {
  room: string;
  phase: RoomPhase;
  hostUserId: string;
  maxRounds: number;
  seats: ({ userId: string; seat: number; isBot?: boolean } | null)[];
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

/** 客户端 → 服务端 */
export type ClientMsg =
  | { t: 'auth'; seq: number; token: string; profile?: UserProfile }
  | { t: 'create'; seq: number; maxRounds?: number }
  | { t: 'join'; seq: number; room: string }
  | { t: 'leave'; seq: number }
  | { t: 'start'; seq: number }
  | { t: 'addBot'; seq: number; count?: number }
  | { t: 'removeBot'; seq: number; seat: number }
  | { t: 'nextRound'; seq: number }
  | { t: 'dissolve'; seq: number }
  | { t: 'action'; seq: number; action: Action }
  | { t: 'ping'; seq: number };

/** 服务端 → 客户端 */
export type ServerMsg =
  | { t: 'authOk'; userId: string; profile: UserProfile }
  | { t: 'roomView'; room: RoomView }
  | { t: 'gameView'; view: ViewState }
  | { t: 'event'; events: GameEvent[] }
  | { t: 'roomEnd'; room: string; reason: RoomEndReason; standings: FinalStanding[]; rounds: RoundReview[] }
  | { t: 'legal'; seat: number; actions: ActionKind[] }
  | { t: 'ack'; seq: number; ok: boolean; reason?: string }
  | { t: 'pong' }
  | { t: 'error'; reason: string };
