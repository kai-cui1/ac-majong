import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { startGateway, type Gateway } from '../src/wsGateway';
import { MockIdentity } from '../src/identity';
import { MemoryGameStore, MemoryRealtime } from '@ac-majong/persistence';
import type { ServerMsg } from '@ac-majong/protocol';

/**
 * BL-012 回放查询（replayList / replayLoad）：
 * - listRoomsByPlayer：房主 + 入座成员命中，无关人空；
 * - 网关：房间→局两级列表、单局回放数据（快照+动作+昵称+视角座位）、D-29 参赛四方权限拒绝。
 */
describe('BL-012 回放查询', () => {
  it('MemoryGameStore.listRoomsByPlayer：房主/成员命中，无关为空，倒序', async () => {
    const store = new MemoryGameStore();
    await store.createRoom({ roomId: 'r1', hostOpenid: 'u1', maxRounds: 8, initialScore: {}, finalScore: null, status: 'closed', createdAt: new Date(Date.now() - 20000) });
    await store.createRoom({ roomId: 'r2', hostOpenid: 'u9', maxRounds: 8, initialScore: {}, finalScore: null, status: 'closed', createdAt: new Date(Date.now() - 10000) });
    await store.addMemberEvent({ roomId: 'r2', openid: 'u1', seat: 1, event: 'join' });
    const rooms = await store.listRoomsByPlayer('u1');
    expect(rooms.map((r) => r.roomId)).toEqual(['r2', 'r1']); // 创建时间倒序
    expect(await store.listRoomsByPlayer('u7')).toEqual([]);
  });

  describe('网关 e2e', () => {
    let gw: Gateway | null = null;
    afterEach(() => {
      gw?.close();
      gw = null;
    });

    async function start(store: MemoryGameStore): Promise<number> {
      gw = startGateway({
        port: 0,
        identity: new MockIdentity(),
        heartbeatMs: 5000,
        persistence: { store, realtime: new MemoryRealtime() },
      });
      await new Promise<void>((res) => {
        if (gw!.wss.address()) return res();
        gw!.wss.once('listening', () => res());
      });
      return (gw!.wss.address() as AddressInfo).port;
    }

    function client(port: number) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString()) as ServerMsg;
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.pred(m)) { const [w] = waiters.splice(i, 1); w!.res(m); }
        }
      });
      return {
        ws,
        wait: (pred: (m: ServerMsg) => boolean) => new Promise<ServerMsg>((res) => waiters.push({ pred, res })),
        send: (m: unknown) => ws.send(JSON.stringify(m)),
        auth: async (token: string, nickname: string) => {
          await new Promise((r) => ws.on('open', r));
          const p = clientWait(ws, waiters, (m) => m.t === 'authOk');
          ws.send(JSON.stringify({ t: 'auth', seq: 1, token, profile: { nickname, avatarUrl: '' } }));
          return p;
        },
      };
    }
    function clientWait(_ws: WebSocket, waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[], pred: (m: ServerMsg) => boolean): Promise<ServerMsg> {
      return new Promise<ServerMsg>((res) => waiters.push({ pred, res }));
    }

    it('replayList 房间→局两级；replayLoad 快照+动作+viewSeat；非参赛被拒', async () => {
      const store = new MemoryGameStore();
      const port = await start(store);
      const c1 = client(port);
      await c1.auth('u1', '小一');
      // 建房（网关落 rooms + member create seat0）
      const rvP = c1.wait((m) => m.t === 'roomView');
      c1.send({ t: 'create', seq: 2, maxRounds: 8 });
      const rv = await rvP;
      const roomId = rv.t === 'roomView' ? rv.room.room : '';
      expect(roomId).toMatch(/^\d{6}$/);

      // 种一局已结束的胡牌局（result=win 事件形状）
      await store.createGame({ gameId: 'g1', roomId, roundNo: 1, dealerSeat: 0, seed: 7, endType: 'win', result: { winners: [{ seat: 2, tai: 8, detail: [] }] } });
      await store.saveInitialState({
        gameId: 'g1',
        wall: ['W1', 'W2'],
        hands: [0, 1, 2, 3].map((seat) => ({ seat, concealed: { W1: 2 } as Record<string, number>, melds: [], flowers: [], zi: 0, score: 0 })),
        lianzhuangCount: 1,
      });
      await store.appendActions([
        { gameId: 'g1', seq: 1, seat: 0, actionType: 'discard', payload: { type: 'discard', seat: 0, tile: 'W1' } },
      ]);
      await store.finishGame('g1', 'win', { winners: [{ seat: 2, tai: 8, detail: [] }] }, new Date());

      // 回放列表
      const listP = c1.wait((m) => m.t === 'replayList');
      c1.send({ t: 'replayList', seq: 3 });
      const list = await listP;
      expect(list.t).toBe('replayList');
      if (list.t !== 'replayList') return;
      expect(list.rooms.length).toBe(1);
      const room0 = list.rooms[0]!;
      expect(room0.roomId).toBe(roomId);
      expect(room0.seatNames[0]).toBe('小一');
      expect(room0.rounds.length).toBe(1);
      const round0 = room0.rounds[0]!;
      expect(round0.gameId).toBe('g1');
      expect(round0.endType).toBe('win');
      expect(round0.winnerSeats).toEqual([2]);
      expect(round0.taiBySeat[2]).toBe(8);
      expect(round0.at).toBeTruthy();

      // 单局回放（参赛者）
      const dataP = c1.wait((m) => m.t === 'replayData');
      c1.send({ t: 'replayLoad', seq: 4, gameId: 'g1' });
      const data = await dataP;
      expect(data.t).toBe('replayData');
      if (data.t !== 'replayData') return;
      expect(data.snapshot.round).toBe(1);
      expect(data.snapshot.dealerSeat).toBe(0);
      expect(data.snapshot.lianzhuangCount).toBe(1);
      expect(data.snapshot.players.length).toBe(4);
      expect(data.actions.length).toBe(1);
      expect(data.viewSeat).toBe(0);
      expect(data.names[0]).toBe('小一');
      c1.ws.close();

      // 非参赛者被拒（D-29）
      const c2 = client(port);
      await c2.auth('u2', '小二');
      const ackP = c2.wait((m) => m.t === 'ack' && !m.ok);
      c2.send({ t: 'replayLoad', seq: 2, gameId: 'g1' });
      const ack = await ackP;
      expect(ack.t === 'ack' && ack.reason).toBe('无权查看该对局');

      // 不存在的局
      const ack2P = c2.wait((m) => m.t === 'ack' && !m.ok);
      c2.send({ t: 'replayLoad', seq: 3, gameId: 'nope' });
      const ack2 = await ack2P;
      expect(ack2.t === 'ack' && ack2.reason).toBe('对局不存在');
      c2.ws.close();
    });
  });
});
