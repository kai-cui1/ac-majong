import type { Hand, ScoreResult, TileId, Meld, ScoreDetail, MatchedPattern } from './types';
import { winDecompositions, waitingTiles, isWin, type WinDecomp, type MeldUnit } from './winCheck';
import { analyze } from './analyze';
import { recognizePatterns } from './recognize';
import { computeTai } from './scoring';
import { settle, winBonusLines } from './settlement';
import { dedup, patternTai } from './containment';

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
    // D-26/BL-008：八只花摸满即胡（可选）——无结构分解时按「暗刻抽取」降级分解计实例番
    if (hand.flowers.length === 8) {
      const d = flowers8Decomp(hand.concealed);
      const a = analyze(hand, d);
      const res = computeTai(recognizePatterns(hand, a));
      return { win: true, ...res };
    }
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

/** 八只花降级分解：暗牌中所有刻子视为暗坎（字刻→见字/暗坎），无将无顺（D-27：40+其他成立番） */
function flowers8Decomp(concealed: Record<string, number>): WinDecomp {
  const melds: MeldUnit[] = [];
  for (const [t, c] of Object.entries(concealed)) {
    if (c >= 3) melds.push({ kind: 'pung', tiles: [t as TileId, t as TileId, t as TileId] });
  }
  return { kind: 'flowers8', pair: null, concealedMelds: melds };
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
  // 2026-09-17 加成显性化：胡方子/连庄行追加进明细，total = 结算台数（门槛仍按基础番种判定）
  const dealerInvolved = ctx.winnerSeat === ctx.dealerSeat || ctx.discarderSeat === ctx.dealerSeat;
  const lines = winBonusLines({ winnerZi: hand.seatsZi[ctx.winnerSeat] ?? 0, dealerInvolved, lianzhuangCount: hand.lianzhuangCount });
  const addTai = lines.reduce((s, l) => s + l.tai, 0);
  const augmented = addTai > 0
    ? { ...score, total: score.total + addTai, detail: [...score.detail, ...lines.map((l) => ({ name: l.name, tai: l.tai, count: l.count }))] }
    : score;
  return { score: augmented, delta };
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
  /** BL-021 保底台数（锁定番种小计：花/杠/门清/已副露东风刻） */
  secured: number;
  /** BL-021 保底明细（番名/分值与结算同源） */
  securedDetail: ScoreDetail[];
}

/**
 * BL-021 保底（锁定）台数明细：不依赖未来摸牌与拆解的番种 = 见花 / 杠（含九万九筒特番）/ 门清（当前状态）/ 已副露东风刻。
 * 番名与分值与 recognize 同源；杠族吸收复用 dedup（明杠九筒吸收明杠等），保证与结算口径一致。
 * 门清为「当前状态」保底：之后吃碰会实时消失（徽章/浮层随视图重算）。
 */
