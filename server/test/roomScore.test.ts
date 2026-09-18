import { describe, it, expect } from 'vitest';
import { driveCeremony } from './ceremonyHelper';
import { RoomManager } from '../src/roomManager';
import type { RoomActor } from '../src/roomActor';
import type { Connection } from '../src/connection';
import type { ServerMsg } from '@ac-majong/protocol';
import { legalActions, getPlayer } from '@ac-majong/engine';
import type { Action, TableState } from '@ac-majong/engine';
import { MemoryGameStore, MemoryRealtime } from '../src/persistence/memory';
import type { GameStore, RealtimeStore } from '../src/persistence/entities';
import { rebuildRoomFromStore } from '../src/wsGateway';

/**
 * BL-016 房间积分周期：房间=完整结算周期——
 * 积分账本每局末落库、重进/服务重启后事件溯源重建（座位+积分保留）、
 * 已关闭房间拒绝加入、房号全局唯一永不复用。
 */

class MockConn implements Connection {
  userId: string;
  sent: ServerMsg[] = [];
  constructor(userId: string) {
    this.userId = userId;
  }
  send(msg: ServerMsg): void {
    this.sent.push(msg);
  }
  close(): void {}
}

/** 与 wsGateway 一致的落库钩子（开局快照 / 动作 Redis 缓冲 / 局末 drain+积分账本） */
function makeHooks(store: GameStore, realtime: RealtimeStore) {
  return {
    onGameStart(roomId: string, gameId: string, snap: unknown, dealerSeat: number, seed: number, roundNo: number): void {
      void (async () => {
        await store.createGame({ gameId, roomId, roundNo, dealerSeat, seed, endType: null, result: null });
        const s = snap as { wall: string[]; players: never[]; lianzhuangCount: number };
        await store.saveInitialState({ gameId, wall: s.wall, hands: s.players, lianzhuangCount: s.lianzhuangCount });
      })();
    },
    onGameAction(gameId: string, seq: number, seat: number | null, action: Action): void {
      void realtime.bufferActions(gameId, [{ gameId, seq, seat, actionType: action.type, payload: action }]);
    },
    onGameEnd(roomId: string, gameId: string, endType: 'win' | 'exhaustive', result: unknown, scores: Record<number, number>): void {
      void (async () => {
        const rows = await realtime.drainActions(gameId);
        if (rows.length) await store.appendActions(rows);
        await store.finishGame(gameId, endType, result, new Date());
        await store.updateRoomScores(roomId, scores);
      })();
    },
    onRoomEnd(roomId: string, standings: { seat: number; score: number }[]): void {
      const finalScore: Record<number, number> = {};
      for (const s of standings) finalScore[s.seat] = s.score;
      void store.closeRoom(roomId, finalScore, new Date());
    },
  };
}

/** 自动驱动器（同 roomActor.test）：每步选一个合法动作（响应一律 pass），把当前局跑到 settled/exhaustive */
function driveOne(s: TableState): Action | null {
  if (s.phase === 'settled' || s.phase === 'exhaustive') return null;
  if (s.phase === 'draw') return { type: 'draw', seat: s.currentSeat };
  if (s.phase === 'discard') {
    const tile = Object.keys(getPlayer(s, s.currentSeat).concealed)[0];
    return tile ? { type: 'discard', seat: s.currentSeat, tile } : null;
  }
  const seat = s.players.find((p) => s.pending[p.seat] === null && legalActions(s, p.seat).includes('pass'))?.seat;
  return seat != null ? { type: 'respond', seat, move: 'pass' } : null;
}

function driveRoomToEnd(room: RoomActor): void {
  const seatToUser = new Map<number, string>();
  for (const s of room.roomView().seats) if (s) seatToUser.set(s.seat, s.userId);
  for (let i = 0; i < 1000; i++) {
    const st = room.getState();
    if (!st || st.phase === 'settled' || st.phase === 'exhaustive') return;
    const a = driveOne(st);
    if (!a) return;
    const uid = seatToUser.get(a.seat);
    if (uid == null) return;
    room.handleAction(uid, a);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 30));

async function setupSimRoom(store: GameStore, realtime: RealtimeStore, seed: number, roomId: string) {
  const hooks = makeHooks(store, realtime);
  const rm = new RoomManager(seed, hooks, store);
  const conns = ['u0', 'u1', 'u2', 'u3'].map((u) => new MockConn(u));
  const room = rm.create('u0', conns[0]!, 8, undefined, undefined, roomId);
  room.addPlayer('u1', conns[1]!);
  room.addPlayer('u2', conns[2]!);
  room.addPlayer('u3', conns[3]!);
  await store.createRoom({
    roomId, hostOpenid: 'u0', maxRounds: 8,
    initialScore: { 0: 0, 1: 0, 2: 0, 3: 0 }, finalScore: null, status: 'idle',
  });
  for (let seat = 0; seat < 4; seat++) {
    await store.addMemberEvent({ roomId, openid: `u${seat}`, seat, event: seat === 0 ? 'create' : 'join' });
  }
  return { rm, room, conns, hooks };
}

