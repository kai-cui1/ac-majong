import { describe, it, expect } from 'vitest';
import {
  createTable,
  shuffle,
  wallRemaining,
  countAll,
  type PlayerState,
  type TableState,
} from '../src/table';
import { applyAction } from '../src/reducer';
import {
  canChi,
  canPong,
  canExposedKong,
  concealedKongOptions,
  addedKongOptions,
  canWinDraw,
  canWinDiscard,
  chiOptions,
  legalActions,
} from '../src/actions';
import { fullWall } from '../src/tiles';
import { meld } from './helpers';

function P(concealed: Record<string, number>, melds: PlayerState['melds'] = []): PlayerState {
  return { seat: 0, concealed, melds, flowers: [], zi: 0, score: 0 };
}
function mkTable(o: Partial<TableState>): TableState {
  return {
    wall: Array(50).fill('W1'),
    players: [0, 1, 2, 3].map((s) => P({})).map((p, i) => ({ ...p, seat: i })),
    dealerSeat: 0,
    currentSeat: 0,
    phase: 'draw',
    lastDiscard: null,
    discards: [],
    lastDrawn: null,
    pending: {},
    lianzhuangCount: 0,
    round: 1,
    ...o,
  };
}
const FIVE_PONGS = [
  meld('pong', 'W111'),
  meld('pong', 'T222'),
  meld('pong', 'B333'),
  meld('pong', 'W444'),
  meld('pong', 'T555'),
];

describe('建桌发牌', () => {
  it('庄 17 / 闲 16，庄家先出牌', () => {
    const t = createTable(0, 42);
    expect(countAll(t.players[0]!.concealed)).toBe(17);
    expect(countAll(t.players[1]!.concealed)).toBe(16);
    expect(countAll(t.players[2]!.concealed)).toBe(16);
    expect(countAll(t.players[3]!.concealed)).toBe(16);
    expect(t.phase).toBe('discard');
    expect(t.currentSeat).toBe(0);
  });
  it('牌张守恒：暗牌 + 花 + 牌墙 = 144', () => {
    const t = createTable(2, 7);
    let sum = t.wall.length;
    for (const p of t.players) sum += countAll(p.concealed) + p.flowers.length;
    expect(sum).toBe(144);
  });
  it('发牌后手中不含花（已移出并补摸）', () => {
    const t = createTable(1, 99);
    for (const p of t.players) expect(Object.keys(p.concealed).some((x) => x.startsWith('H'))).toBe(false);
  });
  it('确定性洗牌：同种子同结果', () => {
    expect(shuffle(fullWall(), 5)).toEqual(shuffle(fullWall(), 5));
  });
  it('wallRemaining = 牌墙 - 死牌4', () => {
    const t = createTable(0, 3);
    expect(wallRemaining(t)).toBe(t.wall.length - 4);
  });
});

describe('吃 / 碰 / 杠 合法性', () => {
  it('canChi：B4B6 遇 B5 → 可吃', () => {
    expect(canChi(P({ B4: 1, B6: 1 }), 'B5')).toBe(true);
    expect(chiOptions(P({ B4: 1, B6: 1 }), 'B5')).toEqual([['B4', 'B5', 'B6']]);
  });
  it('canChi：字牌不可吃', () => expect(canChi(P({ Z1: 1, Z2: 1 }), 'Z3')).toBe(false));
  it('canPong：2 张可碰、1 张不可', () => {
    expect(canPong(P({ W5: 2 }), 'W5')).toBe(true);
    expect(canPong(P({ W5: 1 }), 'W5')).toBe(false);
  });
  it('canExposedKong：3 张可明杠', () => expect(canExposedKong(P({ W5: 3 }), 'W5')).toBe(true));
  it('暗杠：手中 4 张', () => expect(concealedKongOptions(P({ W5: 4, T1: 1 }))).toEqual(['W5']));
  it('加杠：有碰副 + 手中同牌', () => {
    expect(addedKongOptions(P({ T2: 1 }, [meld('pong', 'T222')]))).toEqual(['T2']);
    expect(addedKongOptions(P({ W5: 1 }, [meld('pong', 'T222')]))).toEqual([]);
  });
});

