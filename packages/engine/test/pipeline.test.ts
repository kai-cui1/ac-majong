import { describe, it, expect } from 'vitest';
import { scoreHand, scoreAndSettle, previewTai } from '../src/pipeline';
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
    expect(ps).toEqual([{ name: '见花', count: 1, tiles: ['H1'] }]);
  });
});

describe('previewTai · 三态实时台数预览', () => {
  // 13 张听牌型（minimal 去掉胡牌张 B8）
  const ting13 = { Z1: 2, T5: 1, T6: 1, T7: 1, B2: 1, B3: 1, B4: 1, W5: 1, W6: 1, W7: 1, B6: 1, B7: 1 };
  const melds = minimal.melds;
  const flowers = minimal.flowers;

  it('C：3n+1 已听牌 → tenpai 且台数>0', () => {
    const p = previewTai(ting13, melds, flowers);
    expect(p.tenpai).toBe(true);
    expect(p.canWin).toBeFalsy();
    expect(p.tai).toBeGreaterThan(0);
  });

  it('A：3n+2 可直接自摸 → canWin 且台数=胡牌台数', () => {
    // 碰碰胡高台手（非最小胡，避免自摸 probe 偏移触发诈胡分支）
    const p = previewTai(pengpeng.concealed, pengpeng.melds, []);
    expect(p.canWin).toBe(true);
    expect(p.tenpai).toBe(true);
    expect(p.tai).toBeGreaterThan(0);
  });

  it('B：3n+2 未胡 → 给出打哪张可听(viaDiscard)及台数', () => {
    const p = previewTai({ ...ting13, W9: 1 }, melds, flowers);
    expect(p.tenpai).toBe(true);
    expect(p.canWin).toBeFalsy();
    expect(p.viaDiscard).toBe('W9');
    expect(p.tai).toBeGreaterThan(0);
  });

  it('ScoreDetail 带 count/tiles（见花展开具体牌）', () => {
    const s = scoreHand(mkHand({ concealed: { B5: 2 }, melds: pengpeng.melds, flowers: ['H1', 'H2'], winTile: 'B5', winBy: 'zimo' }));
    const fh = s.detail.find((d) => d.name === '见花');
    expect(fh).toBeDefined();
    expect(fh!.count).toBe(2);
    expect(fh!.tiles).toEqual(['H1', 'H2']);
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
