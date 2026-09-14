import type { TileId, Hand } from './types';
import type { TableState, Response } from './table';
import {
  addTile,
  removeTile,
  getPlayer,
  nextSeat,
  wallRemaining,
  isExhaustive,
  DEAD_WALL,
  createTable,
} from './table';
import { legalActions } from './actions';
import { scoreAndSettle } from './pipeline';
import { isFlower } from './tiles';

export type Action =
  | { type: 'draw'; seat: number }
  | { type: 'discard'; seat: number; tile: TileId }
  | { type: 'declareWin'; seat: number } // 自摸
  | { type: 'kongConcealed'; seat: number; tile: TileId }
  | { type: 'kongAdded'; seat: number; tile: TileId }
  | { type: 'respond'; seat: number; move: Response['move']; chiTiles?: TileId[] };

export type GameEvent =
  | { type: 'drawn'; seat: number; tile: TileId }
  | { type: 'flower'; seat: number; tile: TileId }
  | { type: 'discarded'; seat: number; tile: TileId }
  | { type: 'responseNeeded'; seats: number[] }
  | { type: 'melded'; seat: number; move: string; tiles: TileId[] }
  | { type: 'kong'; seat: number; kind: string; tile: TileId }
  | { type: 'advance'; seat: number }
  | { type: 'win'; winners: { seat: number; tai: number }[]; delta: Record<number, number> }
  | { type: 'zhahu'; seat: number }
  | { type: 'exhaustive' }
  | { type: 'roundEnd'; dealerSeat: number; lianzhuangCount: number; round: number };

const seatList = (s: TableState) => s.players.map((p) => p.seat);

/** 可移植深拷贝（TableState 为纯数据，兼容 Node 与微信小游戏） */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** 纯函数状态机：应用一个动作 → 新状态 + 事件 */
export function applyAction(state: TableState, action: Action): { state: TableState; events: GameEvent[] } {
  const s = clone(state);
  const events: GameEvent[] = [];
  switch (action.type) {
    case 'draw':
      doDraw(s, action.seat, events);
      break;
    case 'discard':
      doDiscard(s, action.seat, action.tile, events);
      break;
    case 'declareWin':
      doSelfWin(s, action.seat, events);
      break;
    case 'kongConcealed':
      doKong(s, action.seat, action.tile, 'kong_concealed', events);
      break;
    case 'kongAdded':
      doKong(s, action.seat, action.tile, 'kong_added', events);
      break;
    case 'respond':
      doRespond(s, action.seat, action.move, action.chiTiles, events);
      break;
  }
  return { state: s, events };
}

/** 摸牌（含花补摸、荒庄） */
function doDraw(s: TableState, seat: number, events: GameEvent[]): void {
  const tile = drawWithFlowers(s, seat, events);
  if (tile == null) {
    doExhaustive(s, events);
    return;
  }
  addTile(getPlayer(s, seat).concealed, tile);
  s.lastDrawn = { seat, tile };
  s.currentSeat = seat;
  s.phase = 'discard';
  events.push({ type: 'drawn', seat, tile });
}

/** 从牌墙摸一张，遇花则移入花区并继续补摸；无可摸返回 null（荒庄） */
function drawWithFlowers(s: TableState, seat: number, events: GameEvent[]): TileId | null {
  while (true) {
    if (s.wall.length <= DEAD_WALL) return null;
    const tile = s.wall.shift()!;
    if (!isFlower(tile)) return tile;
    getPlayer(s, seat).flowers.push(tile);
    events.push({ type: 'flower', seat, tile });
  }
}

function doDiscard(s: TableState, seat: number, tile: TileId, events: GameEvent[]): void {
  removeTile(getPlayer(s, seat).concealed, tile);
  s.lastDiscard = { seat, tile };
  s.lastDrawn = null;
  events.push({ type: 'discarded', seat, tile });
  enterResponse(s, events);
}

