import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { startGateway, type Gateway } from '../src/wsGateway';
import { MockIdentity } from '../src/identity';
import { MemoryGameStore, MemoryRealtime } from '@ac-majong/persistence';
import type { RoomActor } from '../src/roomActor';
import { legalActions, getPlayer } from '@ac-majong/engine';
import type { Action, TableState } from '@ac-majong/engine';
import type { ServerMsg } from '@ac-majong/protocol';

let gw: Gateway | null = null;
let store: MemoryGameStore;
let realtime: MemoryRealtime;
afterEach(() => {
  gw?.close();
  gw = null;
});

async function start(): Promise<number> {
  store = new MemoryGameStore();
  realtime = new MemoryRealtime();
  gw = startGateway({
    port: 0,
    identity: new MockIdentity(),
    heartbeatMs: 5000,
    persistence: { store, realtime },
  });
  await new Promise<void>((res) => {
    if (gw!.wss.address()) return res();
    gw!.wss.once('listening', () => res());
  });
  return (gw!.wss.address() as AddressInfo).port;
}

function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const msgs: ServerMsg[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as ServerMsg;
    msgs.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(m)) {
        waiters[i]!.res(m);
        waiters.splice(i, 1);
      }
    }
  });
  const opened = new Promise<void>((r) => ws.once('open', () => r()));
  return {
    ws,
    opened,
    msgs,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    wait: (pred: (m: ServerMsg) => boolean, timeout = 3000) =>
      new Promise<ServerMsg>((res, rej) => {
        const hit = msgs.find(pred);
        if (hit) return res(hit);
        const to = setTimeout(() => rej(new Error('timeout waiting message')), timeout);
        waiters.push({
          pred,
          res: (m) => {
            clearTimeout(to);
            res(m);
          },
        });
      }),
  };
}

