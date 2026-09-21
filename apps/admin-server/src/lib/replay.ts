import { applyAction, rehydrate } from '@ac-majong/engine';
import type { Action, TableState } from '@ac-majong/engine';
import type { ReplayBundle } from '@ac-majong/protocol';
import { buildReplayBundle, toRoundSnapshot } from '@ac-majong/persistence';
import type { AdminGameQueries } from '@ac-majong/persistence';

/** 单帧：一个动作后的全信息台态（admin 为特权方，不做防透视裁剪，Admin 技术方案 §6） */
export interface ReplayFrame {
  seq: number;
  action: Action | null;
  events: string[];
  state: TableState;
}
export interface ReplayMeta {
  gameId: string;
  roomId: string;
  roundNo: number;
  dealerSeat: number;
  names: Record<number, string>;
  endType: string | null;
  result: unknown;
}
export interface ReplayService {
  /** 逐帧还原（服务端 reduce，前端不引 engine） */
  frames(gameId: string): Promise<{ meta: ReplayMeta; frames: ReplayFrame[] } | null>;
  /** 导出自包含、离线可确定性重演的回放包（申诉取证，BL-024） */
  bundle(gameId: string): Promise<ReplayBundle | null>;
}

/** 用 persistence 的只读 replaySource + engine 组装回放；frames/bundle 共用同一 ReplayBundle 契约。 */
export function createReplayService(game: AdminGameQueries): ReplayService {
  return {
    async bundle(gameId) {
      return buildReplayBundle(game.replaySource(), gameId);
    },
    async frames(gameId) {
      const src = game.replaySource();
      const bundle = await buildReplayBundle(src, gameId);
      if (!bundle) return null;
      const g = await src.getGame(gameId);
      const init = await src.getInitialState(gameId);
      if (!g || !init) return null;
      let state = rehydrate(toRoundSnapshot(g, init));
      const frames: ReplayFrame[] = [{ seq: 0, action: null, events: [], state }];
      for (let i = 0; i < bundle.actions.length; i++) {
        const action = bundle.actions[i]!.action as Action;
        const r = applyAction(state, action);
        state = r.state;
        frames.push({ seq: i + 1, action, events: r.events.map((e) => e.type), state });
      }
      const meta: ReplayMeta = {
        gameId,
        roomId: bundle.room.id,
        roundNo: bundle.game.roundNo,
        dealerSeat: bundle.game.dealerSeat,
        names: bundle.names,
        endType: g.endType,
        result: g.result,
      };
      return { meta, frames };
    },
  };
}