/** 进入响应阶段：计算各家可响应动作；无人可响应则直接推进 */
function enterResponse(s: TableState, events: GameEvent[]): void {
  const discarder = s.lastDiscard!.seat;
  s.pending = {};
  s.phase = 'response';
  const actionable: number[] = [];
  for (const p of s.players) {
    if (p.seat === discarder) continue;
    const acts = legalActions(s, p.seat).filter((a) => a !== 'pass');
    if (acts.length > 0) {
      s.pending[p.seat] = null;
      actionable.push(p.seat);
    } else {
      s.pending[p.seat] = { move: 'pass' };
    }
  }
  if (actionable.length === 0) {
    advance(s, events);
    return;
  }
  events.push({ type: 'responseNeeded', seats: actionable });
}

function doRespond(s: TableState, seat: number, move: Response['move'], chiTiles: TileId[] | undefined, events: GameEvent[]): void {
  if (s.phase !== 'response') return;
  s.pending[seat] = { move, chiTiles };
  const awaiting = Object.values(s.pending).some((v) => v === null);
  if (!awaiting) resolveResponses(s, events);
}

/** 无人响应 → 推进到下家摸牌 */
function advance(s: TableState, events: GameEvent[]): void {
  const from = s.lastDiscard ? s.lastDiscard.seat : s.currentSeat;
  const next = nextSeat(s, from);
  s.lastDiscard = null;
  s.pending = {};
  s.currentSeat = next;
  s.phase = 'draw';
  events.push({ type: 'advance', seat: next });
}

/** 杠（暗杠/加杠）：亮副 + 补摸 */
function doKong(s: TableState, seat: number, tile: TileId, kind: 'kong_concealed' | 'kong_added', events: GameEvent[]): void {
  const p = getPlayer(s, seat);
  if (kind === 'kong_concealed') {
    for (let i = 0; i < 4; i++) removeTile(p.concealed, tile);
    p.melds.push({ type: 'kong_concealed', tiles: [tile, tile, tile, tile] });
  } else {
    removeTile(p.concealed, tile);
    const m = p.melds.find((x) => x.type === 'pong' && x.tiles[0] === tile);
    if (m) {
      m.type = 'kong_added';
      m.tiles.push(tile);
    }
    // TODO(3c)：加杠可被他家抢杠胡
  }
  events.push({ type: 'kong', seat, kind, tile });
  const rep = drawWithFlowers(s, seat, events); // 杠后补摸
  if (rep == null) {
    doExhaustive(s, events);
    return;
  }
  addTile(p.concealed, rep);
  s.lastDrawn = { seat, tile: rep };
  s.currentSeat = seat;
  s.phase = 'discard';
  // TODO(3c)：标记本次补摸来自杠 → 若胡则计杠开胡
  events.push({ type: 'drawn', seat, tile: rep });
}

// ================= 响应解析 =================

function seatsWithMove(s: TableState, move: Response['move']): number[] {
  return Object.entries(s.pending)
    .filter(([, r]) => r != null && r.move === move)
    .map(([seat]) => Number(seat));
}

function closestByTurn(s: TableState, from: number, candidates: number[]): number {
  let seat = from;
  for (let i = 0; i < s.players.length; i++) {
    seat = nextSeat(s, seat);
    if (candidates.includes(seat)) return seat;
  }
  return candidates[0]!;
}

/** 优先级：胡 > 碰/明杠 > 吃 > 过 */
function resolveResponses(s: TableState, events: GameEvent[]): void {
  const discarder = s.lastDiscard!.seat;
  const tile = s.lastDiscard!.tile;
  const winners = seatsWithMove(s, 'win');
  if (winners.length > 0) {
    resolveDiscardWin(s, winners, tile, discarder, events);
    return;
  }
  const pk = [...seatsWithMove(s, 'pong'), ...seatsWithMove(s, 'kong_exposed')];
  if (pk.length > 0) {
    const seat = closestByTurn(s, discarder, pk);
    if (s.pending[seat]!.move === 'pong') applyPong(s, seat, tile, events);
    else applyExposedKong(s, seat, tile, events);
    return;
  }
  const chi = seatsWithMove(s, 'chi');
  if (chi.length > 0) {
    applyChi(s, chi[0]!, tile, s.pending[chi[0]!]!.chiTiles ?? [], events);
    return;
  }
  advance(s, events);
}

