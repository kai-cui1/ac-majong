import type { TableState, Action, GameEvent, ActionKind, RoundSnapshot } from '@ac-majong/engine';
import { createTable, applyAction, startNextRound, legalActions, snapshotRound } from '@ac-majong/engine';
import type { RoomView, RoomPhase, FinalStanding, RoundReview, RoomEndReason } from '@ac-majong/protocol';
import type { Connection } from './connection';
import { redact } from './redact';
import { makeBotConnection } from './devBots';

export interface OpResult {
  ok: boolean;
  seat?: number;
  reason?: string;
}

/** 对局持久化钩子（网关注入，fire-and-forget 落库；RoomActor 保持同步、无异步 IO）。见持久化技术方案 §7 M-E。 */
export interface GameHooks {
  onGameStart(roomId: string, gameId: string, snap: RoundSnapshot, dealerSeat: number, seed: number, roundNo: number): void;
  onGameAction(gameId: string, seq: number, seat: number | null, action: Action): void;
  onGameEnd(gameId: string, endType: 'win' | 'exhaustive', result: unknown): void;
  /** 散场（打满上限/房主解散）：网关据此 closeRoom + rooms.final_score 落库（弱依赖）。见持久化技术方案 §7 M-G。 */
  onRoomEnd(roomId: string, standings: FinalStanding[], rounds: RoundReview[]): void;
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
  /** 各家展示昵称（by seat），供 ViewState.names 显示真实昵称（还原度） */
  private names: (string | null)[] = [null, null, null, null];
  private connOf = new Map<string, Connection>();
  private seed: number;
  private botSeq = 0;
  private hooks?: GameHooks;
  private gameId: string | null = null;
  private gameSeq = 0;
  private actionSeq = 0;
  /** 单局回顾 + 各家胡牌局数（散场战绩页用，独立于落库钩子累积） */
  private roundLog: RoundReview[] = [];
  private winCount: Record<number, number> = {};

