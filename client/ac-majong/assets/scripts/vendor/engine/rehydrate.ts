import type { Meld, TileId } from './types';
import type { TableState } from './table';
import type { Action, GameEvent } from './reducer';
import { applyAction } from './reducer';
import type { WallOpts } from './table';

/**
 * 一局开始时的「业务事实」快照（事件溯源的还原锚点）。
 * 只存发牌后的**剩余牌墙 + 各家起手**，不含任何"每步 TableState"；
 * 且**算法无关**——重建不依赖洗牌/发牌算法（seed 仅作交叉校验），保证长期可还原（对应架构风险 A8）。
 */
export interface RoundSnapshot {
  /** 发牌 + 补花后的剩余牌墙（末尾 DEAD_WALL 张为死牌） */
  wall: TileId[];
  players: {
    seat: number;
    concealed: Record<TileId, number>;
    melds: Meld[];
    flowers: TileId[];
    zi: number;
    score: number;
  }[];
  dealerSeat: number;
  currentSeat: number;
  lianzhuangCount: number;
  round: number;
  /** BL-017 physical 模式：固化物理牌墙 + 开牌点（回放/重建展示依据） */
  layout?: TileId[][];
  breakGroups?: number;
  initialWallLen?: number;
}

const cloneMelds = (ms: Meld[]): Meld[] => ms.map((m) => ({ ...m, tiles: [...m.tiles] }));

/** 由一局开始时的 TableState 抽取快照（服务端在每局开始时调用并落库 game_initial_states） */
export function snapshotRound(s: TableState): RoundSnapshot {
  return {
    wall: [...s.wall],
    players: s.players.map((p) => ({
      seat: p.seat,
      concealed: { ...p.concealed },
      melds: cloneMelds(p.melds),
      flowers: [...p.flowers],
      zi: p.zi,
      score: p.score,
    })),
    dealerSeat: s.dealerSeat,
    currentSeat: s.currentSeat,
    lianzhuangCount: s.lianzhuangCount,
    round: s.round,
    layout: s.layout ? s.layout.map((r) => [...r]) : undefined,
    breakGroups: s.breakGroups,
    initialWallLen: s.initialWallLen,
  };
}

/**
 * 从快照重建 TableState（算法无关）。
 * 前置：快照取自「一局开始」时刻（phase='discard'、currentSeat=庄家、无弃牌/响应）。
 */
export function rehydrate(snap: RoundSnapshot): TableState {
  return {
    wall: [...snap.wall],
    players: snap.players.map((p) => ({
      seat: p.seat,
      concealed: { ...p.concealed },
      melds: cloneMelds(p.melds),
      flowers: [...p.flowers],
      zi: p.zi,
      score: p.score,
    })),
    dealerSeat: snap.dealerSeat,
    currentSeat: snap.currentSeat,
    phase: 'discard',
    lastDiscard: null,
    discards: [],
    lastDrawn: null,
    pending: {},
    robKong: null,
    lianzhuangCount: snap.lianzhuangCount,
    round: snap.round,
    layout: snap.layout ? snap.layout.map((r) => [...r]) : undefined,
    breakGroups: snap.breakGroups,
    initialWallLen: snap.initialWallLen,
  };
}

/**
 * 回放：从快照 + 有序动作日志重建整局，返回最终状态与全部事件。
 * 前端「对局回放 UI」的数据源；纯函数、确定性，等价于实时对局的最终结果。
 */
export function replayRound(
  snap: RoundSnapshot,
  actions: Action[],
): { state: TableState; events: GameEvent[] } {
  let state = rehydrate(snap);
  const events: GameEvent[] = [];
  for (const a of actions) {
    const r = applyAction(state, a);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}
