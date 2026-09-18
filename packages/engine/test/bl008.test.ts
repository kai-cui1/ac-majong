import { describe, it, expect } from 'vitest';
import { scoreHand } from '../src/pipeline';
import { canWinDraw } from '../src/actions';
import { applyAction } from '../src/reducer';
import type { Hand } from '../src/types';
import type { PlayerState, TableState } from '../src/table';

function mkHand(p: Partial<Hand> & Pick<Hand, 'concealed' | 'melds' | 'winTile' | 'winBy'>): Hand {
  return { flowers: [], isDealer: false, wallRemaining: 50, lianzhuangCount: 0, seatsZi: { 0: 0, 1: 0, 2: 0, 3: 0 }, ...p };
}
const C = (s: string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const t of s.split(' ')) out[t] = (out[t] ?? 0) + 1;
  return out;
};

describe('BL-008 N-实例级：见字按刻实例吸收（规格 4.3 注）', () => {
  it('大三元 + 额外风刻 → 见字保留 ×1', () => {
    const hand = mkHand({
      concealed: C('Z5 Z5 Z5 Z6 Z6 Z6 Z7 Z7 Z7 Z1 Z1 Z1 T2 T2 T3 T4 T5'),
      melds: [], winTile: 'T5', winBy: 'zimo',
    });
    const s = scoreHand(hand);
    expect(s.win).toBe(true);
    expect(s.detail.some((d) => d.name === '大三元')).toBe(true);
    const jz = s.detail.find((d) => d.name === '见字');
    expect(jz?.count).toBe(1); // 4 字刻 - 大三元吸收 3
  });

  it('大三元无额外字刻 → 见字全吸收', () => {
    const hand = mkHand({
      concealed: C('Z5 Z5 Z5 Z6 Z6 Z6 Z7 Z7 Z7 T2 T3 T4 T5 T6 T7 W1 W1'),
      melds: [], winTile: 'T7', winBy: 'zimo',
    });
    const s = scoreHand(hand);
    expect(s.win).toBe(true);
    expect(s.detail.some((d) => d.name === '见字')).toBe(false);
  });

  it('小三元 + 额外风刻 → 见字保留 ×1（3-2）', () => {
    const hand = mkHand({
      concealed: C('Z5 Z5 Z5 Z6 Z6 Z6 Z7 Z7 Z1 Z1 Z1 T2 T3 T4 T5 T6 T7'),
      melds: [], winTile: 'T7', winBy: 'zimo',
    });
    const s = scoreHand(hand);
    expect(s.detail.some((d) => d.name === '小三元')).toBe(true);
    expect(s.detail.find((d) => d.name === '见字')?.count).toBe(1);
  });
});

describe('BL-008 D-26/27：八只花摸满可选胡 + 40+其他成立番', () => {
  const flowers8 = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8'] as never as string[];

  it('无结构分解但 8 花 → 成立胡，八只花 40 + 见字/暗坎等实例番', () => {
    const hand = mkHand({
      concealed: C('Z5 Z5 Z5 W1 W2 W4 W5 W7 W8 T1 T3 T5 T7 T9'),
      melds: [], flowers: flowers8, winTile: 'T9', winBy: 'zimo',
    });
    const s = scoreHand(hand);
    expect(s.win).toBe(true);
    expect(s.detail.some((d) => d.name === '八只花' && d.tai === 40)).toBe(true);
    expect(s.detail.some((d) => d.name === '见字')).toBe(true); // Z5 暗刻实例番仍计
    expect(s.detail.some((d) => d.name === '见花')).toBe(false); // 被八只花吸收
    expect(s.total).toBeGreaterThanOrEqual(41);
  });

  it('canWinDraw：8 花即呈现自摸胡选项（可选胡 D-26）', () => {
    const p: PlayerState = { seat: 0, concealed: C('W1 W2 W4 W5 W7 W8 T1 T3 T5 T7 T9 Z1 Z2'), melds: [], flowers: flowers8, zi: 0, score: 0 };
    expect(canWinDraw(p)).toBe(true);
    const p7 = { ...p, flowers: flowers8.slice(0, 7) };
    expect(canWinDraw(p7)).toBe(false);
  });
});

