import type { Meld, TileId } from './types';
import { fullWall, isFlower } from './tiles';

export const DEAD_WALL = 4; // 末尾死牌张数（不摸 → 荒庄）
export const RESTRICT_TAIL = 8; // 剩 ≤8 张：禁吃/碰/碰杠，可摸杠

export interface PlayerState {
  seat: number;
  concealed: Record<TileId, number>; // 暗牌计数
  melds: Meld[]; // 成型副
  flowers: TileId[]; // 花区
  zi: number; // 子数
  score: number; // 积分
}

export type Phase = 'draw' | 'discard' | 'response' | 'settled' | 'exhaustive';

export interface Discard {
  seat: number;
  tile: TileId;
}

/** 他家对弃牌的响应意图 */
export interface Response {
  move: 'win' | 'pong' | 'kong_exposed' | 'chi' | 'pass';
  chiTiles?: TileId[]; // 吃时选用的两张手牌
}

export interface TableState {
  wall: TileId[]; // 剩余牌墙（末尾 DEAD_WALL 张为死牌）
  players: PlayerState[];
  dealerSeat: number;
  currentSeat: number;
  phase: Phase;
  lastDiscard: Discard | null;
  /** 全局有序弃牌河（被吃/碰/杠收走的牌会移除），供客户端渲染中央牌河 */
  discards: Discard[];
  /** 最近一次摸牌（自摸胡时定位胡张 + 补牌来源，用于杠开/花开/海底捞） */
  lastDrawn: {
    seat: number;
    tile: TileId;
    viaKong?: boolean;
    viaFlower?: boolean;
    wasLastDrawable?: boolean;
  } | null;
  /** 响应阶段：各座位意图（null=待响应） */
  pending: Record<number, Response | null>;
  /** 抢杠胡待响应：某家加杠的牌可被他家抢杠胡 */
  robKong?: { seat: number; tile: TileId } | null;
  lianzhuangCount: number;
  round: number;
  /** BL-017 physical 模式：固化物理牌墙 4 排×36 张（排=seat0..3，排内自右端 g1 起 [上,下] 成组） */
  layout?: TileId[][];
  /** BL-017：开牌点跳组数（庄家排右端起跳 N 组）；0=右端第 1 组开摸 */
  breakGroups?: number;
  /** BL-017：发牌前牌墙总张数（展示层按已摸张数推算各排栈高） */
  initialWallLen?: number;
}

export function addTile(c: Record<TileId, number>, t: TileId): void {
  c[t] = (c[t] ?? 0) + 1;
}
export function removeTile(c: Record<TileId, number>, t: TileId): void {
  const n = (c[t] ?? 0) - 1;
  if (n <= 0) delete c[t];
  else c[t] = n;
}
export function countTile(c: Record<TileId, number>, t: TileId): number {
  return c[t] ?? 0;
}
export function countAll(c: Record<TileId, number>): number {
  return Object.values(c).reduce((s, n) => s + n, 0);
}

/** 确定性洗牌（mulberry32），便于测试复现 */
export function shuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

export function wallRemaining(state: TableState): number {
  return Math.max(0, state.wall.length - DEAD_WALL);
}
/** 是否进入末尾限制（剩 ≤8 张） */
export function isTailRestricted(state: TableState): boolean {
  return wallRemaining(state) <= RESTRICT_TAIL;
}
export function isExhaustive(state: TableState): boolean {
  return wallRemaining(state) <= 0;
}

/** 建桌并发牌：庄 17 / 闲 16，处理花（移花 + 补摸），庄家先进入出牌阶段 */
export function createTable(dealerSeat: number, seed: number, seats = [0, 1, 2, 3], opts?: WallOpts): TableState {
  const wall = opts?.layout
    ? drawOrderFromLayout(opts.layout, dealerSeat, opts.breakGroups ?? 0)
    : shuffle(fullWall(), seed);
  const initialWallLen = wall.length;
  const players: PlayerState[] = seats.map((s) => ({
    seat: s,
    concealed: {},
    melds: [],
    flowers: [],
    zi: opts?.initialZi?.[s] ?? 0, // BL-017 仪式子（选位最大者上子/首庄庄子）
    score: 0,
  }));
  for (const p of players) {
    const n = p.seat === dealerSeat ? 17 : 16;
    for (let i = 0; i < n; i++) addTile(p.concealed, wall.shift()!);
  }
  // 花处理：移入花区并从可摸区补摸，直到手中无花
  let any = true;
  while (any) {
    any = false;
    for (const p of players) {
      const fs = Object.keys(p.concealed).filter((t) => isFlower(t));
      if (fs.length > 0) any = true;
      for (const f of fs) {
        const n = p.concealed[f]!;
        delete p.concealed[f];
        for (let i = 0; i < n; i++) {
          p.flowers.push(f);
          if (wall.length > DEAD_WALL) addTile(p.concealed, wall.shift()!);
        }
      }
    }
  }
  return {
    wall,
    players,
    dealerSeat,
    currentSeat: dealerSeat,
    phase: 'discard',
    lastDiscard: null,
    discards: [],
    lastDrawn: null,
    pending: {},
    robKong: null,
    lianzhuangCount: 0,
    round: 1,
    layout: opts?.layout ? opts.layout.map((r) => [...r]) : undefined,
    breakGroups: opts?.layout ? (opts.breakGroups ?? 0) : undefined,
    initialWallLen: opts?.layout ? initialWallLen : undefined,
  };
}

