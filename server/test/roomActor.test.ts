import { describe, it, expect } from 'vitest';
import { RoomManager } from '../src/roomManager';
import type { RoomActor, GameHooks } from '../src/roomActor';
import type { Connection } from '../src/connection';
import type { ServerMsg, FinalStanding } from '@ac-majong/protocol';
import { legalActions, getPlayer } from '@ac-majong/engine';
import type { Action, TableState } from '@ac-majong/engine';

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

function setupRoomRounds(maxRounds: number, seed: number) {
  const rm = new RoomManager(seed);
  const conns = ['u0', 'u1', 'u2', 'u3'].map((u) => new MockConn(u));
  const room = rm.create('u0', conns[0]!, maxRounds);
  room.addPlayer('u1', conns[1]!);
  room.addPlayer('u2', conns[2]!);
  room.addPlayer('u3', conns[3]!);
  return { rm, conns, room };
}

/** 自动驱动器：每步选一个合法动作（响应一律 pass），把当前局跑到 settled/exhaustive */
function driveOne(s: TableState): Action | null {
  if (s.phase === 'settled' || s.phase === 'exhaustive') return null;
  if (s.phase === 'draw') return { type: 'draw', seat: s.currentSeat };
  if (s.phase === 'discard') {
    const tile = Object.keys(getPlayer(s, s.currentSeat).concealed)[0];
    return tile ? { type: 'discard', seat: s.currentSeat, tile } : null;
  }
  const seat = s.players.find((p) => s.pending[p.seat] === null && legalActions(s, p.seat).includes('pass'))?.seat;
  return seat != null ? { type: 'respond', seat, move: 'pass' } : null;
}

