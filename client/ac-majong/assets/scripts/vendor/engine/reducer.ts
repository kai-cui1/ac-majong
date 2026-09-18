import type { TileId, Hand, ScoreDetail } from './types';
import type { TableState, Response, WallOpts } from './table';
import {
  addTile,
  removeTile,
  getPlayer,
  nextSeat,
  wallRemaining,
  isTailRestricted,
  DEAD_WALL,
  createTable,
} from './table';
import { legalActions, canWinDiscard } from './actions';
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
  | { type: 'win'; winners: { seat: number; tai: number; detail: ScoreDetail[] }[]; delta: Record<number, number>; revealed: Record<number, Record<string, number>> }
  | { type: 'zhahu'; seat: number; revealed: Record<number, Record<string, number>> }
  | { type: 'exhaustive'; revealed: Record<number, Record<string, number>> }
  | { type: 'roundEnd'; dealerSeat: number; lianzhuangCount: number; round: number };

const seatList = (s: TableState) => s.players.map((p) => p.seat);

/** 局末亮牌：各家暗牌计数表（对局结束后公开，供结算层展示） */
function revealedHands(s: TableState): Record<number, Record<string, number>> {
  return Object.fromEntries(s.players.map((p) => [p.seat, { ...p.concealed }]));
}

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

/** 摸牌（含花补摸、荒庄），并记录补牌来源 */
function doDraw(s: TableState, seat: number, events: GameEvent[]): void {
  const dr = drawWithFlowers(s, seat, events);
  if (dr == null) {
    doExhaustive(s, events);
    return;
  }
  addTile(getPlayer(s, seat).concealed, dr.tile);
  s.lastDrawn = { seat, tile: dr.tile, viaFlower: dr.viaFlower, wasLastDrawable: dr.wasLastDrawable };
  s.currentSeat = seat;
  s.phase = 'discard';
  events.push({ type: 'drawn', seat, tile: dr.tile });
}

interface DrawResult {
  tile: TileId;
  viaFlower: boolean;
  wasLastDrawable: boolean;
}

/** 从牌墙摸一张，遇花则移入花区并继续补摸；无可摸返回 null（荒庄） */
function drawWithFlowers(s: TableState, seat: number, events: GameEvent[]): DrawResult | null {
  let viaFlower = false;
  for (;;) {
    if (s.wall.length <= DEAD_WALL) return null;
    const tile = s.wall.shift()!;
    const wasLastDrawable = s.wall.length === DEAD_WALL; // 摸走后无可摸 → 本张为最后一张可摸牌
    if (isFlower(tile)) {
      viaFlower = true;
      getPlayer(s, seat).flowers.push(tile);
      events.push({ type: 'flower', seat, tile });
      continue;
    }
    return { tile, viaFlower, wasLastDrawable };
  }
}

