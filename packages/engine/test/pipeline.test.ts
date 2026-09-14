import { describe, it, expect } from 'vitest';
import { scoreHand, scoreAndSettle } from '../src/pipeline';
import { analyze } from '../src/analyze';
import { recognizePatterns } from '../src/recognize';
import { winDecompositions } from '../src/winCheck';
import type { Hand } from '../src/types';

function mkHand(p: Partial<Hand> & Pick<Hand, 'concealed' | 'melds' | 'winTile' | 'winBy'>): Hand {
  return {
    flowers: [],
    isDealer: false,
    wallRemaining: 50,
    lianzhuangCount: 0,
    seatsZi: { 0: 0, 1: 0, 2: 0, 3: 0 },
    ...p,
  };
}

// 5 副碰（W1/T2/B3/W4/T5）+ 单钓 B5 将，点炮，无花无字
const pengpeng: Hand = mkHand({
  concealed: { B5: 2 },
  melds: [
    { type: 'pong', tiles: ['W1', 'W1', 'W1'] },
    { type: 'pong', tiles: ['T2', 'T2', 'T2'] },
    { type: 'pong', tiles: ['B3', 'B3', 'B3'] },
    { type: 'pong', tiles: ['W4', 'W4', 'W4'] },
    { type: 'pong', tiles: ['T5', 'T5', 'T5'] },
  ],
  winTile: 'B5',
  winBy: 'dianpao',
  fromSeat: 2,
});

// 一对东(将) + 5 顺(跨三门) + 1 花 + 非门清(吃) + 点炮 + 0台听型 → 恰好 1 台 → 最小胡
const minimal: Hand = mkHand({
  concealed: { Z1: 2, T5: 1, T6: 1, T7: 1, B2: 1, B3: 1, B4: 1, W5: 1, W6: 1, W7: 1, B6: 1, B7: 1, B8: 1 },
  melds: [{ type: 'chi', tiles: ['W1', 'W2', 'W3'] }],
  flowers: ['H1'],
  winTile: 'B8',
  winBy: 'dianpao',
  fromSeat: 3,
});

describe('pipeline · 一手牌 → 台数', () => {
  it('碰碰胡 + 全求人 + 无花无字 = 26', () => {
    const r = scoreHand(pengpeng);
    expect(r.win).toBe(true);
    expect(r.total).toBe(26);
    expect(r.detail.map((d) => d.name)).toEqual(expect.arrayContaining(['碰碰胡', '全求人', '无花无字']));
    expect(r.detail).toHaveLength(3); // 无花/无字 被无花无字吸收
  });

  it('最小胡 → 8（1 变 8）', () => {
    const r = scoreHand(minimal);
    expect(r.win).toBe(true);
    expect(r.total).toBe(8);
    expect(r.minimalHu).toBe(true);
    expect(r.zhaHu).toBe(false);
  });

  it('非胡牌结构 → win=false', () => {
    const bad = mkHand({ concealed: { W1: 1, W2: 1, W3: 1 }, melds: [], winTile: 'W3', winBy: 'dianpao' });
    expect(scoreHand(bad).win).toBe(false);
  });
});

describe('recognizePatterns · 番种识别', () => {
  it('碰碰胡手识别出 碰碰胡/全求人/无花无字', () => {
    const d = winDecompositions(pengpeng.concealed, pengpeng.melds.length)[0]!;
    const names = recognizePatterns(pengpeng, analyze(pengpeng, d)).map((p) => p.name);
    expect(names).toContain('碰碰胡');
    expect(names).toContain('全求人');
    expect(names).toContain('无花无字');
  });

  it('最小胡手仅识别出 见花×1（无其它番）', () => {
    const d = winDecompositions(minimal.concealed, minimal.melds.length)[0]!;
    const ps = recognizePatterns(minimal, analyze(minimal, d));
    expect(ps).toEqual([{ name: '见花', count: 1 }]);
  });
});

describe('pipeline · 完整结算', () => {
  it('碰碰胡 26台 点炮 → 最终 29台 = 580 分', () => {
    const { score, delta } = scoreAndSettle(pengpeng, {
      winnerSeat: 1,
      dealerSeat: 0,
      discarderSeat: 2,
      allSeats: [0, 1, 2, 3],
    });
    expect(score.total).toBe(26);
    expect(delta).not.toBeNull();
    expect(delta![1]).toBe(580); // 26 + 3×(0+1) = 29 台 ×20
    expect(delta![2]).toBe(-580);
  });
});
