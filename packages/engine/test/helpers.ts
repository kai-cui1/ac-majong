import type { Hand, Meld, TileId, WinBy } from '../src/types';
import { winDecompositions } from '../src/winCheck';
import { analyze } from '../src/analyze';
import { recognizePatterns } from '../src/recognize';

/** 解析 "W123 T456 B99 Z11" → 计数表（花色字母 + 连续数字） */
export function parseTiles(spec: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const re = /([WTBZH])(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(spec)) !== null) {
    const suit = m[1]!;
    for (const ch of m[2]!) {
      const id = suit + ch;
      counts[id] = (counts[id] ?? 0) + 1;
    }
  }
  return counts;
}

/** 解析成展开的牌列表 */
export function expandTiles(spec: string): TileId[] {
  const out: TileId[] = [];
  for (const [id, n] of Object.entries(parseTiles(spec))) for (let i = 0; i < n; i++) out.push(id);
  return out;
}

export function meld(type: Meld['type'], spec: string): Meld {
  return { type, tiles: expandTiles(spec).sort() };
}

export interface HandOpts {
  melds?: Meld[];
  flowers?: string;
  winTile: TileId;
  winBy?: WinBy;
  isDealer?: boolean;
  flow?: Hand['flow'];
  lianzhuangCount?: number;
  seatsZi?: Record<number, number>;
}

/** 构造一手牌（concealed 为含胡牌张的暗牌） */
export function H(concealedSpec: string, o: HandOpts): Hand {
  return {
    concealed: parseTiles(concealedSpec),
    melds: o.melds ?? [],
    flowers: o.flowers ? expandTiles(o.flowers) : [],
    winTile: o.winTile,
    winBy: o.winBy ?? 'dianpao',
    isDealer: o.isDealer ?? false,
    wallRemaining: 50,
    lianzhuangCount: o.lianzhuangCount ?? 0,
    seatsZi: o.seatsZi ?? { 0: 0, 1: 0, 2: 0, 3: 0 },
    flow: o.flow,
  };
}

/** 该手牌（所有分解合并、去重前）识别出的番种名集合 */
export function recognizedNames(hand: Hand): string[] {
  const ds = winDecompositions(hand.concealed, hand.melds.length);
  const names = new Set<string>();
  for (const d of ds) for (const p of recognizePatterns(hand, analyze(hand, d))) names.add(p.name);
  return [...names];
}

/** 断言辅助：是否是合法胡牌结构 */
export function isWinning(hand: Hand): boolean {
  return winDecompositions(hand.concealed, hand.melds.length).length > 0;
}
