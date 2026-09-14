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
  phase: TableState['phase'];
  dealerSeat: number;
  currentSeat: number;
  wallRemaining: number;
  lianzhuangCount: number;
  lastDiscard: { seat: number; tile: string } | null;
  you: {
    seat: number;
    concealed: Record<string, number>;
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
  seats: ({ userId: string; seat: number } | null)[];
}

/** 客户端 → 服务端 */
export type ClientMsg =
  | { t: 'auth'; seq: number; token: string }
  | { t: 'create'; seq: number; maxRounds?: number }
  | { t: 'join'; seq: number; room: string }
  | { t: 'leave'; seq: number }
  | { t: 'start'; seq: number }
  | { t: 'action'; seq: number; action: Action }
  | { t: 'ping'; seq: number };

/** 服务端 → 客户端 */
export type ServerMsg =
  | { t: 'authOk'; userId: string }
  | { t: 'roomView'; room: RoomView }
  | { t: 'gameView'; view: ViewState }
  | { t: 'event'; events: GameEvent[] }
  | { t: 'legal'; seat: number; actions: ActionKind[] }
  | { t: 'ack'; seq: number; ok: boolean; reason?: string }
  | { t: 'pong' }
  | { t: 'error'; reason: string };
