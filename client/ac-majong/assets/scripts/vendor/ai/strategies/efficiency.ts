import { canPong, chiOptions, previewTai } from '../../engine/index';
import type { Action, Meld, PlayerState, TileId } from '../../engine/index';
import type { ViewState } from '../../protocol/index';
import { countVisible, shanten, shapeBonus, ukeire, type Counts } from '../features/shanten';
import type { BotContext, BotStrategy, DiscardEval } from '../types';

function removeOne(c: Counts, t: TileId): Counts {
  const n = { ...c };
  n[t] = (n[t] ?? 0) - 1;
  if ((n[t] ?? 0) <= 0) delete n[t];
  return n;
}

function removeTwo(c: Counts, t: TileId): Counts {
  const n = { ...c };
  n[t] = (n[t] ?? 0) - 2;
  if ((n[t] ?? 0) <= 0) delete n[t];
  return n;
}

/** 统计可见牌（全场牌河 + 各家副露），供剩余张数估算 */
export function buildVisible(v: ViewState): Counts {
  const tiles: TileId[] = v.discards.map((d) => d.tile);
  for (const m of v.you.melds) tiles.push(...m.tiles);
  for (const o of v.others) for (const m of o.melds) tiles.push(...m.tiles);
  return countVisible(tiles, []);
}

function playerState(ctx: BotContext): PlayerState {
  const you = ctx.view.you;
  return { seat: ctx.seat, concealed: you.concealed, melds: you.melds, flowers: you.flowers, zi: you.zi, score: you.score };
}

/** 对每个可打候选打分（向听最小 → 受入最大 → 听牌台数 → 形状微调 → 扰动） */
export function evaluateDiscards(ctx: BotContext): DiscardEval[] {
  const you = ctx.view.you;
  const concealed = you.concealed;
  const melds = you.melds;
  const visible = buildVisible(ctx.view);
  const opts = {
    isDealer: ctx.seat === ctx.view.dealerSeat,
    wallRemaining: ctx.view.wallRemaining,
    lianzhuangCount: ctx.view.lianzhuangCount,
    myZi: you.zi,
  };
  const evals: DiscardEval[] = (Object.keys(concealed) as TileId[]).map((t) => ({
    tile: t,
    shanten: shanten(removeOne(concealed, t), melds),
    ukeire: 0,
    tenpai: false,
    tai: 0,
    score: 0,
  }));
  const minS = Math.min(...evals.map((e) => e.shanten));
  for (const e of evals) {
    const h = removeOne(concealed, e.tile);
    // 结构听牌后再用 previewTai 校验「达标可胡」（<6 台不计，防诈胡）
    if (e.shanten === 0) {
      const pv = previewTai(h, melds, you.flowers, opts);
      e.tenpai = pv.tenpai;
      e.tai = pv.tai;
    }
    if (e.shanten === minS) e.ukeire = ukeire(h, melds, visible);
  }
  for (const e of evals) {
    let sc = -1000 * e.shanten + e.ukeire;
    if (e.tenpai) sc += 200 + 5 * e.tai;
    sc += shapeBonus(e.tile, concealed);
    if (ctx.cfg.noise > 0) sc += (ctx.rng() - 0.5) * 2 * ctx.cfg.noise * 50;
    e.score = sc;
  }
  return evals.sort((a, b) => b.score - a.score);
}

export function pickDiscard(ctx: BotContext): TileId | null {
  return evaluateDiscards(ctx)[0]?.tile ?? null;
}

interface ResponsePick {
  move: 'pong' | 'chi';
  chiTiles?: TileId[];
}

/** 副露决策：仅当能实质推进向听时才碰/吃（门清更灵活，P1 不主动杠） */
export function pickResponse(ctx: BotContext): ResponsePick | null {
  const v = ctx.view;
  const tile = v.lastDiscard?.tile;
  if (!tile) return null;
  const you = v.you;
  const before = shanten(you.concealed, you.melds);
  if (v.you.legal.includes('pong') && canPong(playerState(ctx), tile)) {
    const after = removeTwo(you.concealed, tile);
    const pongMeld: Meld = { type: 'pong', tiles: [tile, tile, tile] };
    if (shanten(after, [...you.melds, pongMeld]) < before) return { move: 'pong' };
  }
  if (v.you.legal.includes('chi')) {
    const combos = chiOptions(playerState(ctx), tile);
    let best: { chiTiles: TileId[]; s: number } | null = null;
    for (const combo of combos) {
      let h: Counts = { ...you.concealed };
      for (const c of combo) {
        h[c] = (h[c] ?? 0) - 1;
        if ((h[c] ?? 0) <= 0) delete h[c];
      }
      const chiMeld: Meld = { type: 'chi', tiles: [...combo, tile], called: tile };
      const s = shanten(h, [...you.melds, chiMeld]);
      if (!best || s < best.s) best = { chiTiles: combo, s };
    }
    if (best && best.s < before) return { move: 'chi', chiTiles: best.chiTiles };
  }
  return null;
}

/** P1 效率型策略：牌效率驱动（向听/受入/达标台数），合理碰吃，能胡则胡 */
export const efficiencyStrategy: BotStrategy = {
  name: 'efficiency',
  displayName: '最大概率打法',
  decide(ctx: BotContext): Action | null {
    const v = ctx.view;
    const seat = ctx.seat;
    const legal = v.you.legal;
    if (v.phase === 'draw' && v.currentSeat === seat && legal.includes('draw')) {
      return { type: 'draw', seat };
    }
    if (v.phase === 'discard' && v.currentSeat === seat) {
      if (ctx.cfg.canWin && legal.includes('win_draw') && ctx.preview.canWin) {
        return { type: 'declareWin', seat };
      }
      const tile = pickDiscard(ctx);
      if (tile && legal.includes('discard')) return { type: 'discard', seat, tile };
      return null;
    }
    if (v.phase === 'response') {
      if (ctx.cfg.canWin && legal.includes('win_discard')) {
        return { type: 'respond', seat, move: 'win' };
      }
      if (ctx.cfg.allowMeld) {
        const mv = pickResponse(ctx);
        if (mv) {
          return mv.move === 'chi'
            ? { type: 'respond', seat, move: 'chi', chiTiles: mv.chiTiles }
            : { type: 'respond', seat, move: 'pong' };
        }
      }
      if (legal.includes('pass')) return { type: 'respond', seat, move: 'pass' };
    }
    return null;
  },
};
