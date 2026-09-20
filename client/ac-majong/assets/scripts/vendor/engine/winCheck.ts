import type { TileId } from './types';
import { isSuited, rankOf, suitOf } from './tiles';

/** 从暗牌分解出的一副（顺子/刻子） */
export interface MeldUnit {
  kind: 'seq' | 'pung';
  tiles: TileId[];
}

/** 一种胡牌分解 */
export interface WinDecomp {
  kind: 'standard' | 'pairs8' | 'orphans13' | 'flowers8';
  pair: TileId | null;
  concealedMelds: MeldUnit[];
}

export type WaitType = '独独' | '1独' | '对碰' | null;

/** 全部可胡牌张种类（数牌 27 + 字 7 = 34，不含花） */
export const ALL_KINDS: TileId[] = (() => {
  const kinds: TileId[] = [];
  for (const s of ['W', 'T', 'B'] as const) for (let r = 1; r <= 9; r++) kinds.push(`${s}${r}`);
  for (let r = 1; r <= 7; r++) kinds.push(`Z${r}`);
  return kinds;
})();

const ORPHANS: TileId[] = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7', 'W1', 'W9', 'T1', 'T9', 'B1', 'B9'];

function total(counts: Record<string, number>): number {
  return Object.values(counts).reduce((s, c) => s + c, 0);
}

function sub(counts: Record<string, number>, t: TileId, n: number): Record<string, number> {
  const next = { ...counts };
  const v = (next[t] ?? 0) - n;
  if (v <= 0) delete next[t];
  else next[t] = v;
  return next;
}

/** 把 counts 完全分解成若干副的所有方式（枚举，用于取台数最大 / 番种识别） */
export function decomposeMelds(counts: Record<string, number>): MeldUnit[][] {
  const present = ALL_KINDS.filter((t) => (counts[t] ?? 0) > 0);
  if (present.length === 0) return [[]];
  const t = present[0]!;
  const c = counts[t]!;
  const out: MeldUnit[][] = [];
  if (c >= 3) {
    for (const d of decomposeMelds(sub(counts, t, 3))) out.push([{ kind: 'pung', tiles: [t, t, t] }, ...d]);
  }
  if (isSuited(t) && rankOf(t) <= 7) {
    const t1 = `${suitOf(t)}${rankOf(t) + 1}`;
    const t2 = `${suitOf(t)}${rankOf(t) + 2}`;
    if ((counts[t1] ?? 0) > 0 && (counts[t2] ?? 0) > 0) {
      const rest = sub(sub(sub(counts, t, 1), t1, 1), t2, 1);
      for (const d of decomposeMelds(rest)) out.push([{ kind: 'seq', tiles: [t, t1, t2] }, ...d]);
    }
  }
  return out;
}

/** 标准型：暗牌 = (5 - formedMeldCount) 副 + 1 对 */
export function standardDecomps(concealed: Record<string, number>, formedMeldCount: number): WinDecomp[] {
  const need = 5 - formedMeldCount;
  if (need < 0 || total(concealed) !== need * 3 + 2) return [];
  const res: WinDecomp[] = [];
  for (const p of ALL_KINDS) {
    if ((concealed[p] ?? 0) >= 2) {
      const rest = sub(concealed, p, 2);
      for (const d of decomposeMelds(rest)) {
        if (d.length === need) res.push({ kind: 'standard', pair: p, concealedMelds: d });
      }
    }
  }
  return res;
}

/**
 * BL-021 部分分解：任意数量副（0..n）+ 可选将 + 余牌浮置——枚举当前手牌「已成型」牌型（保底台数用）。
 * 规范序（恒先处理最小牌）保证不重不漏；cap 防枚举爆炸。
 */
