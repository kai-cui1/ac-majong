import type { Hand, TileId, Meld } from './types';
import type { WinDecomp, MeldUnit } from './winCheck';
import { isHonor, isWind, isDragon, isSuited, suitOf } from './tiles';

/** 分析后的一副 */
export interface AnalyzedMeld {
  kind: 'seq' | 'pung' | 'kong';
  base: TileId; // 刻/杠=该牌；顺=最小牌
  tiles: TileId[];
  concealed: boolean; // 暗刻/暗杠/暗顺（来自暗牌分解）
  revealed: boolean; // 吃/碰/明杠/加杠
}

export interface HandAnalysis {
  winKind: WinDecomp['kind'];
  melds: AnalyzedMeld[];
  pair: TileId | null;
  allTiles: TileId[]; // 整手牌（暗牌展开 + 成型副），与分解无关
  seqCount: number;
  concealedPungCount: number; // 暗坎 = 暗刻 + 暗杠（N3）
  kongExposedCount: number; // 明杠（含加杠）
  kongConcealedCount: number; // 暗杠
  suits: ('W' | 'T' | 'B')[]; // 出现的数牌花色（去重）
  hasHonor: boolean;
  windPungCount: number;
  dragonPungCount: number;
  honorPungCount: number; // 见字计数（字刻 + 字杠）
  honorPungTiles: TileId[]; // 见字的具体字牌（供展开显示）
  pairIsWind: boolean;
  pairIsDragon: boolean;
  hasEastPung: boolean;
  flowerCount: number;
  flowerTiles: TileId[]; // 见花的具体花牌（供展开显示）
  isMenqing: boolean;
  nineB: number; // 手牌中 B9 张数
  nineW: number; // 手牌中 W9 张数
}

function expand(counts: Record<string, number>): TileId[] {
  const out: TileId[] = [];
  for (const [t, c] of Object.entries(counts)) for (let i = 0; i < c; i++) out.push(t);
  return out;
}

function fromFormed(m: Meld): AnalyzedMeld {
  const tiles = [...m.tiles].sort();
  const base = tiles[0]!;
  switch (m.type) {
    case 'chi':
      return { kind: 'seq', base, tiles, concealed: false, revealed: true };
    case 'pong':
      return { kind: 'pung', base, tiles, concealed: false, revealed: true };
    case 'kong_exposed':
    case 'kong_added':
      return { kind: 'kong', base, tiles, concealed: false, revealed: true };
    case 'kong_concealed':
      return { kind: 'kong', base, tiles, concealed: true, revealed: false };
  }
}

function fromUnit(u: MeldUnit): AnalyzedMeld {
  const tiles = [...u.tiles].sort();
  return { kind: u.kind, base: tiles[0]!, tiles, concealed: true, revealed: false };
}

/** 由 Hand + 一个胡牌分解，算出番种识别所需的派生量 */
export function analyze(hand: Hand, decomp: WinDecomp): HandAnalysis {
  const melds: AnalyzedMeld[] = [...hand.melds.map(fromFormed), ...decomp.concealedMelds.map(fromUnit)];
  const allTiles: TileId[] = [...expand(hand.concealed), ...hand.melds.flatMap((m) => m.tiles)];

  const pungLike = melds.filter((m) => m.kind === 'pung' || m.kind === 'kong');
  const seqCount = melds.filter((m) => m.kind === 'seq').length;
  const concealedPungCount =
    decomp.concealedMelds.filter((u) => u.kind === 'pung').length +
    hand.melds.filter((m) => m.type === 'kong_concealed').length; // N3：暗杠计入暗坎
  const kongExposedCount = hand.melds.filter((m) => m.type === 'kong_exposed' || m.type === 'kong_added').length;
  const kongConcealedCount = hand.melds.filter((m) => m.type === 'kong_concealed').length;

  const suits = Array.from(new Set(allTiles.filter(isSuited).map(suitOf))) as ('W' | 'T' | 'B')[];
  const pair = decomp.pair;
  // 门清：无 吃/碰/明杠/加杠（暗杠不破，N2）
  const isMenqing = !hand.melds.some(
    (m) => m.type === 'chi' || m.type === 'pong' || m.type === 'kong_exposed' || m.type === 'kong_added',
  );

  return {
    winKind: decomp.kind,
    melds,
    pair,
    allTiles,
    seqCount,
    concealedPungCount,
    kongExposedCount,
    kongConcealedCount,
    suits,
    hasHonor: allTiles.some(isHonor),
    windPungCount: pungLike.filter((m) => isWind(m.base)).length,
    dragonPungCount: pungLike.filter((m) => isDragon(m.base)).length,
    honorPungCount: pungLike.filter((m) => isHonor(m.base)).length,
    honorPungTiles: pungLike.filter((m) => isHonor(m.base)).map((m) => m.base),
    pairIsWind: pair != null && isWind(pair),
    pairIsDragon: pair != null && isDragon(pair),
    hasEastPung: pungLike.some((m) => m.base === 'Z1'),
    flowerCount: hand.flowers.length,
    flowerTiles: [...hand.flowers],
    isMenqing,
    nineB: allTiles.filter((t) => t === 'B9').length,
    nineW: allTiles.filter((t) => t === 'W9').length,
  };
}
