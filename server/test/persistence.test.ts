import { describe, it, expect } from 'vitest';
import {
  createTable,
  applyAction,
  legalActions,
  getPlayer,
  replayRound,
  snapshotRound,
} from '@ac-majong/engine';
import type { Action, TableState } from '@ac-majong/engine';
import { MemoryGameStore, MemoryRealtime } from '../src/persistence/memory';
import { toRoundSnapshot } from '../src/persistence/entities';
import type { ActionRow } from '../src/persistence/entities';

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

const toRow = (gameId: string, a: Action, seq: number): ActionRow => ({
  gameId,
  seq,
  seat: a.seat,
  actionType: a.type,
  payload: a,
});

describe('MemoryGameStore · 房间 + 一局记录往返', () => {
  it('用户/房间/成员事件/对局/初始快照/动作 落库并读回', async () => {
    const store = new MemoryGameStore();
    await store.upsertUser({ openid: 'o1', nickname: '张三', avatarUrl: '' });
    await store.createRoom({
      roomId: 'R1', hostOpenid: 'o1', maxRounds: 8,
      initialScore: { 0: 22, 1: 22, 2: 22, 3: 22 }, finalScore: null, status: 'idle',
    });
    await store.addMemberEvent({ roomId: 'R1', openid: 'o1', seat: 0, event: 'create' });
    await store.addMemberEvent({ roomId: 'R1', openid: 'o1', seat: null, event: 'join' });
    await store.createGame({
      gameId: 'R1:1', roomId: 'R1', roundNo: 1, dealerSeat: 0, seed: 1001, endType: null, result: null,
    });
    await store.saveInitialState({ gameId: 'R1:1', wall: ['p1', 'p2'], hands: [], lianzhuangCount: 0 });
    await store.appendActions([toRow('R1:1', { type: 'discard', seat: 0, tile: 'p1' }, 0)]);

    expect((await store.getUser('o1'))?.nickname).toBe('张三');
    expect((await store.getRoom('R1'))?.maxRounds).toBe(8);
    expect(await store.listMemberEvents('R1')).toHaveLength(2);
    expect((await store.getGame('R1:1'))?.seed).toBe(1001);
    expect((await store.getInitialState('R1:1'))?.wall).toEqual(['p1', 'p2']);
    expect(await store.listActions('R1:1')).toHaveLength(1);
    expect(await store.listGames('R1')).toHaveLength(1);
    expect(await store.getUser('nope')).toBeNull();
  });

  it('closeRoom 写入最终积分快照（D-32：随房间生命周期）', async () => {
    const store = new MemoryGameStore();
    await store.createRoom({
      roomId: 'R2', hostOpenid: 'o', maxRounds: 2,
      initialScore: { 0: 22, 1: 22, 2: 22, 3: 22 }, finalScore: null, status: 'playing',
    });
    await store.closeRoom('R2', { 0: 30, 1: 20, 2: 25, 3: 13 }, new Date());
    const r = await store.getRoom('R2');
    expect(r?.status).toBe('closed');
    expect(r?.finalScore?.[0]).toBe(30);
    expect(r?.closedAt).toBeInstanceOf(Date);
  });

  it('事件溯源：驱动一局 → 存业务事实 → 读回 → replay 精确还原最终状态', async () => {
    const store = new MemoryGameStore();
    let live = createTable(0, 555);
    const snap = snapshotRound(live);
    const actions: Action[] = [];
    for (let i = 0; i < 800; i++) {
      const a = driveOne(live);
      if (!a) break;
      actions.push(a);
      live = applyAction(live, a).state;
    }
    const endType = live.phase === 'exhaustive' ? 'exhaustive' : 'win';

    await store.createRoom({
      roomId: 'R', hostOpenid: 'o', maxRounds: 1,
      initialScore: { 0: 22, 1: 22, 2: 22, 3: 22 }, finalScore: null, status: 'playing',
    });
    await store.createGame({
      gameId: 'G', roomId: 'R', roundNo: snap.round, dealerSeat: snap.dealerSeat,
      seed: 555, endType: null, result: null,
    });
    await store.saveInitialState({
      gameId: 'G', wall: snap.wall, hands: snap.players, lianzhuangCount: snap.lianzhuangCount,
    });
    await store.appendActions(actions.map((a, i) => toRow('G', a, i)));
    await store.finishGame('G', endType, live.players.map((p) => ({ seat: p.seat, score: p.score })), new Date());

    const g = (await store.getGame('G'))!;
    const init = (await store.getInitialState('G'))!;
    const rows = await store.listActions('G');
    expect(rows).toHaveLength(actions.length);
    const { state } = replayRound(toRoundSnapshot(g, init), rows.map((r) => r.payload));
    expect(state).toEqual(live);
    expect(g.endType).toBe(endType);
  });
});

describe('MemoryRealtime · 会话 / 快照 / 缓冲', () => {
  it('会话存取 + TTL 过期 + 删除', async () => {
    const rt = new MemoryRealtime();
    await rt.saveSession('t1', { openid: 'o1', createdAt: Date.now() }, 300);
    expect((await rt.getSession('t1'))?.openid).toBe('o1');
    await rt.saveSession('t2', { openid: 'o2', createdAt: Date.now() }, -1);
    expect(await rt.getSession('t2')).toBeNull();
    await rt.delSession('t1');
    expect(await rt.getSession('t1')).toBeNull();
  });

  it('动作缓冲 drain 后清空', async () => {
    const rt = new MemoryRealtime();
    await rt.bufferActions('G', [toRow('G', { type: 'draw', seat: 0 }, 0)]);
    expect(await rt.drainActions('G')).toHaveLength(1);
    expect(await rt.drainActions('G')).toHaveLength(0);
  });

  it('房间快照 + 实例路由', async () => {
    const rt = new MemoryRealtime();
    await rt.saveRoomSnapshot('R', '{"a":1}');
    expect(await rt.getRoomSnapshot('R')).toBe('{"a":1}');
    await rt.setRoomInstance('R', 'inst-1');
    expect(await rt.getRoomInstance('R')).toBe('inst-1');
  });
});
