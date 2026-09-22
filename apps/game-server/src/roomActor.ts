import type { TableState, Action, GameEvent, ActionKind, RoundSnapshot } from '@ac-majong/engine';
import { createTable, applyAction, startNextRound, legalActions, snapshotRound, buildPhysicalLayout, wallInfo } from '@ac-majong/engine';
import { DEFAULT_PERSONA, TRUSTEE_PERSONA, personaById } from '@ac-majong/ai';
import type { RoomView, RoomPhase, FinalStanding, RoundReview, RoomEndReason, RoomSettings, SeatingView, PublicRoomEntry, CeremonyPresentation, CeremonyDice, CeremonyToken } from '@ac-majong/protocol';
import { randomUUID } from 'node:crypto';
import type { Connection } from './connection';
import { redact } from './redact';
import { makeBotConnection, makeTrusteeConnection } from './devBots';
import { createLogger } from './logger';
import type { RoomMetaPatch } from '@ac-majong/persistence';

const log = createLogger('room');

/** 正式仪式时长（ms）；测试通过构造参数注入，不提供玩家倍速入口。 */
export const CEREMONY_MS = Object.freeze({ input: 10_000, auto: 600, rolling: 1200, result: 2000, summary: 2000, seated: 1500, final: 3000 });
export type CeremonyTimings = { [K in keyof typeof CEREMONY_MS]: number };
export interface RoomTimings {
  trusteeAfterMs?: number;
  /** BL-022 停滞看门狗阈值(ms)；<=0 或省略=不启用（仅按需 inspect().stall.idleMs）。服务端经 STALL_WATCHDOG_MS 启用 */
  stallWatchdogMs?: number;
  ceremony?: Partial<CeremonyTimings>;
  /** BL-032 测试注入：回合/响应截止毫秒（优先于 settings 档位；<=0=关闭截止，仅供旧假时钟测试隔离用） */
  turnMs?: number;
  respMs?: number;
}

