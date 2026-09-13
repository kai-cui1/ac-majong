import type { Suit, TileId } from './types';

/** 风：东南西北 = Z1..Z4 */
export const WIND_IDS: TileId[] = ['Z1', 'Z2', 'Z3', 'Z4'];
/** 元：中发白 = Z5..Z7 */
export const DRAGON_IDS: TileId[] = ['Z5', 'Z6', 'Z7'];
export const HONOR_NAMES = ['东', '南', '西', '北', '中', '发', '白'];

export function suitOf(id: TileId): Suit {
  return id.charAt(0) as Suit;
}

export function rankOf(id: TileId): number {
  return Number(id.slice(1));
}

export function isSuited(id: TileId): boolean {
  const s = suitOf(id);
  return s === 'W' || s === 'T' || s === 'B';
}

export function isHonor(id: TileId): boolean {
  return suitOf(id) === 'Z';
}

export function isFlower(id: TileId): boolean {
  return suitOf(id) === 'H';
}

export function isWind(id: TileId): boolean {
  return WIND_IDS.includes(id);
}

export function isDragon(id: TileId): boolean {
  return DRAGON_IDS.includes(id);
}

export function isTerminal(id: TileId): boolean {
  return isSuited(id) && (rankOf(id) === 1 || rankOf(id) === 9);
}

/** 幺九字：十三幺用到的 13 种 */
export function isTerminalOrHonor(id: TileId): boolean {
  return isHonor(id) || isTerminal(id);
}

/** 九筒 / 九万为高价值特殊牌（九条 T9 不算，见规格书 3.9） */
export function isNineSpecial(id: TileId): boolean {
  return id === 'B9' || id === 'W9';
}

/** 完整牌墙 144 张：数牌 3×9×4=108，字 7×4=28，花 8 */
export function fullWall(): TileId[] {
  const wall: TileId[] = [];
  for (const s of ['W', 'T', 'B'] as Suit[]) {
    for (let r = 1; r <= 9; r++) for (let k = 0; k < 4; k++) wall.push(`${s}${r}`);
  }
  for (let r = 1; r <= 7; r++) for (let k = 0; k < 4; k++) wall.push(`Z${r}`);
  for (let r = 1; r <= 8; r++) wall.push(`H${r}`);
  return wall;
}
