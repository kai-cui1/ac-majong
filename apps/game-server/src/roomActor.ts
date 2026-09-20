import type { TableState, Action, GameEvent, ActionKind, RoundSnapshot } from '@ac-majong/engine';
import { createTable, applyAction, startNextRound, legalActions, snapshotRound, buildPhysicalLayout, wallInfo } from '@ac-majong/engine';
import type { RoomView, RoomPhase, FinalStanding, RoundReview, RoomEndReason, RoomSettings, SeatingView, PublicRoomEntry } from '@ac-majong/protocol';
import type { Connection } from './connection';
import { redact } from './redact';
import { makeBotConnection, makeTrusteeConnection } from './devBots';
import { createLogger } from './logger';

const log = createLogger('room');

export interface OpResult {
  ok: boolean;
  seat?: number;
  reason?: string;
}

/** 对局持久化钩子（网关注入，fire-and-forget 落库；RoomActor 保持同步、无异步 IO）。见持久化技术方案 §7 M-E。 */
export interface GameHooks {
  onGameStart(roomId: string, gameId: string, snap: RoundSnapshot, dealerSeat: number, seed: number, roundNo: number): void;
  onGameAction(gameId: string, seq: number, seat: number | null, action: Action): void;
  /** scores=局末各家累计积分（网关据此写 rooms.member_scores 积分账本，BL-016 重进/重启恢复依据） */
  onGameEnd(roomId: string, gameId: string, endType: 'win' | 'exhaustive', result: unknown, scores: Record<number, number>): void;
  /** 散场（打满上限/房主解散）：网关据此 closeRoom + rooms.final_score 落库（弱依赖）。见持久化技术方案 §7 M-G。 */
  onRoomEnd(roomId: string, standings: FinalStanding[], rounds: RoundReview[]): void;
  /** BL-017：开局仪式结束落 seating 日志（弱依赖） */
  onSeating?(roomId: string, seating: unknown): void;
}

/** BL-016：服务重启后由 DB 事件溯源重建房间的恢复快照（网关组装，RoomActor.restore 同步注入） */
export interface RoomRestore {
  phase: 'waiting' | 'playing';
  state: TableState | null;
  gameId: string | null;
  gameSeq: number;
  actionSeq: number;
  /** 下一个可用对局种子（取最新一局 seed+1，避免重建后续局种子重叠） */
  seed?: number;
  /** seat → userId（含未重连的真人座位，座位保留以恢复积分） */
  seats: (string | null)[];
  names: (string | null)[];
  roundLog: RoundReview[];
  winCount: Record<number, number>;
  /** 积分账本（rooms.member_scores）：降级 waiting 后开局作为各家初始累计分，保证积分不丢（FR-房间-09） */
  ledgerScores?: Record<number, number>;
  /** 重连时立即恢复托管代打的离线真人座位（对局中重建，FR-断线-03 语义） */
  absentUsers?: string[];
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
  /** BL-018：创建时间戳（列表同组内倒序排序用） */
  readonly createdAt = Date.now();
  readonly maxRounds: number;
  phase: RoomPhase = 'waiting';
  private state: TableState | null = null;
  private seatOf = new Map<string, number>();
  private userAtSeat: (string | null)[] = [null, null, null, null];
  /** 各家展示昵称（by seat），供 ViewState.names 显示真实昵称（还原度） */
  private names: (string | null)[] = [null, null, null, null];
  private connOf = new Map<string, Connection>();
  /** M-I：离线标记（掉线未超时的座位）与托管态（超时后服务端代打） */
  private offlineSince = new Map<string, number>();
  private trusteeOf = new Set<string>();
  private trusteeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private trusteeAfterMs: number;
  private seed: number;
  private botSeq = 0;
  private hooks?: GameHooks;
  private gameId: string | null = null;
  private gameSeq = 0;
  private actionSeq = 0;
  /** 单局回顾 + 各家胡牌局数（散场战绩页用，独立于落库钩子累积） */
  private roundLog: RoundReview[] = [];
  private winCount: Record<number, number> = {};
  /** BL-016：重建降级 waiting 时的积分账本，开局写入各家初始累计分 */
  private ledgerScores: Record<number, number> | null = null;
  /** BL-017 房间玩法参数（建房设定，开局后不可改） */
  readonly settings: RoomSettings;
  /** BL-017 开局仪式/摸牌位骰视图（null=不在仪式阶段） */
  private seating: SeatingView | null = null;
  private seatingTimers: ReturnType<typeof setTimeout>[] = [];
  private seatingLog: unknown[] = [];

