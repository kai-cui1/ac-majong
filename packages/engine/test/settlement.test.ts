import { describe, it, expect } from 'vitest';
import { settle, bonus, TAI_TO_POINTS } from '../src/settlement';
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

describe('结算 settle（D-17 / 规格书 6.2）', () => {
  it('1台=20积分', () => expect(TAI_TO_POINTS).toBe(20));

  it('点炮：非庄胡、非庄点炮、无子 → 6+3×1=9台=180', () => {
    const inp: SettleInput = { ...base, winTai: 6, winBy: 'dianpao', winnerSeat: 1, discarderSeat: 2 };
    const d = settle(inp);
    expect(d[1]).toBe(180);
    expect(d[2]).toBe(-180);
    expect(d[0] ?? 0).toBe(0);
    expect(d[3] ?? 0).toBe(0);
  });

  it('自摸：非庄胡，三家各付 9台=180', () => {
    const inp: SettleInput = { ...base, winTai: 6, winBy: 'zimo', winnerSeat: 1 };
    const d = settle(inp);
    expect(d[1]).toBe(540);
    expect(d[0]).toBe(-180);
    expect(d[2]).toBe(-180);
    expect(d[3]).toBe(-180);
  });

  it('庄家自摸 + 连庄 n=2 → 每家 6+3+3=12台=240', () => {
    const inp: SettleInput = { ...base, winTai: 6, winBy: 'zimo', winnerSeat: 0, lianzhuangCount: 2 };
    const d = settle(inp);
    expect(d[0]).toBe(720);
    expect(d[1]).toBe(-240);
    expect(d[2]).toBe(-240);
    expect(d[3]).toBe(-240);
  });

  it('带子数 N：胡牌方1子+点炮方2子 → N=3，6+3×4=18台=360', () => {
    const inp: SettleInput = {
      ...base,
      winTai: 6,
      winBy: 'dianpao',
      winnerSeat: 1,
      discarderSeat: 2,
      seatsZi: { 0: 0, 1: 1, 2: 2, 3: 0 },
    };
    const d = settle(inp);
    expect(d[1]).toBe(360);
    expect(d[2]).toBe(-360);
  });

  it('点炮胡缺 discarderSeat 抛错', () => {
    expect(() => settle({ ...base, winTai: 6, winBy: 'dianpao', winnerSeat: 1 })).toThrow();
  });
});
