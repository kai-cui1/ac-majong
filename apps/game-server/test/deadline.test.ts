import { afterEach, describe, expect, it, vi } from 'vitest';
import { driveCeremony } from './ceremonyHelper';
import { RoomActor, normalizeRoomSettings } from '../src/roomActor';
import type { Connection } from '../src/connection';
import type { GameEvent, RoomSettings, ServerMsg } from '@ac-majong/protocol';

/** BL-032 服务端权威截止：回合窗摸切代打 / 响应窗自动过 / 建房时间档钳制 / 同窗不重置 */

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
const rooms: RoomActor[] = [];

function setup(hooks?: ConstructorParameters<typeof RoomActor>[4], settings?: Partial<RoomSettings>) {
  const conns = ['u0', 'u1', 'u2', 'u3'].map((u) => new MockConn(u));
  const room = new RoomActor('123456', 'u0', 8, 42, hooks, { trusteeAfterMs: 60_000, turnMs: 200, respMs: 200 }, {
    wallMode: 'random', breakDice: false, chiFirstView: true, isPublic: true, ...settings,
  });
  rooms.push(room);
  room.addPlayer('u0', conns[0]!);
  room.addPlayer('u1', conns[1]!);
  room.addPlayer('u2', conns[2]!);
  room.addPlayer('u3', conns[3]!);
  room.start('u0');
  driveCeremony(room);
  const seatOf = new Map<string, number>();
  for (const s of room.roomView().seats) if (s) seatOf.set(s.userId, s.seat);
  return { room, conns, seatOf };
}

const eventsOf = (conns: MockConn[]): GameEvent[] =>
  conns.flatMap((c) => c.sent).flatMap((m) => (m.t === 'event' ? m.events : []));
const viewsOf = (conns: MockConn[]) =>
  conns.flatMap((c) => c.sent).filter((m): m is Extract<ServerMsg, { t: 'gameView' }> => m.t === 'gameView');
const userAt = (seatOf: Map<string, number>, seat: number): string => [...seatOf.entries()].find(([, s]) => s === seat)![0];
/** 响应窗内逐家手动过（直至窗消解） */
function flushResp(room: RoomActor, seatOf: Map<string, number>): void {
  for (let i = 0; i < 8; i++) {
    const st = room.getState()!;
    if (st.phase !== 'response') return;
    let acted = false;
    for (const [s, p] of Object.entries(st.pending)) {
      if (p === null) { room.handleAction(userAt(seatOf, Number(s)), { type: 'respond', seat: Number(s), move: 'pass' }); acted = true; }
    }
    if (!acted) return;
  }
}
async function waitPhase(room: RoomActor, pred: (st: NonNullable<ReturnType<RoomActor['getState']>>) => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = room.getState();
    if (st && pred(st)) return;
    await sleep(10);
  }
  throw new Error('waitPhase 超时');
}
/** 首局庄家直接 discard 相位（发牌 17 张含摸牌）；推进到下一家 draw 窗 */
async function advanceToNextDraw(room: RoomActor, conns: MockConn[], seatOf: Map<string, number>, clear = true): Promise<number> {
  const st0 = room.getState()!;
  const dealer = st0.currentSeat;
  expect(st0.phase).toBe('discard');
  expect(room.handleAction(userAt(seatOf, dealer), { type: 'discard', seat: dealer, tile: Object.keys(st0.players[dealer]!.concealed)[0]! }).ok).toBe(true);
  flushResp(room, seatOf);
  if (clear) conns.forEach((c) => { c.sent.length = 0; }); // 清空捕获：draw 窗广播及后续断言只看向量
  await waitPhase(room, (s) => s.phase === 'draw');
  return room.getState()!.currentSeat;
}

afterEach(() => {
  while (rooms.length) rooms.pop()!.dispose();
  vi.restoreAllMocks();
});

describe('BL-032 建房时间档归一', () => {
  it('秒数钳到最近档位，缺省/非法回默认', () => {
    expect(normalizeRoomSettings({ turnSec: 12, respSec: 999 })).toMatchObject({ turnSec: 10, respSec: 15 });
    expect(normalizeRoomSettings({ turnSec: 17, respSec: 9 })).toMatchObject({ turnSec: 15, respSec: 8 });
    expect(normalizeRoomSettings({})).toMatchObject({ turnSec: 15, respSec: 8, wallMode: 'random', breakDice: false, chiFirstView: true, isPublic: true });
    expect(normalizeRoomSettings({ turnSec: 'x' as unknown as number, respSec: NaN })).toMatchObject({ turnSec: 15, respSec: 8 });
  });

  it('RoomActor 构造即归一（网关透传脏值亦安全）', () => {
    const { room } = setup(undefined, { turnSec: 12, respSec: 999 });
    expect(room.settings.turnSec).toBe(10);
    expect(room.settings.respSec).toBe(15);
  });
});