  constructor(id: string, hostUserId: string, maxRounds: number, seed: number, hooks?: GameHooks) {
    this.id = id;
    this.hostUserId = hostUserId;
    this.maxRounds = maxRounds;
    this.seed = seed;
    this.hooks = hooks;
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
      seats: this.userAtSeat.map((u, seat) => (u ? { userId: u, seat, isBot: u.startsWith('bot-') } : null)),
    };
  }

  addPlayer(userId: string, conn: Connection, nickname?: string): OpResult {
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
    this.names[seat] = nickname ?? (userId.startsWith('bot-') ? '机器人' : userId);
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
    const seed = this.seed++;
    this.state = createTable(0, seed);
    this.phase = 'playing';
    this.beginGame(seed);
    this.broadcastGame();
    return { ok: true };
  }

  /** 开新局：生成 gameId + 快照落库（hooks 弱依赖，RoomActor 保持同步） */
  private beginGame(seed: number): void {
    if (!this.state || !this.hooks) return;
    this.gameSeq++;
    this.actionSeq = 0;
    this.gameId = `${this.id}-g${this.gameSeq}`;
    const snap = snapshotRound(this.state);
    this.hooks.onGameStart(this.id, this.gameId, snap, this.state.dealerSeat, seed, this.state.round);
  }

  /** 房主为空位放入 Bot 陪玩（FR-房间-08）：仅 waiting + 房主 + 有空位；Bot 计入满员 */
  addBot(byUserId: string, count = 1): OpResult {
    if (this.phase !== 'waiting') return { ok: false, reason: '已开始' };
    if (byUserId !== this.hostUserId) return { ok: false, reason: '仅房主可添加机器人' };
    let added = 0;
    for (let i = 0; i < count && this.playerCount() < 4; i++) {
      const n = ++this.botSeq;
      const botId = `bot-${n}`;
      this.addPlayer(botId, makeBotConnection(this, botId, 260 + i * 80), `机器人${n}`);
      added++;
    }
    if (added === 0) return { ok: false, reason: '无空位' };
    return { ok: true };
  }

  /** 房主移除一个 Bot（真人想加入时腾位，PRD 03 §3.1）：仅 waiting + 房主 + 该座位是 Bot */
  removeBot(byUserId: string, seat: number): OpResult {
    if (this.phase !== 'waiting') return { ok: false, reason: '已开始' };
    if (byUserId !== this.hostUserId) return { ok: false, reason: '仅房主可移除机器人' };
    const uid = this.userAtSeat[seat];
    if (!uid || !uid.startsWith('bot-')) return { ok: false, reason: '该座位不是机器人' };
    // 真正腾位（不同于 removePlayer 的「保留座位以支持重连」）：Bot 无需重连，直接清座位给真人
    this.seatOf.delete(uid);
    this.userAtSeat[seat] = null;
    this.connOf.get(uid)?.close();
    this.connOf.delete(uid);
    this.broadcastAll();
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
    this.recordAction(seat, action, events);
    this.broadcastGame(events);
    return { ok: true };
  }

  /** 局内动作落库 + 局末检测（hooks 弱依赖）：动作先缓冲 Redis，局末由网关 drain→MySQL+finishGame */
  private recordAction(seat: number, action: Action, events: GameEvent[]): void {
    const end = events.find((e) => e.type === 'win' || e.type === 'exhaustive');
    if (end) this.logRound(end, action); // 散场回顾累积，不依赖 hooks
    if (!this.hooks || !this.gameId) return;
    this.actionSeq++;
    this.hooks.onGameAction(this.gameId, this.actionSeq, seat, action);
    if (end) this.hooks.onGameEnd(this.gameId, end.type === 'win' ? 'win' : 'exhaustive', end);
  }

  /** 累积单局回顾（赢家/台数/最高番种/自摸）与胡牌局数，供散场战绩页局数回顾 */
  private logRound(end: GameEvent, action: Action): void {
    if (!this.state) return;
    if (end.type === 'win') {
      for (const w of end.winners) this.winCount[w.seat] = (this.winCount[w.seat] ?? 0) + 1;
      const w0 = end.winners[0]!;
      const top = [...w0.detail].sort((a, b) => b.tai - a.tai)[0];
      this.roundLog.push({
        round: this.state.round,
        endType: 'win',
        winnerSeat: w0.seat,
        tai: w0.tai,
        topFan: top?.name ?? null,
        zimo: action.type === 'declareWin',
      });
    } else if (end.type === 'exhaustive') {
      this.roundLog.push({ round: this.state.round, endType: 'exhaustive', winnerSeat: null, tai: 0, topFan: null, zimo: false });
    }
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
    // maxRounds=0 表示「不限」：永不因上限结束，仅房主手动解散才 finished（PRD 03 FR-房间-01/05）
    if (this.maxRounds > 0 && this.state.round >= this.maxRounds) {
      this.finishRoom('maxRounds');
      return { ok: true };
    }
    const seed = this.seed++;
    this.state = startNextRound(this.state, seed).state;
    this.beginGame(seed);
    this.broadcastGame();
    return { ok: true };
  }

  /**
   * 房主主动解散（PRD 03 FR-房间-05）：不限局数（maxRounds=0）时的散场入口。
   * 守卫：仅房主 + 对局中 + 本局已结算（settled/exhaustive），避免局中途中断丢未落库的对局。
   */
  dissolve(byUserId: string): OpResult {
    if (byUserId !== this.hostUserId) return { ok: false, reason: '仅房主可解散' };
    if (this.phase !== 'playing' || !this.state) return { ok: false, reason: '未在对局中' };
    const ph = this.state.phase;
    if (ph !== 'settled' && ph !== 'exhaustive') return { ok: false, reason: '本局进行中，暂不能解散' };
    this.finishRoom('dissolve');
    return { ok: true };
  }

  /**
   * 散场：定格最终排名 + 广播 roomEnd + 触发落库钩子（打满上限/房主解散共用）。
   * 积分取当前累计 state.players[].score；wins 取本房胡牌局数。见 PRD 05 §4.2。
   */
  private finishRoom(reason: RoomEndReason): void {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
    const standings: FinalStanding[] = [];
    for (let seat = 0; seat < 4; seat++) {
      const u = this.userAtSeat[seat];
      if (!u) continue;
      standings.push({
        seat,
        userId: u,
        isBot: u.startsWith('bot-'),
        score: this.state?.players.find((p) => p.seat === seat)?.score ?? 0,
        wins: this.winCount[seat] ?? 0,
      });
    }
    const msg = { t: 'roomEnd' as const, room: this.id, reason, standings, rounds: this.roundLog };
    for (const c of this.connOf.values()) c.send(msg);
    this.hooks?.onRoomEnd(this.id, standings, this.roundLog);
  }

  private broadcastGame(events?: GameEvent[]): void {
    if (!this.state) return;
    if (events && events.length) for (const c of this.connOf.values()) c.send({ t: 'event', events });
    const names = this.names.map((x) => x ?? '');
    for (const [userId, conn] of this.connOf) {
      const seat = this.seatOf.get(userId);
      if (seat == null) continue;
      conn.send({ t: 'gameView', view: redact(this.state, seat, this.id, this.maxRounds, names) });
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
