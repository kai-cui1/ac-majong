import type { ReplayActionRow, ReplayBundle, ReplaySnapshot } from '@ac-majong/protocol';
import type { GameStore } from './entities';

/**
 * 组装回放包所需的最小只读数据源（GameStore 的读子集）。
 * 收窄入参便于非 GameStore 实现（如 admin 的 Drizzle 只读适配）复用同一组装逻辑。
 */
export type ReplaySource = Pick<
  GameStore,
  'getGame' | 'getInitialState' | 'listActions' | 'listMemberEvents' | 'getRoom' | 'getUser'
>;

/**
 * BL-024：由持久化事件溯源组装单局回放包。snapshot 自带整副洗好的墙，故无需 seed 即可离线确定性重演。
 * 不做成员校验——调用方（game-server WS exportReplay / dev HTTP、admin-server 导出取证）各自负责授权。
 *
 * 原位于 apps/game-server/src/diag.ts；下沉至 @ac-majong/persistence 供 game-server 与 admin-server 共用
 * （消除 Admin 跨 app import，见架构 §4 与 Admin 技术方案 §10.1）。仅依赖 ReplaySource + protocol 类型。
 */
export async function buildReplayBundle(store: ReplaySource, gameId: string): Promise<ReplayBundle | null> {
  const game = await store.getGame(gameId);
  if (!game) return null;
  const snapRow = await store.getInitialState(gameId);
  if (!snapRow) return null;
  const [actionRows, memEv, roomRow] = await Promise.all([
    store.listActions(gameId),
    store.listMemberEvents(game.roomId),
    store.getRoom(game.roomId),
  ]);
  const names: Record<number, string> = {};
  const seen = new Set<number>();
  for (const mem of memEv) {
    if (mem.seat == null || seen.has(mem.seat)) continue;
    seen.add(mem.seat);
    const u = await store.getUser(mem.openid);
    names[mem.seat] = u?.nickname ?? mem.openid.slice(0, 8);
  }
  const snapshot: ReplaySnapshot = {
    wall: snapRow.wall as string[],
    players: snapRow.hands.map((pl) => ({ seat: pl.seat, concealed: pl.concealed as Record<string, number>, melds: pl.melds, flowers: pl.flowers as string[], zi: pl.zi, score: pl.score })),
    dealerSeat: game.dealerSeat,
    currentSeat: game.dealerSeat,
    lianzhuangCount: snapRow.lianzhuangCount,
    round: game.roundNo,
  };
  const actions: ReplayActionRow[] = actionRows.map((ar) => ({ seq: ar.seq, seat: ar.seat, action: ar.payload }));
  return {
    v: 1,
    exportedAt: Date.now(),
    room: { id: game.roomId, maxRounds: roomRow?.maxRounds ?? 0, settings: roomRow?.settings ?? null, seating: roomRow?.seating ?? null },
    game: { gameId, roundNo: game.roundNo, dealerSeat: game.dealerSeat },
    snapshot,
    actions,
    names,
  };
}
