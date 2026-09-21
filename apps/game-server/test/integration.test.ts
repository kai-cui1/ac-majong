import { describe, it, expect, afterEach } from 'vitest';
import { FAST_CEREMONY_MS } from './ceremonyHelper';
import type { AddressInfo } from 'node:net';
import { startGateway, type Gateway } from '../src/wsGateway';
import { MockIdentity } from '../src/identity';
import { GameClient, WebTransport, botStep } from '@ac-majong/client-core';
import type { ServerMsg } from '@ac-majong/protocol';

let gw: Gateway | null = null;
afterEach(() => {
  gw?.close();
  gw = null;
});

async function startPort(): Promise<number> {
  gw = startGateway({ port: 0, identity: new MockIdentity(), heartbeatMs: 5000, roomTimings: { ceremony: FAST_CEREMONY_MS } });
  await new Promise<void>((res) => {
    if (gw!.wss.address()) return res();
    gw!.wss.once('listening', () => res());
  });
  return (gw!.wss.address() as AddressInfo).port;
}

const isEvent = (m: ServerMsg): m is Extract<ServerMsg, { t: 'event' }> => m.t === 'event';

describe('全链路集成 · 4 机器人打完整一局（真实 WS）', () => {
  it('建房 → 4 人加入 → 开始 → 自动对局 → 结束（胡牌或荒庄）', async () => {
    const port = await startPort();
    const url = `ws://127.0.0.1:${port}`;

    const clients: GameClient[] = [];
    const rejected: ServerMsg[] = [];
    const requests = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const c: GameClient = new GameClient(new WebTransport(url), {
        onGameView: () => botStep(c),
        onRoomView: (room) => {
          const sv = room.seating;
          const p = sv?.presentation;
          if (p?.phase !== 'input' || p.actor?.userId !== c.userId) return;
          const key = `${p.ceremonyId}:${p.stepId}`;
          if (requests.has(key)) return;
          requests.add(key);
          const ceremonyToken = { ceremonyId: p.ceremonyId, stepId: p.stepId };
          if (sv!.stage === 'pick') c.pickSeat((p.actor.seat + 1) % 4, ceremonyToken);
          else c.roll(ceremonyToken);
        },
        // 本批只约束仪式请求；普通Bot响应期并发过牌仍走既有策略与守卫。
        onAck: (ack) => { if (!ack.ok && !c.view) rejected.push(ack); },
      });
      clients.push(c);
    }
    await Promise.all(clients.map((c) => c.connect()));

    clients.forEach((c, i) => c.auth(`u${i}`));
    await Promise.all(clients.map((c) => c.waitFor((m) => m.t === 'authOk')));

    clients[0]!.create(1); // maxRounds=1，打完一局即结束
    const rv = (await clients[0]!.waitFor((m) => m.t === 'roomView')) as Extract<ServerMsg, { t: 'roomView' }>;
    const roomId = rv.room.room;
    expect(roomId).toMatch(/^\d{6}$/);

    for (let i = 1; i < 4; i++) {
      clients[i]!.join(roomId);
      await clients[i]!.waitFor((m) => m.t === 'roomView');
    }

    clients[0]!.start();
    // BL-017 开局仪式：各客户端按 roomView(seating) 自动掷骰/选座，直至 gameView 发牌
    await Promise.all(clients.map((c) => c.waitFor((m) => m.t === 'gameView', 10000)));
    expect(requests.size).toBeGreaterThanOrEqual(6);
    expect(rejected).toEqual([]);

    // 机器人自动对局，等待本局结束事件
    const endMsg = await clients[0]!.waitFor(
      (m) => isEvent(m) && m.events.some((e) => e.type === 'roundEnd' || e.type === 'exhaustive' || e.type === 'win'),
      20000,
    );
    expect(isEvent(endMsg)).toBe(true);

    // 四家都收到过牌桌视图，且互不泄漏暗牌
    for (const c of clients) {
      expect(c.view).toBeTruthy();
      expect(c.view!.others.every((o) => (o as Record<string, unknown>).concealed === undefined)).toBe(true);
    }

    expect(rejected).toEqual([]);
    clients.forEach((c) => c.close());
  }, 25000);
});
