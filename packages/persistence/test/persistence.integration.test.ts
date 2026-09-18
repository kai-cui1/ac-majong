import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTable, applyAction, legalActions, getPlayer, replayRound, snapshotRound,
} from '@ac-majong/engine';
import type { Action, TableState } from '@ac-majong/engine';
import { MysqlGameStore } from '../src/mysql';
import { RedisRealtime } from '../src/redis';
import { toRoundSnapshot } from '../src/entities';
import type { ActionRow, GameStore, RealtimeStore } from '../src/entities';

// 仅当 DB_IT=1 且提供 DATABASE_URL / REDIS_URL 时运行（需 deploy/docker compose up -d）
const DB_IT = process.env.DB_IT === '1';

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
  gameId, seq, seat: a.seat, actionType: a.type, payload: a,
});

describe.skipIf(!DB_IT)('MySQL + Redis 集成（DB_IT=1 启用）', () => {
  let store: GameStore;
  let realtime: RealtimeStore;
  const sfx = Date.now();

  beforeAll(() => {
    store = MysqlGameStore.create(process.env.DATABASE_URL!);
    realtime = RedisRealtime.create(process.env.REDIS_URL!);
  });
  afterAll(async () => {
    await store?.close();
    await realtime?.close();
  });

  it('房间 + 一局记录 落库/读回（真实 MySQL）', async () => {
    const roomId = `IT${sfx}`;
    const gameId = `${roomId}:1`;
    const openid = `it_${sfx}`;
    await store.upsertUser({ openid, nickname: '集成用户', avatarUrl: '' });
    await store.createRoom({
      roomId, hostOpenid: openid, maxRounds: 8,
      initialScore: { 0: 22, 1: 22, 2: 22, 3: 22 }, finalScore: null, status: 'idle',
    });
    await store.addMemberEvent({ roomId, openid, seat: 0, event: 'create' });
    await store.createGame({ gameId, roomId, roundNo: 1, dealerSeat: 0, seed: 42, endType: null, result: null });
    await store.saveInitialState({ gameId, wall: ['p1', 'p2', 'p3'], hands: [], lianzhuangCount: 0 });
    await store.appendActions([toRow(gameId, { type: 'discard', seat: 0, tile: 'p1' }, 0)]);
    await store.closeRoom(roomId, { 0: 30, 1: 20, 2: 22, 3: 16 }, new Date());

    expect((await store.getUser(openid))?.nickname).toBe('集成用户');
    const room = await store.getRoom(roomId);
    expect(room?.maxRounds).toBe(8);
    expect(room?.status).toBe('closed');
    expect(room?.finalScore?.[0]).toBe(30);
    expect(room?.createdAt).toBeInstanceOf(Date);
    expect(await store.listMemberEvents(roomId)).toHaveLength(1);
    expect((await store.getGame(gameId))?.seed).toBe(42);
    expect((await store.getInitialState(gameId))?.wall).toEqual(['p1', 'p2', 'p3']);
    expect(await store.listActions(gameId)).toHaveLength(1);
    expect(await store.listGames(roomId)).toHaveLength(1);
  });

  it('事件溯源：真实落库后 replay 精确还原整局', async () => {
    const roomId = `ITG${sfx}`;
    const gameId = `${roomId}:1`;
    let live = createTable(0, 9001);
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
      roomId, hostOpenid: 'x', maxRounds: 1,
      initialScore: { 0: 22, 1: 22, 2: 22, 3: 22 }, finalScore: null, status: 'playing',
    });
    await store.createGame({ gameId, roomId, roundNo: snap.round, dealerSeat: snap.dealerSeat, seed: 9001, endType: null, result: null });
    await store.saveInitialState({ gameId, wall: snap.wall, hands: snap.players, lianzhuangCount: snap.lianzhuangCount });
    await store.appendActions(actions.map((a, i) => toRow(gameId, a, i)));
    await store.finishGame(gameId, endType, { scores: live.players.map((p) => ({ seat: p.seat, score: p.score })) }, new Date());

    const g = (await store.getGame(gameId))!;
    const init = (await store.getInitialState(gameId))!;
    const rows = await store.listActions(gameId);
    expect(rows).toHaveLength(actions.length);
    const { state } = replayRound(toRoundSnapshot(g, init), rows.map((r) => r.payload));
    expect(state).toEqual(live);
  });

  it('Redis：会话 / 快照 / 路由 / 动作缓冲', async () => {
    const t = `it_sess_${sfx}`;
    await realtime.saveSession(t, { openid: 'o', createdAt: Date.now() }, 60);
    expect((await realtime.getSession(t))?.openid).toBe('o');
    await realtime.delSession(t);
    expect(await realtime.getSession(t)).toBeNull();

    await realtime.saveRoomSnapshot(`itr_${sfx}`, '{"round":1}');
    expect(await realtime.getRoomSnapshot(`itr_${sfx}`)).toBe('{"round":1}');
    await realtime.setRoomInstance(`itr_${sfx}`, 'inst-A');
    expect(await realtime.getRoomInstance(`itr_${sfx}`)).toBe('inst-A');

    await realtime.bufferActions(`itg_${sfx}`, [toRow(`itg_${sfx}`, { type: 'draw', seat: 0 }, 0)]);
    expect(await realtime.drainActions(`itg_${sfx}`)).toHaveLength(1);
    expect(await realtime.drainActions(`itg_${sfx}`)).toHaveLength(0);
  });
});
