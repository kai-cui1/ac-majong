import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { startGateway, type Gateway } from '../src/wsGateway';
import { MockIdentity } from '../src/identity';
import type { ServerMsg } from '../src/protocol';

let gw: Gateway | null = null;
afterEach(() => {
  gw?.close();
  gw = null;
});

async function start(): Promise<number> {
  gw = startGateway({ port: 0, identity: new MockIdentity(), heartbeatMs: 5000 });
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

    for (let i = 0; i < 4; i++) {
      const gv = (await cs[i]!.wait((m) => m.t === 'gameView')) as Extract<ServerMsg, { t: 'gameView' }>;
      expect(gv.view.you.concealed).toBeTruthy();
      expect(gv.view.others.every((o) => (o as Record<string, unknown>).concealed === undefined)).toBe(true);
    }

    for (const c of cs) c.ws.close();
  });
});
