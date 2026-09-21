import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RoomActor, CEREMONY_MS, type GameHooks } from '../src/roomActor';
import type { Connection } from '../src/connection';
import type { ServerMsg } from '@ac-majong/protocol';
import type { RoomSettings } from '@ac-majong/protocol';

class MockConn implements Connection {
  userId: string;
  sent: ServerMsg[] = [];
  constructor(userId: string) {
    this.userId = userId;
  }
  send(msg: ServerMsg): void {
    this.sent.push(structuredClone(msg));
  }
  close(): void {}
}

/** 骰子队列 stub：替换 RoomActor.roll2d6 保证测试确定性 */
const rooms: RoomActor[] = [];
function stubFaces(...faces: number[]): void {
  vi.spyOn(Math, 'random').mockImplementation(() => {
    const face = faces.shift();
    if (face == null) throw new Error('骰面队列耗尽');
    expect(face).toBeGreaterThanOrEqual(1);
    expect(face).toBeLessThanOrEqual(6);
    return (face - 0.5) / 6;
  });
}
function stubDice(...vals: number[]): void {
  // 既有玩法用例保留总和夹具；通过两个随机样本驱动生产骰子生成器。
  stubFaces(...vals.flatMap((sum) => [Math.min(6, sum - 1), sum - Math.min(6, sum - 1)]));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));
});
afterEach(() => {
  rooms.splice(0).forEach((room) => {
    room.dispose();
    expectOwnTimersCleared(room);
  });
  // Bot 连接自有的代打回调可排空；Actor 自有计时在用例中回收后立即核对数量。
  vi.runOnlyPendingTimers();
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const presentation = (room: RoomActor) => room.roomView().seating!.presentation!;
const tokenOf = (room: RoomActor) => {
  const { ceremonyId, stepId } = presentation(room);
  return { ceremonyId, stepId };
};
function rollAndWait(room: RoomActor, userId: string) {
  const op = room.handleRoll(userId, tokenOf(room));
  expect(op.ok).toBe(true);
  const stage = room.roomView().seating!.stage;
  vi.advanceTimersByTime(CEREMONY_MS.rolling + (stage === 'roll' ? CEREMONY_MS.result : CEREMONY_MS.final));
  if (room.roomView().seating?.presentation?.phase === 'summary') vi.advanceTimersByTime(CEREMONY_MS.summary);
  return op;
}
function pickAndWait(room: RoomActor, userId: string, seat: number) {
  const op = room.handlePickSeat(userId, seat, tokenOf(room));
  expect(op.ok).toBe(true);
  vi.advanceTimersByTime(CEREMONY_MS.seated);
  return op;
}
function rollFour(room: RoomActor): void {
  for (const u of ['u0', 'u1', 'u2', 'u3']) rollAndWait(room, u);
}

function gameHooks() {
  return { onGameStart: vi.fn(), onGameAction: vi.fn(), onGameEnd: vi.fn(), onRoomEnd: vi.fn(), onSeating: vi.fn() };
}
function expectOwnTimersCleared(room: RoomActor): void {
  expect(room['seatingInputTimer']).toBeUndefined();
  expect(room['seatingDisplayTimer']).toBeUndefined();
  expect(room['seatingAdvance']).toBeUndefined();
  expect(room['trusteeTimers'].size).toBe(0);
}
function expectReentrySnapshot(room: RoomActor, conns: MockConn[]): void {
  const before = room.roomView().seating!;
  const state = room.getState();
  const history = JSON.stringify(conns[0]!.sent);
  const samples = vi.mocked(Math.random).mock.calls.length;
  vi.advanceTimersByTime(100);
  const reconnected = new MockConn('u0');
  expect(room.addPlayer('u0', reconnected).ok).toBe(true);
  const expected = { ...before, presentation: { ...before.presentation!, serverNow: before.presentation!.serverNow + 100 } };
  expect(room.roomView().seating).toEqual(expected);
  const msg = reconnected.sent.at(-1)!;
  expect(msg.t).toBe(room.phase === 'playing' ? 'gameView' : 'roomView');
  const received = msg.t === 'gameView' ? msg.view.seating : msg.t === 'roomView' ? msg.room.seating : undefined;
  expect(received).toEqual(expected);
  expect(room.getState()).toBe(state);
  expect(vi.mocked(Math.random)).toHaveBeenCalledTimes(samples);
  expect(JSON.stringify(conns[0]!.sent)).toBe(history);
}
function setup(settings?: Partial<RoomSettings>, trusteeAfterMs = 60_000, hooks?: GameHooks) {
  const conns = ['u0', 'u1', 'u2', 'u3'].map((u) => new MockConn(u));
  const room = new RoomActor('654321', 'u0', 8, 42, hooks, { trusteeAfterMs }, {
    wallMode: 'random', breakDice: false, chiFirstView: true, isPublic: true, ...settings,
  });
  rooms.push(room);
  room.addPlayer('u0', conns[0]!);
  room.addPlayer('u1', conns[1]!);
  room.addPlayer('u2', conns[2]!);
  room.addPlayer('u3', conns[3]!);
  return { room, conns };
}

describe('BL-017 · 开局仪式 seating 状态机（FR-对局-18/19）', () => {
  it('start → phase=seating，stage=roll，gameView 未发', () => {
    const { room, conns } = setup();
    stubDice(1, 1, 1, 1); // 不会被调用
    expect(room.start('u0').ok).toBe(true);
    expect(room.phase).toBe('seating');
    const sv = room.roomView().seating!;
    expect(sv.stage).toBe('roll');
    expect(sv.rolls).toEqual([null, null, null, null]);
    for (const c of conns) expect(c.sent.some((m) => m.t === 'gameView')).toBe(false);
  });

  it('选位骰：点数降序定选座顺位，最大者进入 pick；仪式中动作被拒', () => {
    const { room } = setup();
    stubDice(5, 9, 7, 12); // u0=5 u1=9 u2=7 u3=12
    room.start('u0');
    expect(rollAndWait(room, 'u0').ok).toBe(true);
    expect(room.handleRoll('u0').ok).toBe(false); // 已掷过
    rollAndWait(room, 'u1');
    rollAndWait(room, 'u2');
    const svMid = room.roomView().seating!;
    expect(svMid.stage).toBe('roll');
    rollAndWait(room, 'u3'); // 齐 → 定顺位
    const sv = room.roomView().seating!;
    expect(sv.stage).toBe('pick');
    expect(sv.order).toEqual([3, 1, 2, 0]); // 12 > 9 > 7 > 5
    expect(sv.picker).toBe(3); // u3 最大，先选座
    // 仪式未完成：对局动作被拒
    expect(room.handleAction('u0', { type: 'draw', seat: 0 }).ok).toBe(false);
  });

  it('同点重掷：仅同点者重掷，其余点数保留', () => {
    const { room } = setup();
    stubDice(8, 8, 5, 12, 9, 7); // 首轮 u0=u1=8 同点；重掷 u0=9 u1=7
    room.start('u0');
    rollFour(room);
    let sv = room.roomView().seating!;
    expect(sv.stage).toBe('roll');
    expect(sv.reroll).toEqual([true, true, false, false]);
    expect(sv.rolls).toEqual([8, 8, 5, 12]);
    rollAndWait(room, 'u0');
    rollAndWait(room, 'u1');
    sv = room.roomView().seating!;
    expect(sv.stage).toBe('pick');
    expect(sv.order).toEqual([3, 0, 1, 2]); // 12 > 9 > 7 > 5
  });

  it('逐轮淘汰：重掷者与已定序者撞点不触发其重掷（仅待决组内判重）', () => {
    const { room } = setup();
    stubDice(8, 8, 5, 12, 5, 7); // 首轮 u0=u1=8 同点；重掷 u0=5（撞已定序 u2 的 5）、u1=7
    room.start('u0');
    rollFour(room);
    let sv = room.roomView().seating!;
    expect(sv.reroll).toEqual([true, true, false, false]);
    rollAndWait(room, 'u0');
    rollAndWait(room, 'u1');
    sv = room.roomView().seating!;
    expect(sv.reroll).toEqual([false, false, false, false]); // u2 首轮唯一已定序，不因撞点被拉回重掷
    expect(sv.stage).toBe('pick');
    expect(sv.order).toEqual([3, 1, 0, 2]); // 12 > [7,5 并列块] > u2 的 5
  });

  it('逐轮淘汰：重掷组新点数低于已定序者仍留在原并列块内', () => {
    const { room } = setup();
    stubDice(8, 8, 5, 12, 3, 2); // 重掷 u0=3、u1=2，均低于已定序 u2 的 5
    room.start('u0');
    rollFour(room);
    rollAndWait(room, 'u0');
    rollAndWait(room, 'u1');
    const sv = room.roomView().seating!;
    expect(sv.stage).toBe('pick');
    expect(sv.order).toEqual([3, 0, 1, 2]); // u0/u1 仍在 u2 之前的并列块内，不被新点数拉后
  });

  it('逐轮淘汰：三人同点→两人再同点→逐轮细化直至定序', () => {
    const { room } = setup();
    stubDice(8, 8, 8, 5, 9, 9, 7, 4, 6); // 首轮三同点；二轮 u2=7 定序、u0=u1=9 再同点；三轮 u0=4、u1=6
    room.start('u0');
    rollFour(room);
    expect(room.roomView().seating!.reroll).toEqual([true, true, true, false]);
    rollAndWait(room, 'u0'); rollAndWait(room, 'u1'); rollAndWait(room, 'u2');
    expect(room.roomView().seating!.reroll).toEqual([true, true, false, false]);
    rollAndWait(room, 'u0'); rollAndWait(room, 'u1');
    const sv = room.roomView().seating!;
    expect(sv.stage).toBe('pick');
    expect(sv.order).toEqual([1, 0, 2, 3]); // 块内 6>4；u2(7) 居次；u3(5) 居末
  });

  it('选座重排：A 选座后其余按点数序依次坐下手，视图随座位重索引', () => {
    const { room } = setup();
    stubDice(5, 9, 7, 12, 9); // 选位骰 + 定庄骰 N=9
    room.start('u0');
    rollFour(room);
    expect(room.roomView().seating!.picker).toBe(3); // u3 最大
    expect(room.handlePickSeat('u0', 1).ok).toBe(false); // 非选位最大者
    expect(pickAndWait(room, 'u3', 1).ok).toBe(true); // u3 选 seat1
    // 点数序 [u3, u1, u2, u0] → 自 seat1 起依次 1,2,3,0
    const seats = room.roomView().seats.map((s) => s?.userId);
    expect(seats).toEqual(['u0', 'u3', 'u1', 'u2']);
    const sv = room.roomView().seating!;
    expect(sv.presentation!.actor).toEqual({ userId: 'u3', seat: 1 });
    expect(sv.presentation!.resultsByUserId.u3).toMatchObject({ d1: 6, d2: 6, sum: 12 });
    expect(sv.stage).toBe('dealerBreak');
    expect(sv.picker).toBe(1); // u3 现坐 seat1
    expect(sv.rolls[1]).toBe(12); // 点数随座位重排
  });

  it('定庄骰映射：相对 A 位置 1/5/9=自己、2/6/10=下手、3/7/11=对面、4/8/12=上手', () => {
    const cases: [number, number][] = [
      [7, 3], // 对面（用户例：A=seat1，7 → seat3）
      [9, 1], // 自己（用户例：9 → A 本人）
      [2, 2], // 下手
      [4, 0], // 上手
      [12, 0], // 12 → (11)%4=3 → 上手
      [5, 1], // 5 → (4)%4=0 → 自己
    ];
    for (const [n, expectDealer] of cases) {
      const { room } = setup();
      stubDice(5, 9, 7, 12, n); // A=u3 选 seat1 后掷定庄骰 N
      room.start('u0');
      rollFour(room);
      pickAndWait(room, 'u3', 1);
      rollAndWait(room, 'u3');
      expect(room.roomView().seating).toBeUndefined(); // breakDice=false → 直接发牌
      expect(room.phase).toBe('playing');
      expect(room.getState()!.dealerSeat, `N=${n}`).toBe(expectDealer);
    }
  });

  it('仪式收尾：A 上 1 子 + 首庄庄子；首庄非 A 时两家分别计子', () => {
    const { room } = setup();
    stubDice(5, 9, 7, 12, 7); // A=u3(seat1)，N=7 → 庄=seat3
    room.start('u0');
    rollFour(room);
    pickAndWait(room, 'u3', 1);
    rollAndWait(room, 'u3');
    const st = room.getState()!;
    expect(st.players.find((p) => p.seat === 1)!.zi).toBe(1); // A 的普通子
    expect(st.players.find((p) => p.seat === 3)!.zi).toBe(1); // 首庄庄子
    expect(st.dealerSeat).toBe(3);
    expect(st.players.find((p) => p.seat === 3)!.score).toBe(0);
  });

  it('A 自任首庄（N=9）：子上庄合并为 2', () => {
    const { room } = setup();
    stubDice(5, 9, 7, 12, 9); // N=9 → dealerSeat=A 自己
    room.start('u0');
    rollFour(room);
    pickAndWait(room, 'u3', 2); // A 选 seat2
    rollAndWait(room, 'u3');
    const st = room.getState()!;
    expect(st.dealerSeat).toBe(2);
    expect(st.players.find((p) => p.seat === 2)!.zi).toBe(2); // 1 子 + 1 庄子
  });

  it('breakDice=true：开局仪式一掷同时定庄+定开牌点（合并流程 2026-09-19）', () => {
    const { room } = setup({ wallMode: 'physical', breakDice: true });
    stubDice(5, 9, 7, 12, 7); // A=u3(seat1)，N=7 → 庄=seat3，breakN=7
    room.start('u0');
    rollFour(room);
    pickAndWait(room, 'u3', 1);
    rollAndWait(room, 'u3'); // 定庄摸牌位骰（A=u3，一掷定庄+开牌点）
    expect(room.roomView().seating).toBeUndefined(); // 直接发牌，无单独 breakDice 阶段
    expect(room.phase).toBe('playing');
    const st = room.getState()!;
    expect(st.dealerSeat).toBe(3);
    expect(st.breakGroups).toBe(7); // 同一点数兼定开牌点
    expect(st.layout).toBeTruthy(); // physical 模式固化牌墙
    const flowers = st.players.reduce((s, p) => s + p.flowers.length, 0);
    expect(st.wall.length).toBe(144 - 17 - 16 * 3 - flowers);
    expect(st.initialWallLen).toBe(144);
  });

  it('physical 模式 gameView 携带 wallInfo；random 模式为 null', () => {
    const { room, conns } = setup({ wallMode: 'physical', breakDice: false });
    stubDice(5, 9, 7, 12, 7);
    room.start('u0');
    rollFour(room);
    pickAndWait(room, 'u3', 1);
    rollAndWait(room, 'u3');
    const gv = conns[0]!.sent.filter((m): m is Extract<ServerMsg, { t: 'gameView' }> => m.t === 'gameView').pop();
    expect(gv!.view.wallInfo).toBeTruthy();
    expect(gv!.view.wallInfo!.rows.length).toBe(4);

    const { room: room2, conns: conns2 } = setup({ wallMode: 'random', breakDice: false });
    stubDice(5, 9, 7, 12, 7);
    room2.start('u0');
    rollFour(room2);
    pickAndWait(room2, 'u3', 1);
    rollAndWait(room2, 'u3');
    const gv2 = conns2[0]!.sent.filter((m): m is Extract<ServerMsg, { t: 'gameView' }> => m.t === 'gameView').pop();
    expect(gv2!.view.wallInfo ?? null).toBeNull();
  });

  it('仪式结束后 roomView 不再携带 seating（客户端关闭仪式 UI）', () => {
    const { room } = setup();
    stubDice(5, 9, 7, 12, 7);
    room.start('u0');
    rollFour(room);
    pickAndWait(room, 'u3', 1);
    rollAndWait(room, 'u3');
    expect(room.roomView().seating).toBeUndefined();
    expect(room.roomView().phase).toBe('playing');
  });
});

describe('BL-017 · 权威展示边界与生命周期', () => {
  it('正式时长集中定义，1真人3Bot逐家揭晓，结果期不建局、不发牌', () => {
    expect(CEREMONY_MS).toEqual({ input: 10000, auto: 600, rolling: 1200, result: 2000, summary: 2000, seated: 1500, final: 3000 });
    const starts = vi.fn();
    const host = new MockConn('host');
    const room = new RoomActor('111111', 'host', 8, 42, {
      onGameStart: starts, onGameAction: vi.fn(), onGameEnd: vi.fn(), onRoomEnd: vi.fn(),
    });
    rooms.push(room);
    room.addPlayer('host', host);
    room.addBot('host', 3);
    stubFaces(4, 3, 6, 6, 2, 3, 3, 6, 4, 5);
    room.start('host');
    const users = room.roomView().seats.map((s) => s!.userId);
    const initial = structuredClone(presentation(room));
    expect(initial.pendingRollUserIds).toEqual(users);
    expect(initial.deadline - initial.startedAt).toBe(10000);
    const sums = [7, 12, 5, 9];
    for (let i = 0; i < 4; i++) {
      const p = presentation(room);
      expect(p.actor).toEqual({ userId: users[i], seat: i });
      expect(p.pendingRollUserIds).toEqual(users.slice(i));
      if (i === 0) expect(room.handleRoll('host', tokenOf(room)).ok).toBe(true);
      else {
        vi.advanceTimersByTime(599);
        expect(presentation(room).phase).toBe('input');
        vi.advanceTimersByTime(1);
      }
      expect(presentation(room).phase).toBe('rolling');
      expect(presentation(room).resultsByUserId[users[i]!]).toBeUndefined();
      vi.advanceTimersByTime(1199);
      expect(presentation(room).phase).toBe('rolling');
      vi.advanceTimersByTime(1);
      expect(presentation(room).resultsByUserId[users[i]!]!.sum).toBe(sums[i]);
      expect(Object.keys(presentation(room).resultsByUserId)).toHaveLength(i + 1);
      vi.advanceTimersByTime(1999);
      expect(presentation(room).phase).toBe('result');
      vi.advanceTimersByTime(1);
      expect(room.getState()).toBeNull();
    }
    expect(presentation(room).summaryKind).toBe('ranking');
    expect(room.roomView().seating!.order).toEqual([1, 3, 0, 2]);
    vi.advanceTimersByTime(1999);
    expect(room.roomView().seating!.stage).toBe('roll');
    vi.advanceTimersByTime(1);
    expect(room.roomView().seating!.stage).toBe('pick');
    vi.advanceTimersByTime(599);
    expect(presentation(room).phase).toBe('input');
    vi.advanceTimersByTime(1);
    expect(presentation(room).summaryKind).toBe('seated');
    expect(room.roomView().seats[1]!.userId).toBe(users[1]);
    vi.advanceTimersByTime(1499);
    expect(room.roomView().seating!.stage).toBe('pick');
    vi.advanceTimersByTime(1);
    expect(presentation(room).actor).toEqual({ userId: users[1], seat: 1 });
    vi.advanceTimersByTime(600 + 1200);
    expect(presentation(room).ceremonyDice).toEqual({ d1: 4, d2: 5, sum: 9 });
    expect(room.roomView().seating!.ziCounts).toEqual([0, 2, 0, 0]);
    vi.advanceTimersByTime(2999);
    expect(starts).not.toHaveBeenCalled();
    expect(host.sent.some((m) => m.t === 'gameView')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(starts).toHaveBeenCalledTimes(1);
    expect(room.getState()!.players.map((p) => p.zi)).toEqual([0, 2, 0, 0]);
    expect(room.getState()!.discards).toEqual([]);
    expect(host.sent.some((m) => m.t === 'gameView')).toBe(true);
    const history = host.sent.find((m) => m.t === 'roomView' && m.room.seating);
    expect(history?.t === 'roomView' && history.room.seating!.presentation).toEqual(initial);
    expect(vi.mocked(Math.random)).toHaveBeenCalledTimes(10);
  });

  it('房主不在0座时，从房主沿初始座位下手轮转', () => {
    const room = new RoomActor('222222', 'u2', 8, 42);
    rooms.push(room);
    for (const u of ['u0', 'u1', 'u2', 'u3']) room.addPlayer(u, new MockConn(u));
    stubDice(12, 9, 7, 5);
    room.start('u2');
    expect(presentation(room).pendingRollUserIds).toEqual(['u2', 'u3', 'u0', 'u1']);
    for (const u of ['u2', 'u3', 'u0', 'u1']) {
      expect(presentation(room).actor!.userId).toBe(u);
      rollAndWait(room, u);
    }
    expect(presentation(room).actor).toEqual({ userId: 'u2', seat: 2 });
  });

  it('连续同点含未重掷者再次撞点：队列按初始轮转，旧结果留至自己落定', () => {
    const { room } = setup();
    stubDice(8, 8, 5, 12, 9, 9, 10, 6);
    room.start('u0');
    for (const u of ['u0', 'u1', 'u2']) rollAndWait(room, u);
    room.handleRoll('u3', tokenOf(room));
    vi.advanceTimersByTime(3200);
    expect(presentation(room).summaryKind).toBe('reroll');
    expect(room.roomView().seating!.rolls).toEqual([8, 8, 5, 12]);
    expect(room.handleRoll('u0', tokenOf(room)).ok).toBe(false);
    vi.advanceTimersByTime(1999);
    expect(presentation(room).rerollRound).toBe(0);
    vi.advanceTimersByTime(1);
    expect(presentation(room).rerollRound).toBe(1);
    expect(presentation(room).pendingRollUserIds).toEqual(['u0', 'u1']);
    const old = structuredClone(presentation(room).resultsByUserId);
    room.handleRoll('u0', tokenOf(room));
    vi.advanceTimersByTime(1199);
    expect(presentation(room).resultsByUserId).toEqual(old);
    vi.advanceTimersByTime(1);
    expect(presentation(room).resultsByUserId.u0).toMatchObject({ sum: 9, rerollRound: 1 });
    expect(presentation(room).resultsByUserId.u1).toEqual(old.u1);
    vi.advanceTimersByTime(2000);
    rollAndWait(room, 'u1'); // u1=9 与 u0 仍同点（仅待决组内判重）→ 第二轮重掷
    expect(presentation(room).pendingRollUserIds).toEqual(['u0', 'u1']);
    expect(presentation(room).rerollRound).toBe(2);
    rollAndWait(room, 'u0'); // 10
    rollAndWait(room, 'u1'); // 6 → 组内定序
    expect(room.roomView().seating!.order).toEqual([3, 0, 1, 2]);
    expect(presentation(room).resultsByUserId.u3).toEqual(old.u3);
    expect(presentation(room).resultsByUserId.u2).toEqual(old.u2);
  });

  it('越权、重复、错误阶段、过期及旧步骤令牌被拒，旧端省略令牌仍有守卫', () => {
    const { room } = setup();
    stubDice(8, 8, 5, 12, 9);
    room.start('u0');
    const first = tokenOf(room);
    expect(room.handleRoll('ghost', first).ok).toBe(false);
    expect(room.handleRoll('u1', first).ok).toBe(false);
    expect(room.handlePickSeat('u0', 0, first).ok).toBe(false);
    expect(room.handleRoll('u0', { ...first, ceremonyId: 'old' }).ok).toBe(false);
    expect(room.handleRoll('u0', { ...first, stepId: first.stepId - 1 }).ok).toBe(false);
    expect(room.handleRoll('u0', first).ok).toBe(true);
    expect(room.handleRoll('u0', first).ok).toBe(false);
    vi.advanceTimersByTime(1200);
    expect(room.handleRoll('u1').ok).toBe(false);
    vi.advanceTimersByTime(2000);
    for (const user of ['u1', 'u2', 'u3']) rollAndWait(room, user);
    expect(presentation(room).actor!.userId).toBe('u0');
    expect(room.handleRoll('u0', first).ok).toBe(false);
    expect(room.handleRoll('u0').ok).toBe(true);
    expect(room.handleRoll('u0').ok).toBe(false);

    const other = setup().room;
    other.start('u0');
    const token = tokenOf(other);
    vi.setSystemTime(presentation(other).deadline);
    expect(other.handleRoll('u0', token).ok).toBe(false);
    expect(presentation(other).phase).toBe('input');
  });

  it('真人掷骰及选座10秒超时自动操作，选座保留当前座位并保持身份结果', () => {
    const { room } = setup();
    stubDice(12, 9, 7, 5, 9);
    room.start('u0');
    vi.advanceTimersByTime(9999);
    expect(presentation(room).phase).toBe('input');
    vi.advanceTimersByTime(1);
    expect(presentation(room).phase).toBe('rolling');
    vi.advanceTimersByTime(3200);
    for (const u of ['u1', 'u2', 'u3']) rollAndWait(room, u);
    const results = presentation(room).resultsByUserId;
    const pickToken = tokenOf(room);
    for (const seat of [-1, 4, 1.5, NaN]) expect(room.handlePickSeat('u0', seat, pickToken).ok).toBe(false);
    expect(room.handlePickSeat('u1', 2, pickToken).ok).toBe(false);
    vi.advanceTimersByTime(9999);
    expect(presentation(room).phase).toBe('input');
    vi.advanceTimersByTime(1);
    expect(room.roomView().seating!.picked).toBe(0);
    expect(presentation(room).summaryKind).toBe('seated');
    expect(room.handlePickSeat('u0', 2, pickToken).ok).toBe(false);
    expect(presentation(room).resultsByUserId).toEqual(results);
    vi.advanceTimersByTime(1500);
    expect(presentation(room).actor).toEqual({ userId: 'u0', seat: 0 });
    vi.advanceTimersByTime(10000);
    expect(presentation(room).phase).toBe('rolling');
  });

  it.each(['input', 'rolling', 'result', 'summary'] as const)('%s 阶段重连不换步骤、不重启期限，历史广播不被改写', (phase) => {
    const { room, conns } = setup();
    stubDice(5, 9, 7, 12);
    room.start('u0');
    if (phase === 'summary') {
      for (const u of ['u0', 'u1', 'u2']) rollAndWait(room, u);
      room.handleRoll('u3', tokenOf(room));
      vi.advanceTimersByTime(3200);
    } else if (phase !== 'input') {
      room.handleRoll('u0', tokenOf(room));
      if (phase === 'result') vi.advanceTimersByTime(1200);
    }
    expect(presentation(room).phase).toBe(phase);
    if (phase === 'input' || phase === 'rolling') expect(presentation(room).resultsByUserId).toEqual({});
    else expect(presentation(room).resultsByUserId.u0).toEqual({ d1: 4, d2: 1, sum: 5, rerollRound: 0 });
    expectReentrySnapshot(room, conns);
  });

  it.each([
    ['pick', 'input', null], ['pick', 'summary', 'seated'],
    ['dealerBreak', 'input', null], ['dealerBreak', 'rolling', null], ['dealerBreak', 'result', null],
  ] as const)('%s/%s 重入保留真实骰面、座位、计子、步骤与期限', (stage, phase, summaryKind) => {
    const { room, conns } = setup();
    stubFaces(4, 1, 6, 3, 6, 1, 6, 6, 4, 5);
    room.start('u0');
    rollFour(room);
    if (stage !== 'pick' || phase === 'summary') room.handlePickSeat('u3', 1, tokenOf(room));
    if (stage === 'dealerBreak') {
      vi.advanceTimersByTime(CEREMONY_MS.seated);
      if (phase !== 'input') room.handleRoll('u3', tokenOf(room));
      if (phase === 'result') vi.advanceTimersByTime(CEREMONY_MS.rolling);
    }
    expect(room.roomView().seating!.stage).toBe(stage);
    expect(presentation(room)).toMatchObject({ phase, summaryKind });
    expect(presentation(room).resultsByUserId).toEqual({
      u0: { d1: 4, d2: 1, sum: 5, rerollRound: 0 }, u1: { d1: 6, d2: 3, sum: 9, rerollRound: 0 },
      u2: { d1: 6, d2: 1, sum: 7, rerollRound: 0 }, u3: { d1: 6, d2: 6, sum: 12, rerollRound: 0 },
    });
    expect(presentation(room).ceremonyDice).toEqual(phase === 'result' ? { d1: 4, d2: 5, sum: 9 } : null);
    expectReentrySnapshot(room, conns);
  });

  it('同点汇总重入保留真实骰面与待重掷队列，不重新采样', () => {
    const { room, conns } = setup();
    stubFaces(2, 6, 5, 3, 4, 1, 6, 6);
    room.start('u0');
    for (const u of ['u0', 'u1', 'u2']) rollAndWait(room, u);
    room.handleRoll('u3', tokenOf(room));
    vi.advanceTimersByTime(CEREMONY_MS.rolling + CEREMONY_MS.result);
    expect(presentation(room)).toMatchObject({ phase: 'summary', summaryKind: 'reroll', pendingRollUserIds: ['u0', 'u1'] });
    expect(presentation(room).resultsByUserId.u0).toEqual({ d1: 2, d2: 6, sum: 8, rerollRound: 0 });
    expect(presentation(room).resultsByUserId.u1).toEqual({ d1: 5, d2: 3, sum: 8, rerollRound: 0 });
    expectReentrySnapshot(room, conns);
  });

  it.each([1000, 9700])('输入已过%dms掉线：剩余等待最多600ms且重连不延期', (elapsed) => {
    const { room } = setup();
    stubDice(7);
    room.start('u0');
    const before = presentation(room);
    vi.advanceTimersByTime(elapsed);
    room.playerDisconnected('u0');
    const shortened = presentation(room);
    expect(shortened.deadline).toBe(Math.min(before.deadline, Date.now() + 600));
    expect(shortened.stepId).toBe(before.stepId);
    room.addPlayer('u0', new MockConn('u0'));
    expect(presentation(room).deadline).toBe(shortened.deadline);
    vi.advanceTimersByTime(shortened.deadline - Date.now());
    expect(presentation(room).phase).toBe('rolling');
  });

  it('仪式掉线未重连：各真人沿原离线时间接续托管，重复掉线不延期，离线首庄继续出牌', () => {
    const hooks = gameHooks();
    const { room } = setup(undefined, 60_000, hooks);
    stubDice(5, 9, 7, 12, 4);
    room.start('u0');
    const offlineAt = Date.now();
    room.playerDisconnected('u0');
    vi.advanceTimersByTime(100);
    room.playerDisconnected('u1');
    vi.advanceTimersByTime(200);
    room.playerDisconnected('u0');
    expect(room['offlineSince'].get('u0')).toBe(offlineAt);
    expect(room['trusteeTimers'].size).toBe(0);
    vi.advanceTimersByTime(299);
    expect(presentation(room).phase).toBe('input');
    vi.advanceTimersByTime(1);
    expect(presentation(room).phase).toBe('rolling');
    vi.advanceTimersByTime(CEREMONY_MS.rolling + CEREMONY_MS.result);
    expect(presentation(room).actor!.userId).toBe('u1');
    expect(presentation(room).deadline - Date.now()).toBe(CEREMONY_MS.auto);
    vi.advanceTimersByTime(CEREMONY_MS.auto + CEREMONY_MS.rolling + CEREMONY_MS.result);
    rollAndWait(room, 'u2');
    rollAndWait(room, 'u3');
    pickAndWait(room, 'u3', 1);
    rollAndWait(room, 'u3');
    expect(room.phase).toBe('playing');
    expect(room.getState()!.dealerSeat).toBe(room.seatOfUser('u0'));
    expect(room.getState()!.discards).toEqual([]);
    const pending = new Map(room['trusteeTimers']);
    expect([...pending.keys()].sort()).toEqual(['u0', 'u1']);
    vi.advanceTimersByTime(1000);
    for (const u of ['u0', 'u1']) {
      room.playerDisconnected(u);
      expect(room['trusteeTimers'].get(u)).toBe(pending.get(u));
    }
    vi.advanceTimersByTime(offlineAt + 60_000 - Date.now() - 1);
    expect(room.roomView().seats.filter((s) => s?.trusteed)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(room.roomView().seats[room.seatOfUser('u0')!]!.trusteed).toBe(true);
    expect(room.roomView().seats[room.seatOfUser('u1')!]!.offline).toBe(true);
    const trustee = room['connOf'].get('u0');
    room.playerDisconnected('u0');
    expect(room['connOf'].get('u0')).toBe(trustee);
    vi.advanceTimersByTime(99);
    expect(room.roomView().seats[room.seatOfUser('u1')!]!.trusteed).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(room.roomView().seats[room.seatOfUser('u1')!]!.trusteed).toBe(true);
    expect(room['trusteeTimers'].size).toBe(0);
    vi.advanceTimersByTime(300);
    expect(room.getState()!.discards).toHaveLength(1);
    expect(room.getState()!.discards[0]!.seat).toBe(room.seatOfUser('u0'));
    expect(room.getState()!.players.map((p) => p.zi)).toEqual([1, 1, 0, 0]);
    expect(hooks.onGameStart).toHaveBeenCalledTimes(1);
    expect(hooks.onSeating).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Math.random)).toHaveBeenCalledTimes(10);
  });

  it.each([50, 4800])('托管阈值%dms：首局收尾已到期则立即接管，不缩短展示、不重复发牌计子', (trusteeAfterMs) => {
    const hooks = gameHooks();
    const { room } = setup(undefined, trusteeAfterMs, hooks);
    stubDice(5, 9, 7, 12, 9);
    room.start('u0');
    rollFour(room);
    pickAndWait(room, 'u3', 1);
    room.playerDisconnected('u3');
    vi.advanceTimersByTime(CEREMONY_MS.auto - 1);
    expect(presentation(room).phase).toBe('input');
    vi.advanceTimersByTime(1);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    vi.advanceTimersByTime(CEREMONY_MS.rolling);
    const obsolete = timers.mock.calls.at(-1)![0] as () => void;
    expect(presentation(room).ceremonyDice).toEqual({ d1: 6, d2: 3, sum: 9 });
    vi.advanceTimersByTime(CEREMONY_MS.final - 1);
    expect(room.getState()).toBeNull();
    expect(room['trusteeOf'].size).toBe(0);
    expect(hooks.onGameStart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    const dealt = room.getState()!;
    expect(dealt.players.map((p) => p.zi)).toEqual([0, 2, 0, 0]);
    vi.advanceTimersByTime(1);
    expect(room.roomView().seats[1]!.trusteed).toBe(true);
    expect(room['trusteeTimers'].size).toBe(0);
    obsolete();
    obsolete();
    expect(room.getState()).toBe(dealt);
    expect(hooks.onGameStart).toHaveBeenCalledTimes(1);
    expect(hooks.onSeating).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Math.random)).toHaveBeenCalledTimes(10);
    vi.advanceTimersByTime(400);
    expect(room.getState()!.discards).toHaveLength(1);
    expect(room.getState()!.discards[0]!.seat).toBe(1);
  });

  it.each(['seating', 'playing', 'trusteed'] as const)('%s 时重连接管取消跨仪式离线等待或托管', (phase) => {
    const { room } = setup();
    stubDice(5, 9, 7, 12, 9);
    room.start('u0');
    rollFour(room);
    pickAndWait(room, 'u3', 1);
    room.playerDisconnected('u1');
    const offlineAt = Date.now();
    if (phase !== 'seating') {
      rollAndWait(room, 'u3');
      expect(room['trusteeTimers'].has('u1')).toBe(true);
      if (phase === 'trusteed') {
        vi.advanceTimersByTime(offlineAt + 60_000 - Date.now());
        expect(room.roomView().seats[2]!.trusteed).toBe(true);
      }
    }
    const conn = new MockConn('u1');
    expect(room.addPlayer('u1', conn).ok).toBe(true);
    expect(room['trusteeTimers'].has('u1')).toBe(false);
    expect(room['offlineSince'].has('u1')).toBe(false);
    expect(room['trusteeOf'].has('u1')).toBe(false);
    if (phase === 'seating') rollAndWait(room, 'u3');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(room['connOf'].get('u1')).toBe(conn);
    expect(room.roomView().seats[2]!.trusteed).toBeUndefined();
    expect(room.getState()!.discards).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('仪式中离线 Bot 仍按600ms代掷，但首局不为其建立真人托管等待', () => {
    const room = new RoomActor('333333', 'u0', 8, 42, undefined, { trusteeAfterMs: 1 });
    rooms.push(room);
    for (const u of ['u0', 'u1', 'u2', 'bot-3']) room.addPlayer(u, new MockConn(u));
    stubDice(12, 9, 7, 5, 9);
    room.start('u0');
    room.playerDisconnected('bot-3');
    for (const u of ['u0', 'u1', 'u2']) rollAndWait(room, u);
    expect(presentation(room).deadline - Date.now()).toBe(CEREMONY_MS.auto);
    vi.advanceTimersByTime(CEREMONY_MS.auto + CEREMONY_MS.rolling + CEREMONY_MS.result + CEREMONY_MS.summary);
    pickAndWait(room, 'u0', 0);
    rollAndWait(room, 'u0');
    expectOwnTimersCleared(room);
    vi.advanceTimersByTime(1);
    expect(room['trusteeOf'].size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['input', 'rolling', 'result', 'summary', 'trustee'] as const)('dispose 清空%s自有计时：字段归空、立即零计时，推进时间及旧回调无副作用', (phase) => {
    const { room, conns } = setup();
    stubDice(5, 9, 7, 12, 9);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    room.start('u0');
    if (phase === 'summary') {
      for (const u of ['u0', 'u1', 'u2']) rollAndWait(room, u);
      room.handleRoll('u3', tokenOf(room));
      vi.advanceTimersByTime(CEREMONY_MS.rolling + CEREMONY_MS.result);
    } else if (phase === 'trustee') {
      rollFour(room);
      pickAndWait(room, 'u3', 1);
      rollAndWait(room, 'u3');
      room.playerDisconnected('u1');
      expect(room['trusteeTimers'].size).toBe(1);
    } else if (phase !== 'input') {
      room.handleRoll('u0', tokenOf(room));
      if (phase === 'result') vi.advanceTimersByTime(CEREMONY_MS.rolling);
    }
    if (phase !== 'trustee') expect(presentation(room).phase).toBe(phase);
    expect(vi.getTimerCount()).toBe(1);
    const obsolete = timers.mock.calls.at(-1)![0] as () => void;
    const state = room.getState();
    const counts = conns.map((c) => c.sent.length);
    room.dispose();
    expectOwnTimersCleared(room);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    obsolete();
    expect(vi.getTimerCount()).toBe(0);
    expectOwnTimersCleared(room);
    expect(room.phase).toBe('finished');
    expect(room.getState()).toBe(state);
    expect(room.roomView().seating).toBeUndefined();
    expect(conns.map((c) => c.sent.length)).toEqual(counts);
  });

  it('晚触发回调独立起算下一段；已取消回调不能推进后续步骤或已回收房间', () => {
    const { room } = setup();
    stubDice(7);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    room.start('u0');
    const obsolete = timers.mock.calls.at(-1)![0] as () => void;
    room.handleRoll('u0', tokenOf(room));
    const rolling = presentation(room);
    obsolete();
    expect(presentation(room)).toEqual(rolling);
    const reveal = timers.mock.calls.at(-1)![0] as () => void;
    vi.setSystemTime(rolling.deadline + 5000);
    reveal();
    expect(presentation(room).phase).toBe('result');
    expect(presentation(room).deadline - Date.now()).toBe(2000);
    const result = presentation(room);
    reveal();
    expect(presentation(room)).toEqual(result);
    const advance = timers.mock.calls.at(-1)![0] as () => void;
    room.dispose();
    advance();
    obsolete();
    expect(room.phase).toBe('finished');
    expect(room.getState()).toBeNull();
    expect(room.roomView().seating).toBeUndefined();
  });
});

describe('BL-017 · 局间摸牌位骰 roundBreak（FR-对局-20）', () => {
  /** 快速打到局末：连续摸打直到 settled/exhaustive */
  function driveToEnd(room: RoomActor): void {
    const seatOf = new Map<number, string>();
    for (const s of room.roomView().seats) if (s) seatOf.set(s.seat, s.userId);
    for (let i = 0; i < 400; i++) {
      const st = room.getState();
      if (!st) return;
      if (st.phase === 'settled' || st.phase === 'exhaustive') return;
      const seat = st.currentSeat;
      const u = seatOf.get(seat)!;
      if (st.phase === 'draw') room.handleAction(u, { type: 'draw', seat });
      else if (st.phase === 'discard') {
        const tile = Object.keys(st.players.find((p) => p.seat === seat)!.concealed)[0];
        if (!tile) return;
        room.handleAction(u, { type: 'discard', seat, tile });
      } else {
        // 响应期一律 pass
        for (let s = 0; s < 4; s++) {
          if (st.pending[s] === null) {
            const uu = seatOf.get(s);
            if (uu) room.handleAction(uu, { type: 'respond', seat: s, move: 'pass' });
          }
        }
      }
    }
  }

  it('breakDice=true：nextRound → roundBreak，新局钩子只调用一次且旧结束回调无效', () => {
    const hooks = gameHooks();
    const { room } = setup({ wallMode: 'physical', breakDice: true }, 60_000, hooks);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    stubDice(5, 9, 7, 12, 7); // 仪式：庄 seat3，首局 break=7（合并流程）
    room.start('u0');
    rollFour(room);
    pickAndWait(room, 'u3', 1);
    rollAndWait(room, 'u3'); // 定庄摸牌位骰（A=u3，N=7 → 庄=seat3，breakN=7）
    expect(room.getState()!.breakGroups).toBe(7);
    driveToEnd(room);
    // 局末庄家已轮换（非连庄时 = 下家）
    const nextDealer = room.getState()!.dealerSeat;
    expect(room.nextRound('u0').ok).toBe(true);
    const sv = room.roomView().seating!;
    expect(sv.stage).toBe('roundBreak');
    expect(sv.roller).toBe(nextDealer);
    // roundBreak 期间 nextRound 被拒
    expect(room.nextRound('u0').ok).toBe(false);
    stubDice(11);
    const rollerUser = room.roomView().seats[nextDealer]!.userId;
    expect(room.handleRoll(rollerUser, tokenOf(room)).ok).toBe(true);
    expect(presentation(room).ceremonyDice).toBeNull();
    const oldState = room.getState();
    vi.advanceTimersByTime(1199);
    expect(room.getState()).toBe(oldState);
    vi.advanceTimersByTime(1);
    expect(presentation(room).ceremonyDice).toEqual({ d1: 6, d2: 5, sum: 11 });
    const resultToken = tokenOf(room);
    const obsolete = timers.mock.calls.at(-1)![0] as () => void;
    expect(room.handleRoll(rollerUser, resultToken).ok).toBe(false);
    expect(room.nextRound('u0').ok).toBe(false);
    expect(hooks.onGameStart).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2999);
    expect(room.getState()).toBe(oldState);
    vi.advanceTimersByTime(1);
    expect(room.roomView().seating).toBeUndefined();
    const st2 = room.getState()!;
    expect(st2.round).toBe(2);
    expect(st2.breakGroups).toBe(11);
    expect(st2.dealerSeat).toBe(nextDealer);
    expect(st2.layout).toBeTruthy(); // physical：新局新墙
    expect(hooks.onGameStart).toHaveBeenCalledTimes(2);
    expect(hooks.onGameStart.mock.calls.map((args) => [args[4], args[5]])).toEqual([[42, 1], [43, 2]]);
    expect(hooks.onSeating).toHaveBeenCalledTimes(1);
    obsolete();
    expect(room.getState()).toBe(st2);
    expect(hooks.onGameStart).toHaveBeenCalledTimes(2);
    driveToEnd(room);
    expect(room.nextRound('u0').ok).toBe(true);
    const next = presentation(room);
    const ended = room.getState();
    expect(next.ceremonyId).not.toBe(resultToken.ceremonyId);
    obsolete();
    expect(presentation(room)).toEqual(next);
    expect(room.getState()).toBe(ended);
    expect(hooks.onGameStart).toHaveBeenCalledTimes(2);
  });

  it.each(['input', 'rolling', 'result'] as const)('局间%s重入 gameView 快照保留真实骰面、期限和步骤，不发牌计子', (phase) => {
    const hooks = gameHooks();
    const { room, conns } = setup({ breakDice: true }, 60_000, hooks);
    stubDice(5, 9, 7, 12, 7);
    room.start('u0');
    rollFour(room);
    pickAndWait(room, 'u3', 1);
    rollAndWait(room, 'u3');
    driveToEnd(room);
    room.nextRound('u0');
    stubFaces(3, 6);
    if (phase !== 'input') room.handleRoll(presentation(room).actor!.userId, tokenOf(room));
    if (phase === 'result') vi.advanceTimersByTime(CEREMONY_MS.rolling);
    expect(presentation(room).phase).toBe(phase);
    expect(presentation(room).ceremonyDice).toEqual(phase === 'result' ? { d1: 3, d2: 6, sum: 9 } : null);
    const state = structuredClone(room.getState());
    expectReentrySnapshot(room, conns);
    expect(room.getState()).toEqual(state);
    expect(hooks.onGameStart).toHaveBeenCalledTimes(1);
  });

  it.each(['input', 'rolling', 'result'] as const)('局间%s期解散后旧计时回调不能建局或重复广播', (phase) => {
    const { room, conns } = setup({ breakDice: true });
    stubDice(5, 9, 7, 12, 7, 9);
    room.start('u0');
    const previous = tokenOf(room);
    rollFour(room);
    pickAndWait(room, 'u3', 1);
    rollAndWait(room, 'u3');
    driveToEnd(room);
    const oldState = room.getState();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    room.nextRound('u0');
    const current = presentation(room);
    expect(current.ceremonyId).not.toBe(previous.ceremonyId);
    expect(room.handleRoll(current.actor!.userId, previous).ok).toBe(false);
    if (phase !== 'input') {
      room.handleRoll(current.actor!.userId, tokenOf(room));
      if (phase === 'result') vi.advanceTimersByTime(1200);
    }
    const advance = timers.mock.calls.at(-1)![0] as () => void;
    room.playerDisconnected('u1');
    const offline = timers.mock.calls.at(-1)![0] as () => void;
    expect(room['trusteeTimers'].size).toBe(1);
    expect(vi.getTimerCount()).toBe(2);
    expect(room.dissolve('u0').ok).toBe(true);
    expectOwnTimersCleared(room);
    expect(vi.getTimerCount()).toBe(0);
    const count = conns[0]!.sent.length;
    advance();
    offline();
    vi.advanceTimersByTime(120_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(room.phase).toBe('finished');
    expect(room.getState()).toBe(oldState);
    expect(room.roomView().seating).toBeUndefined();
    expect(conns[0]!.sent).toHaveLength(count);
    expect(conns[0]!.sent.filter((m) => m.t === 'roomEnd')).toHaveLength(1);
  });

  it('局间输入转托管最多等待600ms，展示期间掉线不缩短结果期', () => {
    const { room } = setup({ breakDice: true }, 50);
    stubDice(5, 9, 7, 12, 7, 9);
    room.start('u0');
    rollFour(room);
    pickAndWait(room, 'u3', 1);
    rollAndWait(room, 'u3');
    driveToEnd(room);
    room.nextRound('u0');
    const actor = presentation(room).actor!;
    room.playerDisconnected(actor.userId);
    const deadline = presentation(room).deadline;
    vi.advanceTimersByTime(50);
    expect(room.roomView().seats[actor.seat]!.trusteed).toBe(true);
    expect(presentation(room).deadline).toBe(deadline);
    vi.advanceTimersByTime(550);
    expect(presentation(room).phase).toBe('rolling');
    vi.advanceTimersByTime(1200);
    const result = presentation(room);
    room.playerDisconnected(actor.userId);
    expect(presentation(room).deadline).toBe(result.deadline);
    room.addPlayer(actor.userId, new MockConn(actor.userId));
    expect(presentation(room).deadline).toBe(result.deadline);
    vi.advanceTimersByTime(2999);
    expect(room.getState()!.round).toBe(1);
    vi.advanceTimersByTime(1);
    expect(room.getState()!.round).toBe(2);
  });

  it('breakDice=false：nextRound 直接开新局，无摸牌位骰', () => {
    const { room } = setup({ wallMode: 'random', breakDice: false });
    stubDice(5, 9, 7, 12, 7);
    room.start('u0');
    rollFour(room);
    pickAndWait(room, 'u3', 1);
    rollAndWait(room, 'u3');
    driveToEnd(room);
    expect(room.nextRound('u0').ok).toBe(true);
    expect(room.roomView().seating).toBeUndefined();
    expect(room.getState()!.round).toBe(2);
  });
});