// ============ BL-017 物理牌墙与开牌点 ============

export const GROUPS_PER_ROW = 18; // 每排 18 组（144 张 = 4 排 × 36 张）

/** 建墙选项：physical 模式传 layout+breakGroups；仪式子传 initialZi */
export interface WallOpts {
  layout?: TileId[][];
  breakGroups?: number;
  initialZi?: Record<number, number>;
}

/** 预生成固化物理牌墙：shuffle 后按 seat 0..3 切 4 排 × 36 张（排内自右端 g1 起 [上,下] 成组） */
export function buildPhysicalLayout(seed: number): TileId[][] {
  const flat = shuffle(fullWall(), seed);
  const rows: TileId[][] = [];
  for (let r = 0; r < 4; r++) rows.push(flat.slice(r * 36, (r + 1) * 36));
  return rows;
}

/**
 * 开牌点 → 线性摸牌序列：庄家排 g(N+1)..18 → 上手家排 g1..18 → 再上手 → 再上手 → 庄家排 g1..N（循环末尾摸到跳区）；
 * 组内先上后下；排尽续**上手家**排（2026-09-18 用户确认）。
 */
export function drawOrderFromLayout(layout: TileId[][], dealerSeat: number, breakGroups = 0): TileId[] {
  const n = Math.max(0, Math.min(GROUPS_PER_ROW - 1, breakGroups));
  const rowOrder = [0, 1, 2, 3].map((k) => (dealerSeat - k + 4) % 4);
  const out: TileId[] = [];
  const pushGroup = (row: TileId[], g: number): void => {
    out.push(row[(g - 1) * 2]!, row[(g - 1) * 2 + 1]!);
  };
  const first = layout[rowOrder[0]!]!;
  for (let g = n + 1; g <= GROUPS_PER_ROW; g++) pushGroup(first, g);
  for (let k = 1; k < 4; k++) {
    const row = layout[rowOrder[k]!]!;
    for (let g = 1; g <= GROUPS_PER_ROW; g++) pushGroup(row, g);
  }
  for (let g = 1; g <= n; g++) pushGroup(first, g);
  return out;
}

/** 展示层：按已摸张数推算各排栈高（0/1/2，补花/杠补摸顺序消耗故可为 1）；random 模式返 null */
export function wallInfo(state: TableState): { rows: { seat: number; stacks: number[] }[]; breakSeat: number; breakGroups: number } | null {
  if (!state.layout || state.initialWallLen == null) return null;
  const n = state.breakGroups ?? 0;
  const dealerSeat = state.dealerSeat;
  const rowOrder = [0, 1, 2, 3].map((k) => (dealerSeat - k + 4) % 4);
  const seq: { row: number; g: number }[] = [];
  for (let g = n + 1; g <= GROUPS_PER_ROW; g++) seq.push({ row: rowOrder[0]!, g });
  for (let k = 1; k < 4; k++) for (let g = 1; g <= GROUPS_PER_ROW; g++) seq.push({ row: rowOrder[k]!, g });
  for (let g = 1; g <= n; g++) seq.push({ row: rowOrder[0]!, g });
  let left = Math.max(0, state.initialWallLen - state.wall.length);
  const heights = new Map<number, number[]>();
  for (let s = 0; s < 4; s++) heights.set(s, new Array<number>(GROUPS_PER_ROW).fill(2));
  for (const { row, g } of seq) {
    const take = Math.min(2, left);
    left -= take;
    heights.get(row)![g - 1] = 2 - take;
    if (left <= 0) break;
  }
  return {
    rows: [0, 1, 2, 3].map((seat) => ({ seat, stacks: heights.get(seat)! })),
    breakSeat: dealerSeat,
    breakGroups: n,
  };
}

export function getPlayer(state: TableState, seat: number): PlayerState {
  const p = state.players.find((x) => x.seat === seat);
  if (!p) throw new Error(`座位不存在: ${seat}`);
  return p;
}
export function nextSeat(state: TableState, seat: number): number {
  const i = state.players.findIndex((p) => p.seat === seat);
  return state.players[(i + 1) % state.players.length]!.seat;
}
