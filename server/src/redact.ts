import type { TableState } from '@ac-majong/engine';
import { legalActions, wallRemaining, countAll } from '@ac-majong/engine';
import type { ViewState } from '@ac-majong/protocol';

/**
 * 按座位裁剪的视图（防透视核心）。ViewState 定义见 @ac-majong/protocol。
 * 关键：`you.concealed` 给完整暗牌；`others` 只给暗牌张数，绝不给具体牌。
 */
export function redact(state: TableState, seat: number, room: string, maxRounds: number): ViewState {
  const me = state.players.find((p) => p.seat === seat);
  if (!me) throw new Error(`redact: 座位不存在 ${seat}`);
  return {
    room,
    round: state.round,
    maxRounds,
    phase: state.phase,
    dealerSeat: state.dealerSeat,
    currentSeat: state.currentSeat,
    wallRemaining: wallRemaining(state),
    lianzhuangCount: state.lianzhuangCount,
    lastDiscard: state.lastDiscard,
    discards: state.discards.map((d) => ({ seat: d.seat, tile: d.tile })),
    you: {
      seat,
      concealed: { ...me.concealed },
      melds: me.melds,
      flowers: [...me.flowers],
      zi: me.zi,
      score: me.score,
      legal: legalActions(state, seat),
    },
    others: state.players
      .filter((p) => p.seat !== seat)
      .map((p) => ({
        seat: p.seat,
        concealedCount: countAll(p.concealed), // 只给张数
        melds: p.melds,
        flowersCount: p.flowers.length,
        zi: p.zi,
        score: p.score,
      })),
  };
}
