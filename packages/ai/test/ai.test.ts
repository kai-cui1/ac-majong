import { describe, expect, it } from 'vitest';
import type { ViewState } from '@ac-majong/protocol';
import { createAutoPlayer, personaById, shanten, standardShanten, ukeire, countVisible, DEFAULT_PERSONA, TRUSTEE_PERSONA } from '../src/index';
import { evaluateDiscards, pickDiscard } from '../src/strategies/efficiency';
import { buildContext } from '../src/autoPlayer';
import type { Counts } from '../src/features/shanten';
import type { BotConfig } from '../src/types';

const C = (o: Record<string, number>): Counts => o;

function makeView(concealed: Counts, over: Partial<ViewState> = {}): ViewState {
  return {
    room: 'R1',
    round: 1,
    maxRounds: 8,
    names: ['a', 'b', 'c', 'd'],
    phase: 'discard',
    dealerSeat: 0,
    currentSeat: 0,
    wallRemaining: 60,
    lianzhuangCount: 0,
    lastDiscard: null,
    discards: [],
    you: { seat: 0, concealed, drawn: null, melds: [], flowers: [], zi: 0, score: 0, legal: ['discard'] },
    others: [
      { seat: 1, concealedCount: 13, melds: [], flowersCount: 0, zi: 0, score: 0 },
      { seat: 2, concealedCount: 13, melds: [], flowersCount: 0, zi: 0, score: 0 },
      { seat: 3, concealedCount: 13, melds: [], flowersCount: 0, zi: 0, score: 0 },
    ],
    ...over,
  } as ViewState;
}

const ctxOf = (view: ViewState, cfgOver: Partial<BotConfig> = {}) => {
  const persona = personaById(DEFAULT_PERSONA)!;
  return buildContext(view, 0, { ...persona.config, ...cfgOver }, () => 0.5);
};

describe('shanten 向听数', () => {
  it('完整胡牌型 = -1', () => {
    const h = C({ W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, W7: 1, W8: 1, W9: 1, T1: 1, T2: 1, T3: 1, T5: 2 });
    expect(standardShanten(h, 0)).toBe(-1);
  });
  it('听牌 = 0', () => {
    const h = C({ W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, W7: 1, W8: 1, W9: 1, T1: 1, T2: 1, T3: 1, T5: 1 });
    expect(standardShanten(h, 0)).toBe(0);
  });
  it('一向听 = 1', () => {
    const h = C({ W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, W7: 1, W8: 1, W9: 1, T5: 2, T9: 1, B9: 1 });
    expect(standardShanten(h, 0)).toBe(1);
  });
  it('有副露时向听相应减少需求', () => {
    // 1 副露 + 暗牌 10 张(2 面子+搭子+将) = 听牌(0)
    const h = C({ W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, T1: 1, T2: 1, T5: 2 });
    expect(standardShanten(h, 1)).toBe(0);
  });
  it('综合 shanten 与 standard 一致（标准型手）', () => {
    const h = C({ W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, W7: 1, W8: 1, W9: 1, T1: 1, T2: 1, T3: 1, T5: 1 });
    expect(shanten(h, [])).toBe(0);
  });
});

describe('ukeire 受入', () => {
  it('听牌手受入 > 0', () => {
    const h = C({ W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, W7: 1, W8: 1, W9: 1, T1: 1, T2: 1, T3: 1, T5: 1 });
    expect(ukeire(h, [], {})).toBeGreaterThan(0);
  });
  it('可见牌会减少剩余张数', () => {
    // 该手单听 T5（独独）；把 T5 记为可见后剩余归零 → 受入下降
    const h = C({ W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, W7: 1, W8: 1, W9: 1, T1: 1, T2: 1, T3: 1, T5: 1 });
    const visNone = ukeire(h, [], {});
    const visMany = ukeire(h, [], countVisible(['T5', 'T5', 'T5'], []));
    expect(visNone).toBeGreaterThan(0);
    expect(visMany).toBeLessThan(visNone);
  });
});

describe('efficiency 效率型弃牌', () => {
  it('优先弃孤张保搭子（打 B9 听牌）', () => {
    const h = C({ W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, W7: 1, W8: 1, W9: 1, T5: 2, T1: 1, T2: 1, B9: 1 });
    const ctx = ctxOf(makeView(h));
    expect(pickDiscard(ctx)).toBe('B9');
  });
  it('评分排序：听牌路线排在最前', () => {
    const h = C({ W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, W7: 1, W8: 1, W9: 1, T5: 2, T1: 1, T2: 1, B9: 1 });
    const evals = evaluateDiscards(ctxOf(makeView(h)));
    expect(evals[0]!.tile).toBe('B9');
    expect(evals[0]!.shanten).toBe(0);
  });
});

describe('AutoPlayer / 人格', () => {
  it('未知 persona 回落默认', () => {
    expect(createAutoPlayer('nope').personaId).toBe(DEFAULT_PERSONA);
  });
  it('托管 persona 解析为 trustee', () => {
    expect(createAutoPlayer(TRUSTEE_PERSONA).personaId).toBe(TRUSTEE_PERSONA);
  });
  it('托管不主动胡/副露：response 一律过', () => {
    const v = makeView(C({ W1: 1, W2: 1 }), { phase: 'response', lastDiscard: { seat: 1, tile: 'W1' } });
    (v.you as any).legal = ['win_discard', 'pong', 'pass'];
    const a = createAutoPlayer(TRUSTEE_PERSONA).decide(v, 0);
    expect(a).toEqual({ type: 'respond', seat: 0, move: 'pass' });
  });
  it('效率型在 response 能胡则胡', () => {
    const v = makeView(C({ W1: 1, W2: 1 }), { phase: 'response', lastDiscard: { seat: 1, tile: 'W1' } });
    (v.you as any).legal = ['win_discard', 'pass'];
    // 构造一个 preview.canWin 无关：response 点炮胡由 legal 决定（引擎已保证达标）
    const a = createAutoPlayer(DEFAULT_PERSONA).decide(v, 0);
    expect(a).toEqual({ type: 'respond', seat: 0, move: 'win' });
  });
  it('效率型 discard 相位返回合法弃牌', () => {
    const h = C({ W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, W7: 1, W8: 1, W9: 1, T5: 2, T1: 1, T2: 1, B9: 1 });
    const a = createAutoPlayer(DEFAULT_PERSONA).decide(makeView(h), 0);
    expect(a).toMatchObject({ type: 'discard', seat: 0 });
    expect(Object.keys(h)).toContain((a as any).tile);
  });
});
