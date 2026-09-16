import { describe, it, expect } from 'vitest';
import { RoomManager } from '../src/roomManager';
import type { Connection } from '../src/connection';
import type { ServerMsg } from '@ac-majong/protocol';

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
  lastGameView() {
    const g = this.sent.filter((m): m is Extract<ServerMsg, { t: 'gameView' }> => m.t === 'gameView');
    return g[g.length - 1];
  }
}

function setupRoom(seed: number) {
  const rm = new RoomManager(seed);
  const conns = ['u0', 'u1', 'u2', 'u3'].map((u) => new MockConn(u));
  const room = rm.create('u0', conns[0]!, 8);
  room.addPlayer('u1', conns[1]!);
  room.addPlayer('u2', conns[2]!);
  room.addPlayer('u3', conns[3]!);
  return { rm, conns, room };
}
const concealedCount = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);

describe('RoomActor · 房间生命周期', () => {
  it('create → 房主入座、6 位房间号、waiting', () => {
    const rm = new RoomManager(12345);
    const room = rm.create('u0', new MockConn('u0'), 8);
    expect(room.id).toMatch(/^\d{6}$/);
    expect(room.playerCount()).toBe(1);
    expect(room.phase).toBe('waiting');
  });

  it('满 4 人 + 房主开始 → playing，各家收到 gameView，庄 17 闲 16', () => {
    const { conns, room } = setupRoom(999);
    expect(room.playerCount()).toBe(4);
    expect(room.start('u0').ok).toBe(true);
    expect(room.phase).toBe('playing');
    for (const c of conns) expect(c.lastGameView()).toBeTruthy();
    expect(concealedCount(conns[0]!.lastGameView()!.view.you.concealed)).toBe(17); // u0=seat0=庄
    expect(concealedCount(conns[1]!.lastGameView()!.view.you.concealed)).toBe(16);
  });

  it('未满 4 人 / 非房主 不能开始', () => {
    const rm = new RoomManager(1);
    const room = rm.create('u0', new MockConn('u0'), 8);
    room.addPlayer('u1', new MockConn('u1'));
    expect(room.start('u0').ok).toBe(false); // 仅 2 人
    room.addPlayer('u2', new MockConn('u2'));
    room.addPlayer('u3', new MockConn('u3'));
    expect(room.start('u1').ok).toBe(false); // 非房主
    expect(room.start('u0').ok).toBe(true);
  });
});

describe('RoomActor · 防透视与权限', () => {
  it('他家 gameView 只含暗牌张数，无具体牌', () => {
    const { conns, room } = setupRoom(7);
    room.start('u0');
    const v1 = conns[1]!.lastGameView()!.view;
    expect(v1.others.every((o) => (o as Record<string, unknown>).concealed === undefined)).toBe(true);
    expect(v1.others.every((o) => o.concealedCount === 17 || o.concealedCount === 16)).toBe(true);
  });

  it('庄家可出牌；越权（冒用他人座位）被拒', () => {
    const { room } = setupRoom(5);
    room.start('u0');
    const st = room.getState()!;
    const tile = Object.keys(st.players[0]!.concealed)[0]!;
    expect(room.handleAction('u0', { type: 'discard', seat: 0, tile }).ok).toBe(true);
    // u1(seat1) 冒用 seat0 出牌 → 座位不符
    expect(room.handleAction('u1', { type: 'discard', seat: 0, tile }).ok).toBe(false);
  });

  it('未鉴权/未开始时的动作被拒', () => {
    const rm = new RoomManager(3);
    const room = rm.create('u0', new MockConn('u0'), 8);
    room.addPlayer('u1', new MockConn('u1'));
    room.addPlayer('u2', new MockConn('u2'));
    room.addPlayer('u3', new MockConn('u3'));
    // 未 start
    expect(room.handleAction('u0', { type: 'draw', seat: 0 }).ok).toBe(false);
  });

  it('nextRound 相位守卫：未开始/本局未结束/非房间成员均被拒', () => {
    const { room } = setupRoom(11);
    expect(room.nextRound('u0').ok).toBe(false); // 未 start：不在对局中
    room.start('u0');
    expect(room.nextRound('u0').ok).toBe(false); // 本局刚开始(discard)，未结束
    expect(room.nextRound('ghost').ok).toBe(false); // 不在房间
  });
});
