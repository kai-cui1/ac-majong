import type { Hand, ScoreResult, TileId, Meld, ScoreDetail } from './types';
import { winDecompositions, waitingTiles } from './winCheck';
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

/** 台数预览结果（南家徽章/浮层用） */
export interface TaiPreview {
  /** 是否已听牌 */
  tenpai: boolean;
  waits: TileId[];
  /** 已听牌时按「自摸最佳听张」估算的台数；未听牌=0 */
  tai: number;
  detail: ScoreDetail[];
}

/**
 * 台数预览：已听牌时枚举听张、按「自摸」构造完成手牌复用 scoreHand 取最大台数明细；
 * 未听牌返回 tenpai=false/tai=0。不另立算台规则，保证与真实结算一致。
 */
export function previewTai(
  concealed: Record<string, number>,
  melds: Meld[],
  flowers: TileId[],
  opts: { isDealer?: boolean; wallRemaining?: number; lianzhuangCount?: number } = {},
): TaiPreview {
  const waits = waitingTiles(concealed, melds.length);
  if (waits.length === 0) return { tenpai: false, waits: [], tai: 0, detail: [] };
  let best: { tai: number; detail: ScoreDetail[] } = { tai: 0, detail: [] };
  for (const w of waits) {
    const hand: Hand = {
      concealed: { ...concealed, [w]: (concealed[w] ?? 0) + 1 },
      melds,
      flowers,
      winTile: w,
      winBy: 'zimo',
      isDealer: opts.isDealer ?? false,
      wallRemaining: opts.wallRemaining ?? 0,
      lianzhuangCount: opts.lianzhuangCount ?? 0,
      seatsZi: {},
    };
    const s = scoreHand(hand);
    if (s.win && !s.zhaHu && s.total > best.tai) best = { tai: s.total, detail: s.detail };
  }
  return { tenpai: true, waits, tai: best.tai, detail: best.detail };
}
