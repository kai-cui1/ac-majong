import type { TileId } from './types';
import type { PlayerState, TableState } from './table';
import { addTile, countTile, isTailRestricted, nextSeat } from './table';
import { isSuited, isFlower, rankOf, suitOf } from './tiles';
import { isWin } from './winCheck';

/** 含 t 的所有可能顺子（t 作最低/中间/最高） */
function chiCombos(t: TileId): TileId[][] {
  if (!isSuited(t)) return [];
  const s = suitOf(t);
  const r = rankOf(t);
  const combos: TileId[][] = [];
  if (r <= 7) combos.push([t, `${s}${r + 1}`, `${s}${r + 2}`]);
  if (r >= 2 && r <= 8) combos.push([`${s}${r - 1}`, t, `${s}${r + 1}`]);
  if (r >= 3) combos.push([`${s}${r - 2}`, `${s}${r - 1}`, t]);
  return combos;
}

/** 可吃的顺子组合（手中已具备另两张） */
export function chiOptions(p: PlayerState, tile: TileId): TileId[][] {
  if (isFlower(tile)) return [];
  return chiCombos(tile).filter((c) => c.every((x) => x === tile || countTile(p.concealed, x) >= 1));
}
export function canChi(p: PlayerState, tile: TileId): boolean {
  return chiOptions(p, tile).length > 0;
}
export function canPong(p: PlayerState, tile: TileId): boolean {
  return !isFlower(tile) && countTile(p.concealed, tile) >= 2;
}
/** 明杠（直杠）：他家弃牌 + 手中 3 张 */
export function canExposedKong(p: PlayerState, tile: TileId): boolean {
  return !isFlower(tile) && countTile(p.concealed, tile) >= 3;
}
/** 暗杠：自己回合手中 4 张 */
export function concealedKongOptions(p: PlayerState): TileId[] {
  return Object.keys(p.concealed).filter((t) => !isFlower(t) && countTile(p.concealed, t) === 4);
}
/** 加杠：已有碰副 + 手中 1 张同牌 */
export function addedKongOptions(p: PlayerState): TileId[] {
  return p.melds
    .filter((m) => m.type === 'pong')
    .map((m) => m.tiles[0]!)
    .filter((t) => countTile(p.concealed, t) >= 1);
}

/** 自摸胡（结构判定，或八只花 D-26；台数≥6 的门槛在 reducer 声明时校验） */
export function canWinDraw(p: PlayerState): boolean {
  return isWin(p.concealed, p.melds.length) || p.flowers.length === 8;
}
/** 点炮胡（结构判定） */
export function canWinDiscard(p: PlayerState, tile: TileId): boolean {
  if (isFlower(tile)) return false;
  const c = { ...p.concealed };
  addTile(c, tile);
  return isWin(c, p.melds.length);
}

export type ActionKind =
  | 'draw'
  | 'discard'
  | 'chi'
  | 'pong'
  | 'kong_exposed'
  | 'kong_concealed'
  | 'kong_added'
  | 'win_draw'
  | 'win_discard'
  | 'pass';

/** 当前该座位的合法动作（含末尾限制 D-09） */
export function legalActions(state: TableState, seat: number): ActionKind[] {
  const p = state.players.find((x) => x.seat === seat);
  if (!p) return [];
  const acts: ActionKind[] = [];
  const restricted = isTailRestricted(state);

  if (state.phase === 'draw' && state.currentSeat === seat) {
    acts.push('draw');
  } else if (state.phase === 'discard' && state.currentSeat === seat) {
    acts.push('discard');
    if (canWinDraw(p)) acts.push('win_draw');
    if (concealedKongOptions(p).length > 0) acts.push('kong_concealed'); // 摸杠：末尾仍可
    if (!restricted && addedKongOptions(p).length > 0) acts.push('kong_added'); // 碰杠：末尾禁
  } else if (state.phase === 'response' && state.lastDiscard && state.lastDiscard.seat !== seat) {
    const tile = state.lastDiscard.tile;
    if (canWinDiscard(p, tile)) acts.push('win_discard'); // 胡不受末尾限制
    if (!restricted) {
      if (canPong(p, tile)) acts.push('pong');
      if (canExposedKong(p, tile)) acts.push('kong_exposed');
      if (nextSeat(state, state.lastDiscard.seat) === seat && canChi(p, tile)) acts.push('chi');
    }
    acts.push('pass');
  }
  return acts;
}