  constructor(id: string, hostUserId: string, maxRounds: number, seed: number, hooks?: GameHooks, timings?: { trusteeAfterMs?: number }, settings?: RoomSettings) {
    this.id = id;
    this.hostUserId = hostUserId;
    this.maxRounds = maxRounds;
    this.seed = seed;
    this.hooks = hooks;
    this.trusteeAfterMs = timings?.trusteeAfterMs ?? 60_000; // D-24：掉线保留 60 秒后托管
    this.settings = { wallMode: 'random', breakDice: false, chiFirstView: true, isPublic: true, ...settings };
  }

  getState(): TableState | null {
    return this.state;
  }

  /**
   * BL-016：从持久化重建（服务重启后成员重进触发）——注入座位/对局现场/积分/回顾，
   * 使房间周期跨重启延续（积分保留、局可续打）。Bot 座位由网关挂 bot 连接；
   * 未重连的真人座位对局中立即转托管代打，避免牌局卡死。
   */
  restore(r: RoomRestore): void {
    this.phase = r.phase;
    this.state = r.state;
    this.gameId = r.gameId;
    this.gameSeq = r.gameSeq;
    this.actionSeq = r.actionSeq;
    if (r.seed != null) this.seed = r.seed;
    this.roundLog = [...r.roundLog];
    this.winCount = { ...r.winCount };
    this.ledgerScores = r.ledgerScores ? { ...r.ledgerScores } : null;
    r.seats.forEach((u, seat) => {
      if (!u) return;
      this.userAtSeat[seat] = u;
      this.seatOf.set(u, seat);
      this.names[seat] = r.names[seat] ?? null;
    });
    log.info(`房间重建: room=${this.id} phase=${this.phase} seats=[${r.seats.map((u) => u ?? '-').join(',')}] game=${r.gameId ?? '-'} actionSeq=${r.actionSeq}`);
    for (const u of r.absentUsers ?? []) {
      if (this.phase === 'playing' && this.seatOf.has(u) && !u.startsWith('bot-') && !this.connOf.has(u)) this.enterTrustee(u);
    }
  }

  /** BL-016：重建后为 Bot 座位挂回保守代打连接（网关在 restore 后调用） */
  attachBot(userId: string, delayMs = 300): void {
    this.connOf.set(userId, makeBotConnection(this, userId, delayMs));
  }
  seatOfUser(userId: string): number | undefined {
    return this.seatOf.get(userId);
  }
  playerCount(): number {
    return this.seatOf.size;
  }

  /** BL-018：大厅公开房间列表行——仅公开开关 ON 且未终局时返回；排序/上限由 RoomManager 聚合 */
  listEntry(): PublicRoomEntry | null {
    if (this.settings.isPublic === false) return null;
    if (this.phase !== 'waiting' && this.phase !== 'seating' && this.phase !== 'playing') return null;
    const hostSeat = this.seatOf.get(this.hostUserId);
    return {
      room: this.id,
      host: (hostSeat != null ? this.names[hostSeat] : null) ?? this.names[0] ?? this.hostUserId,
      seats: this.playerCount(),
      maxRounds: this.maxRounds,
      status: this.phase === 'playing' ? 'playing' : 'waiting',
    };
  }

