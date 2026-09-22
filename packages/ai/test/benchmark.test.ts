import { describe, expect, it } from 'vitest';
import { fullWall } from '@ac-majong/engine';
import type { TileId, ViewState } from '@ac-majong/protocol';
import { buildContext } from '../src/autoPlayer';
import { evaluateDiscards } from '../src/strategies/efficiency';
import { shanten, type Counts } from '../src/features/shanten';
import { hashString, seededRng } from '../src/rng';
import { personaById, DEFAULT_PERSONA } from '../src/personas';

function makeView(concealed: Counts): ViewState {
  return {
    room: 'B', round: 1, maxRounds: 8, names: ['a', 'b', 'c', 'd'],
    phase: 'discard', dealerSeat: 0, currentSeat: 0, wallRemaining: 60, lianzhuangCount: 0,
    lastDiscard: null, discards: [],
    you: { seat: 0, concealed, drawn: null, melds: [], flowers: [], zi: 0, score: 0, legal: ['discard'] },
    others: [1, 2, 3].map((s) => ({ seat: s, concealedCount: 13, melds: [], flowersCount: 0, zi: 0, score: 0 })),
  } as ViewState;
}

const add = (c: Counts, t: TileId): Counts => ({ ...c, [t]: (c[t] ?? 0) + 1 });
const rem = (c: Counts, t: TileId): Counts => {
  const n = { ...c };
  n[t] = (n[t] ?? 0) - 1;
  if ((n[t] ?? 0) <= 0) delete n[t];
  return n;
};

/** 单人摸打模拟：从 13 张起，每轮摸一张按策略打一张，记录到听牌(向听0)的轮数；摸完未听记为上限 */
function turnsToTenpai(seed: number, strategy: 'efficiency' | 'p0'): number {
  const rng = seededRng(seed);
  const wall = fullWall();
  // Fisher-Yates 洗牌（种子源）
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [wall[i], wall[j]] = [wall[j]!, wall[i]!];
  }
  let hand: Counts = {};
  for (let i = 0; i < 13; i++) hand = add(hand, wall.pop()!);
  const cfg = personaById(DEFAULT_PERSONA)!.config;
  const MAX = 60;
  for (let turn = 1; turn <= MAX; turn++) {
    const drawn = wall.pop();
    if (!drawn) return MAX;
    hand = add(hand, drawn);
    let discard: TileId;
    if (strategy === 'p0') {
      discard = Object.keys(hand)[0]!; // P0 骨架：打第一张
    } else {
      const ctx = buildContext(makeView(hand), 0, cfg, seededRng(hashString(`bench-${seed}-${turn}`)));
      discard = evaluateDiscards(ctx)[0]?.tile ?? Object.keys(hand)[0]!;
    }
    hand = rem(hand, discard);
    if (shanten(hand, []) === 0) return turn;
  }
  return MAX;
}

describe('P1 自对弈基准 · 听牌速度（效率型 vs P0 骨架）', () => {
  it('效率型平均听牌轮数不劣于 P0（显著更快）', () => {
    const N = 60;
    let sumEff = 0;
    let sumP0 = 0;
    for (let i = 0; i < N; i++) {
      const seed = 1000 + i * 7;
      sumEff += turnsToTenpai(seed, 'efficiency');
      sumP0 += turnsToTenpai(seed, 'p0');
    }
    const avgEff = sumEff / N;
    const avgP0 = sumP0 / N;
    // eslint-disable-next-line no-console
    console.log(`[bench] 平均听牌轮数 efficiency=${avgEff.toFixed(2)} p0=${avgP0.toFixed(2)} (N=${N})`);
    expect(avgEff).toBeLessThan(avgP0);
  }, 120000);
});
