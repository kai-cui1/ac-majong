import type { ViewState } from '../protocol/index';
import type { GameClient } from './client';

/** 选择打出的牌：骨架策略——打暗牌第一张（生产可换安全牌/听牌策略） */
export function pickDiscard(v: ViewState): string {
  const tiles = Object.keys(v.you.concealed);
  if (tiles.length === 0) throw new Error('无牌可打');
  return tiles[0]!;
}

/**
 * 根据当前视图决定并发送一个动作；返回是否发出了动作。
 * 策略：能胡则胡（自摸/点炮）→ 否则 摸牌 / 打牌 / 过。
 */
export function botStep(client: GameClient): boolean {
  const v = client.view;
  if (!v) return false;
  const me = v.you.seat;
  const legal = v.you.legal;

  if (v.phase === 'draw' && v.currentSeat === me && legal.includes('draw')) {
    client.action({ type: 'draw', seat: me });
    return true;
  }
  if (v.phase === 'discard' && v.currentSeat === me) {
    if (legal.includes('win_draw')) {
      client.action({ type: 'declareWin', seat: me });
      return true;
    }
    if (legal.includes('discard')) {
      client.action({ type: 'discard', seat: me, tile: pickDiscard(v) });
      return true;
    }
  }
  if (v.phase === 'response') {
    if (legal.includes('win_discard')) {
      client.action({ type: 'respond', seat: me, move: 'win' });
      return true;
    }
    if (legal.includes('pass')) {
      client.action({ type: 'respond', seat: me, move: 'pass' });
      return true;
    }
  }
  return false;
}
