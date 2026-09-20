import { describe, it, expect, afterEach } from 'vitest';
import { RoomActor } from '../src/roomActor';
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
    this.sent.push(msg);
  }
  close(): void {}
}

/** 骰子队列 stub：替换 RoomActor.roll2d6 保证测试确定性 */
const realRoll = (RoomActor as unknown as { roll2d6: () => number }).roll2d6;
let diceQueue: number[] = [];
function stubDice(...vals: number[]): void {
  diceQueue = [...vals];
  (RoomActor as unknown as { roll2d6: () => number }).roll2d6 = () => {
    if (!diceQueue.length) throw new Error('骰子队列耗尽');
    return diceQueue.shift()!;
  };
}
afterEach(() => {
  (RoomActor as unknown as { roll2d6: () => number }).roll2d6 = realRoll;
});

function setup(settings?: RoomSettings) {
  const conns = ['u0', 'u1', 'u2', 'u3'].map((u) => new MockConn(u));
  const room = new RoomActor('654321', 'u0', 8, 42, undefined, { trusteeAfterMs: 60_000 }, settings);
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
    expect(room.handleRoll('u0').ok).toBe(true);
    expect(room.handleRoll('u0').ok).toBe(false); // 已掷过
    room.handleRoll('u1');
    room.handleRoll('u2');
    const svMid = room.roomView().seating!;
    expect(svMid.stage).toBe('roll');
    room.handleRoll('u3'); // 齐 → 定顺位
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
    for (const u of ['u0', 'u1', 'u2', 'u3']) room.handleRoll(u);
    let sv = room.roomView().seating!;
    expect(sv.stage).toBe('roll');
    expect(sv.reroll).toEqual([true, true, false, false]);
    expect(sv.rolls).toEqual([null, null, 5, 12]);
    room.handleRoll('u0');
    room.handleRoll('u1');
    sv = room.roomView().seating!;
    expect(sv.stage).toBe('pick');
    expect(sv.order).toEqual([3, 0, 1, 2]); // 12 > 9 > 7 > 5
  });

  it('选座重排：A 选座后其余按点数序依次坐下手，视图随座位重索引', () => {
    const { room } = setup();
    stubDice(5, 9, 7, 12, 9); // 选位骰 + 定庄骰 N=9
    room.start('u0');
    for (const u of ['u0', 'u1', 'u2', 'u3']) room.handleRoll(u);
    expect(room.roomView().seating!.picker).toBe(3); // u3 最大
    expect(room.handlePickSeat('u0', 1).ok).toBe(false); // 非选位最大者
    expect(room.handlePickSeat('u3', 1).ok).toBe(true); // u3 选 seat1
    // 点数序 [u3, u1, u2, u0] → 自 seat1 起依次 1,2,3,0
    const seats = room.roomView().seats.map((s) => s?.userId);
    expect(seats).toEqual(['u0', 'u3', 'u1', 'u2']);
    const sv = room.roomView().seating!;
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
      for (const u of ['u0', 'u1', 'u2', 'u3']) room.handleRoll(u);
      room.handlePickSeat('u3', 1);
      room.handleRoll('u3');
      expect(room.roomView().seating).toBeUndefined(); // breakDice=false → 直接发牌
      expect(room.phase).toBe('playing');
      expect(room.getState()!.dealerSeat, `N=${n}`).toBe(expectDealer);
    }
  });

  it('仪式收尾：A 上 1 子 + 首庄庄子；首庄非 A 时两家分别计子', () => {
    const { room } = setup();
    stubDice(5, 9, 7, 12, 7); // A=u3(seat1)，N=7 → 庄=seat3
    room.start('u0');
    for (const u of ['u0', 'u1', 'u2', 'u3']) room.handleRoll(u);
    room.handlePickSeat('u3', 1);
    room.handleRoll('u3');
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
    for (const u of ['u0', 'u1', 'u2', 'u3']) room.handleRoll(u);
    room.handlePickSeat('u3', 2); // A 选 seat2
    room.handleRoll('u3');
    const st = room.getState()!;
    expect(st.dealerSeat).toBe(2);
    expect(st.players.find((p) => p.seat === 2)!.zi).toBe(2); // 1 子 + 1 庄子
  });

  it('breakDice=true：开局仪式一掷同时定庄+定开牌点（合并流程 2026-09-19）', () => {
    const { room } = setup({ wallMode: 'physical', breakDice: true });
    stubDice(5, 9, 7, 12, 7); // A=u3(seat1)，N=7 → 庄=seat3，breakN=7
    room.start('u0');
    for (const u of ['u0', 'u1', 'u2', 'u3']) room.handleRoll(u);
    room.handlePickSeat('u3', 1);
    room.handleRoll('u3'); // 定庄摸牌位骰（A=u3，一掷定庄+开牌点）
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
    for (const u of ['u0', 'u1', 'u2', 'u3']) room.handleRoll(u);
    room.handlePickSeat('u3', 1);
    room.handleRoll('u3');
    const gv = conns[0]!.sent.filter((m): m is Extract<ServerMsg, { t: 'gameView' }> => m.t === 'gameView').pop();
    expect(gv!.view.wallInfo).toBeTruthy();
    expect(gv!.view.wallInfo!.rows.length).toBe(4);

    const { room: room2, conns: conns2 } = setup({ wallMode: 'random', breakDice: false });
    stubDice(5, 9, 7, 12, 7);
    room2.start('u0');
    for (const u of ['u0', 'u1', 'u2', 'u3']) room2.handleRoll(u);
    room2.handlePickSeat('u3', 1);
    room2.handleRoll('u3');
    const gv2 = conns2[0]!.sent.filter((m): m is Extract<ServerMsg, { t: 'gameView' }> => m.t === 'gameView').pop();
    expect(gv2!.view.wallInfo ?? null).toBeNull();
  });

  it('仪式结束后 roomView 不再携带 seating（客户端关闭仪式 UI）', () => {
    const { room } = setup();
    stubDice(5, 9, 7, 12, 7);
    room.start('u0');
    for (const u of ['u0', 'u1', 'u2', 'u3']) room.handleRoll(u);
    room.handlePickSeat('u3', 1);
    room.handleRoll('u3');
    expect(room.roomView().seating).toBeUndefined();
    expect(room.roomView().phase).toBe('playing');
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

  it('breakDice=true：nextRound → roundBreak，掷骰者为轮换后庄家；掷后开新局带新 breakGroups', () => {
    const { room } = setup({ wallMode: 'physical', breakDice: true });
    stubDice(5, 9, 7, 12, 7); // 仪式：庄 seat3，首局 break=7（合并流程）
    room.start('u0');
    for (const u of ['u0', 'u1', 'u2', 'u3']) room.handleRoll(u);
    room.handlePickSeat('u3', 1);
    room.handleRoll('u3'); // 定庄摸牌位骰（A=u3，N=7 → 庄=seat3，breakN=7）
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
    expect(room.handleRoll(rollerUser).ok).toBe(true);
    expect(room.roomView().seating).toBeUndefined();
    const st2 = room.getState()!;
    expect(st2.round).toBe(2);
    expect(st2.breakGroups).toBe(11);
    expect(st2.dealerSeat).toBe(nextDealer);
    expect(st2.layout).toBeTruthy(); // physical：新局新墙
  });

  it('breakDice=false：nextRound 直接开新局，无摸牌位骰', () => {
    const { room } = setup({ wallMode: 'random', breakDice: false });
    stubDice(5, 9, 7, 12, 7);
    room.start('u0');
    for (const u of ['u0', 'u1', 'u2', 'u3']) room.handleRoll(u);
    room.handlePickSeat('u3', 1);
    room.handleRoll('u3');
    driveToEnd(room);
    expect(room.nextRound('u0').ok).toBe(true);
    expect(room.roomView().seating).toBeUndefined();
    expect(room.getState()!.round).toBe(2);
  });
});