export function securedLines(melds: Meld[], flowers: TileId[], isDealer: boolean): ScoreDetail[] {
  const raw: MatchedPattern[] = [];
  if (flowers.length) raw.push({ name: '见花', count: flowers.length, tiles: [...flowers] });
  let exp = 0;
  let con = 0;
  for (const m of melds) {
    const b = [...m.tiles].sort()[0]!;
    const nine = b === 'B9' ? '九筒' : b === 'W9' ? '九万' : '';
    if (m.type === 'kong_concealed') { if (nine) raw.push({ name: `暗杠${nine}` }); else con++; }
    else if (m.type === 'kong_exposed' || m.type === 'kong_added') { if (nine) raw.push({ name: `明杠${nine}` }); else exp++; }
    else if (m.type === 'pong' && b === 'Z1') raw.push({ name: isDealer ? '东风字_庄' : '东风字_非庄' });
  }
  if (exp) raw.push({ name: '明杠', count: exp });
  if (con) raw.push({ name: '暗杠', count: con });
  // 门清：无 吃/碰/明杠/加杠（暗杠不破，N2，与 analyze.isMenqing 同口径）
  if (!melds.some((m) => m.type === 'chi' || m.type === 'pong' || m.type === 'kong_exposed' || m.type === 'kong_added')) raw.push({ name: '门清' });
  return dedup(raw).map((p) => ({ name: p.name, tai: patternTai(p), count: p.count, tiles: p.tiles }));
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
  opts: { isDealer?: boolean; wallRemaining?: number; lianzhuangCount?: number; drawn?: TileId; myZi?: number } = {},
): TaiPreview {
  /** 胡方视角加成（子/连庄）并入预览台数与明细，与结算口径一致 */
  const withBonus = (tai: number, detail: ScoreDetail[]): { tai: number; detail: ScoreDetail[] } => {
    const lines = winBonusLines({ winnerZi: opts.myZi ?? 0, dealerInvolved: opts.isDealer ?? false, lianzhuangCount: opts.lianzhuangCount ?? 0 });
    const add = lines.reduce((s, l) => s + l.tai, 0);
    return add > 0 ? { tai: tai + add, detail: [...detail, ...lines.map((l) => ({ name: l.name, tai: l.tai, count: l.count }))] } : { tai, detail };
  };
  /** BL-021：保底台数随预览一同返回（徽章/浮层常显） */
  const securedDetail = securedLines(melds, flowers, opts.isDealer ?? false);
  const sec = { secured: securedDetail.reduce((s, d) => s + d.tai, 0), securedDetail };
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
  /** 逐听张算分：只保留达 6 台起胡门槛的「可胡听张」（D-15：不足为诈胡，不得提示） */
  const bestOverWaits = (conc: Record<string, number>, waits: TileId[]) => {
    let best: { tai: number; detail: ScoreDetail[] } = { tai: 0, detail: [] };
    const good: TileId[] = [];
    for (const w of waits) {
      const s = scoreHand(mkHand({ ...conc, [w]: (conc[w] ?? 0) + 1 }, w));
      if (s.win && !s.zhaHu) {
        good.push(w);
        if (s.total > best.tai) best = { tai: s.total, detail: s.detail };
      }
    }
    return { best, good };
  };
  // A：可直接自摸
  if (isWin(concealed, melds.length)) {
    const winTile = opts.drawn ?? (Object.keys(concealed)[0] as TileId);
    const s = scoreHand(mkHand(concealed, winTile));
    if (s.win && !s.zhaHu) {
      const b = withBonus(s.total, s.detail);
      return { tenpai: true, canWin: true, waits: [], tai: b.tai, detail: b.detail, ...sec };
    }
  }
  const total = Object.values(concealed).reduce((a, b) => a + b, 0);
  // B：3n+2，遍历打法取最佳听牌路线（仅计可胡听张）
  if (total % 3 === 2) {
    let best: { tai: number; detail: ScoreDetail[]; via: TileId; waits: TileId[] } | null = null;
    for (const t of Object.keys(concealed) as TileId[]) {
      const conc = { ...concealed, [t]: (concealed[t] ?? 0) - 1 };
      if ((conc[t] ?? 0) <= 0) delete conc[t];
      const waits = waitingTiles(conc, melds.length);
      if (waits.length === 0) continue;
      const { best: b, good } = bestOverWaits(conc, waits);
      if (b.tai > 0 && good.length > 0 && (!best || b.tai > best.tai)) best = { tai: b.tai, detail: b.detail, via: t, waits: good };
    }
    if (best) {
      const b = withBonus(best.tai, best.detail);
      return { tenpai: true, viaDiscard: best.via, waits: best.waits, tai: b.tai, detail: b.detail, ...sec };
    }
    return { tenpai: false, waits: [], tai: 0, detail: [], ...sec };
  }
  // C：3n+1 已听牌（无达门槛听张则不算听牌）
  const waits = waitingTiles(concealed, melds.length);
  if (waits.length === 0) return { tenpai: false, waits: [], tai: 0, detail: [], ...sec };
  const { best: b, good } = bestOverWaits(concealed, waits);
  if (good.length === 0) return { tenpai: false, waits: [], tai: 0, detail: [], ...sec };
  const wb = withBonus(b.tai, b.detail);
  return { tenpai: true, waits: good, tai: wb.tai, detail: wb.detail, ...sec };
}
