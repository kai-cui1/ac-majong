import type { Action, TileId } from '../../engine/index';
import type { BotContext, BotStrategy } from '../types';

/** 托管保守代打：优先打「现物」（全场牌河已现，相对安全），否则打第一张；不吃/碰/杠/胡 */
function safestDiscard(ctx: BotContext): TileId | null {
  const concealed = ctx.view.you.concealed;
  const keys = Object.keys(concealed) as TileId[];
  if (keys.length === 0) return null;
  const discarded = new Set(ctx.view.discards.map((d) => d.tile));
  for (const t of keys) if (discarded.has(t)) return t;
  return keys[0]!;
}

export const trusteeStrategy: BotStrategy = {
  name: 'trustee',
  displayName: '托管（保守）',
  decide(ctx: BotContext): Action | null {
    const v = ctx.view;
    const seat = ctx.seat;
    const legal = v.you.legal;
    if (v.phase === 'draw' && v.currentSeat === seat && legal.includes('draw')) {
      return { type: 'draw', seat };
    }
    if (v.phase === 'discard' && v.currentSeat === seat && legal.includes('discard')) {
      const tile = safestDiscard(ctx);
      if (tile) return { type: 'discard', seat, tile };
      return null;
    }
    if (v.phase === 'response' && legal.includes('pass')) {
      return { type: 'respond', seat, move: 'pass' };
    }
    return null;
  },
};
