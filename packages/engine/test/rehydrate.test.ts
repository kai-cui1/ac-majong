import { describe, it, expect } from 'vitest';
import {
  createTable,
  snapshotRound,
  rehydrate,
  replayRound,
  applyAction,
  legalActions,
  getPlayer,
} from '../src/index';
import type { Action, TableState } from '../src/index';

/** 自动驱动器：每步选一个合法动作（响应阶段一律 pass），把一局跑到底 */
function driveOne(s: TableState): Action | null {
  if (s.phase === 'settled' || s.phase === 'exhaustive') return null;
  if (s.phase === 'draw') return { type: 'draw', seat: s.currentSeat };
  if (s.phase === 'discard') {
    const tile = Object.keys(getPlayer(s, s.currentSeat).concealed)[0];
    return tile ? { type: 'discard', seat: s.currentSeat, tile } : null;
  }
  const seat = s.players.find(
    (p) => s.pending[p.seat] === null && legalActions(s, p.seat).includes('pass'),
  )?.seat;
  return seat != null ? { type: 'respond', seat, move: 'pass' } : null;
}

describe('rehydrate · 事件溯源还原', () => {
  it('snapshot → rehydrate 精确重建一局初始 TableState', () => {
    const t = createTable(0, 12345);
    expect(rehydrate(snapshotRound(t))).toEqual(t);
  });

  it('确定性：同 seed 的快照一致（可交叉校验）', () => {
    expect(snapshotRound(createTable(0, 42))).toEqual(snapshotRound(createTable(0, 42)));
  });

  it('replay：单动作回放与实时一致', () => {
    const t0 = createTable(0, 777);
    const tile = Object.keys(getPlayer(t0, 0).concealed)[0]!;
    const action: Action = { type: 'discard', seat: 0, tile };
    const live = applyAction(t0, action).state;
    expect(replayRound(snapshotRound(t0), [action]).state).toEqual(live);
  });

  it('replay：整局自动驱动回放，最终状态与实时逐一致', () => {
    let live = createTable(2, 20240916);
    const snap = snapshotRound(live);
    const actions: Action[] = [];
    for (let i = 0; i < 800; i++) {
      const a = driveOne(live);
      if (!a) break;
      actions.push(a);
      live = applyAction(live, a).state;
    }
    expect(actions.length).toBeGreaterThan(10);
    const { state, events } = replayRound(snap, actions);
    expect(state).toEqual(live);
    expect(events.length).toBeGreaterThan(0);
  });
});
