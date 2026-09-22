import { describe, it, expect, afterEach, vi } from 'vitest';
import { FAST_CEREMONY_MS } from './ceremonyHelper';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { startGateway, type Gateway } from '../src/wsGateway';
import { MockIdentity } from '../src/identity';
import { MemoryGameStore, MemoryRealtime } from '@ac-majong/persistence';
import { CEREMONY_MS, type RoomActor, type RoomTimings } from '../src/roomActor';
import { legalActions, getPlayer } from '@ac-majong/engine';
import type { Action, TableState } from '@ac-majong/engine';
import type { RoomView, ServerMsg } from '@ac-majong/protocol';

let gw: Gateway | null = null;
let store: MemoryGameStore;
let realtime: MemoryRealtime;
afterEach(async () => {
  const closed = gw ? new Promise<void>((resolve) => gw!.wss.once('close', () => resolve())) : Promise.resolve();
  gw?.close();
  await closed;
  gw = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function start(roomTimings: RoomTimings = { ceremony: FAST_CEREMONY_MS }): Promise<number> {
  store = new MemoryGameStore();
  realtime = new MemoryRealtime();
  gw = startGateway({
    port: 0,
    identity: new MockIdentity(),
    heartbeatMs: 5000,
    persistence: { store, realtime },
    roomTimings,
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
async function driveCeremonyWs(cs: ReturnType<typeof client>[], auditTokens = false): Promise<void> {
  const last = <T,>(arr: T[]): T | undefined => arr[arr.length - 1];
  const gameViewOf = (c: ReturnType<typeof client>) =>
    last(c.msgs.filter((m): m is Extract<ServerMsg, { t: 'gameView' }> => m.t === 'gameView'));
  const roomViewOf = (c: ReturnType<typeof client>) =>
    last(c.msgs.filter((m): m is Extract<ServerMsg, { t: 'roomView' }> => m.t === 'roomView'));
  const byUserId = new Map(cs.map((c) => {
    const auth = c.msgs.find((m) => m.t === 'authOk');
    if (auth?.t !== 'authOk') throw new Error('仪式驱动必须先鉴权');
    return [auth.userId, c];
  }));
  const sent = new Set<string>();
  for (let step = 0; step < 1600; step++) {
    if (gameViewOf(cs[0]!)) return; // 发牌完成
    const sv = roomViewOf(cs[0]!)?.room.seating;
    const p = sv?.presentation;
    const key = p ? `${p.ceremonyId}:${p.stepId}` : '';
    if (p?.phase === 'input' && p.actor && !sent.has(key)) {
      const c = byUserId.get(p.actor.userId);
      if (!c) throw new Error(`找不到当前操作者连接：${p.actor.userId}`);
      sent.add(key);
      const ceremonyToken = { ceremonyId: p.ceremonyId, stepId: p.stepId };
      const seq = 900 + step * 3;
      const action = sv!.stage === 'pick'
        ? { t: 'pickSeat', seat: (p.actor.seat + 1) % 4 }
        : { t: 'roll' };
      if (auditTokens) {
        c.send({ ...action, seq: seq + 1, ceremonyToken: { ...ceremonyToken, stepId: p.stepId - 1 } });
        const stale = await c.wait((m) => m.t === 'ack' && m.seq === seq + 1);
        expect(stale).toMatchObject({ t: 'ack', ok: false, reason: '仪式步骤已失效' });
      }
      c.send({ ...action, seq, ceremonyToken });
      const ack = await c.wait((m) => m.t === 'ack' && m.seq === seq);
      expect(ack).toMatchObject({ t: 'ack', ok: true });
    }
    await new Promise((r) => setTimeout(r, 5));
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

    const faces = [2, 3, 4, 5, 3, 4, 6, 6, 4, 3];
    vi.spyOn(Math, 'random').mockImplementation(() => {
      const face = faces.shift();
      if (face == null) throw new Error('固定仪式骰面队列耗尽');
      return (face - 0.5) / 6;
    });
    cs[0]!.send({ t: 'start', seq: 3 });
    await cs[0]!.wait((m) => m.t === 'ack' && m.seq === 3);
    const initial = await cs[0]!.wait((m) => m.t === 'roomView' && !!m.room.seating);
    if (initial.t !== 'roomView') throw new Error('缺少仪式快照');
    const p = initial.room.seating!.presentation!;
    cs[1]!.send({ t: 'roll', seq: 4, ceremonyToken: { ceremonyId: p.ceremonyId, stepId: p.stepId } });
    expect(await cs[1]!.wait((m) => m.t === 'ack' && m.seq === 4)).toMatchObject({ ok: false, reason: '未轮到你操作' });
    await driveCeremonyWs(cs, true);

    for (let i = 0; i < 4; i++) {
      const gv = (await cs[i]!.wait((m) => m.t === 'gameView')) as Extract<ServerMsg, { t: 'gameView' }>;
      expect(gv.view.you.concealed).toBeTruthy();
      expect(gv.view.others.every((o) => (o as Record<string, unknown>).concealed === undefined)).toBe(true);
    }

    const timeline = (c: ReturnType<typeof client>) => c.msgs.flatMap((m) => {
      const p = m.t === 'roomView' ? m.room.seating?.presentation : undefined;
      if (!p) return [];
      const { serverNow: _sample, ...step } = p;
      return [step];
    });
    const expected = timeline(cs[0]!);
    expect(expected).toHaveLength(18);
    expect(expected.filter((p) => p.phase === 'result').map((p) => p.ceremonyDice?.sum ?? p.resultsByUserId[p.actor!.userId]!.sum)).toEqual([5, 9, 7, 12, 7]);
    expect(expected.every((p, i) => p.stepId === i + 1)).toBe(true);
    expect(expected.filter((p) => p.phase === 'rolling').every((p) => p.ceremonyDice === null)).toBe(true);
    for (const c of cs.slice(1)) expect(timeline(c)).toEqual(expected);
    const last = expected.at(-1)!;
    expect(last.phase).toBe('result');
    expect(last.ceremonyDice).toEqual({ d1: 4, d2: 3, sum: 7 });
    expect(faces).toHaveLength(0);
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

describe('Spec 分支回归 · 主动 leave（真实 WebSocket）', () => {
  async function setupRoom() {
    // 独立随机端口/内存存储；本组使用正式仪式时长和默认60s托管，不缩小生产参数。
    const port = await start({ ceremony: CEREMONY_MS, turnMs: 0, respMs: 0 }); // BL-031：leave 分支回归不需截止代打
    const cs = [client(port), client(port), client(port), client(port)];
    await Promise.all(cs.map((c) => c.opened));
    for (let i = 0; i < cs.length; i++) {
      cs[i]!.send({ t: 'auth', seq: 1, token: `leave-u${i}` });
      await cs[i]!.wait((m) => m.t === 'authOk');
    }
    cs[0]!.send({ t: 'create', seq: 2, maxRounds: 8 });
    const created = await cs[0]!.wait((m) => m.t === 'ack' && m.seq === 2);
    if (created.t !== 'ack' || !created.ok || !created.reason) throw new Error('建房失败');
    const roomId = created.reason;
    for (const c of cs.slice(1)) {
      c.send({ t: 'join', seq: 2, room: roomId });
      expect(await c.wait((m) => m.t === 'ack' && m.seq === 2)).toMatchObject({ ok: true });
    }
    return { port, cs, roomId, room: gw!.rooms.get(roomId)!, observer: cs[1]! };
  }

  function latestRoom(c: ReturnType<typeof client>): RoomView {
    const msg = c.msgs.filter((m): m is Extract<ServerMsg, { t: 'roomView' }> => m.t === 'roomView').at(-1);
    if (!msg) throw new Error('缺少房间快照');
    return msg.room;
  }

  async function waitStep(c: ReturnType<typeof client>, stepId: number): Promise<RoomView> {
    const msg = await c.wait((m) => m.t === 'roomView' && (m.room.phase === 'playing' || m.room.seating?.presentation?.stepId === stepId));
    if (msg.t !== 'roomView') throw new Error('缺少仪式步骤快照');
    return msg.room;
  }

  async function driveToFinalResult(cs: ReturnType<typeof client>[], observer: ReturnType<typeof client>) {
    for (let i = 0; i < 60; i++) {
      const rv = latestRoom(observer);
      const sv = rv.seating!;
      const p = sv.presentation!;
      if (sv.stage === 'dealerBreak' && p.phase === 'result') return;
      if (p.phase === 'input' && !rv.seats[p.actor!.seat]!.offline) {
        const c = cs.find((c) => c.msgs.some((m) => m.t === 'authOk' && m.userId === p.actor!.userId))!;
        const seq = 1000 + p.stepId;
        const ceremonyToken = { ceremonyId: p.ceremonyId, stepId: p.stepId };
        c.send(sv.stage === 'pick' ? { t: 'pickSeat', seq, seat: 0, ceremonyToken } : { t: 'roll', seq, ceremonyToken });
        expect(await c.wait((m) => m.t === 'ack' && m.seq === seq)).toMatchObject({ ok: true });
      } else {
        vi.advanceTimersByTime(p.deadline - Date.now());
      }
      await waitStep(observer, p.stepId + 1);
    }
    throw new Error('仪式未进入定庄结果期');
  }

  it.each([
    { when: 'input', alreadyOffline: false },
    { when: 'input', alreadyOffline: true },
    { when: 'result', alreadyOffline: false },
  ] as const)('首局 $when leave（既有离线=$alreadyOffline）：保留成员/原期限、完整展示、托管与重入', async ({ when, alreadyOffline }) => {
    const { port, cs, roomId, room, observer } = await setupRoom();
    const leavingIndex = when === 'input' ? 0 : 3;
    const leaving = cs[leavingIndex]!;
    const userId = `leave-u${leavingIndex}`;
    let previous: ReturnType<typeof client> | undefined;
    if (alreadyOffline) {
      // 同一身份的另一真实会话关闭后，仍绑定该房的会话再发 leave，不得重置离线起点。
      previous = client(port);
      await previous.opened;
      previous.send({ t: 'auth', seq: 1, token: userId });
      await previous.wait((m) => m.t === 'authOk');
      previous.send({ t: 'join', seq: 2, room: roomId });
      await previous.wait((m) => m.t === 'ack' && m.seq === 2);
    }
    const faces = [2, 3, 4, 5, 3, 4, 6, 6, ...(when === 'input' ? [2, 2] : [4, 5])];
    vi.spyOn(Math, 'random').mockImplementation(() => {
      const face = faces.shift();
      if (face == null) throw new Error('固定仪式骰面队列耗尽');
      return (face - 0.5) / 6;
    });
    // 仅控制业务时钟/定时器，WS 握手、消息路由及关闭仍使用真实网络 IO。
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
    cs[0]!.send({ t: 'start', seq: 3 });
    expect(await cs[0]!.wait((m) => m.t === 'ack' && m.seq === 3)).toMatchObject({ ok: true });
    await waitStep(observer, 1);
    if (when === 'result') await driveToFinalResult(cs, observer);
    const before = latestRoom(observer);
    const original = before.seating!.presentation!;
    const seatBefore = before.seats.find((s) => s?.userId === userId)!;
    expect(original.phase).toBe(when);
    expect(original.actor!.userId).toBe(userId);
    const offlineAt = Date.now();
    if (previous) {
      previous.ws.close();
      await observer.wait((m) => m.t === 'roomView' && !!m.room.seats.find((s) => s?.userId === userId)?.offline);
      vi.advanceTimersByTime(200);
    }
    const from = observer.msgs.length;
    leaving.send({ t: 'leave', seq: 4 });
    expect(await leaving.wait((m) => m.t === 'ack' && m.seq === 4)).toMatchObject({ ok: true });
    await observer.wait((m) => observer.msgs.indexOf(m) >= from && m.t === 'roomView');
    const left = latestRoom(observer);
    expect(left.phase).toBe('seating');
    expect(left.seats.filter(Boolean)).toHaveLength(4);
    expect(left.seats.find((s) => s?.userId === userId)).toEqual({ ...seatBefore, offline: true });
    expect(room.isMember(userId)).toBe(true);
    expect(room['offlineSince'].get(userId)).toBe(offlineAt);
    const p = left.seating!.presentation!;
    expect(p.stepId).toBe(original.stepId);
    expect(p.deadline).toBe(when === 'input' ? offlineAt + 600 : original.deadline);
    expect(room['trusteeTimers'].size).toBe(0);
    expect((await store.listMemberEvents(roomId)).filter((e) => e.openid === userId && e.event === 'leave')).toHaveLength(1);

    vi.advanceTimersByTime(100);
    leaving.send({ t: 'leave', seq: 5 });
    expect(await leaving.wait((m) => m.t === 'ack' && m.seq === 5)).toMatchObject({ ok: true });
    expect(room['offlineSince'].get(userId)).toBe(offlineAt);
    expect(room.roomView().seating!.presentation!.deadline).toBe(p.deadline);
    expect((await store.listMemberEvents(roomId)).filter((e) => e.openid === userId && e.event === 'leave')).toHaveLength(1);
    leaving.send({ t: 'roll', seq: 6 });
    expect(await leaving.wait((m) => m.t === 'error')).toMatchObject({ reason: '无房间' });

    if (when === 'input') {
      vi.advanceTimersByTime(p.deadline - Date.now() - 1);
      expect(room.roomView().seating!.presentation!.phase).toBe('input');
      vi.advanceTimersByTime(1);
      const rolling = (await waitStep(observer, p.stepId + 1)).seating!.presentation!;
      expect(rolling).toMatchObject({ phase: 'rolling', startedAt: offlineAt + 600, actor: original.actor });
      expect(rolling.deadline - rolling.startedAt).toBe(1200);
      expect(rolling.resultsByUserId[userId]).toBeUndefined();
      await driveToFinalResult(cs, observer);
      const timeline = observer.msgs.flatMap((m) => m.t === 'roomView' && m.room.seating?.presentation ? [m.room.seating] : []);
      const firstResult = timeline.find((s) => s.stage === 'roll' && s.presentation!.phase === 'result' && s.presentation!.actor?.userId === userId)!.presentation!;
      expect(firstResult.deadline - firstResult.startedAt).toBe(2000);
      const nextInput = timeline.find((s) => s.presentation!.stepId === firstResult.stepId + 1)!.presentation!;
      expect(nextInput.startedAt).toBe(firstResult.deadline);
    }
    const final = latestRoom(observer).seating!.presentation!;
    expect(final.deadline - final.startedAt).toBe(3000);
    vi.advanceTimersByTime(final.deadline - Date.now() - 1);
    expect(room.phase).toBe('seating');
    expect(room.getState()).toBeNull();
    expect(observer.msgs.some((m) => m.t === 'gameView')).toBe(false);
    vi.advanceTimersByTime(1);
    const playing = await waitStep(observer, final.stepId + 1);
    await observer.wait((m) => m.t === 'gameView');
    expect(playing.phase).toBe('playing');
    expect(playing.seats.map((s) => s!.userId)).toEqual(['leave-u3', 'leave-u1', 'leave-u2', 'leave-u0']);
    const seat = playing.seats.find((s) => s?.userId === userId)!.seat;
    expect(seat).not.toBe(leavingIndex);
    expect(playing.seats[seat]).toMatchObject({ userId, offline: true, isBot: false });
    expect(room.getState()!.dealerSeat).toBe(seat);
    expect(room.getState()!.discards).toEqual([]);
    expect(room['trusteeTimers'].size).toBe(1);
    expect(faces).toHaveLength(0);

    // 注入非零积分现场，防止重入把累计分重置为初始零分而测试仍误通过。
    const scores = [25, -10, -5, -10];
    for (const player of room.getState()!.players) player.score = scores[player.seat]!;
    vi.advanceTimersByTime(offlineAt + 60_000 - Date.now() - 1);
    expect(room.roomView().seats[seat]!.offline).toBe(true);
    expect(room.roomView().seats[seat]!.trusteed).toBeUndefined();
    expect(room.getState()!.discards).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(room.roomView().seats[seat]!.trusteed).toBe(true);
    expect(room['trusteeTimers'].size).toBe(0);
    vi.advanceTimersByTime(400);
    const auto = await observer.wait((m) => m.t === 'gameView' && m.view.discards.length === 1);
    if (auto.t !== 'gameView') throw new Error('未收到托管出牌');
    expect(auto.view.discards[0]!.seat).toBe(seat);
    const stateBeforeReentry = structuredClone(room.getState());

    const returned = client(port);
    await returned.opened;
    returned.send({ t: 'auth', seq: 1, token: userId });
    await returned.wait((m) => m.t === 'authOk');
    returned.send({ t: 'join', seq: 2, room: roomId });
    expect(await returned.wait((m) => m.t === 'ack' && m.seq === 2)).toMatchObject({ ok: true });
    const restoredRoom = latestRoom(returned);
    expect(restoredRoom.seats[seat]).toEqual({ ...playing.seats[seat], offline: undefined });
    expect(restoredRoom.seats.filter(Boolean)).toHaveLength(4);
    const restored = await returned.wait((m) => m.t === 'gameView');
    if (restored.t !== 'gameView') throw new Error('缺少重入对局快照');
    expect(restored.view.you.seat).toBe(seat);
    expect(restored.view.you.score).toBe(scores[seat]);
    expect([restored.view.you, ...restored.view.others].sort((a, b) => a.seat - b.seat).map((p) => p.score)).toEqual(scores);
    expect(room['offlineSince'].has(userId)).toBe(false);
    expect(room['trusteeOf'].has(userId)).toBe(false);
    expect(room['trusteeTimers'].size).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(room.getState()).toEqual(stateBeforeReentry);
    expect(room.roomView().seats[seat]!.trusteed).toBeUndefined();
  });

  it('waiting leave 仍仅清连接并保留座位，无离线托管计时，允许原成员重入', async () => {
    const { cs, roomId, room, observer } = await setupRoom();
    const leaving = cs[0]!;
    const before = room.roomView();
    const remove = vi.spyOn(room, 'removePlayer');
    const disconnect = vi.spyOn(room, 'playerDisconnected');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const from = observer.msgs.length;
    leaving.send({ t: 'leave', seq: 3 });
    expect(await leaving.wait((m) => m.t === 'ack' && m.seq === 3)).toMatchObject({ ok: true });
    await observer.wait((m) => observer.msgs.indexOf(m) >= from && m.t === 'roomView');
    expect(latestRoom(observer)).toEqual(before);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('leave-u0');
    expect(disconnect).not.toHaveBeenCalled();
    expect(room['connOf'].has('leave-u0')).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(room.roomView()).toEqual(before);
    expect(room['offlineSince'].size).toBe(0);
    expect(room['trusteeTimers'].size).toBe(0);
    leaving.send({ t: 'start', seq: 4 });
    expect(await leaving.wait((m) => m.t === 'error')).toMatchObject({ reason: '无房间' });
    leaving.send({ t: 'join', seq: 5, room: roomId });
    expect(await leaving.wait((m) => m.t === 'ack' && m.seq === 5)).toMatchObject({ ok: true });
    expect(room.roomView()).toEqual(before);
    expect(room['connOf'].has('leave-u0')).toBe(true);
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
    // mine 标记：房主自己拉列表 mine=true，他人 mine=false（BL-016 重入入口依据）
    expect(pub!.mine).toBe(true);
    c2.send({ t: 'roomList', seq: 3 });
    const list2 = (await c2.wait((m) => m.t === 'roomList')) as Extract<ServerMsg, { t: 'roomList' }>;
    const pubForU2 = list2.rooms.find((r) => r.room === pv1.room.room);
    expect(pubForU2?.mine).toBe(false);
    c1.ws.close();
    c2.ws.close();
  });
});
