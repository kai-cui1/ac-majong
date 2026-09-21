import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomActor, CEREMONY_MS, type RoomTimings } from '../src/roomActor';
import { RoomManager } from '../src/roomManager';
import type { Connection } from '../src/connection';
import type { ServerMsg } from '@ac-majong/protocol';

class MockConn implements Connection {
  userId: string;
  sent: ServerMsg[] = [];
  constructor(userId: string) { this.userId = userId; }
  send(msg: ServerMsg): void { this.sent.push(structuredClone(msg)); }
  close(): void {}
}

const rooms: RoomActor[] = [];
/** 骰面队列 stub（1..6），保证仪式确定性 */
function stubFaces(...faces: number[]): void {
  vi.spyOn(Math, 'random').mockImplementation(() => {
    const f = faces.shift();
    if (f == null) throw new Error('骰面队列耗尽');
    return (f - 0.5) / 6;
  });
}
function setup(timings?: RoomTimings): RoomActor {
  const room = new RoomActor('123456', 'u0', 8, 42, undefined, timings);
  rooms.push(room);
  for (const u of ['u0', 'u1', 'u2', 'u3']) room.addPlayer(u, new MockConn(u), u);
  return room;
}
const token = (room: RoomActor) => {
  const p = room.roomView().seating!.presentation!;
  return { ceremonyId: p.ceremonyId, stepId: p.stepId };
};
function roll(room: RoomActor, u: string): void {
  expect(room.handleRoll(u, token(room)).ok).toBe(true);
  const stage = room.roomView().seating!.stage;
  vi.advanceTimersByTime(CEREMONY_MS.rolling + (stage === 'roll' ? CEREMONY_MS.result : CEREMONY_MS.final));
  if (room.roomView().seating?.presentation?.phase === 'summary') vi.advanceTimersByTime(CEREMONY_MS.summary);
}
/** 走完开局仪式到 playing（四家选位骰互不相同→无重掷） */
function toPlaying(room: RoomActor): void {
  stubFaces(1, 1, 2, 2, 3, 3, 4, 4, 5, 5); // 选位 2/4/6/8 + 定庄 10
  if (room.phase === 'waiting') expect(room.start('u0').ok).toBe(true);
  for (const u of ['u0', 'u1', 'u2', 'u3']) roll(room, u);
  const picker = room.roomView().seating!.picker!; // sum8 最大 = u3
  const pickerUser = 'u3';
  expect(picker).toBe(3);
  expect(room.handlePickSeat(pickerUser, 1, token(room)).ok).toBe(true);
  vi.advanceTimersByTime(CEREMONY_MS.seated);
  roll(room, pickerUser); // dealerBreak → finalize → playing
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-21T00:00:00Z'));
});
afterEach(() => {
  rooms.splice(0).forEach((r) => r.dispose());
  vi.runOnlyPendingTimers();
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('BL-022 房间自检与停滞看门狗', () => {
  it('inspect：seating 期给出 stage/槽位表；playing 期给出 game.legalBySeat 与 stall.idleMs', () => {
    const room = setup();
    stubFaces(1, 1);
    expect(room.start('u0').ok).toBe(true);
    let d = room.inspect() as { phase: string; seating: { stage: string; slots: unknown[] } };
    expect(d.phase).toBe('seating');
    expect(d.seating.stage).toBe('roll');
    expect(d.seating.slots).toEqual([]);
    toPlaying(room);
    d = room.inspect() as typeof d;
    expect(d.phase).toBe('playing');
    const game = (d as { game: { phase: string; currentSeat: number; legalBySeat: string[][]; wallLen: number } }).game;
    expect(['draw', 'discard']).toContain(game.phase);
    expect(game.legalBySeat[game.currentSeat].length).toBeGreaterThan(0);
    expect(game.wallLen).toBeGreaterThan(0);
    expect((d as { stall: { idleMs: number } }).stall.idleMs).toBeGreaterThanOrEqual(0);
  });

  it('停滞看门狗：playing 超 20s 无动作 warn 一次（含在等谁/legal）；成功动作后重置可再告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const room = setup({ stallWatchdogMs: 20_000 });
    toPlaying(room);
    vi.advanceTimersByTime(25_000);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('停滞看门狗'))).toBe(true);
    const n1 = warn.mock.calls.length;
    vi.advanceTimersByTime(25_000);
    expect(warn.mock.calls.length).toBe(n1); // 单次停滞只告警一次
    // 成功动作重置：当前座摸牌后再静默 25s 应再次告警
    const d = room.inspect() as { game: { currentSeat: number }; seats: ({ userId: string } | null)[] };
    const actor = d.seats[d.game.currentSeat]!.userId;
    const st = room.getState()!;
    const tile = Object.keys(st.players[d.game.currentSeat].concealed)[0]!;
    const op = room.handleAction(actor, { type: 'discard', seat: d.game.currentSeat, tile });
    expect(op.ok).toBe(true);
    vi.advanceTimersByTime(25_000);
    expect(warn.mock.calls.length).toBeGreaterThan(n1);
  });

  it('dispose 清理看门狗定时器（playing 中回收不留 interval）', () => {
    const room = setup({ stallWatchdogMs: 20_000 });
    toPlaying(room);
    room.dispose();
    vi.runOnlyPendingTimers();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('BL-022 RoomManager.list', () => {
  it('返回活跃房间供 /dev/rooms 使用', () => {
    const rm = new RoomManager();
    const conn = new MockConn('u0');
    const room = rm.create('u0', conn, 8, 'u0');
    expect(rm.list().map((r) => r.id)).toContain(room.id);
    room.dispose();
    rm.remove(room.id);
    expect(rm.list()).toEqual([]);
  });
});

describe('BL-026 结算事件补发（晚进入/重连重建浮层）', () => {
  it('playing 相位即使有缓存也不补发', () => {
    const room = setup();
    toPlaying(room);
    room.noteTerminal([{ type: 'exhaustive', revealed: {} } as never]);
    expect(room.resendSettlement('u0')).toBe(null);
    expect(room.resendSettlement('stranger')).toBe(null);
  });

  it('全 Bot 局终局后：成员可补发终局事件、重连连接收到 event、非成员 null', () => {
    stubFaces(1, 1, 2, 2, 3, 3, 4, 4, 5, 5);
    const room = new RoomActor('654321', 'b0', 8, 99);
    rooms.push(room);
    for (const u of ['b0', 'b1', 'b2', 'b3']) room.addPlayer(u, new MockConn(u), u);
    for (const u of ['b0', 'b1', 'b2', 'b3']) room.attachBot(u, 0);
    expect(room.start('b0').ok).toBe(true);
    for (const u of ['b0', 'b1', 'b2', 'b3']) roll(room, u);
    expect(room.handlePickSeat('b3', 1, token(room)).ok).toBe(true);
    vi.advanceTimersByTime(CEREMONY_MS.seated);
    roll(room, 'b3');
    let phase = room.getState()?.phase;
    for (let i = 0; i < 6000 && phase !== 'settled' && phase !== 'exhaustive'; i++) {
      vi.advanceTimersByTime(200);
      phase = room.getState()?.phase;
    }
    expect(phase === 'settled' || phase === 'exhaustive').toBe(true);
    const ev = room.resendSettlement('b0');
    expect(ev).not.toBe(null);
    expect(['win', 'exhaustive', 'zhahu']).toContain(ev!.type);
    expect(room.resendSettlement('stranger')).toBe(null);
    // 重连：同座新连接重入应收到补发的 event 消息
    const c = new MockConn('b0');
    expect(room.addPlayer('b0', c, 'b0').ok).toBe(true);
    expect(c.sent.some((m) => m.t === 'event')).toBe(true);
  });
});