/** BL-017：异步驱动开局仪式至发牌（以 cs[0] 收到 gameView 为终点）；每步按 seating 阶段发 roll/pickSeat */
async function driveCeremonyWs(cs: ReturnType<typeof client>[]): Promise<void> {
  const last = <T,>(arr: T[]): T | undefined => arr[arr.length - 1];
  const gameViewOf = (c: ReturnType<typeof client>) =>
    last(c.msgs.filter((m): m is Extract<ServerMsg, { t: 'gameView' }> => m.t === 'gameView'));
  const roomViewOf = (c: ReturnType<typeof client>) =>
    last(c.msgs.filter((m): m is Extract<ServerMsg, { t: 'roomView' }> => m.t === 'roomView'));
  for (let step = 0; step < 60; step++) {
    if (gameViewOf(cs[0]!)) return; // 发牌完成
    const rv = roomViewOf(cs[0]!);
    const sv = rv?.room.seating;
    if (!sv) {
      // seating 视图尚未到达（start ack 与广播异步）或仪式已结束 → 等待下一轮
      await new Promise((r) => setTimeout(r, 40));
      continue;
    }
    const users: (string | null)[] = rv.room.seats.map((s) => s?.userId ?? null);
    const bySeat = (seat: number | null | undefined) => (seat == null ? undefined : cs.find((_, ci) => users[ci] === users[seat]));
    if (sv.stage === 'roll') {
      for (let seat = 0; seat < 4; seat++) {
        if (users[seat] && (sv.rolls[seat] == null || sv.reroll[seat])) {
          bySeat(seat)?.send({ t: 'roll', seq: 900 + step });
        }
      }
    } else if (sv.stage === 'pick') {
      bySeat(sv.picker)?.send({ t: 'pickSeat', seq: 900 + step, seat: sv.picker });
    } else {
      const roller = sv.stage === 'dealerDice' ? sv.picker : sv.stage === 'roundBreak' ? sv.roller : sv.dealerSeat;
      bySeat(roller)?.send({ t: 'roll', seq: 900 + step });
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('driveCeremonyWs: 仪式未在限定步数内完成');
}

describe('wsGateway · 端到端（真实 WebSocket）', () => {
  it('auth → create → join×3 → start → 各家收到 gameView', async () => {
    const port = await start();
    const cs = [client(port), client(port), client(port), client(port)];
    await Promise.all(cs.map((c) => c.opened));

    for (let i = 0; i < 4; i++) {
      cs[i]!.send({ t: 'auth', seq: 1, token: `u${i}` });
      await cs[i]!.wait((m) => m.t === 'authOk');
    }

    cs[0]!.send({ t: 'create', seq: 2, maxRounds: 8 });
    const ack = (await cs[0]!.wait((m) => m.t === 'ack' && m.seq === 2)) as Extract<ServerMsg, { t: 'ack' }>;
    expect(ack.ok).toBe(true);
    const roomId = ack.reason!;
    expect(roomId).toMatch(/^\d{6}$/);

    for (let i = 1; i < 4; i++) {
      cs[i]!.send({ t: 'join', seq: 2, room: roomId });
      const j = (await cs[i]!.wait((m) => m.t === 'ack' && m.seq === 2)) as Extract<ServerMsg, { t: 'ack' }>;
      expect(j.ok).toBe(true);
    }

    cs[0]!.send({ t: 'start', seq: 3 });
    await cs[0]!.wait((m) => m.t === 'ack' && m.seq === 3);
    await driveCeremonyWs(cs);

    for (let i = 0; i < 4; i++) {
      const gv = (await cs[i]!.wait((m) => m.t === 'gameView')) as Extract<ServerMsg, { t: 'gameView' }>;
      expect(gv.view.you.concealed).toBeTruthy();
      expect(gv.view.others.every((o) => (o as Record<string, unknown>).concealed === undefined)).toBe(true);
    }

    for (const c of cs) c.ws.close();
  });

  it('auth 携带 profile → authOk 回传资料 + users 落库 + 会话建立（BL-013 登录接线）', async () => {
    const port = await start();
    const c = client(port);
    await c.opened;

    c.send({ t: 'auth', seq: 1, token: 'wx_mock_1', profile: { nickname: '老张', avatarUrl: 'a.png' } });
    const ok = (await c.wait((m) => m.t === 'authOk')) as Extract<ServerMsg, { t: 'authOk' }>;
    expect(ok.userId).toBe('wx_mock_1');
    expect(ok.profile).toEqual({ nickname: '老张', avatarUrl: 'a.png' });

    // users 落库
    const u = await store.getUser('wx_mock_1');
    expect(u?.nickname).toBe('老张');
    expect(u?.avatarUrl).toBe('a.png');
    expect(u?.lastLoginAt).toBeInstanceOf(Date);
    // 会话写入
    expect((await realtime.getSession('wx_mock_1'))?.openid).toBe('wx_mock_1');

    c.ws.close();
  });

  it('auth 不带 profile → 兜底昵称「牌友」仍落库', async () => {
    const port = await start();
    const c = client(port);
    await c.opened;
    c.send({ t: 'auth', seq: 1, token: 'bare_user' });
    const ok = (await c.wait((m) => m.t === 'authOk')) as Extract<ServerMsg, { t: 'authOk' }>;
    expect(ok.profile.nickname).toBe('牌友');
    expect((await store.getUser('bare_user'))?.nickname).toBe('牌友');
    c.ws.close();
  });

  it('create → rooms 落库（房号/房主/maxRounds/status/初始积分，BL-013 M-C 接线）', async () => {
    const port = await start();
    const c = client(port);
    await c.opened;
    c.send({ t: 'auth', seq: 1, token: 'host_a' });
    await c.wait((m) => m.t === 'authOk');
    c.send({ t: 'create', seq: 2, maxRounds: 16 });
    const ack = (await c.wait((m) => m.t === 'ack' && m.seq === 2)) as Extract<ServerMsg, { t: 'ack' }>;
    expect(ack.ok).toBe(true);
    expect(ack.reason).toMatch(/^\d{6}$/);
    const row = await store.getRoom(ack.reason!);
    expect(row?.hostOpenid).toBe('host_a');
    expect(row?.maxRounds).toBe(16);
    expect(row?.status).toBe('idle');
    expect(row?.initialScore).toEqual({ 0: 0, 1: 0, 2: 0, 3: 0 });
    expect(row?.finalScore).toBeNull();
    c.ws.close();
  });

  it('create maxRounds=0（不限）→ rooms 落库 max_rounds=0', async () => {
    const port = await start();
    const c = client(port);
    await c.opened;
    c.send({ t: 'auth', seq: 1, token: 'host_b' });
    await c.wait((m) => m.t === 'authOk');
    c.send({ t: 'create', seq: 2, maxRounds: 0 });
    const ack = (await c.wait((m) => m.t === 'ack' && m.seq === 2)) as Extract<ServerMsg, { t: 'ack' }>;
    expect((await store.getRoom(ack.reason!))?.maxRounds).toBe(0);
    c.ws.close();
  });

  it('addBot：房主放 3 Bot → roomView seats 标 isBot、满 4 人（FR-房间-08）', async () => {
    const port = await start();
    const c = client(port);
    await c.opened;
    c.send({ t: 'auth', seq: 1, token: 'host_bot' });
    await c.wait((m) => m.t === 'authOk');
    c.send({ t: 'create', seq: 2, maxRounds: 8 });
    const ack = (await c.wait((m) => m.t === 'ack' && m.seq === 2)) as Extract<ServerMsg, { t: 'ack' }>;
    expect(ack.ok).toBe(true);
    c.send({ t: 'addBot', seq: 3, count: 3 });
    const rv = (await c.wait(
      (m) => m.t === 'roomView' && m.room.seats.filter((s) => s?.isBot).length === 3,
    )) as Extract<ServerMsg, { t: 'roomView' }>;
    expect(rv.room.seats.filter((s) => s != null).length).toBe(4);
    expect(rv.room.seats[0]).toMatchObject({ isBot: false }); // 房主非 Bot
    c.ws.close();
  });

  it('create/join → room_member_events 落库（房主 create + 成员 join）', async () => {
    const port = await start();
    const host = client(port);
    await host.opened;
    host.send({ t: 'auth', seq: 1, token: 'host_m' });
    await host.wait((m) => m.t === 'authOk');
    host.send({ t: 'create', seq: 2, maxRounds: 8 });
    const ack = (await host.wait((m) => m.t === 'ack' && m.seq === 2)) as Extract<ServerMsg, { t: 'ack' }>;
    const roomId = ack.reason!;
    const guest = client(port);
    await guest.opened;
    guest.send({ t: 'auth', seq: 1, token: 'guest_m' });
    await guest.wait((m) => m.t === 'authOk');
    guest.send({ t: 'join', seq: 2, room: roomId });
    await guest.wait((m) => m.t === 'ack' && m.seq === 2);
    const events = await store.listMemberEvents(roomId);
    expect(events.some((e) => e.openid === 'host_m' && e.event === 'create' && e.seat === 0)).toBe(true);
    expect(events.some((e) => e.openid === 'guest_m' && e.event === 'join')).toBe(true);
    host.ws.close();
    guest.ws.close();
  });

  it('start → games + game_initial_states 落库（M-E 对局落库）', async () => {
    const port = await start();
    const cs = [client(port), client(port), client(port), client(port)];
    await Promise.all(cs.map((c) => c.opened));
    for (let i = 0; i < 4; i++) {
      cs[i]!.send({ t: 'auth', seq: 1, token: `g${i}` });
      await cs[i]!.wait((m) => m.t === 'authOk');
    }
    cs[0]!.send({ t: 'create', seq: 2, maxRounds: 8 });
    const ack = (await cs[0]!.wait((m) => m.t === 'ack' && m.seq === 2)) as Extract<ServerMsg, { t: 'ack' }>;
    const roomId = ack.reason!;
    for (let i = 1; i < 4; i++) {
      cs[i]!.send({ t: 'join', seq: 2, room: roomId });
      await cs[i]!.wait((m) => m.t === 'ack' && m.seq === 2);
    }
    cs[0]!.send({ t: 'start', seq: 3 });
    await driveCeremonyWs(cs);
    await cs[0]!.wait((m) => m.t === 'gameView');
    await new Promise((r) => setTimeout(r, 50)); // 等 fire-and-forget 落库
    const games = await store.listGames(roomId);
    expect(games.length).toBe(1);
    expect(games[0]!.roundNo).toBe(1);
    expect(games[0]!.endType).toBeNull();
    const init = await store.getInitialState(games[0]!.gameId);
    expect(init!.wall.length).toBeGreaterThan(0);
    expect(init!.hands.length).toBe(4);
    for (const c of cs) c.ws.close();
  });

  it('打满 maxRounds=1 → nextRound 散场：roomEnd 广播 + rooms.status=closed + final_score 落库（M-G）', async () => {
    const port = await start();
    const cs = [client(port), client(port), client(port), client(port)];
    await Promise.all(cs.map((c) => c.opened));
    for (let i = 0; i < 4; i++) {
      cs[i]!.send({ t: 'auth', seq: 1, token: `f${i}` });
      await cs[i]!.wait((m) => m.t === 'authOk');
    }
    cs[0]!.send({ t: 'create', seq: 2, maxRounds: 1 });
    const ack = (await cs[0]!.wait((m) => m.t === 'ack' && m.seq === 2)) as Extract<ServerMsg, { t: 'ack' }>;
    const roomId = ack.reason!;
    for (let i = 1; i < 4; i++) {
      cs[i]!.send({ t: 'join', seq: 2, room: roomId });
      await cs[i]!.wait((m) => m.t === 'ack' && m.seq === 2);
    }
    cs[0]!.send({ t: 'start', seq: 3 });
    await driveCeremonyWs(cs);
    await cs[0]!.wait((m) => m.t === 'gameView');
    driveRoomToEnd(gw!.rooms.get(roomId)!); // 服务端同步打完本局
    cs[0]!.send({ t: 'nextRound', seq: 4 });
    const re = (await cs[0]!.wait((m) => m.t === 'roomEnd')) as Extract<ServerMsg, { t: 'roomEnd' }>;
    expect(re.reason).toBe('maxRounds');
    expect(re.standings.length).toBe(4);
    await new Promise((r) => setTimeout(r, 60)); // 等 fire-and-forget closeRoom
    const row = await store.getRoom(roomId);
    expect(row?.status).toBe('closed');
    expect(row?.finalScore).toBeTruthy();
    expect(Object.values(row!.finalScore!).reduce((a, b) => a + b, 0)).toBe(0); // 零和
    for (const c of cs) c.ws.close();
  });

  it('dissolve：房主解散（不限局数）→ roomEnd(reason=dissolve) + rooms.status=closed（M-G）', async () => {
    const port = await start();
    const cs = [client(port), client(port), client(port), client(port)];
    await Promise.all(cs.map((c) => c.opened));
    for (let i = 0; i < 4; i++) {
      cs[i]!.send({ t: 'auth', seq: 1, token: `d${i}` });
      await cs[i]!.wait((m) => m.t === 'authOk');
    }
    cs[0]!.send({ t: 'create', seq: 2, maxRounds: 0 }); // 不限
    const ack = (await cs[0]!.wait((m) => m.t === 'ack' && m.seq === 2)) as Extract<ServerMsg, { t: 'ack' }>;
    const roomId = ack.reason!;
    for (let i = 1; i < 4; i++) {
      cs[i]!.send({ t: 'join', seq: 2, room: roomId });
      await cs[i]!.wait((m) => m.t === 'ack' && m.seq === 2);
    }
    cs[0]!.send({ t: 'start', seq: 3 });
    await driveCeremonyWs(cs);
    await cs[0]!.wait((m) => m.t === 'gameView');
    driveRoomToEnd(gw!.rooms.get(roomId)!);
    cs[0]!.send({ t: 'dissolve', seq: 4 });
    const re = (await cs[0]!.wait((m) => m.t === 'roomEnd')) as Extract<ServerMsg, { t: 'roomEnd' }>;
    expect(re.reason).toBe('dissolve');
    await new Promise((r) => setTimeout(r, 60));
    expect((await store.getRoom(roomId))?.status).toBe('closed');
    for (const c of cs) c.ws.close();
  });
});

/** 同步驱动一局到 settled/exhaustive（响应一律 pass），用于网关散场落库测试 */
function driveRoomToEnd(room: RoomActor): void {
  const seatToUser = new Map<number, string>();
  for (const s of room.roomView().seats) if (s) seatToUser.set(s.seat, s.userId);
  const driveOne = (s: TableState): Action | null => {
    if (s.phase === 'settled' || s.phase === 'exhaustive') return null;
    if (s.phase === 'draw') return { type: 'draw', seat: s.currentSeat };
    if (s.phase === 'discard') {
      const tile = Object.keys(getPlayer(s, s.currentSeat).concealed)[0];
      return tile ? { type: 'discard', seat: s.currentSeat, tile } : null;
    }
    const seat = s.players.find((p) => s.pending[p.seat] === null && legalActions(s, p.seat).includes('pass'))?.seat;
    return seat != null ? { type: 'respond', seat, move: 'pass' } : null;
  };
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

describe('BL-018 公开房间列表', () => {
  it('roomList 仅含公开且未终局房（含房主/人数/局数/状态；非公开房不下发）', async () => {
    const port = await start();
    // u1 建公开房
    const c1 = client(port);
    await c1.opened;
    c1.send({ t: 'auth', seq: 1, token: 'u1', profile: { nickname: '张三', avatarUrl: '' } });
    await c1.wait((m) => m.t === 'authOk');
    c1.send({ t: 'create', seq: 2, maxRounds: 8, settings: { wallMode: 'random', breakDice: false, chiFirstView: true, isPublic: true } });
    const pv1 = (await c1.wait((m) => m.t === 'roomView')) as Extract<ServerMsg, { t: 'roomView' }>;
    // u2 建非公开房
    const c2 = client(port);
    await c2.opened;
    c2.send({ t: 'auth', seq: 1, token: 'u2', profile: { nickname: '李四', avatarUrl: '' } });
    await c2.wait((m) => m.t === 'authOk');
    c2.send({ t: 'create', seq: 2, maxRounds: 4, settings: { wallMode: 'random', breakDice: false, chiFirstView: true, isPublic: false } });
    const pv2 = (await c2.wait((m) => m.t === 'roomView')) as Extract<ServerMsg, { t: 'roomView' }>;
    // 拉列表：含公开房（房主/人数/局数/状态），不含非公开房
    c1.send({ t: 'roomList', seq: 3 });
    const list = (await c1.wait((m) => m.t === 'roomList')) as Extract<ServerMsg, { t: 'roomList' }>;
    const pub = list.rooms.find((r) => r.room === pv1.room.room);
    expect(pub).toBeDefined();
    expect(pub!.host).toBe('张三');
    expect(pub!.seats).toBe(1);
    expect(pub!.maxRounds).toBe(8);
    expect(pub!.status).toBe('waiting');
    expect(list.rooms.some((r) => r.room === pv2.room.room)).toBe(false);
    c1.ws.close();
    c2.ws.close();
  });
});