  roomView(): RoomView {
    return {
      room: this.id,
      phase: this.phase,
      hostUserId: this.hostUserId,
      maxRounds: this.maxRounds,
      settings: this.settings,
      seating: this.seating ?? undefined,
      seats: this.userAtSeat.map((u, seat) => (u ? {
        userId: u,
        seat,
        nickname: this.names[seat] ?? undefined,
        isBot: u.startsWith('bot-'),
        offline: this.offlineSince.has(u) || undefined,
        trusteed: this.trusteeOf.has(u) || undefined,
      } : null)),
    };
  }

  addPlayer(userId: string, conn: Connection, nickname?: string): OpResult {
    this.connOf.set(userId, conn);
    const existing = this.seatOf.get(userId);
    if (existing != null) {
      log.debug(`玩家重连: room=${this.id} user=${userId} seat=${existing}`);
      this.cancelOffline(userId); // 重连接管：清离线计时/卸托管代打
      this.broadcastAll(); // 重连
      return { ok: true, seat: existing };
    }
    if (this.phase !== 'waiting') return { ok: false, reason: '房间已开始' };
    const seat = this.userAtSeat.indexOf(null);
    if (seat < 0) return { ok: false, reason: '房间已满' };
    this.seatOf.set(userId, seat);
    this.userAtSeat[seat] = userId;
    this.names[seat] = nickname ?? (userId.startsWith('bot-') ? '机器人' : userId);
    log.info(`玩家加入: room=${this.id} user=${userId} seat=${seat} 当前人数=${this.seatOf.size}`);
    this.broadcastAll();
    return { ok: true, seat };
  }

  removePlayer(userId: string): void {
    this.connOf.delete(userId); // 座位保留以支持重连
    this.broadcastAll();
  }

  /**
   * 掉线入口（M-I / FR-断线-01）：WS 断开/对局中主动退出均走此——
   * 清连接 + 保留座位 + 标记离线 + 60 秒后转托管；等待期掉线仅清连接。
   */
  playerDisconnected(userId: string): void {
    this.connOf.delete(userId);
    if (this.phase === 'playing' && this.seatOf.has(userId) && !userId.startsWith('bot-') && !this.trusteeOf.has(userId)) {
      this.offlineSince.set(userId, Date.now());
      const t = setTimeout(() => this.enterTrustee(userId), this.trusteeAfterMs);
      this.trusteeTimers.set(userId, t);
      log.info(`玩家掉线: room=${this.id} user=${userId} ${this.trusteeAfterMs}ms 后转托管`);
    }
    this.broadcastAll();
  }

  /** 超时转托管（FR-断线-03）：挂保守代打连接，直至重连接管或本局结束 */
  private enterTrustee(userId: string): void {
    this.trusteeTimers.delete(userId);
    if (!this.seatOf.has(userId) || this.connOf.has(userId)) return; // 已重连则不作动
    this.offlineSince.delete(userId);
    this.trusteeOf.add(userId);
    this.connOf.set(userId, makeTrusteeConnection(this, userId));
    log.info(`转托管: room=${this.id} user=${userId} seat=${this.seatOf.get(userId)}`);
    this.broadcastAll();
    if (this.state) this.broadcastGame(); // 立即给托管连接当前局面，轮到其行动时即刻代打
  }

  /** 重连接管（FR-断线-04）：清离线计时/卸托管代打连接（真实 conn 由 addPlayer 覆盖） */
  private cancelOffline(userId: string): void {
    const t = this.trusteeTimers.get(userId);
    if (t) { clearTimeout(t); this.trusteeTimers.delete(userId); }
    this.offlineSince.delete(userId);
    if (this.trusteeOf.delete(userId)) log.info(`托管解除: room=${this.id} user=${userId}`);
  }