describe('胡牌合法性（结构）', () => {
  it('canWinDraw：暗牌 5 顺 + 将', () => {
    const p = P({ W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, W7: 1, W8: 1, W9: 1, T1: 1, T2: 1, T3: 1, T4: 1, T5: 1, T6: 1, B9: 2 });
    expect(canWinDraw(p)).toBe(true);
  });
  it('canWinDiscard：5 碰 + 单钓 B5', () => {
    const p = P({ B5: 1 }, FIVE_PONGS);
    expect(canWinDiscard(p, 'B5')).toBe(true);
    expect(canWinDiscard(p, 'B6')).toBe(false);
  });
});

describe('legalActions + 末尾限制（D-09）', () => {
  it('出牌阶段：当前手可打牌', () => {
    const t = createTable(0, 1);
    expect(legalActions(t, 0)).toContain('discard');
  });
  it('响应阶段（非末尾）：他家可碰 + 过', () => {
    const t = mkTable({ phase: 'response', lastDiscard: { seat: 0, tile: 'W5' } });
    t.players[1]!.concealed = { W5: 2 };
    const acts = legalActions(t, 1);
    expect(acts).toContain('pong');
    expect(acts).toContain('pass');
  });
  it('末尾≤8张：禁碰，但胡仍可、过仍可', () => {
    const t = mkTable({ phase: 'response', lastDiscard: { seat: 0, tile: 'B5' }, wall: ['W1'] });
    t.players[1]!.concealed = { B5: 1 };
    t.players[1]!.melds = FIVE_PONGS;
    const acts = legalActions(t, 1);
    expect(wallRemaining(t)).toBe(0);
    expect(acts).toContain('win_discard');
    expect(acts).not.toContain('pong');
    expect(acts).toContain('pass');
  });
  it('末尾≤8张：暗杠（摸杠）仍允许', () => {
    const t = mkTable({ phase: 'discard', currentSeat: 0, wall: ['W1'] });
    t.players[0]!.concealed = { W5: 4 };
    const acts = legalActions(t, 0);
    expect(acts).toContain('kong_concealed');
    expect(acts).toContain('discard');
  });
  it('吃仅限下家', () => {
    const t = mkTable({ phase: 'response', lastDiscard: { seat: 0, tile: 'B5' } });
    t.players[1]!.concealed = { B4: 1, B6: 1 }; // 下家(1) 可吃
    t.players[2]!.concealed = { B4: 1, B6: 1 }; // 非下家(2) 不可吃
    expect(legalActions(t, 1)).toContain('chi');
    expect(legalActions(t, 2)).not.toContain('chi');
  });
  it('已响应者本窗再无合法动作（2026-09-18 bugfix：防重复点吃/碰重置倒计时）', () => {
    const t = mkTable({ phase: 'response', lastDiscard: { seat: 0, tile: 'B5' } });
    t.players[1]!.concealed = { B4: 1, B6: 1 };
    expect(legalActions(t, 1)).toContain('chi');
    t.pending[1] = { move: 'chi', chiTiles: ['B4', 'B6'] };
    expect(legalActions(t, 1)).toEqual([]);
    expect(legalActions(t, 2)).toContain('pass'); // 未响应方不受影响
  });
  it('吃副记录被吃牌（FR-对局-17 横置标记数据源）', () => {
    const t = mkTable({ phase: 'response', lastDiscard: { seat: 0, tile: 'B5' } });
    t.players[1]!.concealed = { B4: 1, B6: 1 };
    const r = applyAction(t, { type: 'respond', seat: 1, move: 'chi', chiTiles: ['B4', 'B6'] });
    const meld = r.state.players[1]!.melds[0]!;
    expect(meld.type).toBe('chi');
    expect(meld.tiles).toEqual(['B4', 'B5', 'B6']);
    expect(meld.called).toBe('B5');
  });
});