function doDiscard(s: TableState, seat: number, tile: TileId, events: GameEvent[]): void {
  removeTile(getPlayer(s, seat).concealed, tile);
  s.lastDiscard = { seat, tile };
  s.discards.push({ seat, tile });
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

/** 杠：暗杠直接完成；加杠先给他家抢杠胡机会 */
function doKong(s: TableState, seat: number, tile: TileId, kind: 'kong_concealed' | 'kong_added', events: GameEvent[]): void {
  if (kind === 'kong_added') {
    const robbers = s.players.filter((p) => p.seat !== seat && canWinDiscard(p, tile));
    if (robbers.length > 0 && !isTailRestricted(s)) {
      s.robKong = { seat, tile };
      s.pending = {};
      s.phase = 'response';
      for (const p of s.players) {
        if (p.seat === seat) continue;
        s.pending[p.seat] = canWinDiscard(p, tile) ? null : { move: 'pass' };
      }
      events.push({ type: 'responseNeeded', seats: robbers.map((r) => r.seat) });
      return;
    }
    completeAddedKong(s, seat, tile, events);
    return;
  }
  const p = getPlayer(s, seat);
  for (let i = 0; i < 4; i++) removeTile(p.concealed, tile);
  p.melds.push({ type: 'kong_concealed', tiles: [tile, tile, tile, tile] });
  events.push({ type: 'kong', seat, kind: 'kong_concealed', tile });
  drawAfterKong(s, seat, events);
}

/** 完成加杠（碰→加杠）并补摸 */
function completeAddedKong(s: TableState, seat: number, tile: TileId, events: GameEvent[]): void {
  const p = getPlayer(s, seat);
  removeTile(p.concealed, tile);
  const m = p.melds.find((x) => x.type === 'pong' && x.tiles[0] === tile);
  if (m) {
    m.type = 'kong_added';
    m.tiles.push(tile);
  }
  events.push({ type: 'kong', seat, kind: 'kong_added', tile });
  drawAfterKong(s, seat, events);
}

/** 杠后补摸（标记 viaKong → 若胡则杠开胡） */
function drawAfterKong(s: TableState, seat: number, events: GameEvent[]): void {
  const dr = drawWithFlowers(s, seat, events);
  if (dr == null) {
    doExhaustive(s, events);
    return;
  }
  addTile(getPlayer(s, seat).concealed, dr.tile);
  s.lastDrawn = { seat, tile: dr.tile, viaKong: true, viaFlower: dr.viaFlower, wasLastDrawable: dr.wasLastDrawable };
  s.currentSeat = seat;
  s.phase = 'discard';
  events.push({ type: 'drawn', seat, tile: dr.tile });
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

/** 优先级：胡 > 碰/明杠 > 吃 > 过；抢杠响应单独解析 */
function resolveResponses(s: TableState, events: GameEvent[]): void {
  if (s.robKong) {
    resolveRobKong(s, events);
    return;
  }
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
  s.discards.pop();
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
  s.discards.pop();
  s.lastDiscard = null;
  s.pending = {};
  events.push({ type: 'kong', seat, kind: 'exposed', tile });
  drawAfterKong(s, seat, events);
}

function applyChi(s: TableState, seat: number, tile: TileId, chiTiles: TileId[], events: GameEvent[]): void {
  const p = getPlayer(s, seat);
  for (const t of chiTiles) removeTile(p.concealed, t);
  const meldTiles = [tile, ...chiTiles].sort();
  p.melds.push({ type: 'chi', tiles: meldTiles, called: tile }); // FR-对局-17：记录被吃牌供横置标记
  s.discards.pop();
  s.lastDiscard = null;
  s.pending = {};
  s.currentSeat = seat;
  s.phase = 'discard';
  events.push({ type: 'melded', seat, move: 'chi', tiles: meldTiles });
}

// ================= 胡牌与结算 =================

function buildHand(s: TableState, seat: number, winTile: TileId, winBy: 'zimo' | 'dianpao', fromSeat?: number, flow?: Hand['flow']): Hand {
  const p = getPlayer(s, seat);
  const concealed = { ...p.concealed };
  if (winBy === 'dianpao') addTile(concealed, winTile);
  const ld = s.lastDrawn;
  const autoFlow =
    winBy === 'zimo' && ld && ld.seat === seat
      ? { winAfterKong: ld.viaKong, winAfterFlower: ld.viaFlower, isLastDrawable: ld.wasLastDrawable }
      : {};
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
    flow: flow ?? autoFlow,
  };
}

function applyDeltas(s: TableState, delta: Record<number, number>): void {
  for (const [seat, v] of Object.entries(delta)) getPlayer(s, Number(seat)).score += v;
}

function resolveDiscardWin(s: TableState, winners: number[], tile: TileId, discarder: number, events: GameEvent[]): void {
  settleWins(s, winners, tile, discarder, undefined, events);
}

/** 抢杠胡解析：有人胡则按抢杠结算，否则完成加杠 */
function resolveRobKong(s: TableState, events: GameEvent[]): void {
  const { seat: konger, tile } = s.robKong!;
  const winners = seatsWithMove(s, 'win');
  s.robKong = null;
  s.pending = {};
  if (winners.length > 0) {
    settleWins(s, winners, tile, konger, { robbedKong: true }, events);
    return;
  }
  completeAddedKong(s, konger, tile, events);
}

/** 结算一批赢家（点炮 / 一炮多响 / 抢杠共用）；payer = 放炮/被抢杠方 */
function settleWins(
  s: TableState,
  winners: number[],
  tile: TileId,
  payer: number,
  flow: Hand['flow'],
  events: GameEvent[],
): void {
  const allDelta: Record<number, number> = {};
  const winTais: { seat: number; tai: number; detail: ScoreDetail[] }[] = [];
  const zhahu: number[] = [];
  for (const seat of winners) {
    const hand = buildHand(s, seat, tile, 'dianpao', payer, flow);
    const { score, delta } = scoreAndSettle(hand, {
      winnerSeat: seat,
      dealerSeat: s.dealerSeat,
      discarderSeat: payer,
      allSeats: seatList(s),
    });
    if (!score.win || score.zhaHu) {
      zhahu.push(seat);
      continue;
    }
    winTais.push({ seat, tai: score.total, detail: score.detail });
    for (const [k, v] of Object.entries(delta ?? {})) allDelta[Number(k)] = (allDelta[Number(k)] ?? 0) + v;
  }
  for (const seat of zhahu) applyZhahuPenalty(s, seat, events);
  if (winTais.length === 0) {
    endRoundNoWin(s, events);
    return;
  }
  applyDeltas(s, allDelta);
  getPlayer(s, payer).zi = 0; // 放炮方子清零
  events.push({ type: 'win', winners: winTais, delta: allDelta, revealed: revealedHands(s) });
  // D-28（BL-008）：一炮多响轮庄——庄家在赢家中→连庄；否则换庄（下家上庄）
  const rotSeat = winTais.some((w) => w.seat === s.dealerSeat) ? s.dealerSeat : closestByTurn(s, payer, winTais.map((w) => w.seat));
  endRound(s, rotSeat, events);
}

function doSelfWin(s: TableState, seat: number, events: GameEvent[]): void {
  if (s.phase !== 'discard' || s.currentSeat !== seat || s.lastDrawn == null) return;
  const tile = s.lastDrawn.tile;
  const hand = buildHand(s, seat, tile, 'zimo');
  const { score, delta } = scoreAndSettle(hand, { winnerSeat: seat, dealerSeat: s.dealerSeat, allSeats: seatList(s) });
  if (!score.win || score.zhaHu) {
    applyZhahuPenalty(s, seat, events);
    endRoundNoWin(s, events);
    return;
  }
  applyDeltas(s, delta!);
  for (const p of s.players) if (p.seat !== seat) p.zi = 0; // 被自摸者子清零
  events.push({ type: 'win', winners: [{ seat, tai: score.total, detail: score.detail }], delta: delta!, revealed: revealedHands(s) });
  endRound(s, seat, events);
}

/** 诈胡罚分：向其它每家付 300（虚拟积分） */
function applyZhahuPenalty(s: TableState, seat: number, events: GameEvent[]): void {
  const others = s.players.length - 1;
  getPlayer(s, seat).score -= 300 * others;
  for (const p of s.players) if (p.seat !== seat) p.score += 300;
  events.push({ type: 'zhahu', seat, revealed: revealedHands(s) });
}

/** 无人有效胡（如全诈胡）时结束本局：庄家不变、不连庄（默认，规则待明确） */
function endRoundNoWin(s: TableState, events: GameEvent[]): void {
  s.phase = 'settled';
  events.push({ type: 'roundEnd', dealerSeat: s.dealerSeat, lianzhuangCount: s.lianzhuangCount, round: s.round });
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
  events.push({ type: 'exhaustive', revealed: revealedHands(s) });
  events.push({ type: 'roundEnd', dealerSeat: s.dealerSeat, lianzhuangCount: s.lianzhuangCount, round: s.round });
}

/** 开下一局：保留积分/子，重新发牌（BL-017：physical 模式传新局 layout+breakGroups） */
export function startNextRound(state: TableState, seed: number, opts?: WallOpts): { state: TableState; events: GameEvent[] } {
  const savedScore = Object.fromEntries(state.players.map((p) => [p.seat, p.score]));
  const savedZi = Object.fromEntries(state.players.map((p) => [p.seat, p.zi]));
  const fresh = createTable(state.dealerSeat, seed, seatList(state), opts);
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
