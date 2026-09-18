import { describe, it, expect } from 'vitest';
import { settle, bonus, TAI_TO_POINTS, winBonusLines } from '../src/settlement';
import type { SettleInput } from '../src/settlement';

const base = {
  dealerSeat: 0,
  lianzhuangCount: 0,
  seatsZi: { 0: 0, 1: 0, 2: 0, 3: 0 },
  allSeats: [0, 1, 2, 3],
};

describe('连庄加分 bonus（D-18 / N4）', () => {
  it('n=0 → 0（刚上庄不加）', () => expect(bonus(0)).toBe(0));
  it('n=1 → 1', () => expect(bonus(1)).toBe(1));
  it('n=2 → 3', () => expect(bonus(2)).toBe(3));
  it('n=3 → 5', () => expect(bonus(3)).toBe(5));
  it('n=4 → 7', () => expect(bonus(4)).toBe(7));
});

describe('结算 settle（2026-09-17 简化：积分与台数 1:1；子每只 +3 台；连庄加成庄家涉及时计）', () => {
  it('积分与台数 1:1', () => expect(TAI_TO_POINTS).toBe(1));

  it('点炮：非庄胡、非庄点炮、无子 → 6 台 = 6 积分', () => {
    const inp: SettleInput = { ...base, winTai: 6, winBy: 'dianpao', winnerSeat: 1, discarderSeat: 2 };
    const d = settle(inp);
    expect(d[1]).toBe(6);
    expect(d[2]).toBe(-6);
    expect(d[0] ?? 0).toBe(0);
    expect(d[3] ?? 0).toBe(0);
  });

  it('自摸：非庄胡、无子 → 三家各付 6，胡方 +18', () => {
    const inp: SettleInput = { ...base, winTai: 6, winBy: 'zimo', winnerSeat: 1 };
    const d = settle(inp);
    expect(d[1]).toBe(18);
    expect(d[0]).toBe(-6);
    expect(d[2]).toBe(-6);
    expect(d[3]).toBe(-6);
  });

  it('庄家自摸 + 连庄 n=2 → 每家 6+3=9', () => {
    const inp: SettleInput = { ...base, winTai: 6, winBy: 'zimo', winnerSeat: 0, lianzhuangCount: 2 };
    const d = settle(inp);
    expect(d[0]).toBe(27);
    expect(d[1]).toBe(-9);
    expect(d[2]).toBe(-9);
    expect(d[3]).toBe(-9);
  });

  it('子加成：胡方 1 子 + 点炮方 2 子 → 6+3×3=15', () => {
    const inp: SettleInput = {
      ...base,
      winTai: 6,
      winBy: 'dianpao',
      winnerSeat: 1,
      discarderSeat: 2,
      seatsZi: { 0: 0, 1: 1, 2: 2, 3: 0 },
    };
    const d = settle(inp);
    expect(d[1]).toBe(15);
    expect(d[2]).toBe(-15);
  });

  it('庄家点炮付别人：连庄 n=2 也计入 → 6+3=9', () => {
    const inp: SettleInput = { ...base, winTai: 6, winBy: 'dianpao', winnerSeat: 1, discarderSeat: 0, lianzhuangCount: 2 };
    const d = settle(inp);
    expect(d[1]).toBe(9);
    expect(d[0]).toBe(-9);
  });

  it('非庄家遗留子：非庄胡带 2 子 → 6+6=12', () => {
    const inp: SettleInput = {
      ...base,
      winTai: 6,
      winBy: 'dianpao',
      winnerSeat: 2,
      discarderSeat: 3,
      seatsZi: { 0: 0, 1: 0, 2: 2, 3: 0 },
    };
    const d = settle(inp);
    expect(d[2]).toBe(12);
    expect(d[3]).toBe(-12);
  });

  it('点炮缺 discarderSeat 抛错', () => {
    expect(() => settle({ ...base, winTai: 6, winBy: 'dianpao', winnerSeat: 1 })).toThrow();
  });
});

describe('winBonusLines 展示加成行', () => {
  it('胡方 2 子 + 庄家涉及连庄 2 → 子×2(+6) + 连庄×2(+3)', () => {
    const lines = winBonusLines({ winnerZi: 2, dealerInvolved: true, lianzhuangCount: 2 });
    expect(lines).toEqual([
      { name: '子', tai: 6, count: 2 },
      { name: '连庄', tai: 3, count: 2 },
    ]);
  });
  it('无子且非庄涉及 → 空', () => {
    expect(winBonusLines({ winnerZi: 0, dealerInvolved: false, lianzhuangCount: 2 })).toEqual([]);
  });
});
