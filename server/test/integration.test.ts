import { describe, it, expect, afterEach } from 'vitest';
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
  gw = startGateway({ port: 0, identity: new MockIdentity(), heartbeatMs: 5000 });
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
    for (let i = 0; i < 4; i++) {
      const c: GameClient = new GameClient(new WebTransport(url), { onGameView: () => botStep(c) });
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
    const USERS = ['u0', 'u1', 'u2', 'u3'];
    for (let step = 0; step < 80; step++) {
      if (clients[0]!.view) break; // 已发牌
      const rv = clients[0]!.room;
      const sv = rv?.seating;
      if (!sv) {
        // seating 广播尚未到达（start 与广播异步）→ 等待下一轮
        await new Promise((r) => setTimeout(r, 40));
        continue;
      }
      const seatOfUser = new Map<string, number>();
      rv!.seats.forEach((st) => {
        if (st) seatOfUser.set(st.userId, st.seat);
      });
      const idxOfSeat = (seat: number) => USERS.findIndex((u) => seatOfUser.get(u) === seat);
      if (sv.stage === 'roll') {
        USERS.forEach((u, i) => {
          const seat = seatOfUser.get(u);
          // 同点重掷：rolls 非空但 reroll 标记的座位也需再掷
          if (seat != null && (sv.rolls[seat] == null || sv.reroll[seat])) clients[i]!.roll();
        });
      } else if (sv.stage === 'pick') {
        const i = idxOfSeat(sv.picker!);
        if (i >= 0) clients[i]!.pickSeat(sv.picker!);
      } else {
        const roller = sv.stage === 'dealerDice' ? sv.picker : sv.dealerSeat;
        const i = roller == null ? -1 : idxOfSeat(roller);
        if (i >= 0) clients[i]!.roll();
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    await Promise.all(clients.map((c) => c.waitFor((m) => m.t === 'gameView')));

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

    clients.forEach((c) => c.close());
  }, 25000);
});