export function partialDecomps(concealed: Record<string, number>, cap = 384): WinDecomp[] {
  const res: WinDecomp[] = [];
  const enumSets = (counts: Record<string, number>, acc: MeldUnit[], pair: TileId | null): void => {
    if (res.length >= cap) return;
    const present = ALL_KINDS.filter((t) => (counts[t] ?? 0) > 0);
    if (present.length === 0) {
      res.push({ kind: 'standard', pair, concealedMelds: acc });
      return;
    }
    const t = present[0]!;
    const c = counts[t]!;
    enumSets(sub(counts, t, 1), acc, pair); // 浮置一张
    if (c >= 3) enumSets(sub(counts, t, 3), [...acc, { kind: 'pung', tiles: [t, t, t] }], pair);
    if (isSuited(t) && rankOf(t) <= 7) {
      const t1 = `${suitOf(t)}${rankOf(t) + 1}` as TileId;
      const t2 = `${suitOf(t)}${rankOf(t) + 2}` as TileId;
      if ((counts[t1] ?? 0) > 0 && (counts[t2] ?? 0) > 0) {
        enumSets(sub(sub(sub(counts, t, 1), t1, 1), t2, 1), [...acc, { kind: 'seq', tiles: [t, t1, t2] }], pair);
      }
    }
  };
  enumSets(concealed, [], null);
  for (const p of ALL_KINDS) {
    if ((concealed[p] ?? 0) >= 2) enumSets(sub(concealed, p, 2), [], p);
  }
  return res;
}

/** 八对半（N1）：无成型副，暗牌 17 张 = 8 对 + 1 奇张（8对+1单 或 7对+1刻 均满足） */
export function isPairs8(concealed: Record<string, number>, formedMeldCount: number): boolean {
  if (formedMeldCount !== 0 || total(concealed) !== 17) return false;
  let pairs = 0;
  let odd = 0;
  for (const c of Object.values(concealed)) {
    pairs += Math.floor(c / 2);
    if (c % 2 === 1) odd++;
  }
  return pairs === 8 && odd === 1;
}

/** 十三幺：13 种幺九字各≥1、其一成对（14 张）+ 任意一副（3 张，可来自暗牌或成型副） */
export function isOrphans13(concealed: Record<string, number>, formedMeldCount: number): boolean {
  if (formedMeldCount > 1) return false;
  if (total(concealed) !== 17 - formedMeldCount * 3) return false;
  let paired = 0;
  const rest: Record<string, number> = {};
  for (const [t, c] of Object.entries(concealed)) {
    if (ORPHANS.includes(t)) {
      if (c === 1) continue;
      else if (c === 2) paired++;
      else return false; // M0：幺九字 count>2 的罕见形暂不支持
    } else {
      rest[t] = c;
    }
  }
  for (const o of ORPHANS) if ((concealed[o] ?? 0) < 1) return false;
  if (paired !== 1) return false;
  const needExtra = 1 - formedMeldCount;
  return decomposeMelds(rest).some((d) => d.length === needExtra);
}

export function winDecompositions(concealed: Record<string, number>, formedMeldCount: number): WinDecomp[] {
  const res = standardDecomps(concealed, formedMeldCount);
  if (isPairs8(concealed, formedMeldCount)) res.push({ kind: 'pairs8', pair: null, concealedMelds: [] });
  if (isOrphans13(concealed, formedMeldCount)) res.push({ kind: 'orphans13', pair: null, concealedMelds: [] });
  return res;
}

export function isWin(concealed: Record<string, number>, formedMeldCount: number): boolean {
  return winDecompositions(concealed, formedMeldCount).length > 0;
}

/** 听牌集合枚举：readyConcealed 为 16 张听牌暗牌，返回所有能胡的牌 */
export function waitingTiles(readyConcealed: Record<string, number>, formedMeldCount: number): TileId[] {
  const waits: TileId[] = [];
  for (const t of ALL_KINDS) {
    if ((readyConcealed[t] ?? 0) >= 4) continue; // 该牌已现 4 张，不可能再胡
    const next = { ...readyConcealed, [t]: (readyConcealed[t] ?? 0) + 1 };
    if (isWin(next, formedMeldCount)) waits.push(t);
  }
  return waits;
}

/** 听牌型分类：独独(单听) / 对碰(双碰) / 1独(多面听且胡张在手中) */
export function classifyWait(
  readyConcealed: Record<string, number>,
  formedMeldCount: number,
  winTile: TileId,
): WaitType {
  const waits = waitingTiles(readyConcealed, formedMeldCount);
  if (waits.length === 1) return '独独';
  if (waits.length > 1) {
    if (waits.every((t) => (readyConcealed[t] ?? 0) === 2)) return '对碰';
    if ((readyConcealed[winTile] ?? 0) >= 1) return '1独';
  }
  return null;
}