describe('BL-016 · 房间积分周期', () => {
  it('每局末积分写入账本；服务重启重建后座位/积分保留、可续局', async () => {
    const store = new MemoryGameStore();
    const realtime = new MemoryRealtime();
    const { room } = await setupSimRoom(store, realtime, 42, '900001');
    room.start('u0');
    driveCeremony(room);
    await store.markRoomPlaying('900001');
    driveRoomToEnd(room);
    await tick(); // 等待 fire-and-forget 落库
    const scores = room.getState()!.players.map((p) => p.score);
    const row = await store.getRoom('900001');
    expect(row?.status).toBe('playing');
    expect(Object.values(row?.memberScores ?? {})).toEqual([scores[0], scores[1], scores[2], scores[3]]);

    // 模拟服务重启：全新 RoomManager（内存为空）→ 成员重进触发事件溯源重建
    const rm2 = new RoomManager(7, makeHooks(store, realtime), store);
    const rebuilt = await rebuildRoomFromStore(rm2, store, realtime, '900001');
    expect(rebuilt?.room).toBeTruthy();
    const room2 = rebuilt!.room!;
    expect(room2.phase).toBe('playing');
    expect(room2.getState()!.players.map((p) => p.score)).toEqual(scores); // 积分保留
    expect(room2.seatOfUser('u2')).toBe(2); // 座位保留（含未重连成员）
    const c = new MockConn('u0');
    expect(room2.addPlayer('u0', c).ok).toBe(true); // 重进恢复
    expect(room2.nextRound('u0').ok).toBe(true); // 续局
    expect(room2.getState()!.round).toBe(2);
    expect(room2.getState()!.players.map((p) => p.score)).toEqual(scores); // 下一局带着累计分开局
  });

  it('局中重启：未落盘动作缓冲（Redis）参与重演，现场与积分可恢复续打', async () => {
    const store = new MemoryGameStore();
    const realtime = new MemoryRealtime();
    const { room } = await setupSimRoom(store, realtime, 77, '900002');
    room.start('u0');
    driveCeremony(room);
    await store.markRoomPlaying('900002');
    const seatToUser = new Map<number, string>();
    for (const s of room.roomView().seats) if (s) seatToUser.set(s.seat, s.userId);
    let steps = 0;
    for (let i = 0; i < 6; i++) {
      const st = room.getState()!;
      if (st.phase === 'settled' || st.phase === 'exhaustive') break;
      const a = driveOne(st);
      if (!a) break;
      room.handleAction(seatToUser.get(a.seat)!, a);
      steps++;
    }
    expect(steps).toBeGreaterThan(0);
    expect(await store.listActions('900002-g1')).toHaveLength(0); // 局中动作仍在缓冲，未落盘
    const buffered = await realtime.peekActions('900002-g1');
    expect(buffered).toHaveLength(steps);

    const rm2 = new RoomManager(7, makeHooks(store, realtime), store);
    const rebuilt = await rebuildRoomFromStore(rm2, store, realtime, '900002');
    const room2 = rebuilt!.room!;
    expect(room2.phase).toBe('playing');
    const st2 = room2.getState()!;
    expect(['draw', 'discard', 'response', 'settled', 'exhaustive']).toContain(st2.phase);
    // 重进后可继续行牌（重建现场合法）
    const c0 = new MockConn('u0');
    room2.addPlayer('u0', c0);
    if (st2.phase !== 'settled' && st2.phase !== 'exhaustive') {
      driveRoomToEnd(room2); // 重建现场可完整续打到局末
      const ph = room2.getState()!.phase;
      expect(ph === 'settled' || ph === 'exhaustive').toBe(true);
    }
  });

  it('已关闭房间：拒绝重进（reason=房间已关闭），积分已定格 final_score', async () => {
    const store = new MemoryGameStore();
    const realtime = new MemoryRealtime();
    const { room } = await setupSimRoom(store, realtime, 9, '900003');
    room.start('u0');
    driveCeremony(room);
    driveRoomToEnd(room);
    room.dissolve('u0'); // 房主解散 → finishRoom → closeRoom
    await tick();
    const row = await store.getRoom('900003');
    expect(row?.status).toBe('closed');
    expect(row?.finalScore).toBeTruthy(); // 积分定格（线下结算依据）

    const rm2 = new RoomManager(7, makeHooks(store, realtime), store);
    const rebuilt = await rebuildRoomFromStore(rm2, store, realtime, '900003');
    expect(rebuilt?.room).toBeUndefined();
    expect(rebuilt?.reason).toBe('房间已关闭');
    expect(rm2.get('900003')).toBeUndefined(); // 未注册进内存
  });

  it('房号全局唯一永不复用：内存回收后发号仍避开 rooms 历史表', async () => {
    const store = new MemoryGameStore();
    const realtime = new MemoryRealtime();
    await store.createRoom({
      roomId: '123456', hostOpenid: 'x', maxRounds: 4,
      initialScore: { 0: 0, 1: 0, 2: 0, 3: 0 }, finalScore: null, status: 'closed',
    });
    const rm = new RoomManager(1, undefined, store);
    for (let i = 0; i < 50; i++) expect(await rm.genUniqueId()).not.toBe('123456');
    // 无 store 时退化为内存查重（弱依赖兜底）
    const rm2 = new RoomManager(1);
    expect(await rm2.genUniqueId()).toMatch(/^\d{6}$/);
  });

  it('waiting 房间重启重建：座位保留、新成员可入座', async () => {
    const store = new MemoryGameStore();
    const realtime = new MemoryRealtime();
    const { room } = await setupSimRoom(store, realtime, 5, '900004');
    expect(room.phase).toBe('waiting');
    const rm2 = new RoomManager(7, makeHooks(store, realtime), store);
    const rebuilt = await rebuildRoomFromStore(rm2, store, realtime, '900004');
    const room2 = rebuilt!.room!;
    expect(room2.phase).toBe('waiting');
    expect(room2.seatOfUser('u1')).toBe(1);
    expect(room2.addPlayer('u1', new MockConn('u1')).ok).toBe(true); // 重进恢复原座位
  });
});