  start(byUserId: string): OpResult {
    if (this.phase !== 'waiting') return { ok: false, reason: '已开始' };
    if (byUserId !== this.hostUserId) return { ok: false, reason: '仅房主可开始' };
    if (this.seatOf.size < 4) return { ok: false, reason: '需满 4 人' };
    // BL-017：开局仪式（选位骰→选座→定庄摸牌位一掷）为每房标准流程，完成后才发牌
    this.phase = 'seating';
    this.seating = {
      stage: 'roll', rolls: [null, null, null, null], reroll: [false, false, false, false],
      order: [], picker: null, picked: null, dealerDice: null, dealerSeat: null, breakN: null, roller: null,
    };
    log.info(`开局仪式开始: room=${this.id} settings=${JSON.stringify(this.settings)}`);
    this.scheduleSeatingAuto();
    this.broadcastAll();
    return { ok: true };
  }

  // ============ BL-017 开局仪式 / 摸牌位骰 ============

  private static roll2d6(): number {
    return 2 + Math.floor(Math.random() * 6) + Math.floor(Math.random() * 6);
  }

  private clearSeatingTimers(): void {
    for (const t of this.seatingTimers) clearTimeout(t);
    this.seatingTimers = [];
  }

  /** 手动掷+超时自动（10s）；Bot/托管 0.4~0.8s 内自动代掷（FR-对局-18） */
  private scheduleSeatingAuto(): void {
    this.clearSeatingTimers();
    const s = this.seating;
    if (!s) return;
    const pending: number[] = [];
    if (s.stage === 'roll') {
      for (let i = 0; i < 4; i++) if (s.rolls[i] == null) pending.push(i);
    } else if (s.stage === 'pick' && s.picker != null) {
      pending.push(s.picker);
    } else if (s.stage === 'dealerBreak' && s.picker != null) {
      pending.push(s.picker);
    } else if (s.stage === 'roundBreak' && s.roller != null) {
      pending.push(s.roller);
    }
    for (const seat of pending) {
      const u = this.userAtSeat[seat];
      if (!u) continue;
      const delay = u.startsWith('bot-') ? 400 + Math.floor(Math.random() * 400) : 10_000;
      this.seatingTimers.push(setTimeout(() => {
        const cur = this.seating;
        if (!cur) return;
        if (cur.stage === 'pick') this.handlePickSeat(u, seat); // 超时自动 = 保留自己当前座位
        else this.handleRoll(u);
      }, delay));
    }
  }

  /** 掷骰（语境由阶段决定：选位骰/定庄骰/摸牌位骰） */
  handleRoll(userId: string): OpResult {
    const s = this.seating;
    if (!s) return { ok: false, reason: '不在仪式阶段' };
    const seat = this.seatOf.get(userId);
    if (seat == null) return { ok: false, reason: '不在房间' };
    if (s.stage === 'roll') {
      if (s.rolls[seat] != null && !s.reroll[seat]) return { ok: false, reason: '已掷过' };
      const v = RoomActor.roll2d6();
      s.rolls[seat] = v;
      s.reroll[seat] = false;
      this.seatingLog.push({ stage: 'roll', seat, v });
      if (s.rolls.every((x) => x != null)) this.resolveSeatingRolls();
      this.broadcastAll();
      return { ok: true };
    }
    if (s.stage === 'dealerBreak') {
      if (seat !== s.picker) return { ok: false, reason: '仅选位最大者掷定庄摸牌位骰' };
      const v = RoomActor.roll2d6();
      s.dealerDice = v;
      s.dealerSeat = (seat + ((v - 1) % 4)) % 4; // 1=自己 2=下手 3=对面 4=上手
      s.breakN = v; // 同一点数兼定开牌点（B 门前牌墙右端起跳 N 组）
      this.seatingLog.push({ stage: 'dealerBreak', seat, v, dealerSeat: s.dealerSeat, breakN: v });
      this.finalizeCeremony(v);
      return { ok: true };
    }
    if (s.stage === 'roundBreak') {
      if (seat !== s.roller) return { ok: false, reason: '仅庄家掷摸牌位骰' };
      const v = RoomActor.roll2d6();
      s.breakN = v;
      this.seatingLog.push({ stage: 'roundBreak', seat, v, round: (this.state?.round ?? 0) + 1 });
      this.beginNextRoundWithBreak(v);
      return { ok: true };
    }
    return { ok: false, reason: '当前阶段不可掷骰' };
  }

