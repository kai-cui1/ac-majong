import { Node, Sprite, UITransform, resources, SpriteFrame, Color, Sprite as CCSprite } from 'cc';
import { tileResPath } from './TileAtlas';

/** 牌的标准显示尺寸（南家手牌）。素材原始约 126×170，等比。 */
export const TILE_W = 44;
export const TILE_H = 60;

/**
 * 创建一张牌节点（带 Sprite），异步加载牌面。
 * @param tileId 引擎牌 ID（如 "W1"）；传空/牌背用 back=true
 */
export function createTileNode(tileId: string, w = TILE_W, h = TILE_H): Node {
  const node = new Node(`Tile_${tileId}`);
  const tf = node.addComponent(UITransform);
  tf.setContentSize(w, h);
  const sp = node.addComponent(Sprite);
  sp.sizeMode = CCSprite.SizeMode.CUSTOM;
  sp.type = CCSprite.Type.SIMPLE;
  loadTileFace(sp, tileId);
  return node;
}

/** 牌面 SpriteFrame 缓存：命中则同步赋值，避免异步回调与重渲染销毁竞态，并降低重复载图开销 */
const frameCache = new Map<string, SpriteFrame>();

/** 给已有 Sprite 载入牌面图 */
export function loadTileFace(sp: Sprite, tileId: string): void {
  const cached = frameCache.get(tileId);
  if (cached) {
    sp.spriteFrame = cached;
    sp.color = Color.WHITE;
    return;
  }
  resources.load(tileResPath(tileId), SpriteFrame, (err, frame) => {
    // 回调可能晚于节点销毁到达（对局中每次 gameView 重渲染会 destroyAllChildren）；
    // 此时 sp.node 为 null，再赋 spriteFrame 会触发 Sprite 读 null._uiProps 崩溃，必须跳过
    if (!sp.isValid || !sp.node || !sp.node.isValid) return;
    if (err) {
      // 载图失败兜底：显示灰底，避免整局崩溃
      sp.spriteFrame = null;
      sp.color = new Color(200, 200, 200, 255);
      console.warn(`[TileNode] 载入牌面失败 ${tileId}:`, err.message);
      return;
    }
    frameCache.set(tileId, frame);
    sp.spriteFrame = frame;
    sp.color = Color.WHITE;
  });
}

/** 把 concealed 计数表展开为已排序的 TileId 列表（万<条<筒<字，同门按点数） */
export function expandSorted(concealed: Record<string, number>): string[] {
  const order = (id: string) => {
    const s = 'WTBZH'.indexOf(id.charAt(0));
    return s * 100 + Number(id.slice(1));
  };
  const out: string[] = [];
  for (const [id, n] of Object.entries(concealed)) for (let i = 0; i < n; i++) out.push(id);
  return out.sort((a, b) => order(a) - order(b));
}
