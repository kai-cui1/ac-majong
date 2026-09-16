import type { TableState, Action, GameEvent, ActionKind } from '@ac-majong/engine';
import { createTable, applyAction, startNextRound, legalActions } from '@ac-majong/engine';
import type { RoomView, RoomPhase } from '@ac-majong/protocol';
import type { Connection } from './connection';
import { redact } from './redact';

export interface OpResult {
  ok: boolean;
  seat?: number;
  reason?: string;
}

/** action → legalActions 的 ActionKind 映射（服务端权威合法性校验） */
function actionKind(action: Action): ActionKind | null {
  switch (action.type) {
    case 'draw':
      return 'draw';
    case 'discard':
      return 'discard';
    case 'declareWin':
      return 'win_draw';
    case 'kongConcealed':
      return 'kong_concealed';
    case 'kongAdded':
      return 'kong_added';
    case 'respond':
      return action.move === 'win'
        ? 'win_discard'
        : action.move === 'pong'
          ? 'pong'
          : action.move === 'kong_exposed'
            ? 'kong_exposed'
            : action.move === 'chi'
              ? 'chi'
              : 'pass';
    default:
      return null;
  }
}

/**
 * 单房间权威状态机。Node 事件循环天然串行处理消息，故方法为同步（无异步 IO）。
 * 若后续加入 Redis 快照等异步操作，再引入串行队列。
 */
export class RoomActor {
  readonly id: string;
  readonly hostUserId: string;
  readonly maxRounds: number;
  phase: RoomPhase = 'waiting';
  private state: TableState | null = null;
  private seatOf = new Map<string, number>();
  private userAtSeat: (string | null)[] = [null, null, null, null];
  private connOf = new Map<string, Connection>();
  private seed: number;

  constructor(id: string, hostUserId: string, maxRounds: number, seed: number) {
    this.id = id;
    this.hostUserId = hostUserId;
    this.maxRounds = maxRounds;
    this.seed = seed;
  }

  getState(): TableState | null {
    return this.state;
  }
  seatOfUser(userId: string): number | undefined {
    return this.seatOf.get(userId);
  }
  playerCount(): number {
    return this.seatOf.size;
  }

  roomView(): RoomView {
    return {
      room: this.id,
      phase: this.phase,
      hostUserId: this.hostUserId,
      maxRounds: this.maxRounds,
      seats: this.userAtSeat.map((u, seat) => (u ? { userId: u, seat } : null)),
    };
  }

  addPlayer(userId: string, conn: Connection): OpResult {
    this.connOf.set(userId, conn);
    const existing = this.seatOf.get(userId);
    if (existing != null) {
      this.broadcastAll(); // 重连
      return { ok: true, seat: existing };
    }
    if (this.phase !== 'waiting') return { ok: false, reason: '房间已开始' };
    const seat = this.userAtSeat.indexOf(null);
    if (seat < 0) return { ok: false, reason: '房间已满' };
    this.seatOf.set(userId, seat);
    this.userAtSeat[seat] = userId;
    this.broadcastAll();
    return { ok: true, seat };
  }

  removePlayer(userId: string): void {
    this.connOf.delete(userId); // 座位保留以支持重连
    this.broadcastAll();
  }

  start(byUserId: string): OpResult {
    if (this.phase !== 'waiting') return { ok: false, reason: '已开始' };
    if (byUserId !== this.hostUserId) return { ok: false, reason: '仅房主可开始' };
    if (this.seatOf.size < 4) return { ok: false, reason: '需满 4 人' };
    this.state = createTable(0, this.seed++);
    this.phase = 'playing';
    this.broadcastGame();
    return { ok: true };
  }

  handleAction(userId: string, action: Action): OpResult {
    if (this.phase !== 'playing' || !this.state) return { ok: false, reason: '未在对局中' };
    const seat = this.seatOf.get(userId);
    if (seat == null) return { ok: false, reason: '不在房间' };
    if ('seat' in action && action.seat !== seat) return { ok: false, reason: '座位不符' };
    const kind = actionKind(action);
    if (kind && !legalActions(this.state, seat).includes(kind)) return { ok: false, reason: `非法操作:${kind}` };
    const { state, events } = applyAction(this.state, action);
    this.state = state;
    this.broadcastGame(events);
    return { ok: true };
  }

  /**
   * 开下一局（由客户端结算浮层驱动，取代旧的“局末即时自动续局”，让玩家有时间看结算）。
   * 相位守卫：仅当本局已结束（settled/exhaustive）才受理，天然防止重复推进。
   * 达到总局上限则置 finished。
   */
  nextRound(byUserId: string): OpResult {
    if (this.phase !== 'playing' || !this.state) return { ok: false, reason: '未在对局中' };
    if (this.seatOf.get(byUserId) == null) return { ok: false, reason: '不在房间' };
    const ph = this.state.phase;
    if (ph !== 'settled' && ph !== 'exhaustive') return { ok: false, reason: '本局尚未结束' };
    if (this.state.round >= this.maxRounds) {
      this.phase = 'finished';
      this.broadcastAll();
      return { ok: true };
    }
    this.state = startNextRound(this.state, this.seed++).state;
    this.broadcastGame();
    return { ok: true };
  }

  private broadcastGame(events?: GameEvent[]): void {
    if (!this.state) return;
    if (events && events.length) for (const c of this.connOf.values()) c.send({ t: 'event', events });
    for (const [userId, conn] of this.connOf) {
      const seat = this.seatOf.get(userId);
      if (seat == null) continue;
      conn.send({ t: 'gameView', view: redact(this.state, seat, this.id, this.maxRounds) });
    }
  }

  private broadcastAll(): void {
    if (this.phase === 'playing' && this.state) {
      this.broadcastGame();
      return;
    }
    const rv = this.roomView();
    for (const c of this.connOf.values()) c.send({ t: 'roomView', room: rv });
  }
}