function driveRoomToEnd(room: RoomActor): void {
  const seatToUser = new Map<number, string>();
  for (const s of room.roomView().seats) if (s) seatToUser.set(s.seat, s.userId);
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

describe('RoomActor · 局数上限与「不限」', () => {
  it('maxRounds=1：首局结束后 nextRound → finished', () => {
    const { room } = setupRoomRounds(1, 20240916);
    room.start('u0');
    driveRoomToEnd(room);
    const ph = room.getState()!.phase;
    expect(ph === 'settled' || ph === 'exhaustive').toBe(true);
    expect(room.nextRound('u0').ok).toBe(true);
    expect(room.phase).toBe('finished'); // round(1) >= maxRounds(1)
  });

  it('maxRounds=0（不限）：首局结束后 nextRound 续局、不 finished', () => {
    const { room } = setupRoomRounds(0, 20240916);
    room.start('u0');
    driveRoomToEnd(room);
    expect(room.nextRound('u0').ok).toBe(true);
    expect(room.phase).toBe('playing'); // 不限 → 续局
    expect(room.getState()!.round).toBe(2); // 进入第 2 局
  });
});

describe('RoomActor · Bot 陪玩（FR-房间-08）', () => {
  it('房主 addBot(3) → 满 4 人、seats 标 isBot、房主 isBot=false', () => {
    const rm = new RoomManager(7);
    const room = rm.create('host', new MockConn('host'), 8);
    expect(room.addBot('host', 3).ok).toBe(true);
    expect(room.playerCount()).toBe(4);
    const view = room.roomView();
    expect(view.seats[0]).toMatchObject({ userId: 'host', isBot: false });
    expect(view.seats.filter((s) => s?.isBot).length).toBe(3);
    expect(view.seats.filter((s) => s != null).length).toBe(4);
  });

  it('非房主 addBot 被拒；房主 removeBot 移除 Bot 腾位、移除非Bot座位被拒', () => {
    const rm = new RoomManager(7);
    const room = rm.create('host', new MockConn('host'), 8);
    expect(room.addBot('other', 1).ok).toBe(false); // 非房主
    room.addBot('host', 1);
    expect(room.playerCount()).toBe(2);
    const botSeat = room.roomView().seats.findIndex((s) => s?.isBot);
    expect(botSeat).toBeGreaterThan(0);
    expect(room.removeBot('host', botSeat).ok).toBe(true); // 移除 Bot
    expect(room.playerCount()).toBe(1);
    expect(room.removeBot('host', 0).ok).toBe(false); // seat0=房主（非 Bot）
  });
});

describe('RoomActor · 对局落库钩子（GameHooks，M-E）', () => {
  it('start→onGameStart；打完一局→onGameAction 多次 + onGameEnd 一次', () => {
    const calls = { start: 0, action: 0, end: 0 };
    const hooks: GameHooks = {
      onGameStart: () => { calls.start++; },
      onGameAction: () => { calls.action++; },
      onGameEnd: () => { calls.end++; },
      onRoomEnd: () => {},
    };
    const rm = new RoomManager(20240916, hooks);
    const conns = ['u0', 'u1', 'u2', 'u3'].map((u) => new MockConn(u));
    const room = rm.create('u0', conns[0]!, 8);
    room.addPlayer('u1', conns[1]!);
    room.addPlayer('u2', conns[2]!);
    room.addPlayer('u3', conns[3]!);
    room.start('u0');
    expect(calls.start).toBe(1);
    driveRoomToEnd(room);
    expect(calls.action).toBeGreaterThan(10); // 一局多个动作
    expect(calls.end).toBe(1); // 局末一次
  });
});

const roomEndOf = (c: MockConn) => c.sent.filter((m): m is Extract<ServerMsg, { t: 'roomEnd' }> => m.t === 'roomEnd');

describe('RoomActor · 散场战绩（M-G）', () => {
  it('maxRounds=1 打满 → nextRound 触发 finishRoom：广播 roomEnd（4家 standings、零和积分、局数回顾）+ onRoomEnd 钩子', () => {
    let endCalls = 0;
    let lastStandings: FinalStanding[] = [];
    const hooks: GameHooks = {
      onGameStart: () => {}, onGameAction: () => {}, onGameEnd: () => {},
      onRoomEnd: (_rid, standings) => { endCalls++; lastStandings = standings; },
    };
    const rm = new RoomManager(20240916, hooks);
    const conns = ['u0', 'u1', 'u2', 'u3'].map((u) => new MockConn(u));
    const room = rm.create('u0', conns[0]!, 1);
    room.addPlayer('u1', conns[1]!);
    room.addPlayer('u2', conns[2]!);
    room.addPlayer('u3', conns[3]!);
    room.start('u0');
    driveRoomToEnd(room);
    expect(room.nextRound('u0').ok).toBe(true); // round(1) >= maxRounds(1) → 散场
    expect(room.phase).toBe('finished');
    expect(endCalls).toBe(1);
    expect(lastStandings.length).toBe(4);
    expect(lastStandings.reduce((a, s) => a + s.score, 0)).toBe(0); // 积分零和
    for (const c of conns) {
      const re = roomEndOf(c);
      expect(re.length).toBe(1);
      expect(re[0]!.reason).toBe('maxRounds');
      expect(re[0]!.rounds.length).toBe(1); // 打了 1 局
    }
  });

  it('dissolve：不限局数(maxRounds=0)房主本局结算后解散 → finished + roomEnd(reason=dissolve)；非房主/局中被拒', () => {
    const hooks: GameHooks = {
      onGameStart: () => {}, onGameAction: () => {}, onGameEnd: () => {}, onRoomEnd: () => {},
    };
    const rm = new RoomManager(20240916, hooks);
    const conns = ['u0', 'u1', 'u2', 'u3'].map((u) => new MockConn(u));
    const room = rm.create('u0', conns[0]!, 0); // 不限
    room.addPlayer('u1', conns[1]!);
    room.addPlayer('u2', conns[2]!);
    room.addPlayer('u3', conns[3]!);
    room.start('u0');
    expect(room.dissolve('u0').ok).toBe(false); // 局中（discard）不可解散
    driveRoomToEnd(room);
    expect(room.dissolve('u1').ok).toBe(false); // 非房主
    expect(room.dissolve('u0').ok).toBe(true); // 房主 + 本局已结算
    expect(room.phase).toBe('finished');
    const re = roomEndOf(conns[0]!);
    expect(re.length).toBe(1);
    expect(re[0]!.reason).toBe('dissolve');
  });

  it('不限局数续局不会散场：多局后 roundLog 逐局累积', () => {
    const rm = new RoomManager(20240916);
    const conns = ['u0', 'u1', 'u2', 'u3'].map((u) => new MockConn(u));
    const room = rm.create('u0', conns[0]!, 0);
    room.addPlayer('u1', conns[1]!);
    room.addPlayer('u2', conns[2]!);
    room.addPlayer('u3', conns[3]!);
    room.start('u0');
    driveRoomToEnd(room);
    expect(room.nextRound('u0').ok).toBe(true); // 不限 → 续局
    expect(room.phase).toBe('playing');
    driveRoomToEnd(room);
    expect(room.nextRound('u0').ok).toBe(true);
    expect(room.phase).toBe('playing'); // 仍不散场
    expect(roomEndOf(conns[0]!).length).toBe(0); // 未广播 roomEnd
  });
});
