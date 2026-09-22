import { ALL_KINDS, isHonor, isSuited, isTerminal, isTerminalOrHonor, rankOf } from '../../engine/index';
import type { Meld, TileId } from '../../engine/index';

export type Counts = Record<string, number>;

/** 参与向听计算的牌种（排除花牌 H） */
const KINDS: TileId[] = ALL_KINDS.filter((k) => !k.startsWith('H'));

export function totalCount(c: Counts): number {
  return Object.values(c).reduce((a, b) => a + b, 0);
}

/** 跨调用缓存（手牌签名 -> 向听），限制容量防内存膨胀 */
const CACHE = new Map<string, number>();
const CACHE_CAP = 20000;

function cacheKey(formedMelds: number, c: Counts): string {
  let s = `${formedMelds}|`;
  for (const k of KINDS) s += (c[k] ?? 0);
  return s;
}

/**
 * 标准型向听数：shanten = (need - m)*2 - t - j。
 * need = 4 - 已成型副数；m = 暗牌面子数；t = 搭子数（对子可作搭子，封顶 need-m）；j = 将(0/1)。
 * 递归枚举「面子/搭子/将」组合取最小；带同状态缓存与剪枝。
 */
export function standardShanten(concealed: Counts, formedMelds: number): number {
  const key = cacheKey(formedMelds, concealed);
  const hit = CACHE.get(key);
  if (hit != null) return hit;

  const need = 4 - formedMelds;
  const counts: Counts = { ...concealed };
  let best = 8;

  const rec = (i: number, m: number, t: number, j: number): number => {
    if (m > need) return 8;
    if (best === -1) return -1;
    let p = i;
    while (p < KINDS.length && (counts[KINDS[p]!] ?? 0) === 0) p++;
    let result: number;
    if (p >= KINDS.length) {
      const tt = Math.min(t, need - m);
      result = (need - m) * 2 - tt - j;
    } else {
      const k = KINDS[p]!;
      const c = counts[k] ?? 0;
      const r = rankOf(k);
      const suited = isSuited(k);
      const k1 = `${k.charAt(0)}${r + 1}`;
      const k2 = `${k.charAt(0)}${r + 2}`;
      let local = 8;
      const consider = (v: number) => {
        if (v < local) local = v;
      };
      // 前进（k 的剩余视为孤张）
      consider(rec(p + 1, m, t, j));
      // 刻子
      if (c >= 3) {
        counts[k] = c - 3;
        consider(rec(p, m + 1, t, j));
        counts[k] = c;
      }
      // 顺子
      if (suited && r <= 7 && (counts[k1] ?? 0) >= 1 && (counts[k2] ?? 0) >= 1) {
        counts[k] = c - 1;
        counts[k1] = (counts[k1] ?? 0) - 1;
        counts[k2] = (counts[k2] ?? 0) - 1;
        consider(rec(p, m + 1, t, j));
        counts[k] = c;
        counts[k1] = (counts[k1] ?? 0) + 1;
        counts[k2] = (counts[k2] ?? 0) + 1;
      }
      // 对子作将（仅一次）
      if (j === 0 && c >= 2) {
        counts[k] = c - 2;
        consider(rec(p, m, t, 1));
        counts[k] = c;
      }
      // 对子作搭子
      if (c >= 2) {
        counts[k] = c - 2;
        consider(rec(p, m, t + 1, j));
        counts[k] = c;
      }
      // 搭子 k,k+1
      if (suited && r <= 8 && (counts[k1] ?? 0) >= 1) {
        counts[k] = c - 1;
        counts[k1] = (counts[k1] ?? 0) - 1;
        consider(rec(p, m, t + 1, j));
        counts[k] = c;
        counts[k1] = (counts[k1] ?? 0) + 1;
      }
      // 搭子 k,k+2
      if (suited && r <= 7 && (counts[k2] ?? 0) >= 1) {
        counts[k] = c - 1;
        counts[k2] = (counts[k2] ?? 0) - 1;
        consider(rec(p, m, t + 1, j));
        counts[k] = c;
        counts[k2] = (counts[k2] ?? 0) + 1;
      }
      result = local;
    }
    if (result < best) best = result;
    return result;
  };

  const val = rec(0, 0, 0, 0);
  if (CACHE.size >= CACHE_CAP) CACHE.clear();
  CACHE.set(key, val);
  return val;
}

/** 八对半向听（近似）：还差几对（仅无副露时有意义） */
export function pairs8Shanten(concealed: Counts, formedMelds: number): number {
  if (formedMelds !== 0) return 8;
  let pairs = 0;
  for (const c of Object.values(concealed)) pairs += Math.floor(c / 2);
  return Math.max(0, 8 - pairs);
}

/** 十三幺向听（近似）：缺几种幺九字 + 是否已有将 */
export function orphans13Shanten(concealed: Counts): number {
  let distinct = 0;
  let paired = 0;
  for (const k of KINDS) {
    if (!isTerminalOrHonor(k)) continue;
    const c = concealed[k] ?? 0;
    if (c >= 1) distinct++;
    if (c >= 2) paired = 1;
  }
  return Math.max(0, 13 - distinct - paired);
}

/** 综合向听数 = min(标准, 八对半, 十三幺) */
export function shanten(concealed: Counts, melds: Meld[]): number {
  const fm = melds.length;
  return Math.min(standardShanten(concealed, fm), pairs8Shanten(concealed, fm), orphans13Shanten(concealed));
}

/**
 * 受入 / 进张数：能使向听前进的牌的剩余张数之和。
 * visible = 已见于牌河/副露的牌（不含自家暗牌），用于估算剩余张数。
 */
export function ukeire(concealed: Counts, melds: Meld[], visible: Counts): number {
  const base = shanten(concealed, melds);
  let sum = 0;
  for (const k of KINDS) {
    const own = concealed[k] ?? 0;
    if (own >= 4) continue;
    const remaining = 4 - own - (visible[k] ?? 0);
    if (remaining <= 0) continue;
    const next: Counts = { ...concealed, [k]: own + 1 };
    if (shanten(next, melds) < base) sum += remaining;
  }
  return sum;
}

/** 统计可见牌（牌河 + 各家副露），供剩余张数估算 */
export function countVisible(discards: TileId[], meldTiles: TileId[]): Counts {
  const vis: Counts = {};
  for (const t of [...discards, ...meldTiles]) vis[t] = (vis[t] ?? 0) + 1;
  return vis;
}

/** 弃牌形状微调：孤张字牌/幺九优先弃（加分），中张/对子优先留（减分） */
export function shapeBonus(t: TileId, concealed: Counts): number {
  const c = concealed[t] ?? 0;
  if (isHonor(t)) return c >= 2 ? -20 : 30;
  if (isTerminal(t)) return c >= 2 ? -10 : 20;
  const r = rankOf(t);
  return r >= 3 && r <= 7 ? -15 : 0;
}