  /** 选位骰齐后：同点者重掷（仅同点者）；否则按点数降序进入选座 */
  private resolveSeatingRolls(): void {
    const s = this.seating!;
    const counts = new Map<number, number>();
    for (const v of s.rolls) counts.set(v!, (counts.get(v!) ?? 0) + 1);
    let tied = false;
    for (let i = 0; i < 4; i++) {
      if ((counts.get(s.rolls[i]!) ?? 0) > 1) {
        s.reroll[i] = true;
        s.rolls[i] = null;
        tied = true;
      }
    }
    if (tied) {
      log.info(`选位骰同点重掷: room=${this.id}`);
      this.scheduleSeatingAuto();
      return;
    }
    s.order = [0, 1, 2, 3].sort((a, b) => (s.rolls[b] ?? 0) - (s.rolls[a] ?? 0));
    s.stage = 'pick';
    s.picker = s.order[0]!;
    this.scheduleSeatingAuto();
  }

  /** 选位最大者选座：其余按点数序依次坐其下手；选座后重排座位并重索引仪式视图 */
  handlePickSeat(userId: string, seat: number): OpResult {
    const s = this.seating;
    if (!s || s.stage !== 'pick') return { ok: false, reason: '不在选座阶段' };
    const cur = this.seatOf.get(userId);
    if (cur == null || cur !== s.picker) return { ok: false, reason: '仅选位最大者选座' };
    if (seat < 0 || seat > 3) return { ok: false, reason: '座位无效' };
    s.picked = seat;
    const newSeatOfOld = new Map<number, number>();
    s.order.forEach((os, i) => newSeatOfOld.set(os, (seat + i) % 4));
    const newUserAt: (string | null)[] = [null, null, null, null];
    const newNames: (string | null)[] = [null, null, null, null];
    const newRolls: (number | null)[] = [null, null, null, null];
    const newReroll = [false, false, false, false];
    const nextSeatOf = new Map<string, number>();
    for (let os = 0; os < 4; os++) {
      const u = this.userAtSeat[os];
      if (!u) continue;
      const ns = newSeatOfOld.get(os)!;
      newUserAt[ns] = u;
      newNames[ns] = this.names[os] ?? null;
      newRolls[ns] = s.rolls[os] ?? null;
      newReroll[ns] = s.reroll[os] ?? false;
      nextSeatOf.set(u, ns);
    }
    this.userAtSeat = newUserAt;
    this.names = newNames;
    this.seatOf = nextSeatOf;
    s.rolls = newRolls;
    s.reroll = newReroll;
    s.order = s.order.map((os) => newSeatOfOld.get(os)!);
    // 重排后 order[0] 即 A 的新座
    s.picker = s.order[0]!;
    this.seatingLog.push({ stage: 'pick', seat: s.picker, picked: seat });
    s.stage = 'dealerBreak';
    log.info(`选座完成: room=${this.id} A=seat${s.picker} → 座位重排 ${newUserAt.map((u) => u ?? '-').join(',')}`);
    this.scheduleSeatingAuto();
    this.broadcastAll();
    return { ok: true };
  }

