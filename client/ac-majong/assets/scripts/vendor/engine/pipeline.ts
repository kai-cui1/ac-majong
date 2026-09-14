import type { Hand, ScoreResult } from './types';
import { winDecompositions } from './winCheck';
import { analyze } from './analyze';
import { recognizePatterns } from './recognize';
import { computeTai } from './scoring';
import { settle } from './settlement';

export interface HandScore extends ScoreResult {
  /** 是否成立胡牌结构（false = 根本没胡） */
  win: boolean;
}

/**
 * 对一手胡牌算台数：枚举所有合法分解 → 识别番种 → 算台；
 * 按 N6「取台数最大的分解」。真实牌面下 sum===1 即最小胡（→8）。
 */
export function scoreHand(hand: Hand): HandScore {
  const decomps = winDecompositions(hand.concealed, hand.melds.length);
  if (decomps.length === 0) {
    return { win: false, total: 0, detail: [], zhaHu: false, minimalHu: false };
  }
  let best: ScoreResult | null = null;
  for (const d of decomps) {
    const a = analyze(hand, d);
    const patterns = recognizePatterns(hand, a);
    const probe = computeTai(patterns);
    const minimal = probe.total === 1;
    const res = computeTai(patterns, { minimal });
    if (best === null || res.total > best.total) best = res;
  }
  return { win: true, ...best! };
}

export interface SettleContext {
  winnerSeat: number;
  dealerSeat: number;
  discarderSeat?: number;
  allSeats: number[];
}

/** 完整流水线：一手牌 → 台数 → 各家积分变动（诈胡/未胡则 delta=null） */
export function scoreAndSettle(
  hand: Hand,
  ctx: SettleContext,
): { score: HandScore; delta: Record<number, number> | null } {
  const score = scoreHand(hand);
  if (!score.win || score.zhaHu) return { score, delta: null };
  const delta = settle({
    winTai: score.total,
    winBy: hand.winBy,
    winnerSeat: ctx.winnerSeat,
    discarderSeat: ctx.discarderSeat,
    dealerSeat: ctx.dealerSeat,
    lianzhuangCount: hand.lianzhuangCount,
    seatsZi: hand.seatsZi,
    allSeats: ctx.allSeats,
  });
  return { score, delta };
}
