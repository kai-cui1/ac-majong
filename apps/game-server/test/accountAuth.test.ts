import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { startGateway, type Gateway } from '../src/wsGateway';
import { MockIdentity } from '../src/identity';
import { MemoryGameStore, MemoryRealtime } from '@ac-majong/persistence';
import { hashPassword, verifyPassword, validateUsername, validatePassword, loginOrRegister, resolveSession } from '../src/accountAuth';
import type { ServerMsg } from '@ac-majong/protocol';

describe('accountAuth 单元', () => {
  it('哈希往返：正确密码通过、错误密码拒绝', async () => {
    const h = await hashPassword('secret123');
    expect(await verifyPassword('secret123', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
  });

  it('格式校验：账号/密码边界', () => {
    expect(validateUsername('ab')).toMatch(/3-20/);
    expect(validateUsername('good_1')).toBeNull();
    expect(validatePassword('12345')).toMatch(/6-64/);
    expect(validatePassword('123456')).toBeNull();
  });

  it('注册即登录 → 复登校验密码 → 会话可解析', async () => {
    const store = new MemoryGameStore();
    const rt = new MemoryRealtime();
    const r = await loginOrRegister(store, rt, { username: 'Alice', password: 'pass123', nickname: '小艾' });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.userId).toBe('h5:alice');
    expect(r.nickname).toBe('小艾');
    expect(await resolveSession(rt, r.session)).toBe('h5:alice');
    // 复登：密码正确
    const r2 = await loginOrRegister(store, rt, { username: 'alice', password: 'pass123' });
    expect('error' in r2).toBe(false);
    // 复登：密码错误
    const r3 = await loginOrRegister(store, rt, { username: 'alice', password: 'nope123' });
    expect('error' in r3).toBe(true);
    // 昵称沿用存档（不传昵称不覆盖）
    if (!('error' in r2)) expect(r2.nickname).toBe('小艾');
  });

  it('无效会话 → null', async () => {
    expect(await resolveSession(new MemoryRealtime(), 'deadbeef')).toBeNull();
  });
});

describe('网关账号模式（IDENTITY=account）', () => {
  let gw: Gateway | null = null;
  afterEach(() => {
    gw?.close();
    gw = null;
  });

  async function start(): Promise<number> {
    gw = startGateway({
      port: 0,
      identity: new MockIdentity(),
      heartbeatMs: 5000,
      persistence: { store: new MemoryGameStore(), realtime: new MemoryRealtime() },
      accountMode: true,
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
    };
  }

  it('账号注册登录 → authOk 带 session；会话复登免密码；错密码被拒', async () => {
    const port = await start();
    const c = client(port);
    await new Promise((r) => c.ws.on('open', r));
    const okP = c.wait((m) => m.t === 'authOk');
    c.send({ t: 'auth', seq: 1, account: { username: 'bob', password: 'pass123' }, profile: { nickname: '老 Bob' } });
    const ok = await okP;
    expect(ok.t).toBe('authOk');
    const sess = ok.t === 'authOk' ? ok.session : undefined;
    expect(sess).toBeTruthy();
    expect(ok.t === 'authOk' && ok.userId).toBe('h5:bob');
    c.ws.close();

    // 会话复登
    const c2 = client(port);
    await new Promise((r) => c2.ws.on('open', r));
    const ok2P = c2.wait((m) => m.t === 'authOk');
    c2.send({ t: 'auth', seq: 1, token: sess });
    const ok2 = await ok2P;
    expect(ok2.t === 'authOk' && ok2.profile.nickname).toBe('老 Bob');
    c2.ws.close();

    // 错密码
    const c3 = client(port);
    await new Promise((r) => c3.ws.on('open', r));
    const ackP = c3.wait((m) => m.t === 'ack' && !m.ok);
    c3.send({ t: 'auth', seq: 1, account: { username: 'bob', password: 'bad1234' } });
    const ack = await ackP;
    expect(ack.t === 'ack' && ack.reason).toBe('账号或密码错误');
    c3.ws.close();

    // 无效会话
    const c4 = client(port);
    await new Promise((r) => c4.ws.on('open', r));
    const ack4P = c4.wait((m) => m.t === 'ack' && !m.ok);
    c4.send({ t: 'auth', seq: 1, token: 'invalid-session' });
    const ack4 = await ack4P;
    expect(ack4.t === 'ack' && ack4.reason).toBe('会话过期，请重新登录');
    c4.ws.close();
  });
});
