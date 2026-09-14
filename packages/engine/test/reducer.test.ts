import { describe, it, expect } from 'vitest';
import { applyAction, startNextRound } from '../src/reducer';
import { DEAD_WALL, type TableState, type PlayerState } from '../src/table';
import { meld } from './helpers';

function pl(seat: number, concealed: Record<string, number>, melds: PlayerState['melds'] = []): PlayerState {
  return { seat, concealed, melds, flowers: [], zi: 0, score: 0 };
}
function tbl(o: Partial<TableState>): TableState {
  return {
    wall: Array(60).fill('T1'),
    players: [pl(0, {}), pl(1, {}), pl(2, {}), pl(3, {})],
    dealerSeat: 0,
    currentSeat: 0,
    phase: 'draw',
    lastDiscard: null,
    lastDrawn: null,
    pending: {},
    lianzhuangCount: 0,
    round: 1,
    ...o,
  };
}

describe('reducer · 出牌与推进', () => {
  it('出牌无人响应 → 推进到下家摸牌', () => {
    const s0 = tbl({ phase: 'discard', currentSeat: 0, players: [pl(0, { W1: 1, W2: 1 }), pl(1, {}), pl(2, {}), pl(3, {})] });
    const { state, events } = applyAction(s0, { type: 'discard', seat: 0, tile: 'W1' });
    expect(events.some((e) => e.type === 'discarded')).toBe(true);
    expect(events.some((e) => e.type === 'advance')).toBe(true);
    expect(state.phase).toBe('draw');
    expect(state.currentSeat).toBe(1);
  });

  it('碰：他家碰牌后进入其出牌阶段', () => {
    const s0 = tbl({ phase: 'discard', currentSeat: 0, players: [pl(0, { W5: 1 }), pl(1, {}), pl(2, { W5: 2 }), pl(3, {})] });
    const r1 = applyAction(s0, { type: 'discard', seat: 0, tile: 'W5' });
    expect(r1.state.phase).toBe('response');
    expect(r1.events.some((e) => e.type === 'responseNeeded')).toBe(true);
    const r2 = applyAction(r1.state, { type: 'respond', seat: 2, move: 'pong' });
    expect(r2.state.phase).toBe('discard');
    expect(r2.state.currentSeat).toBe(2);
    expect(r2.state.players[2]!.melds.some((m) => m.type === 'pong' && m.tiles[0] === 'W5')).toBe(true);
  });
});

describe('reducer · 胡牌结算与轮庄', () => {
  it('自摸胡 → win 事件 + 庄家连庄', () => {
    const win = { W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, W7: 1, W8: 1, W9: 1, B1: 3, B2: 3, B9: 2 };
    const s0 = tbl({ phase: 'discard', currentSeat: 0, dealerSeat: 0, players: [pl(0, win), pl(1, {}), pl(2, {}), pl(3, {})], lastDrawn: { seat: 0, tile: 'B9' } });
    const { state, events } = applyAction(s0, { type: 'declareWin', seat: 0 });
    expect(events.some((e) => e.type === 'win')).toBe(true);
    expect(state.players[0]!.score).toBeGreaterThan(0);
    expect(state.players[1]!.score).toBeLessThan(0);
    expect(state.lianzhuangCount).toBe(1); // 庄家自摸 → 连庄
    expect(state.dealerSeat).toBe(0);
  });

  it('点炮胡 → 换庄 + 点炮方子清零', () => {
    const pongs = [meld('pong', 'W111'), meld('pong', 'T222'), meld('pong', 'B333'), meld('pong', 'W444'), meld('pong', 'T555')];
    const s0 = tbl({ phase: 'discard', currentSeat: 0, dealerSeat: 0, players: [pl(0, { B5: 1 }), pl(1, { B5: 1 }, pongs), pl(2, {}), pl(3, {})] });
    const r1 = applyAction(s0, { type: 'discard', seat: 0, tile: 'B5' });
    const r2 = applyAction(r1.state, { type: 'respond', seat: 1, move: 'win' });
    expect(r2.events.some((e) => e.type === 'win')).toBe(true);
    expect(r2.state.players[1]!.score).toBeGreaterThan(0);
    expect(r2.state.players[0]!.score).toBeLessThan(0);
    expect(r2.state.dealerSeat).toBe(1); // 闲家(1)胡 → 庄(0)下家(1)上庄
    expect(r2.state.players[0]!.zi).toBe(0); // 点炮方清零
  });
});

describe('reducer · 荒庄与下一局', () => {
  it('牌墙摸尽 → 荒庄 + 庄家连庄', () => {
    const s0 = tbl({ phase: 'draw', currentSeat: 0, dealerSeat: 0, wall: ['T1', 'T2', 'T3', 'T4'].slice(0, DEAD_WALL) });
    const { state, events } = applyAction(s0, { type: 'draw', seat: 0 });
    expect(state.phase).toBe('exhaustive');
    expect(events.some((e) => e.type === 'exhaustive')).toBe(true);
    expect(state.lianzhuangCount).toBe(1);
  });

  it('startNextRound：保留积分/子，重新发牌，局数+1，庄家17张', () => {
    const s0 = tbl({ phase: 'settled', round: 3, dealerSeat: 1 });
    s0.players[0]!.score = 500;
    s0.players[1]!.zi = 2;
    const { state } = startNextRound(s0, 123);
    expect(state.round).toBe(4);
    expect(state.players[0]!.score).toBe(500);
    expect(state.players[1]!.zi).toBe(2);
    expect(state.dealerSeat).toBe(1);
    const cnt = (p: PlayerState) => Object.values(p.concealed).reduce((a, b) => a + b, 0);
    expect(cnt(state.players[1]!)).toBe(17);
    expect(cnt(state.players[0]!)).toBe(16);
  });
});
