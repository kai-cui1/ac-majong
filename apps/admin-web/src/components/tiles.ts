/**
 * 牌面贴图工具（FR-Admin-10）：TileId → `public/tiles/*.png` 文件名映射。
 * 复刻 client `TileAtlas.ts` 的映射（admin-web 不引 packages/**，见架构 §4 / Admin 技术方案 §6）——
 * 与原型 admin/monitor.html、admin/replay.html 内联的 asset() 同源，回归架构 §6.2「复用牌面贴图」。
 */

/** 引擎 TileId（形如 "W1".."W9"、"T1".."T9"、"B1".."B9"、"Z1".."Z7"、"H1".."H8"） */
export type TileId = string;

const WIND: Record<number, string> = { 1: 'wind_east', 2: 'wind_south', 3: 'wind_west', 4: 'wind_north' };
const DRAGON: Record<number, string> = { 5: 'dragon_zhong', 6: 'dragon_fa', 7: 'dragon_bai' };
const FLOWER = ['flower_spring', 'flower_summer', 'flower_autumn', 'flower_winter', 'flower_plum', 'flower_orchid', 'flower_bamboo', 'flower_chrys'];

/** TileId → 贴图文件名（不含扩展名）；未知牌兜底 wan_1 */
export function tileAssetName(id: TileId): string {
  const s = id.charAt(0);
  const r = Number(id.slice(1));
  if (s === 'W') return `wan_${r}`;
  if (s === 'T') return `tiao_green_${r}`;
  if (s === 'B') return `tong_blue_${r}`;
  if (s === 'Z') return r <= 4 ? WIND[r] ?? 'wind_east' : DRAGON[r] ?? 'dragon_zhong';
  if (s === 'H') return FLOWER[r - 1] ?? 'flower_spring';
  return 'wan_1';
}

/** TileId → 可引用的贴图 URL（public/tiles 静态资源，同源根路径） */
export function tileSrc(id: TileId): string {
  return `/tiles/${tileAssetName(id)}.png`;
}

/** 暗牌计数表（TileId→张数）展开为升序 TileId 列表，供逐张贴图渲染 */
export function expandConcealed(c: Record<string, number> | undefined | null): TileId[] {
  const out: TileId[] = [];
  for (const id of Object.keys(c ?? {}).sort()) {
    const n = c?.[id] ?? 0;
    for (let i = 0; i < n; i++) out.push(id);
  }
  return out;
}

/** 副类型 → 中文标签（对齐引擎 MeldType） */
export const MELD_LABEL: Record<string, string> = {
  chi: '吃',
  pong: '碰',
  kong_exposed: '明杠',
  kong_concealed: '暗杠',
  kong_added: '加杠',
};
