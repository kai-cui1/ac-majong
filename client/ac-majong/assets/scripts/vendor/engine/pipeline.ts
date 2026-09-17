import type { Hand, ScoreResult, TileId, Meld, ScoreDetail } from './types';
import { winDecompositions, waitingTiles, isWin } from './winCheck';
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
  /** 是否已听牌（含「打一张可听」与「可直接自摸」） */
  tenpai: boolean;
  waits: TileId[];
  /** 实时台数：可自摸=胡牌台数；打一张可听=该路线最高台数；已听牌=最佳听张台数；否则 0 */
  tai: number;
  detail: ScoreDetail[];
  /** 当前手牌已可直接自摸胡 */
  canWin?: boolean;
  /** 3n+2 时打哪张可听（取台数最高路线） */
  viaDiscard?: TileId;
}

/**
 * 台数预览（三态实时）：
 *  A 可直接自摸（3n+2 且 isWin）→ 胡牌台数（canWin）；
 *  B 3n+2 未胡 → 遍历打法，取「打后听牌且台数最高」路线（viaDiscard）；
 *  C 3n+1 已听牌 → 枚举听张按自摸取最大台数。
 * 复用 scoreHand，不另立算台规则，保证与真实结算一致。
 */
export function previewTai(
  concealed: Record<string, number>,
  melds: Meld[],
  flowers: TileId[],
  opts: { isDealer?: boolean; wallRemaining?: number; lianzhuangCount?: number; drawn?: TileId } = {},
): TaiPreview {
  const mkHand = (conc: Record<string, number>, winTile: TileId): Hand => ({
    concealed: conc,
    melds,
    flowers,
    winTile,
    winBy: 'zimo',
    isDealer: opts.isDealer ?? false,
    wallRemaining: opts.wallRemaining ?? 0,
    lianzhuangCount: opts.lianzhuangCount ?? 0,
    seatsZi: {},
  });
  const bestOverWaits = (conc: Record<string, number>, waits: TileId[]) => {
    let best: { tai: number; detail: ScoreDetail[] } = { tai: 0, detail: [] };
    for (const w of waits) {
      const s = scoreHand(mkHand({ ...conc, [w]: (conc[w] ?? 0) + 1 }, w));
      if (s.win && !s.zhaHu && s.total > best.tai) best = { tai: s.total, detail: s.detail };
    }
    return best;
  };
  // A：可直接自摸
  if (isWin(concealed, melds.length)) {
    const winTile = opts.drawn ?? (Object.keys(concealed)[0] as TileId);
    const s = scoreHand(mkHand(concealed, winTile));
    if (s.win && !s.zhaHu) return { tenpai: true, canWin: true, waits: [], tai: s.total, detail: s.detail };
  }
  const total = Object.values(concealed).reduce((a, b) => a + b, 0);
  // B：3n+2，遍历打法取最佳听牌路线
  if (total % 3 === 2) {
    let best: { tai: number; detail: ScoreDetail[]; via: TileId; waits: TileId[] } | null = null;
    for (const t of Object.keys(concealed) as TileId[]) {
      const conc = { ...concealed, [t]: (concealed[t] ?? 0) - 1 };
      if ((conc[t] ?? 0) <= 0) delete conc[t];
      const waits = waitingTiles(conc, melds.length);
      if (waits.length === 0) continue;
      const b = bestOverWaits(conc, waits);
      if (b.tai > 0 && (!best || b.tai > best.tai)) best = { tai: b.tai, detail: b.detail, via: t, waits };
    }
    if (best) return { tenpai: true, viaDiscard: best.via, waits: best.waits, tai: best.tai, detail: best.detail };
    return { tenpai: false, waits: [], tai: 0, detail: [] };
  }
  // C：3n+1 已听牌
  const waits = waitingTiles(concealed, melds.length);
  if (waits.length === 0) return { tenpai: false, waits: [], tai: 0, detail: [] };
  const b = bestOverWaits(concealed, waits);
  return { tenpai: true, waits, tai: b.tai, detail: b.detail };
}