/** BL-032 建房可选档位（秒）：思考时间/响应时间；网关建房时钳制到最近档位 */
export const TURN_TIERS = Object.freeze([10, 15, 20, 30]);
export const RESP_TIERS = Object.freeze([5, 8, 10, 15]);
const snapTier = (v: unknown, tiers: readonly number[], dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? tiers.reduce((b, t) => (Math.abs(t - v) < Math.abs(b - v) ? t : b), dflt)
    : dflt;
/** 建房参数归一：开关类容错 + 时间档钳制（BL-032）；RoomActor 内部信任本函数输出 */
export function normalizeRoomSettings(s?: Partial<RoomSettings> | null): RoomSettings {
  const out: RoomSettings = { wallMode: 'random', breakDice: false, chiFirstView: true, isPublic: true, ...s };
  out.wallMode = out.wallMode === 'physical' ? 'physical' : 'random';
  out.breakDice = out.breakDice !== false;
  out.chiFirstView = out.chiFirstView !== false;
  out.isPublic = out.isPublic !== false;
  out.turnSec = snapTier(s?.turnSec, TURN_TIERS, 15);
  out.respSec = snapTier(s?.respSec, RESP_TIERS, 8);
  return out;
}

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
  /** BL-031/FR-AI-11/FR-房间-12：房间元信息增量落库（局数/玩法/Bot打法/托管预设，弱依赖） */
  onRoomMeta?(roomId: string, patch: RoomMetaPatch): void;
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
  /** BL-031（FR-AI-11）：重建恢复的 Bot 打法（seat→personaId） */
  botPersonas?: Record<number, string>;
  /** BL-031（FR-AI-11）：重建恢复的托管打法预设（userId→personaId） */
  trusteePersonas?: Record<string, string>;
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
  maxRounds: number;
  phase: RoomPhase = 'waiting';
  private state: TableState | null = null;
  /** BL-026：本局终局事件（win/exhaustive/zhahu）缓存：重连/晚进入客户端补发结算浮层用 */
  private lastTerminal: GameEvent | null = null;
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
  /** BL-031：座位 → Bot 打法 personaId（房主可选/可改） */
  private botPersonas: Record<number, string> = {};
  /** BL-031：userId → 托管打法预设（FR-AI-04/10，玩家个人） */
  private trusteePersonas: Record<string, string> = {};
  private hooks?: GameHooks;
  private gameId: string | null = null;
  private gameSeq = 0;
  private actionSeq = 0;
  /** 单局回顾 + 各家胡牌局数（散场战绩页用，独立于落库钩子累积） */
  private roundLog: RoundReview[] = [];
  private winCount: Record<number, number> = {};
  /** BL-016：重建降级 waiting 时的积分账本，开局写入各家初始累计分 */
  private ledgerScores: Record<number, number> | null = null;
  /** BL-017 房间玩法参数（建房设定；FR-房间-12 开局前房主可改、开局后锁定） */
  settings: RoomSettings;
  /** BL-017 开局仪式/摸牌位骰视图（null=不在仪式阶段） */
  private seating: SeatingView | null = null;
  private seatingInputTimer?: ReturnType<typeof setTimeout>;
  private seatingDisplayTimer?: ReturnType<typeof setTimeout>;
  private seatingAdvance?: () => void;
  private ceremonyOrder: string[] = [];
  private readonly ceremonyMs: CeremonyTimings;
  private seatingLog: unknown[] = [];
  /** BL-017 定座位逐轮淘汰：有序槽位表（number=已定序座位 / number[]=待决并列组，块内待后续轮定序） */
  private seatingSlots: (number | number[])[] = [];
  /** 本轮参与掷骰（即判重范围）的座位；已定序者不在其中 */
  private seatingRollers: number[] = [];
  /** BL-022 停滞看门狗：最近一次成功动作时刻 + 巡检定时器 + 单次停滞是否已告警 */
  private lastActionAt = 0;
  private stallWatchdogMs: number;
  private stallTimer?: ReturnType<typeof setInterval>;
  private stallLogged = false;
  /** BL-032 服务端权威截止：当前窗（turn=摸+打 / resp=响应窗）+ 定时器 + 窗锚点键（窗内广播不重置） */
  private deadline: { kind: 'turn' | 'resp'; seats: number[]; at: number; totalMs: number } | null = null;
  private deadlineKey = '';
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private readonly turnMsOverride?: number;
  private readonly respMsOverride?: number;

  constructor(id: string, hostUserId: string, maxRounds: number, seed: number, hooks?: GameHooks, timings?: RoomTimings, settings?: RoomSettings) {
    this.id = id;
    this.hostUserId = hostUserId;
    this.maxRounds = maxRounds;
    this.seed = seed;
    this.hooks = hooks;
    this.trusteeAfterMs = timings?.trusteeAfterMs ?? 60_000; // D-24：掉线保留 60 秒后托管
    this.stallWatchdogMs = timings?.stallWatchdogMs ?? 0; // BL-022：默认关，服务端经 env 启用
    this.settings = normalizeRoomSettings(settings);
    this.turnMsOverride = timings?.turnMs;
    this.respMsOverride = timings?.respMs;
    this.ceremonyMs = { ...CEREMONY_MS, ...timings?.ceremony };
  }

  /** BL-032 回合窗时长（ms）：测试注入优先，否则 settings 档位 */
  private get turnMs(): number {
    return this.turnMsOverride ?? (this.settings.turnSec ?? 15) * 1000;
  }
  /** BL-032 响应窗时长（ms）：同上 */
  private get respMs(): number {
    return this.respMsOverride ?? (this.settings.respSec ?? 8) * 1000;
  }

  getState(): TableState | null {
    return this.state;
  }

  /** 回收仪式与托管计时；不写散场日志，用于网关停服/移除房间。 */
  dispose(): void {
    this.phase = 'finished';
    this.clearSeatingTimers();
    this.stopStallWatchdog();
    this.seating = null;
    if (this.deadlineTimer) { clearTimeout(this.deadlineTimer); this.deadlineTimer = undefined; } // BL-032
    this.deadline = null;
    for (const timer of this.trusteeTimers.values()) clearTimeout(timer);
    this.trusteeTimers.clear();
    this.connOf.clear();
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
    if (r.botPersonas) this.botPersonas = { ...r.botPersonas };
    if (r.trusteePersonas) this.trusteePersonas = { ...r.trusteePersonas };
    log.info(`房间重建: room=${this.id} phase=${this.phase} seats=[${r.seats.map((u) => u ?? '-').join(',')}] game=${r.gameId ?? '-'} actionSeq=${r.actionSeq}`);
    for (const u of r.absentUsers ?? []) {
      if (this.phase === 'playing' && this.seatOf.has(u) && !u.startsWith('bot-') && !this.connOf.has(u)) this.enterTrustee(u);
    }
  }

  /** BL-016：重建后为 Bot 座位挂回代打连接（网关在 restore 后调用）；persona 读当前座位设定 */
  attachBot(userId: string, delayMs = 300): void {
    this.connOf.set(userId, makeBotConnection(this, userId, delayMs, () => this.botPersonaOf(userId)));
  }
  /** 某 Bot 用户当前打法（缺省默认） */
  private botPersonaOf(userId: string): string {
    const seat = this.seatOf.get(userId);
    return (seat != null ? this.botPersonas[seat] : undefined) ?? DEFAULT_PERSONA;
  }
  seatOfUser(userId: string): number | undefined {
    return this.seatOf.get(userId);
  }
  playerCount(): number {
    return this.seatOf.size;
  }

  /** BL-018：是否该房成员（列表 mine 标记用：自己的房对局中/满员仍可重入） */
  isMember(userId: string): boolean {
    return this.seatOf.has(userId);
  }

  /** BL-018：大厅公开房间列表行——仅公开开关 ON 且未终局时返回；排序/上限由 RoomManager 聚合 */
  listEntry(): Omit<PublicRoomEntry, 'mine'> | null {
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
      seating: this.seatingSnapshot(),
      seats: this.userAtSeat.map((u, seat) => (u ? {
        userId: u,
        seat,
        nickname: this.names[seat] ?? undefined,
        isBot: u.startsWith('bot-'),
        offline: this.offlineSince.has(u) || undefined,
        trusteed: this.trusteeOf.has(u) || undefined,
        botPersona: u.startsWith('bot-') ? this.botPersonas[seat] : undefined,
        trusteePersona: this.trusteePersonas[u],
      } : null)),
    };
  }

  addPlayer(userId: string, conn: Connection, nickname?: string): OpResult {
    this.connOf.set(userId, conn);
    const existing = this.seatOf.get(userId);
    if (existing != null) {
      log.debug(`玩家重连: room=${this.id} user=${userId} seat=${existing}`);
      this.cancelOffline(userId); // 重连接管：清离线计时/卸托管代打
      // 重入先补权威房间资料：局间仪式需要各家身份与玩法设置，不能依赖旧缓存或占位房。
      conn.send({ t: 'roomView', room: this.roomView() });
      this.broadcastAll(); // 重连
      const term = this.resendSettlement(userId); // BL-026：结算相位重连补发终局事件，否则浮层缺失看似卡死
      if (term) conn.send({ t: 'event', events: [term] });
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
    this.shortenSeatingInput(userId);
    this.broadcastAll();
  }

  /**
   * 掉线入口（M-I / FR-断线-01）：WS 断开/对局中主动退出均走此——
   * 清连接 + 保留座位 + 标记离线 + 60 秒后转托管；等待期掉线仅清连接。
   */
  playerDisconnected(userId: string): void {
    if (this.trusteeOf.has(userId)) return; // 重复掉线通知不能卸除已经接管的代打连接
    this.connOf.delete(userId);
    if ((this.phase === 'seating' || this.phase === 'playing') && this.seatOf.has(userId) && !userId.startsWith('bot-') && !this.offlineSince.has(userId)) {
      this.offlineSince.set(userId, Date.now());
    }
    this.shortenSeatingInput(userId);
    this.scheduleOfflineTrustee(userId);
    this.broadcastAll();
  }

  /** 仪式中只保留离线起点；进入对局后按原截止时间接续，重复通知不延期。 */
  private scheduleOfflineTrustee(userId: string): void {
    const since = this.offlineSince.get(userId);
    if (this.phase !== 'playing' || since == null || !this.seatOf.has(userId) || userId.startsWith('bot-') || this.connOf.has(userId) || this.trusteeOf.has(userId) || this.trusteeTimers.has(userId)) return;
    const remaining = Math.max(0, since + this.trusteeAfterMs - Date.now());
    this.trusteeTimers.set(userId, setTimeout(() => this.enterTrustee(userId), remaining));
    log.info(`玩家掉线: room=${this.id} user=${userId} ${remaining}ms 后转托管`);
  }

  /** 超时转托管（FR-断线-03）：挂保守代打连接，直至重连接管或本局结束 */
  private enterTrustee(userId: string): void {
    this.trusteeTimers.delete(userId);
    if (this.phase === 'finished' || !this.seatOf.has(userId) || this.connOf.has(userId)) return; // 已重连则不作动
    this.offlineSince.delete(userId);
    this.trusteeOf.add(userId);
    this.connOf.set(userId, makeTrusteeConnection(this, userId, 400, () => this.trusteePersonas[userId] ?? TRUSTEE_PERSONA));
    this.shortenSeatingInput(userId);
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
    this.seatingSlots = [];
    this.seatingRollers = [0, 1, 2, 3];
    log.info(`开局仪式开始: room=${this.id} settings=${JSON.stringify(this.settings)}`);
    const hostSeat = this.seatOf.get(this.hostUserId)!;
    this.ceremonyOrder = [0, 1, 2, 3].map((i) => this.userAtSeat[(hostSeat + i) % 4]!);
    this.seatingLog = [];
    this.seating.presentation = this.newPresentation(this.ceremonyOrder);
    this.enterSeatingInput('roll', this.ceremonyOrder[0]!);
    return { ok: true };
  }

  // ============ BL-017 开局仪式 / 摸牌位骰 ============

  private static roll2d6(): CeremonyDice {
    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    return { d1, d2, sum: d1 + d2 };
  }

  private newPresentation(pending: string[] = []): CeremonyPresentation {
    return {
      ceremonyId: randomUUID(), stepId: 0, startedAt: 0, deadline: 0, serverNow: 0,
      phase: 'input', actor: null, rerollRound: 0, pendingRollUserIds: [...pending],
      resultsByUserId: {}, ceremonyDice: null, summaryKind: null,
    };
  }

  /** 每次采样独立复制，连接或测试保存的广播历史不会被后续步骤改写。 */
  private seatingSnapshot(): SeatingView | undefined {
    if (!this.seating) return undefined;
    const s = structuredClone(this.seating);
    if (s.presentation) s.presentation.serverNow = Date.now();
    return s;
  }

  private clearSeatingTimers(): void {
    clearTimeout(this.seatingInputTimer);
    clearTimeout(this.seatingDisplayTimer);
    this.seatingInputTimer = this.seatingDisplayTimer = undefined;
    this.seatingAdvance = undefined;
  }

  private scheduleSeatingStep(advance: () => void): void {
    const s = this.seating!;
    const { ceremonyId, stepId, phase, deadline } = s.presentation!;
    const stage = s.stage;
    this.seatingAdvance = advance;
    const timer = setTimeout(() => {
      const cur = this.seating;
      const p = cur?.presentation;
      if (this.phase === 'finished' || cur !== s || cur.stage !== stage || p?.ceremonyId !== ceremonyId || p.stepId !== stepId || p.phase !== phase) return;
      advance();
    }, Math.max(0, deadline - Date.now()));
    if (phase === 'input') this.seatingInputTimer = timer;
    else this.seatingDisplayTimer = timer;
  }

  /** 每段在实际进入时独立起算；迟到回调不能压缩下一段。 */
  private enterSeatingStep(stage: SeatingView['stage'], phase: CeremonyPresentation['phase'], userId: string | null, ms: number, advance: () => void, summaryKind: CeremonyPresentation['summaryKind'] = null): void {
    this.clearSeatingTimers();
    const s = this.seating!;
    const p = s.presentation!;
    s.stage = stage;
    p.stepId++;
    p.phase = phase;
    p.actor = userId == null ? null : { userId, seat: this.seatOf.get(userId)! };
    p.summaryKind = summaryKind;
    p.startedAt = p.serverNow = Date.now();
    p.deadline = p.startedAt + ms;
    this.scheduleSeatingStep(advance);
    this.broadcastAll();
  }

  private enterSeatingInput(stage: SeatingView['stage'], userId: string): void {
    const auto = userId.startsWith('bot-') || !this.connOf.has(userId) || this.offlineSince.has(userId) || this.trusteeOf.has(userId);
    this.enterSeatingStep(stage, 'input', userId, auto ? this.ceremonyMs.auto : this.ceremonyMs.input, () => {
      // 到期代操作走内部入口，不冒充已过期的玩家请求。
      if (stage === 'pick') this.pickSeatingSeat(userId, this.seatOf.get(userId)!);
      else this.rollSeatingDice(userId);
    });
  }

  private shortenSeatingInput(userId: string): void {
    const p = this.seating?.presentation;
    if (p?.phase !== 'input' || p.actor?.userId !== userId || !this.seatingAdvance) return;
    const deadline = Math.min(p.deadline, Date.now() + this.ceremonyMs.auto);
    if (deadline === p.deadline) return;
    p.deadline = deadline;
    const advance = this.seatingAdvance;
    clearTimeout(this.seatingInputTimer);
    this.scheduleSeatingStep(advance);
  }

  private validateSeatingInput(userId: string, token?: CeremonyToken): OpResult {
    if (this.phase === 'finished' || !this.seating?.presentation) return { ok: false, reason: '不在仪式阶段' };
    if (!this.seatOf.has(userId)) return { ok: false, reason: '不在房间' };
    const p = this.seating.presentation;
    if (p.phase !== 'input') return { ok: false, reason: '等待展示结束' };
    if (p.actor?.userId !== userId) return { ok: false, reason: '未轮到你操作' };
    if (Date.now() >= p.deadline) return { ok: false, reason: '操作已过期' };
    if (token !== undefined && (!token || token.ceremonyId !== p.ceremonyId || token.stepId !== p.stepId)) return { ok: false, reason: '仪式步骤已失效' };
    return { ok: true };
  }

  /** 掷骰（语境由阶段决定：选位骰/定庄骰/摸牌位骰） */
  handleRoll(userId: string, token?: CeremonyToken): OpResult {
    const valid = this.validateSeatingInput(userId, token);
    if (!valid.ok) return valid;
    if (this.seating!.stage === 'pick') return { ok: false, reason: '当前阶段不可掷骰' };
    this.rollSeatingDice(userId);
    return { ok: true };
  }

  private rollSeatingDice(userId: string): void {
    const s = this.seating!;
    const p = s.presentation!;
    const stage = s.stage;
    const seat = this.seatOf.get(userId)!;
    const dice = RoomActor.roll2d6(); // 私存于闭包，滚动中不下发新终值
    this.enterSeatingStep(stage, 'rolling', userId, this.ceremonyMs.rolling, () => {
      if (stage === 'roll') {
        p.resultsByUserId[userId] = { ...dice, rerollRound: p.rerollRound };
        p.pendingRollUserIds = p.pendingRollUserIds.filter((u) => u !== userId);
        s.rolls[seat] = dice.sum;
        s.reroll[seat] = false;
      } else {
        p.ceremonyDice = dice;
        s.breakN = dice.sum;
        if (stage === 'dealerBreak') {
          s.dealerDice = dice.sum;
          s.dealerSeat = (seat + ((dice.sum - 1) % 4)) % 4;
          s.ziCounts = this.ceremonyZi(s);
        }
      }
      this.seatingLog.push({ stage, userId, seat, ...dice, v: dice.sum, dealerSeat: s.dealerSeat, breakN: s.breakN, rerollRound: p.rerollRound });
      this.enterSeatingStep(stage, 'result', userId, stage === 'roll' ? this.ceremonyMs.result : this.ceremonyMs.final, () => {
        if (stage === 'dealerBreak') this.finalizeCeremony(dice.sum);
        else if (stage === 'roundBreak') this.beginNextRoundWithBreak(dice.sum);
        else if (p.pendingRollUserIds.length) this.enterSeatingInput('roll', p.pendingRollUserIds[0]!);
        else this.resolveSeatingRolls();
      });
    });
  }

  /** 选位骰逐轮定序：仅本轮掷骰者（未定序组）内判重；已定序者不再参与比较；并列组在其预留名次块内定序 */
  private resolveSeatingRolls(): void {
    const s = this.seating!;
    const p = s.presentation!;
    // 首轮槽位表为空 → 全体为一个待决组；后续轮在既有槽位表上细化待决组
    const groups: (number | number[])[] = this.seatingSlots.length ? this.seatingSlots : [[...this.seatingRollers]];
    const slots: (number | number[])[] = [];
    for (const g of groups) {
      if (typeof g === 'number') { slots.push(g); continue; }
      const members = [...g].sort((a, b) => s.rolls[b]! - s.rolls[a]!);
      for (let i = 0; i < members.length;) {
        const v = s.rolls[members[i]!]!;
        let j = i;
        while (j < members.length && s.rolls[members[j]!] === v) j++;
        const run = members.slice(i, j);
        slots.push(run.length === 1 ? run[0]! : run);
        i = j;
      }
    }
    this.seatingSlots = slots;
    const pendingSeats = slots.filter((g): g is number[] => Array.isArray(g)).flat();
    s.reroll = [0, 1, 2, 3].map((seat) => pendingSeats.includes(seat));
    const pending = this.ceremonyOrder.filter((u) => s.reroll[this.seatOf.get(u)!]);
    if (pending.length) {
      p.pendingRollUserIds = pending;
      this.seatingRollers = pending.map((u) => this.seatOf.get(u)!);
      this.enterSeatingStep('roll', 'summary', null, this.ceremonyMs.summary, () => {
        p.rerollRound++;
        this.enterSeatingInput('roll', pending[0]!);
      }, 'reroll');
    } else {
      s.order = slots.filter((g): g is number => typeof g === 'number');
      s.picker = s.order[0]!;
      this.enterSeatingStep('roll', 'summary', null, this.ceremonyMs.summary, () => {
        this.enterSeatingInput('pick', this.userAtSeat[s.picker!]!);
      }, 'ranking');
    }
  }

  /** 结果预告与建局使用同一份计子函数，展示本身不修改引擎玩家。 */
  private ceremonyZi(s: SeatingView): number[] {
    const zi = [0, 0, 0, 0];
    if (s.picker != null) zi[s.picker] = 1;
    if (s.dealerSeat != null) zi[s.dealerSeat] = zi[s.dealerSeat]! + 1;
    return zi;
  }

  /** 选位最大者选座：其余按点数序依次坐其下手；选座后重排座位并重索引仪式视图 */
  handlePickSeat(userId: string, seat: number, token?: CeremonyToken): OpResult {
    const valid = this.validateSeatingInput(userId, token);
    if (!valid.ok) return valid;
    if (this.seating!.stage !== 'pick') return { ok: false, reason: '不在选座阶段' };
    if (!Number.isInteger(seat) || seat < 0 || seat > 3) return { ok: false, reason: '座位无效' };
    this.pickSeatingSeat(userId, seat);
    return { ok: true };
  }

  private pickSeatingSeat(userId: string, seat: number): void {
    const s = this.seating!;
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
    s.ziCounts = this.ceremonyZi(s);
    log.info(`选座完成: room=${this.id} A=seat${s.picker} → 座位重排 ${newUserAt.map((u) => u ?? '-').join(',')}`);
    this.enterSeatingStep('pick', 'summary', null, this.ceremonyMs.seated, () => {
      this.enterSeatingInput('dealerBreak', userId);
    }, 'seated');
  }

  /** 仪式收尾：A 上 1 子 + 首庄庄子，按玩法参数建墙发牌进入第 1 局 */
  private finalizeCeremony(breakN: number): void {
    const s = this.seating!;
    const dealer = s.dealerSeat!;
    const seed = this.seed++;
    const layout = this.settings.wallMode === 'physical' ? buildPhysicalLayout(seed) : undefined;
    const initialZi = this.ceremonyZi(s);
    this.state = createTable(dealer, seed, [0, 1, 2, 3], { layout, breakGroups: breakN, initialZi });
    this.lastTerminal = null; // BL-026：新局清终局缓存
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
    for (const userId of this.offlineSince.keys()) this.scheduleOfflineTrustee(userId);
    this.broadcastRoom(); // 仪式结束：roomView(phase=playing、seating 已清) 先于 gameView，客户端关闭仪式 UI 并清 room.seating
    this.broadcastGame();
    this.armStallWatchdog();
  }

  /** 局间摸牌位骰完成后开下一局（physical 模式新局新墙） */
  private beginNextRoundWithBreak(breakN: number): void {
    if (!this.state) return;
    const seed = this.seed++;
    const layout = this.settings.wallMode === 'physical' ? buildPhysicalLayout(seed) : undefined;
    this.state = startNextRound(this.state, seed, { layout, breakGroups: breakN }).state;
    this.lastTerminal = null; // BL-026：新局清终局缓存
    this.clearSeatingTimers();
    this.seating = null;
    log.info(`开始下一局: room=${this.id} round=${this.state.round} break=${breakN}`);
    this.beginGame(seed);
    this.broadcastRoom(); // 摸牌位骰结束：roomView(seating 已清)，客户端关闭骰子横幅并清 room.seating
    this.broadcastGame();
    this.armStallWatchdog();
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

  /** 房主为空位放入 Bot 陪玩（FR-房间-08）：仅 waiting + 房主 + 有空位；Bot 计入满员；BL-031 可指定打法 */
  addBot(byUserId: string, count = 1, personaId?: string): OpResult {
    if (this.phase !== 'waiting') return { ok: false, reason: '已开始' };
    if (byUserId !== this.hostUserId) return { ok: false, reason: '仅房主可添加机器人' };
    if (personaId != null && !personaById(personaId)?.available) return { ok: false, reason: '打法不可用' };
    let added = 0;
    for (let i = 0; i < count && this.playerCount() < 4; i++) {
      const n = ++this.botSeq;
      const botId = `bot-${n}`;
      this.addPlayer(botId, makeBotConnection(this, botId, 260 + i * 80, () => this.botPersonaOf(botId)), `机器人${n}`);
      const seat = this.seatOf.get(botId);
      if (seat != null) this.botPersonas[seat] = personaId ?? DEFAULT_PERSONA;
      added++;
    }
    if (added === 0) return { ok: false, reason: '无空位' };
    this.hooks?.onRoomMeta?.(this.id, { botPersonas: { ...this.botPersonas } });
    this.broadcastAll();
    return { ok: true };
  }

  /** BL-031（FR-AI-03）：房主改已添加 Bot 的打法；waiting/playing 均可（即时生效于后续决策） */
  updateBotPersona(byUserId: string, seat: number, personaId: string): OpResult {
    if (byUserId !== this.hostUserId) return { ok: false, reason: '仅房主可修改机器人打法' };
    const uid = this.userAtSeat[seat];
    if (!uid || !uid.startsWith('bot-')) return { ok: false, reason: '该座位不是机器人' };
    if (!personaById(personaId)?.available) return { ok: false, reason: '打法不可用' };
    this.botPersonas[seat] = personaId;
    this.hooks?.onRoomMeta?.(this.id, { botPersonas: { ...this.botPersonas } });
    this.broadcastAll();
    return { ok: true };
  }

  /** FR-房间-12：房主开局前改房间玩法/局数；开局后锁定 */
  updateRoom(byUserId: string, patch: { maxRounds?: number; settings?: Partial<RoomSettings> }): OpResult {
    if (this.phase !== 'waiting') return { ok: false, reason: '已开始，玩法不可修改' };
    if (byUserId !== this.hostUserId) return { ok: false, reason: '仅房主可修改房间玩法' };
    if (patch.maxRounds != null) this.maxRounds = patch.maxRounds;
    if (patch.settings) this.settings = { ...this.settings, ...patch.settings };
    this.hooks?.onRoomMeta?.(this.id, { maxRounds: this.maxRounds, settings: this.settings });
    this.broadcastAll();
    return { ok: true };
  }

  /** FR-AI-04/10：玩家预设自己掉线托管所用打法（个人级，持久化见 FR-AI-11） */
  setTrusteePersona(userId: string, personaId: string): OpResult {
    if (!this.seatOf.has(userId)) return { ok: false, reason: '非本房成员' };
    if (!personaById(personaId)?.available) return { ok: false, reason: '打法不可用' };
    this.trusteePersonas[userId] = personaId;
    this.hooks?.onRoomMeta?.(this.id, { trusteePersonas: { ...this.trusteePersonas } });
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

  /** BL-022 房间状态自检：一次性 dump 定位「服务端在等谁/卡在哪」所需的全部权威状态（dev/诊断用，不含令牌） */
  inspect(): Record<string, unknown> {
    const st = this.state;
    return {
      room: this.id, phase: this.phase, maxRounds: this.maxRounds, settings: this.settings, names: this.names,
      seats: this.roomView().seats.map((s) => (s ? { userId: s.userId, isBot: s.isBot } : null)),
      // FR-Admin-10 上帝全知视角：携带完整台态（纯只读投影，不含 seed/令牌；wall 已 materialize 为实牌），供 admin 监控页复用回放牌桌俯视图
      gameId: this.gameId,
      state: st ?? null,
      game: st
        ? { round: st.round, phase: st.phase, currentSeat: st.currentSeat, wallLen: st.wall.length, legalBySeat: [0, 1, 2, 3].map((seat) => legalActions(st, seat)) }
        : null,
      seating: this.seating
        ? {
            stage: this.seating.stage, rolls: this.seating.rolls, reroll: this.seating.reroll, order: this.seating.order,
            picker: this.seating.picker, dealerSeat: this.seating.dealerSeat, breakN: this.seating.breakN, roller: this.seating.roller,
            slots: this.seatingSlots, rollers: this.seatingRollers,
            presentation: this.seating.presentation
              ? { stepId: this.seating.presentation.stepId, phase: this.seating.presentation.phase, actor: this.seating.presentation.actor, rerollRound: this.seating.presentation.rerollRound, pending: this.seating.presentation.pendingRollUserIds }
              : null,
          }
        : null,
      timers: { trusteePending: [...this.trusteeTimers.keys()], offlineSince: [...this.offlineSince.entries()], seatingInputActive: this.seatingInputTimer != null },
      stall: { lastActionAt: this.lastActionAt, idleMs: st && this.phase === 'playing' ? Date.now() - this.lastActionAt : 0 },
    };
  }

  /** BL-022 停滞看门狗：playing 相位若超 20s 无任何成功动作，warn 一次并给出「在等谁/其 legal」，避免「服务端沉默」无从定位 */
  private armStallWatchdog(): void {
    this.stopStallWatchdog();
    this.lastActionAt = Date.now();
    this.stallLogged = false;
    if (this.stallWatchdogMs <= 0) return; // 未启用：仍可按需 inspect().stall.idleMs 诊断
    this.stallTimer = setInterval(() => {
      if (this.phase !== 'playing' || !this.state) { this.stopStallWatchdog(); return; }
      if (this.stallLogged || Date.now() - this.lastActionAt < this.stallWatchdogMs) return;
      this.stallLogged = true;
      const st = this.state;
      const expected = this.userAtSeat[st.currentSeat] ?? null;
      log.warn(`停滞看门狗: room=${this.id} round=${st.round} phase=${st.phase} curSeat=${st.currentSeat} expected=${expected} legal=${JSON.stringify(legalActions(st, st.currentSeat))} wallLen=${st.wall.length} idleMs=${Date.now() - this.lastActionAt}`);
    }, 5_000);
  }
  private stopStallWatchdog(): void {
    if (this.stallTimer) { clearInterval(this.stallTimer); this.stallTimer = undefined; }
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
    return this.execSeatAction(seat, action) ? { ok: true } : { ok: false, reason: '执行失败' };
  }

  /** BL-032 内部执行（已校验合法性后）：真人/托管/截止代打共用同一落库与广播路径 */
  private execSeatAction(seat: number, action: Action): boolean {
    if (this.phase !== 'playing' || !this.state) return false;
    const kind = actionKind(action);
    if (kind && !legalActions(this.state, seat).includes(kind)) return false;
    const { state, events } = applyAction(this.state, action);
    this.state = state;
    this.lastActionAt = Date.now();
    this.stallLogged = false;
    log.debug(`执行动作: room=${this.id} seat=${seat} type=${action.type}${events.length ? ` events=[${events.map(e => e.type).join(',')}]` : ''}`);
    this.recordAction(seat, action, events);
    this.noteTerminal(events);
    this.broadcastGame(events);
    return true;
  }

  // ============ BL-032 服务端权威截止（回合/响应窗） ============

  /** 当前窗锚点键：同窗内视图广播（如 pendingChi）不得重置截止；换窗必变 */
  private computeDeadlineKey(): string | null {
    const st = this.state;
    if (!st || this.phase !== 'playing' || this.seating) return null;
    if (st.phase === 'draw' || st.phase === 'discard') return `T:${st.round}:${st.currentSeat}:${st.discards.length}`;
    if (st.phase === 'response' && st.lastDiscard) return `R:${st.round}:${st.discards.length}:${st.lastDiscard.seat}:${st.lastDiscard.tile}`;
    return null;
  }

  /** 每次状态广播后对齐截止窗：同窗保留原定时器（不重置），换窗重建，无窗清除 */
  private syncDeadline(): void {
    const key = this.computeDeadlineKey();
    if (this.deadline && this.deadlineKey === key && this.deadlineTimer) return; // 窗内广播不重置
    if (this.deadlineTimer) { clearTimeout(this.deadlineTimer); this.deadlineTimer = undefined; }
    this.deadline = null;
    this.deadlineKey = key ?? '';
    const st = this.state;
    if (!key || !st) return;
    const isTurn = key.startsWith('T:');
    const seats = isTurn
      ? [st.currentSeat]
      : Object.entries(st.pending).filter(([, p]) => p === null).map(([s]) => Number(s));
    if (seats.length === 0) return; // 响应窗无待响应者（不应出现）→ 不挂定时器
    const totalMs = isTurn ? this.turnMs : this.respMs;
    if (totalMs <= 0) return; // <=0=关闭截止（测试隔离）
    this.deadline = { kind: isTurn ? 'turn' : 'resp', seats, at: Date.now() + totalMs, totalMs };
    this.deadlineTimer = setTimeout(() => this.onDeadline(), totalMs);
  }

  /** 截止到期：服务端代打——回合窗=摸（如需）＋摸切优先出牌；响应窗=逐家自动过。动作入事件流与落库，回放可复现 */
  private onDeadline(): void {
    this.deadlineTimer = undefined;
    const st = this.state;
    if (!st || this.phase !== 'playing' || !this.deadline) return;
    if (this.computeDeadlineKey() !== this.deadlineKey) return; // 窗已换（竞态保护）
    const d = this.deadline;
    if (d.kind === 'turn') {
      const seat = st.currentSeat;
      if (st.phase === 'draw') {
        log.info(`回合截止代摸: room=${this.id} seat=${seat}`);
        this.execSeatAction(seat, { type: 'draw', seat });
      }
      const cur = this.state;
      if (cur && cur.phase === 'discard' && cur.currentSeat === seat) {
        const p = cur.players.find((x) => x.seat === seat);
        const tile = cur.lastDrawn?.seat === seat
          ? cur.lastDrawn.tile // 摸切优先：刚摸的那张
          : Object.keys(p?.concealed ?? {}).sort()[0]; // 无摸牌张（如碰/杠后）→ 手牌首张
        if (tile) {
          log.info(`回合截止代打: room=${this.id} seat=${seat} tile=${tile}`);
          this.execSeatAction(seat, { type: 'discard', seat, tile });
        }
      }
    } else {
      for (const seat of d.seats) {
        const cur = this.state;
        if (!cur || cur.phase !== 'response') break;
        if (cur.pending[seat] === null) {
          log.info(`响应截止自动过: room=${this.id} seat=${seat}`);
          this.execSeatAction(seat, { type: 'respond', seat, move: 'pass' });
        }
      }
    }
    this.syncDeadline(); // 代打被拒（竞态）时重挂同窗截止，防永久停摆
  }

  /** BL-026：缓存终局事件（win/exhaustive/zhahu），供重连/晚挂载客户端补发结算浮层 */
  noteTerminal(events: GameEvent[]): void {
    const t = events.find((e) => e.type === 'win' || e.type === 'exhaustive' || e.type === 'zhahu');
    if (t) this.lastTerminal = t;
  }

  /** BL-026：结算相位且仍有缓存时返回本局终局事件（补发用）；仪式/局间骰进行中不补（避免浮层盖住仪式 UI） */
  resendSettlement(userId: string): GameEvent | null {
    if (!this.seatOf.has(userId)) return null;
    if (this.seating) return null;
    if (!this.state || (this.state.phase !== 'settled' && this.state.phase !== 'exhaustive')) return null;
    return this.lastTerminal;
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
      this.seating.presentation = this.newPresentation();
      this.enterSeatingInput('roundBreak', this.userAtSeat[this.state.dealerSeat]!);
      return { ok: true };
    }
    const seed = this.seed++;
    const layout = this.settings.wallMode === 'physical' ? buildPhysicalLayout(seed) : undefined;
    this.state = startNextRound(this.state, seed, { layout, breakGroups: 0 }).state;
    this.lastTerminal = null; // BL-026：新局清终局缓存
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
    this.stopStallWatchdog(); // 散场停停滞看门狗
    this.seating = null;
    if (this.deadlineTimer) { clearTimeout(this.deadlineTimer); this.deadlineTimer = undefined; } // BL-032 散场清截止计时
    this.deadline = null;
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
    this.syncDeadline(); // BL-032：状态变更后对齐截止窗（先于视图下发，保证视图带最新 deadline）
    const names = this.names.map((x) => x ?? '');
    const wi = wallInfo(this.state); // BL-017 physical 模式四边牌墙栈高
    for (const [userId, conn] of this.connOf) {
      const seat = this.seatOf.get(userId);
      if (seat == null) continue;
      const view = redact(this.state, seat, this.id, this.maxRounds, names, this.settings);
      if (this.seating) view.seating = this.seatingSnapshot(); // 局间摸牌位骰阶段随 gameView 下发
      if (wi) view.wallInfo = wi;
      view.serverNow = Date.now(); // BL-032：客户端钟差同步
      view.deadline = this.deadline ? { ...this.deadline, seats: [...this.deadline.seats] } : null;
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
