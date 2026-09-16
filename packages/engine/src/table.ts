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
export function createTable(dealerSeat: number, seed: number, seats = [0, 1, 2, 3]): TableState {
  const wall = shuffle(fullWall(), seed);
  const players: PlayerState[] = seats.map((s) => ({
    seat: s,
    concealed: {},
    melds: [],
    flowers: [],
    zi: 0,
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