function applyPong(s: TableState, seat: number, tile: TileId, events: GameEvent[]): void {
  const p = getPlayer(s, seat);
  removeTile(p.concealed, tile);
  removeTile(p.concealed, tile);
  p.melds.push({ type: 'pong', tiles: [tile, tile, tile] });
  s.lastDiscard = null;
  s.pending = {};
  s.currentSeat = seat;
  s.phase = 'discard';
  events.push({ type: 'melded', seat, move: 'pong', tiles: [tile, tile, tile] });
}

function applyExposedKong(s: TableState, seat: number, tile: TileId, events: GameEvent[]): void {
  const p = getPlayer(s, seat);
  for (let i = 0; i < 3; i++) removeTile(p.concealed, tile);
  p.melds.push({ type: 'kong_exposed', tiles: [tile, tile, tile, tile] });
  s.lastDiscard = null;
  s.pending = {};
  events.push({ type: 'kong', seat, kind: 'exposed', tile });
  const rep = drawWithFlowers(s, seat, events);
  if (rep == null) {
    doExhaustive(s, events);
    return;
  }
  addTile(p.concealed, rep);
  s.lastDrawn = { seat, tile: rep };
  s.currentSeat = seat;
  s.phase = 'discard';
  events.push({ type: 'drawn', seat, tile: rep });
}

function applyChi(s: TableState, seat: number, tile: TileId, chiTiles: TileId[], events: GameEvent[]): void {
  const p = getPlayer(s, seat);
  for (const t of chiTiles) removeTile(p.concealed, t);
  const meldTiles = [tile, ...chiTiles].sort();
  p.melds.push({ type: 'chi', tiles: meldTiles });
  s.lastDiscard = null;
  s.pending = {};
  s.currentSeat = seat;
  s.phase = 'discard';
  events.push({ type: 'melded', seat, move: 'chi', tiles: meldTiles });
}

// ================= 胡牌与结算 =================

function buildHand(s: TableState, seat: number, winTile: TileId, winBy: 'zimo' | 'dianpao', fromSeat?: number): Hand {
  const p = getPlayer(s, seat);
  const concealed = { ...p.concealed };
  if (winBy === 'dianpao') addTile(concealed, winTile);
  return {
    concealed,
    melds: p.melds,
    flowers: p.flowers,
    winTile,
    winBy,
    fromSeat,
    isDealer: seat === s.dealerSeat,
    wallRemaining: wallRemaining(s),
    lianzhuangCount: s.lianzhuangCount,
    seatsZi: Object.fromEntries(s.players.map((x) => [x.seat, x.zi])),
    flow: {}, // TODO(3c)：补牌胡/海底捞 flow 标记
  };
}

function applyDeltas(s: TableState, delta: Record<number, number>): void {
  for (const [seat, v] of Object.entries(delta)) getPlayer(s, Number(seat)).score += v;
}

function resolveDiscardWin(s: TableState, winners: number[], tile: TileId, discarder: number, events: GameEvent[]): void {
  const allDelta: Record<number, number> = {};
  const winTais: { seat: number; tai: number }[] = [];
  const zhahu: number[] = [];
  for (const seat of winners) {
    const hand = buildHand(s, seat, tile, 'dianpao', discarder);
    const { score, delta } = scoreAndSettle(hand, {
      winnerSeat: seat,
      dealerSeat: s.dealerSeat,
      discarderSeat: discarder,
      allSeats: seatList(s),
    });
    if (!score.win || score.zhaHu) {
      zhahu.push(seat);
      continue;
    }
    winTais.push({ seat, tai: score.total });
    for (const [k, v] of Object.entries(delta ?? {})) allDelta[Number(k)] = (allDelta[Number(k)] ?? 0) + v;
  }
  if (winTais.length === 0) {
    for (const seat of zhahu) applyZhahu(s, seat, events);
    return;
  }
  applyDeltas(s, allDelta);
  getPlayer(s, discarder).zi = 0; // 点炮方子清零
  events.push({ type: 'win', winners: winTais, delta: allDelta });
  // 一炮多响时按最近赢家轮庄（TODO：多家胡的轮庄规则待复核）
  endRound(s, closestByTurn(s, discarder, winTais.map((w) => w.seat)), events);
}

