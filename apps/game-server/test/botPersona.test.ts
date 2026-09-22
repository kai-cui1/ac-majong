import { describe, it, expect } from 'vitest';
import { RoomManager } from '../src/roomManager';
import type { Connection } from '../src/connection';
import type { RoomRestore } from '../src/roomActor';
import type { RoomMetaPatch } from '@ac-majong/persistence';
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
}

function setup() {
  const rm = new RoomManager(7);
  const host = new MockConn('u0');
  const room = rm.create('u0', host, 8);
  return { rm, room, host };
}

describe('BL-031 · Bot 打法 persona', () => {
  it('addBot 指定打法 → roomView 座位带 botPersona', () => {
    const { room } = setup();
    const r = room.addBot('u0', 1, 'efficiency-novice');
    expect(r.ok).toBe(true);
    const botSeat = room.roomView().seats.find((s) => s?.isBot);
    expect(botSeat?.botPersona).toBe('efficiency-novice');
  });
  it('addBot 不指定 → 默认最大概率打法', () => {
    const { room } = setup();
    room.addBot('u0', 1);
    const botSeat = room.roomView().seats.find((s) => s?.isBot);
    expect(botSeat?.botPersona).toBe('efficiency-normal');
  });
  it('房主可改已添加 Bot 打法；非房主拒绝', () => {
    const { room } = setup();
    room.addBot('u0', 1);
    const seat = room.roomView().seats.find((s) => s?.isBot)!.seat;
    expect(room.updateBotPersona('u0', seat, 'efficiency-novice').ok).toBe(true);
    expect(room.roomView().seats[seat]?.botPersona).toBe('efficiency-novice');
    // 非房主（u9 不在房）拒绝
    expect(room.updateBotPersona('u9', seat, 'efficiency-normal').ok).toBe(false);
  });
  it('锁定打法（P2+ 敬请期待）不可选', () => {
    const { room } = setup();
    room.addBot('u0', 1);
    const seat = room.roomView().seats.find((s) => s?.isBot)!.seat;
    expect(room.updateBotPersona('u0', seat, 'big-hand').ok).toBe(false);
    expect(room.addBot('u0', 1, 'monte-carlo').ok).toBe(false); // addBot 同样校验 available
  });
});

describe('FR-房间-12 · 等待页玩法集中修改 + 开局锁定', () => {
  it('开局前房主可改局数与玩法', () => {
    const { room } = setup();
    const r = room.updateRoom('u0', { maxRounds: 16, settings: { wallMode: 'random', breakDice: false } });
    expect(r.ok).toBe(true);
    expect(room.maxRounds).toBe(16);
    expect(room.settings.wallMode).toBe('random');
    expect(room.roomView().settings?.wallMode).toBe('random');
  });
  it('非房主拒绝修改', () => {
    const { room } = setup();
    expect(room.updateRoom('u9', { maxRounds: 4 }).ok).toBe(false);
  });
  it('开局后锁定不可改', () => {
    const { room } = setup();
    room.phase = 'playing'; // 模拟已开局
    const r = room.updateRoom('u0', { maxRounds: 4 });
    expect(r.ok).toBe(false);
    expect(room.maxRounds).toBe(8);
  });
});

describe('FR-AI-04/10 · 托管打法预设', () => {
  it('成员可预设托管打法；非成员/锁定打法拒绝', () => {
    const { rm, room } = setup();
    const guest = new MockConn('u1');
    room.addPlayer('u1', guest);
    expect(room.setTrusteePersona('u1', 'efficiency-normal').ok).toBe(true);
    expect(room.roomView().seats.find((s) => s?.userId === 'u1')?.trusteePersona).toBe('efficiency-normal');
    expect(room.setTrusteePersona('u9', 'efficiency-normal').ok).toBe(false);
    expect(room.setTrusteePersona('u1', 'balanced').ok).toBe(false); // 锁定档
    void rm;
  });
});

describe('FR-AI-11 · Bot 打法 / 托管预设持久化', () => {
  /** 捕获 onRoomMeta 落库 patch（模拟网关 fire-and-forget 写 rooms） */
  function setupHooked() {
    const patches: RoomMetaPatch[] = [];
    const rm = new RoomManager(7, { onRoomMeta: (_id, patch) => patches.push(patch) } as never);
    const host = new MockConn('u0');
    const room = rm.create('u0', host, 8);
    return { room, patches };
  }
  it('addBot / updateBotPersona 触发 botPersonas 落库', () => {
    const { room, patches } = setupHooked();
    room.addBot('u0', 1, 'efficiency-novice');
    expect(patches.at(-1)?.botPersonas).toEqual({ 1: 'efficiency-novice' });
    room.updateBotPersona('u0', 1, 'efficiency-normal');
    expect(patches.at(-1)?.botPersonas).toEqual({ 1: 'efficiency-normal' });
  });
  it('setTrusteePersona 触发 trusteePersonas 落库', () => {
    const { room, patches } = setupHooked();
    room.addPlayer('u1', new MockConn('u1'));
    room.setTrusteePersona('u1', 'efficiency-normal');
    expect(patches.at(-1)?.trusteePersonas).toEqual({ u1: 'efficiency-normal' });
  });
  it('updateRoom 触发 maxRounds + settings 落库（FR-房间-12）', () => {
    const { room, patches } = setupHooked();
    room.updateRoom('u0', { maxRounds: 16, settings: { wallMode: 'random' } });
    const last = patches.at(-1)!;
    expect(last.maxRounds).toBe(16);
    expect(last.settings?.wallMode).toBe('random');
  });
  it('重启重建：restore 载入 botPersonas / trusteePersonas → roomView 恢复', () => {
    const rm = new RoomManager(7);
    const restore: RoomRestore = {
      phase: 'waiting', state: null, gameId: null, gameSeq: 0, actionSeq: 0,
      seats: ['u0', 'bot-1', null, null], names: ['房主', '机器人1', null, null],
      roundLog: [], winCount: {},
      botPersonas: { 1: 'efficiency-novice' },
      trusteePersonas: { u0: 'efficiency-normal' },
    };
    const room = rm.createRestored('R1', 'u0', 8, restore);
    const view = room.roomView();
    expect(view.seats[1]?.botPersona).toBe('efficiency-novice');
    expect(view.seats[0]?.trusteePersona).toBe('efficiency-normal');
  });
});
