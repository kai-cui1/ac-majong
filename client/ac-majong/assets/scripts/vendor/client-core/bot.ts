import { createAutoPlayer, DEFAULT_PERSONA, hashString, seededRng } from '../ai/index';
import type { ViewState } from '../protocol/index';
import type { GameClient } from './client';

/** 默认打法决策器（最大概率打法）；固定种子源，不干扰全局 Math.random 且可复现 */
const defaultPlayer = createAutoPlayer(DEFAULT_PERSONA, seededRng(hashString('client-core-bot')));

/** 选择打出的牌：委托给 `@ac-majong/ai` 默认打法；保留旧签名供既有调用 */
export function pickDiscard(v: ViewState): string {
  const a = defaultPlayer.decide(v, v.you.seat);
  if (a && a.type === 'discard') return a.tile;
  const tiles = Object.keys(v.you.concealed);
  if (tiles.length === 0) throw new Error('无牌可打');
  return tiles[0]!;
}

/**
 * 根据当前视图决定并发送一个动作；返回是否发出了动作。
 * 决策完全委托 `@ac-majong/ai` AutoPlayer（效率型：能胡则胡 / 摸打 / 合理碰吃 / 否则过）。
 */
export function botStep(client: GameClient): boolean {
  const v = client.view;
  if (!v) return false;
  const action = defaultPlayer.decide(v, v.you.seat);
  if (!action) return false;
  client.action(action);
  return true;
}