function doSelfWin(s: TableState, seat: number, events: GameEvent[]): void {
  if (s.phase !== 'discard' || s.currentSeat !== seat || s.lastDrawn == null) return;
  const tile = s.lastDrawn.tile;
  const hand = buildHand(s, seat, tile, 'zimo');
  const { score, delta } = scoreAndSettle(hand, { winnerSeat: seat, dealerSeat: s.dealerSeat, allSeats: seatList(s) });
  if (!score.win || score.zhaHu) {
    applyZhahu(s, seat, events);
    return;
  }
  applyDeltas(s, delta!);
  for (const p of s.players) if (p.seat !== seat) p.zi = 0; // 被自摸者子清零
  events.push({ type: 'win', winners: [{ seat, tai: score.total }], delta: delta! });
  endRound(s, seat, events);
}

function applyZhahu(s: TableState, seat: number, events: GameEvent[]): void {
  const others = s.players.length - 1;
  getPlayer(s, seat).score -= 300 * others;
  for (const p of s.players) if (p.seat !== seat) p.score += 300;
  events.push({ type: 'zhahu', seat });
  s.phase = 'settled';
  // TODO(3c)：诈胡后本局是否继续/如何轮庄待明确；M0 仅结算罚分
}

/** 局末轮庄：庄胡连庄、闲胡换庄（下家上庄）；上庄/连庄 +1 子 */
function endRound(s: TableState, winnerSeat: number, events: GameEvent[]): void {
  if (winnerSeat === s.dealerSeat) {
    s.lianzhuangCount += 1;
  } else {
    s.dealerSeat = nextSeat(s, s.dealerSeat);
    s.lianzhuangCount = 0;
  }
  getPlayer(s, s.dealerSeat).zi += 1; // 上庄/连庄 +1 子
  s.phase = 'settled';
  events.push({ type: 'roundEnd', dealerSeat: s.dealerSeat, lianzhuangCount: s.lianzhuangCount, round: s.round });
}

function doExhaustive(s: TableState, events: GameEvent[]): void {
  s.phase = 'exhaustive';
  s.lianzhuangCount += 1; // 荒庄庄家连庄
  getPlayer(s, s.dealerSeat).zi += 1;
  events.push({ type: 'exhaustive' });
  events.push({ type: 'roundEnd', dealerSeat: s.dealerSeat, lianzhuangCount: s.lianzhuangCount, round: s.round });
}

/** 开下一局：保留积分/子，重新发牌 */
export function startNextRound(state: TableState, seed: number): { state: TableState; events: GameEvent[] } {
  const savedScore = Object.fromEntries(state.players.map((p) => [p.seat, p.score]));
  const savedZi = Object.fromEntries(state.players.map((p) => [p.seat, p.zi]));
  const fresh = createTable(state.dealerSeat, seed, seatList(state));
  for (const p of fresh.players) {
    p.score = savedScore[p.seat] ?? 0;
    p.zi = savedZi[p.seat] ?? 0;
  }
  fresh.lianzhuangCount = state.lianzhuangCount;
  fresh.round = state.round + 1;
  return {
    state: fresh,
    events: [{ type: 'roundEnd', dealerSeat: fresh.dealerSeat, lianzhuangCount: fresh.lianzhuangCount, round: fresh.round }],
  };
}
