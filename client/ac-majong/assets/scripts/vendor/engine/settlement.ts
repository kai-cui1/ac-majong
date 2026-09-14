import type { WinBy } from './types';

/** 1 台 = 20 虚拟积分（合规：不可兑现） */
export const TAI_TO_POINTS = 20;

/** 连庄加分：n≥1 → 2n−1（1/3/5/7/9…）；刚上庄 n=0 不加（D-18 / N4） */
export function bonus(n: number): number {
  return n >= 1 ? 2 * n - 1 : 0;
}

export interface SettleInput {
  /** 胡牌台数（computeTai 的结果） */
  winTai: number;
  winBy: WinBy;
  winnerSeat: number;
  /** 点炮方座位（点炮胡必填） */
  discarderSeat?: number;
  dealerSeat: number;
  /** 连庄次数 n */
  lianzhuangCount: number;
  /** 各家桌上「子」数 */
  seatsZi: Record<number, number>;
  /** 全部座位，通常 [0,1,2,3] */
  allSeats: number[];
}

/**
 * 结算：返回各座位积分变动（正=得，负=失）。
 * - 点炮胡：仅点炮方付；自摸：其余三家各付（D-17）。
 * - 最终台数 = 胡牌台数 + 3×(N+1) + (庄家涉及 ? bonus(n) : 0)，N = 胡牌方子数 + 付方子数（规格书 6.2）。
 */
export function settle(inp: SettleInput): Record<number, number> {
  if (inp.winBy === 'dianpao' && inp.discarderSeat == null) {
    throw new Error('点炮胡必须提供 discarderSeat');
  }
  const delta: Record<number, number> = {};
  const add = (seat: number, v: number) => {
    delta[seat] = (delta[seat] ?? 0) + v;
  };

  const payers =
    inp.winBy === 'zimo'
      ? inp.allSeats.filter((s) => s !== inp.winnerSeat)
      : [inp.discarderSeat as number];

  for (const payer of payers) {
    const N = (inp.seatsZi[inp.winnerSeat] ?? 0) + (inp.seatsZi[payer] ?? 0);
    const dealerInvolved = inp.winnerSeat === inp.dealerSeat || payer === inp.dealerSeat;
    const taiFinal = inp.winTai + 3 * (N + 1) + (dealerInvolved ? bonus(inp.lianzhuangCount) : 0);
    const pts = taiFinal * TAI_TO_POINTS;
    add(inp.winnerSeat, pts);
    add(payer, -pts);
  }
  return delta;
}