  /** 仪式收尾：A 上 1 子 + 首庄庄子，按玩法参数建墙发牌进入第 1 局 */
  private finalizeCeremony(breakN: number): void {
    const s = this.seating!;
    const seatA = s.picker!;
    const dealer = s.dealerSeat!;
    const seed = this.seed++;
    const layout = this.settings.wallMode === 'physical' ? buildPhysicalLayout(seed) : undefined;
    const initialZi: Record<number, number> = { [seatA]: 1 };
    initialZi[dealer] = (initialZi[dealer] ?? 0) + 1;
    this.state = createTable(dealer, seed, [0, 1, 2, 3], { layout, breakGroups: breakN, initialZi });
    // BL-016：重建降级 waiting 后开局——以积分账本为各家初始累计分（房间周期内积分不丢）
    if (this.ledgerScores) {
      for (const p of this.state.players) p.score = this.ledgerScores[p.seat] ?? 0;
      this.ledgerScores = null;
    }
    this.phase = 'playing';
    this.clearSeatingTimers();
    this.seating = null;
    this.hooks?.onSeating?.(this.id, { log: this.seatingLog, settings: this.settings });
    log.info(`开局仪式完成: room=${this.id} dealer=seat${dealer} break=${breakN} wallMode=${this.settings.wallMode}`);
    this.beginGame(seed);
    this.broadcastRoom(); // 仪式结束：roomView(phase=playing、seating 已清) 先于 gameView，客户端关闭仪式 UI 并清 room.seating
    this.broadcastGame();
  }

  /** 局间摸牌位骰完成后开下一局（physical 模式新局新墙） */
  private beginNextRoundWithBreak(breakN: number): void {
    if (!this.state) return;
    const seed = this.seed++;
    const layout = this.settings.wallMode === 'physical' ? buildPhysicalLayout(seed) : undefined;
    this.state = startNextRound(this.state, seed, { layout, breakGroups: breakN }).state;
    this.clearSeatingTimers();
    this.seating = null;
    log.info(`开始下一局: room=${this.id} round=${this.state.round} break=${breakN}`);
    this.beginGame(seed);
    this.broadcastRoom(); // 摸牌位骰结束：roomView(seating 已清)，客户端关闭骰子横幅并清 room.seating
    this.broadcastGame();
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
    if (this.seating) return { ok: false, reason: '仪式/摸牌位骰进行中' };
    if (this.phase !== 'playing' || !this.state) return { ok: false, reason: '未在对局中' };
    const seat = this.seatOf.get(userId);
    if (seat == null) return { ok: false, reason: '不在房间' };
    if ('seat' in action && action.seat !== seat) return { ok: false, reason: '座位不符' };
    const kind = actionKind(action);
    if (kind && !legalActions(this.state, seat).includes(kind)) {
      log.warn(`非法操作: room=${this.id} user=${userId} seat=${seat} action=${action.type} kind=${kind}`);
      return { ok: false, reason: `非法操作:${kind}` };
    }
    const { state, events } = applyAction(this.state, action);
    this.state = state;
    log.debug(`执行动作: room=${this.id} seat=${seat} type=${action.type}${events.length ? ` events=[${events.map(e => e.type).join(',')}]` : ''}`);
    this.recordAction(seat, action, events);
    this.broadcastGame(events);
    return { ok: true };
  }

  /** 局内动作落库 + 局末检测（hooks 弱依赖）：动作先缓冲 Redis，局末由网关 drain→MySQL+finishGame+积分账本 */
  private recordAction(seat: number, action: Action, events: GameEvent[]): void {
    const end = events.find((e) => e.type === 'win' || e.type === 'exhaustive');
    if (end) this.logRound(end, action); // 散场回顾累积，不依赖 hooks
    if (!this.hooks || !this.gameId) return;
    this.actionSeq++;
    this.hooks.onGameAction(this.gameId, this.actionSeq, seat, action);
    if (end && this.state) {
      // BL-016：局末累计积分随钩子透出，网关写 rooms.member_scores 账本（重进/重启恢复依据）
      const scores: Record<number, number> = {};
      for (const p of this.state.players) scores[p.seat] = p.score;
      this.hooks.onGameEnd(this.id, this.gameId, end.type === 'win' ? 'win' : 'exhaustive', end, scores);
    }
  }