describe('BL-008 N10：门清一摸档优先级（一摸一 > 一摸二 > 一摸三）', () => {
  it('门清自摸九筒 → 一摸二（非一摸三）', () => {
    const hand = mkHand({
      concealed: C('W1 W2 W3 W4 W5 W6 W7 W8 W9 T2 T3 T4 B5 B5 B5 B9 B9'),
      melds: [], winTile: 'B9', winBy: 'zimo',
    });
    const s = scoreHand(hand);
    expect(s.detail.some((d) => d.name === '门清一摸二')).toBe(true);
    expect(s.detail.some((d) => d.name === '门清一摸三')).toBe(false);
  });

  it('八对半自摸九筒 → 一摸一', () => {
    const hand = mkHand({
      concealed: C('W1 W1 W2 W2 W3 W3 T4 T4 T5 T5 T6 T6 T7 T7 B9 B9 B9'),
      melds: [], winTile: 'B9', winBy: 'zimo',
    });
    const s = scoreHand(hand);
    expect(s.detail.some((d) => d.name === '门清一摸一')).toBe(true);
  });

  it('八对半自摸非九 → 一摸二', () => {
    const hand = mkHand({
      concealed: C('W1 W1 W2 W2 W3 W3 T4 T4 T5 T5 T6 T6 T7 T7 T9 T9 T9'),
      melds: [], winTile: 'T9', winBy: 'zimo',
    });
    const s = scoreHand(hand);
    expect(s.detail.some((d) => d.name === '门清一摸二')).toBe(true);
    expect(s.detail.some((d) => d.name === '门清一摸一')).toBe(false);
  });
});

describe('BL-008 D-28：一炮多响轮庄（庄在赢家即连，否则换庄）', () => {
  function pl(seat: number, concealed: Record<string, number>): PlayerState {
    return { seat, concealed, melds: [], flowers: [], zi: 0, score: 0 };
  }
  function tbl(o: Partial<TableState>): TableState {
    return {
      wall: Array(60).fill('T1'),
      players: [pl(0, {}), pl(1, {}), pl(2, {}), pl(3, {})],
      dealerSeat: 0, currentSeat: 0, phase: 'draw',
      lastDiscard: null, discards: [], lastDrawn: null, pending: {},
      lianzhuangCount: 0, round: 1,
      ...o,
    } as TableState;
  }
  const wait0 = C('W1 W2 W3 W4 W5 W6 W7 W8 W9 W2 W3 W4 W7 W7 W9 W9'); // 清一色双碰听 W7
  const wait1 = C('W1 W1 W2 W2 W3 W3 W4 W4 W5 W5 W6 W6 W7 W7 W8 W8'); // 清一色八对听 W7
  const wait2 = C('W1 W1 W2 W2 W3 W3 W4 W4 W5 W5 W6 W6 W7 W7 W9 W9'); // 清一色八对听 W7
  const noWait = C('W1 W2 W3 T2 T3 T4 T5 T6 T7 B2 B3 B4 B5 B6 B7 W5'); // 无胡/无可吃碰

  it('庄家在赢家中 → 连庄（庄不变、连庄+1、+1 子）', () => {
    const s0 = tbl({ phase: 'discard', currentSeat: 3, dealerSeat: 0, players: [pl(0, wait0), pl(1, wait1), pl(2, noWait), pl(3, { W7: 1, T1: 1 })] });
    const r1 = applyAction(s0, { type: 'discard', seat: 3, tile: 'W7' });
    const r2 = applyAction(r1.state, { type: 'respond', seat: 0, move: 'win' });
    const r3 = applyAction(r2.state, { type: 'respond', seat: 1, move: 'win' });
    const winEv = r3.events.find((e) => e.type === 'win');
    expect(winEv && winEv.type === 'win' ? winEv.winners.length : 0).toBe(2);
    expect(r3.state.dealerSeat).toBe(0);
    expect(r3.state.lianzhuangCount).toBe(1);
    expect(r3.state.players[0]!.zi).toBe(1);
  });

  it('庄家不在赢家中 → 换庄（下家上庄、连庄归零）', () => {
    const s0 = tbl({ phase: 'discard', currentSeat: 3, dealerSeat: 0, players: [pl(0, noWait), pl(1, wait1), pl(2, wait2), pl(3, { W7: 1, T1: 1 })] });
    const r1 = applyAction(s0, { type: 'discard', seat: 3, tile: 'W7' });
    const r2 = applyAction(r1.state, { type: 'respond', seat: 1, move: 'win' });
    const r3 = applyAction(r2.state, { type: 'respond', seat: 2, move: 'win' });
    expect(r3.state.dealerSeat).toBe(1);
    expect(r3.state.lianzhuangCount).toBe(0);
    expect(r3.state.players[1]!.zi).toBe(1);
  });
});
