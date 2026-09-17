import { describe, it, expect } from 'vitest';
import { RoomActor } from '../src/roomActor';
import type { Connection } from '../src/connection';
import type { ServerMsg } from '@ac-majong/protocol';
import { legalActions } from '@ac-majong/engine';
import type { Action } from '@ac-majong/engine';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(trusteeAfterMs = 80) {
  const conns = ['u0', 'u1', 'u2', 'u3'].map((u) => new MockConn(u));
  const room = new RoomActor('123456', 'u0', 8, 42, undefined, { trusteeAfterMs });
  room.addPlayer('u0', conns[0]!);
  room.addPlayer('u1', conns[1]!);
  room.addPlayer('u2', conns[2]!);
  room.addPlayer('u3', conns[3]!);
  room.start('u0');
  return { room, conns };
}

/** 异步推进对局直到指定座位进入 draw 相位；skip 座位交给托管定时器自打（同步循环会饿死定时器） */
async function driveToDraw(room: RoomActor, users: string[], seat: number, skip = new Set<number>(), maxSteps = 80): Promise<void> {
  for (let i = 0; i < maxSteps; i++) {
    const st = room.getState();
    if (!st) return;
    if (st.phase === 'draw' && st.currentSeat === seat) return;
    if (st.phase === 'settled' || st.phase === 'exhaustive') return;
    for (let s = 0; s < 4; s++) {
      if (skip.has(s)) continue;
      const legal = legalActions(st, s);
      if (!legal.length) continue;
      let a: Action | null = null;
      if (st.phase === 'draw' && st.currentSeat === s && legal.includes('draw')) a = { type: 'draw', seat: s };
      else if (st.phase === 'discard' && st.currentSeat === s && legal.includes('discard')) {
        const t = Object.keys(st.players[s]!.concealed)[0];
        if (t) a = { type: 'discard', seat: s, tile: t };
      } else if (st.phase === 'response' && legal.includes('pass')) a = { type: 'respond', seat: s, move: 'pass' };
      if (a) room.handleAction(users[s]!, a);
    }
    await sleep(25);
  }
}

describe('M-I 断线重连与托管（BL-007 / FR-断线-01~04）', () => {
  it('掉线标记离线：座位保留 + roomView offline 广播', () => {
    const { room } = setup();
    room.playerDisconnected('u1');
    const seats = room.roomView().seats;
    expect(seats[1]?.userId).toBe('u1'); // 座位保留
    expect(seats[1]?.offline).toBe(true);
    expect(seats[1]?.trusteed).toBeUndefined();
  });

  it('超时转托管：保守代打自动摸打（FR-断线-03）', async () => {
    const { room, conns } = setup(80);
    await driveToDraw(room, ['u0', 'u1', 'u2', 'u3'], 1); // 轮到 u1 摸牌时掉线
    const st0 = room.getState()!;
    const wall0 = st0.wall.length;
    room.playerDisconnected('u1');
    await sleep(80 + 1100); // 超时转托管 + 代打摸/打两段延迟
    const seats = room.roomView().seats;
    expect(seats[1]?.trusteed).toBe(true);
    expect(seats[1]?.offline).toBeUndefined();
    const st1 = room.getState()!;
    // 托管已代 u1 摸牌并打出（牌墙减少 + 有 u1 的弃牌）
    expect(st1.wall.length).toBeLessThan(wall0);
    expect(st1.discards.some((d) => d.seat === 1)).toBe(true);
    void conns;
  });

  it('托管不主动胡：响应期一律过（保守策略）', async () => {
    const { room } = setup(60);
    room.playerDisconnected('u2');
    await sleep(60 + 50);
    expect(room.roomView().seats[2]?.trusteed).toBe(true);
    // 异步推进（u2 交托管定时器自打）：越过 u2 的回合
    await driveToDraw(room, ['u0', 'u1', 'u2', 'u3'], 0, new Set([2]), 60);
    const after = room.getState()!;
    // 托管期间 u2 无副露（不主动吃碰杠）
    expect(after.players[2]!.melds.length).toBe(0);
    // 且 u2 的弃牌由托管摸打产生
    expect(after.discards.some((d) => d.seat === 2)).toBe(true);
  });

  it('重连接管：离线计时取消 + 托管卸除 + 真实连接恢复行动（FR-断线-02/04）', async () => {
    const { room } = setup(80);
    room.playerDisconnected('u1');
    await sleep(80 + 300); // 先进托管
    expect(room.roomView().seats[1]?.trusteed).toBe(true);
    const real = new MockConn('u1');
    const r = room.addPlayer('u1', real);
    expect(r.ok).toBe(true);
    expect(r.seat).toBe(1);
    const seats = room.roomView().seats;
    expect(seats[1]?.trusteed).toBeUndefined();
    expect(seats[1]?.offline).toBeUndefined();
    // 真实连接收到完整视图（重连恢复）
    expect(real.sent.some((m) => m.t === 'gameView')).toBe(true);
    // 轮到 u1 时真实连接可行动
    await driveToDraw(room, ['u0', 'u1', 'u2', 'u3'], 1);
    const res = room.handleAction('u1', { type: 'draw', seat: 1 });
    expect(res.ok).toBe(true);
  });

  it('60 秒窗口内重连：不转托管', async () => {
    const { room } = setup(120);
    room.playerDisconnected('u3');
    await sleep(30);
    const real = new MockConn('u3');
    room.addPlayer('u3', real);
    await sleep(120 + 100); // 越过原超时点
    const seats = room.roomView().seats;
    expect(seats[3]?.trusteed).toBeUndefined();
    expect(seats[3]?.offline).toBeUndefined();
  });
});