describe('BL-032 服务端权威截止', () => {
  it('gameView 带 serverNow 与回合窗 deadline（kind=turn）', async () => {
    const { room, conns } = setup();
    expect(room.getState()?.phase).toBe('discard'); // 首局庄家发牌即 discard 相位
    await sleep(60);
    const vs = viewsOf(conns);
    const last = vs[vs.length - 1]!;
    expect(typeof last.view.serverNow).toBe('number');
    expect(last.view.deadline).toMatchObject({ kind: 'turn' });
    expect(last.view.deadline!.totalMs).toBe(200);
  });

  it('回合窗超时：服务端代摸＋摸切代打（打出=刚摸），动作入事件流', async () => {
    const onGameAction = vi.fn();
    const { room, conns, seatOf } = setup({ onGameStart: vi.fn(), onGameAction, onGameEnd: vi.fn(), onRoomEnd: vi.fn() });
    const actor = await advanceToNextDraw(room, conns, seatOf);
    await sleep(450); // turnMs=200：代摸+代打一次到期完成
    const evs = eventsOf(conns);
    const drawn = evs.find((e) => e.type === 'drawn') as Extract<GameEvent, { type: 'drawn' }> | undefined;
    const discarded = evs.find((e) => e.type === 'discarded') as Extract<GameEvent, { type: 'discarded' }> | undefined;
    expect(drawn).toBeTruthy();
    expect(discarded).toBeTruthy();
    expect(discarded!.seat).toBe(actor);
    expect(discarded!.tile).toBe(drawn!.tile); // 摸切优先
    // 代打动作落库路径与真人一致（hooks.onGameAction 收到 discard）
    expect(onGameAction.mock.calls.some(([, , seat, a]) => seat === actor && (a as { type: string }).type === 'discard')).toBe(true);
  });

  it('同窗内状态广播不重置截止（draw→discard 同 deadline.at）', async () => {
    const { room, conns, seatOf } = setup();
    const actor = await advanceToNextDraw(room, conns, seatOf, false);
    const at1 = viewsOf(conns).at(-1)!.view.deadline!.at; // draw 窗视图
    expect(room.handleAction(userAt(seatOf, actor), { type: 'draw', seat: actor }).ok).toBe(true);
    const at2 = viewsOf(conns).at(-1)!.view.deadline!.at; // discard 窗视图
    expect(at2).toBe(at1); // 摸牌广播不换窗、不重置
  });

  it('响应窗超时：待响应家逐家自动过（pass 入事件流与落库），窗后正常推进', async () => {
    const onGameAction = vi.fn();
    const { room, conns, seatOf } = setup({ onGameStart: vi.fn(), onGameAction, onGameEnd: vi.fn(), onRoomEnd: vi.fn() });
    const actor = await advanceToNextDraw(room, conns, seatOf);
    const pongSeat = (actor + 1) % 4; // 碰家=任意他家（对碰牌 rig 到其手牌）
    // rig：牌墙顶置 W1（摸牌 shift 取顶）＋碰家暗牌加 W1×2（引擎不校验全局张数，仅测试编排用）
    const st = room.getState()!;
    st.wall[0] = 'W1';
    st.players[pongSeat]!.concealed['W1'] = (st.players[pongSeat]!.concealed['W1'] ?? 0) + 2;
    await sleep(700); // 回合窗200（代摸W1+摸切打W1）→ 响应窗200（自动过）→ 下一家回合窗
    const evs = eventsOf(conns);
    const drawn = evs.find((e) => e.type === 'drawn') as Extract<GameEvent, { type: 'drawn' }> | undefined;
    expect(drawn?.tile).toBe('W1');
    const need = evs.find((e) => e.type === 'responseNeeded') as Extract<GameEvent, { type: 'responseNeeded' }> | undefined;
    expect(need?.seats).toContain(pongSeat);
    // 无人 meld → 自动过后推进（后续各家 idle 继续被代打，相位可能已在更后窗口）
    expect(evs.some((e) => e.type === 'melded')).toBe(false);
    const drawnAll = evs.filter((e) => e.type === 'drawn');
    expect(drawnAll.length).toBeGreaterThanOrEqual(2); // W1 摸牌＋推进后下一家摸牌
    const st2 = room.getState()!;
    expect(st2.currentSeat).not.toBe(actor);
    // 自动过动作经落库路径（hooks 收到 pongSeat 的 respond pass）
    expect(onGameAction.mock.calls.some(([, , seat, a]) => seat === pongSeat && (a as { type: string }).type === 'respond' && (a as { move?: string }).move === 'pass')).toBe(true);
  });

  it('真人及时出牌后本家不再被代打（窗口被正常动作消解）', async () => {
    const { room, conns, seatOf } = setup();
    const st0 = room.getState()!;
    const dealer = st0.currentSeat;
    expect(room.handleAction(userAt(seatOf, dealer), { type: 'discard', seat: dealer, tile: Object.keys(st0.players[dealer]!.concealed)[0]! }).ok).toBe(true);
    flushResp(room, seatOf);
    conns.forEach((c) => { c.sent.length = 0; });
    await sleep(350); // 下一家 idle 会被代打（预期）；本家不应再出牌
    const evs = eventsOf(conns);
    expect(evs.filter((e) => e.type === 'discarded' && (e as { seat: number }).seat === dealer).length).toBe(0);
  });
});