  /** 累积单局回顾（赢家/台数/最高番种/自摸）与胡牌局数，供散场战绩页局数回顾 */
  private logRound(end: GameEvent, action: Action): void {
    if (!this.state) return;
    if (end.type === 'win') {
      for (const w of end.winners) this.winCount[w.seat] = (this.winCount[w.seat] ?? 0) + 1;
      const w0 = end.winners[0]!;
      const top = [...w0.detail].sort((a, b) => b.tai - a.tai)[0];
      log.info(`胡牌: room=${this.id} round=${this.state.round} winner=seat${w0.seat} tai=${w0.tai} topFan=${top?.name ?? '-'} zimo=${action.type === 'declareWin'}`);
      this.roundLog.push({
        round: this.state.round,
        endType: 'win',
        winnerSeat: w0.seat,
        tai: w0.tai,
        topFan: top?.name ?? null,
        zimo: action.type === 'declareWin',
      });
    } else if (end.type === 'exhaustive') {
      log.info(`流局: room=${this.id} round=${this.state.round}`);
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
    if (this.seating?.stage === 'roundBreak') return { ok: false, reason: '等待摸牌位骰' };
    // maxRounds=0 表示「不限」：永不因上限结束，仅房主手动解散才 finished（PRD 03 FR-房间-01/05）
    if (this.maxRounds > 0 && this.state.round >= this.maxRounds) {
      log.info(`达到局数上限，散场: room=${this.id} rounds=${this.state.round}/${this.maxRounds}`);
      this.finishRoom('maxRounds');
      return { ok: true };
    }
    // BL-017：启用摸牌位骰时，庄家轮换后先掷骰定开牌点再开下一局
    if (this.settings.breakDice) {
      const ziCounts = this.state.players.map((p) => p.zi);
      this.seating = {
        stage: 'roundBreak', rolls: [null, null, null, null], reroll: [false, false, false, false],
        order: [], picker: null, picked: null, dealerDice: null, dealerSeat: this.state.dealerSeat, breakN: null, roller: this.state.dealerSeat,
        ziCounts,
      };
      log.info(`摸牌位骰: room=${this.id} 下一局=${this.state.round + 1} 掷骰者=seat${this.state.dealerSeat}`);
      this.scheduleSeatingAuto();
      this.broadcastGame();
      return { ok: true };
    }
    const seed = this.seed++;
    const layout = this.settings.wallMode === 'physical' ? buildPhysicalLayout(seed) : undefined;
    this.state = startNextRound(this.state, seed, { layout, breakGroups: 0 }).state;
    log.info(`开始下一局: room=${this.id} round=${this.state.round} seed=${seed}`);
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
    log.info(`房主解散: room=${this.id} host=${byUserId} totalRounds=${this.state.round}`);
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
    this.clearSeatingTimers(); // 散场清仪式计时
    for (const t of this.trusteeTimers.values()) clearTimeout(t); // 散场清离线计时
    this.trusteeTimers.clear();
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
    const wi = wallInfo(this.state); // BL-017 physical 模式四边牌墙栈高
    for (const [userId, conn] of this.connOf) {
      const seat = this.seatOf.get(userId);
      if (seat == null) continue;
      const view = redact(this.state, seat, this.id, this.maxRounds, names, this.settings);
      if (this.seating) view.seating = this.seating; // 局间摸牌位骰阶段随 gameView 下发
      if (wi) view.wallInfo = wi;
      conn.send({ t: 'gameView', view });
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

  /** 强制广播 roomView（不受 broadcastAll 在 playing 时只发 gameView 的影响）：仪式/局间摸牌位骰结束时清除客户端残留的 room.seating */
  private broadcastRoom(): void {
    const rv = this.roomView();
    for (const c of this.connOf.values()) c.send({ t: 'roomView', room: rv });
  }
}
