/**
 * 牌 ID → 素材文件名 映射。
 * 引擎 TileId 规范：W1..W9(万) T1..T9(条) B1..B9(筒) Z1..Z7(东南西北中发白) H1..H8(花)。
 * 素材位于 assets/res/tiles/<name>.png（见 docs/2-效果图 高保真素材）。
 */

const WIND_NAMES: Record<number, string> = { 1: 'wind_east', 2: 'wind_south', 3: 'wind_west', 4: 'wind_north' };
const DRAGON_NAMES: Record<number, string> = { 5: 'dragon_zhong', 6: 'dragon_fa', 7: 'dragon_bai' };
// 花：H1..H8 → 春夏秋冬 + 梅兰竹菊（顺序与素材约定，可后续微调）
const FLOWER_NAMES: string[] = [
  'flower_spring', 'flower_summer', 'flower_autumn', 'flower_winter',
  'flower_plum', 'flower_orchid', 'flower_bamboo', 'flower_chrys',
];

/** 由 TileId 返回素材名（不含扩展名） */
export function tileAssetName(tileId: string): string {
  const suit = tileId.charAt(0);
  const rank = Number(tileId.slice(1));
  switch (suit) {
    case 'W':
      return `wan_${rank}`;
    case 'T':
      return `tiao_green_${rank}`;
    case 'B':
      return `tong_blue_${rank}`;
    case 'Z':
      return rank <= 4 ? WIND_NAMES[rank]! : DRAGON_NAMES[rank]!;
    case 'H':
      return FLOWER_NAMES[rank - 1] ?? 'flower_spring';
    default:
      return 'wan_1';
  }
}

/** SpriteFrame 资源路径（resources 下，加载用 resources.load）。牌图放 assets/resources/tiles/ 时用此。 */
export function tileResPath(tileId: string): string {
  return `tiles/${tileAssetName(tileId)}/spriteFrame`;
}

/** 牌背/牌侧俯视素材名 */
export const TILE_EDGE_TOP = 'tile_edge_top';
