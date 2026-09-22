import { sys } from 'cc';
import { GameClient, WebTransport } from '../vendor/client-core/index';
import type { Transport } from '../vendor/client-core/index';
import type { ViewState, RoomView, ServerMsg, UserProfile, ReplayRoomSummary, ReplaySnapshot, ReplayActionRow, ReplayBundle, RoomSettings, PublicRoomEntry, CeremonyToken, CeremonyPresentation } from '../vendor/protocol/index';

export type ViewListener = (v: ViewState) => void;
export type RoomListener = (r: RoomView) => void;
export type EventListener = (m: Extract<ServerMsg, { t: 'event' }>) => void;
export type RoomEndListener = (m: Extract<ServerMsg, { t: 'roomEnd' }>) => void;
/** M-I 重连状态：重连中 / 已恢复 / 放弃（用于断线遮罩 UI） */
export type ReconnectStatus = 'reconnecting' | 'restored' | 'failed';
export type ReconnectListener = (s: ReconnectStatus) => void;

/**
 * Cocos 侧网络服务（单例）。封装 client-core.GameClient，向 UI 提供订阅式回调。
 * 平台无关传输由 client-core 提供：本地/Web 用 WebTransport；微信小游戏后续换 WeChatTransport。
 */
export class NetService {
  private static _inst: NetService | null = null;
  static get instance(): NetService {
    if (!this._inst) this._inst = new NetService();
    return this._inst;
  }

  private client: GameClient | null = null;
  private _profile: UserProfile | null = null;
  private viewListeners: ViewListener[] = [];
  private roomListeners: RoomListener[] = [];
  private eventListeners: EventListener[] = [];
  private roomEndListeners: RoomEndListener[] = [];
  private reconnectListeners: ReconnectListener[] = [];
  /** M-I：重连凭据与房间记忆（意外断线后自动重连并重入房间） */
  private cred: { url: string; token?: string; account?: { username: string; password: string }; profile?: UserProfile; transport?: Transport } | null = null;
  /** H5 账号路线：服务端签发的会话令牌（30 天，持久化后重连/复登免密码） */
  private sessionToken: string | null = null;
  private lastRoom: string | null = null;
  /** 持久化记忆房间（刷新/新会话后自动重入，FR-断线-02 扩展）；散场/登出清除 */
  private static readonly LAST_ROOM_KEY = 'ac_last_room';
  private intentionalClose = false;
  private reconnecting = false;
  /** BL-016：最近一次收到 gameView 的时刻（大厅加入→对局中重进时判定切页，避免 RoomScreen 未构建错过订阅广播） */
  lastGameViewAt = 0;
  /** BL-017：最近一次建房的玩法设置（「再来一局」沿用） */
  private lastSettings: RoomSettings | undefined = undefined;
  /** 在消息到达时采样，页面晚订阅或同一步重复广播不会重启仪式时钟。 */
  private ceremonyClock: { ceremonyId: string; stepId: number; server: number; local: number } | null = null;

  private monotonicNow(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  private sampleCeremony(p?: CeremonyPresentation): void {
    if (!p) return;
    const local = this.monotonicNow();
    const old = this.ceremonyClock;
    if (old?.ceremonyId === p.ceremonyId && old.stepId > p.stepId) return;
    const estimated = old?.ceremonyId === p.ceremonyId ? old.server + Math.max(0, local - old.local) : p.serverNow;
    this.ceremonyClock = { ceremonyId: p.ceremonyId, stepId: p.stepId, server: Math.max(estimated, p.serverNow), local };
  }

  ceremonyNow(p: CeremonyPresentation): number {
    const clock = this.ceremonyClock;
    return clock?.ceremonyId === p.ceremonyId
      ? clock.server + Math.max(0, this.monotonicNow() - clock.local)
      : p.serverNow;
  }

  /** BL-032 gameView 服务端钟采样点（单调本地钟+服务端锚点，deadline 同步显示用） */
  private viewClock: { server: number; local: number } | null = null;
  sampleViewClock(serverNow?: number): void {
    if (serverNow == null) return;
    this.viewClock = { server: serverNow, local: this.monotonicNow() };
  }
  /** BL-032 按最近采样推算的当前服务端时刻；无采样回退本地墙钟 */
  viewNow(): number {
    const c = this.viewClock;
    return c ? c.server + Math.max(0, this.monotonicNow() - c.local) : Date.now();
  }

  /** 回前台请求当前权威快照，不补播后台错过的步骤。 */
  refreshRoom(): void {
    if (this.lastRoom && !this.reconnecting) this.client?.join(this.lastRoom);
  }

  onView(cb: ViewListener): void {
    this.viewListeners.push(cb);
  }
  onRoom(cb: RoomListener): void {
    this.roomListeners.push(cb);
  }
  onEvent(cb: EventListener): void {
    this.eventListeners.push(cb);
  }
  /** 散场（打满上限/房主解散）：服务端下发 roomEnd → 切散场战绩页（M-G） */
  onRoomEnd(cb: RoomEndListener): void {
    this.roomEndListeners.push(cb);
  }
  /** M-I：断线重连状态订阅（牌桌遮罩/恢复提示用） */
  onReconnect(cb: ReconnectListener): void {
    this.reconnectListeners.push(cb);
  }
  get isReconnecting(): boolean {
    return this.reconnecting;
  }

  get view(): ViewState | null {
    return this.client?.view ?? null;
  }
  /** 当前房间视图（等待页用） */
  get room(): RoomView | null {
    return this.client?.room ?? null;
  }
  /** 散场战绩（roomEnd）：最终排名 + 局数回顾（散场页用） */
  get finalResult(): Extract<ServerMsg, { t: 'roomEnd' }> | null {
    return this.client?.finalResult ?? null;
  }
  /** 登录成功后服务端回传的用户资料（昵称/头像） */
  get profile(): UserProfile | null {
    return this._profile ?? this.client?.profile ?? null;
  }
  get userId(): string | null {
    return this.client?.userId ?? null;
  }
  get connected(): boolean {
    return this.client != null;
  }

  /**
   * 连接并登录（单例幂等：已连接则复用同一连接）。
   * @param cred token（mock/微信/会话复登）或 account（H5 账号密码注册即登录）
   * @param profile 客户端上报的展示资料（昵称/头像）；服务端登录后 upsertUser 落库
   */
  async connect(
    url: string,
    cred: { token?: string; account?: { username: string; password: string } },
    profile?: UserProfile,
    transport?: Transport,
  ): Promise<void> {
    if (this.client) return;
    this.cred = { url, ...cred, profile, transport };
    this.intentionalClose = false;
    const client = this.buildClient();
    this.client = client;
    await client.connect();
    const sel = this.authSelection();
    client.auth(sel.token, profile, sel.account);
    await this.waitAuth(client);
  }

  /** 已持久化的会话令牌（登录页用于免密复登） */
  storedSession(): string | null {
    if (this.sessionToken) return this.sessionToken;
    try {
      this.sessionToken = sys.localStorage.getItem('ac_session') || null;
    } catch {
      this.sessionToken = null;
    }
    return this.sessionToken;
  }

  /** 登录凭据选择：会话令牌优先 → mock/微信 token → 账号密码 */
  private authSelection(): { token?: string; account?: { username: string; password: string } } {
    if (this.sessionToken) return { token: this.sessionToken };
    if (this.cred?.token) return { token: this.cred.token };
    if (this.cred?.account) return { account: this.cred.account };
    return {};
  }

  /** 等 authOk；ack 失败（密码错/会话过期）则抛错供登录页展示 */
  private async waitAuth(client: GameClient): Promise<void> {
    const m = await client.waitFor((x) => x.t === 'authOk' || (x.t === 'ack' && x.ok === false));
    if (m.t !== 'authOk') {
      this.client = null;
      const reason = (m as Extract<ServerMsg, { t: 'ack' }>).reason ?? '鉴权失败';
      if (reason.includes('会话过期')) this.clearSession();
      client.close();
      throw new Error(reason);
    }
  }

  private clearSession(): void {
    this.sessionToken = null;
    try {
      sys.localStorage.removeItem('ac_session');
    } catch {
      /* 忽略存储异常 */
    }
    this.forgetLastRoom(); // 登出/换账号：记忆房间属旧身份，一并清除
  }

  /** 已持久化的记忆房间号（登录成功后用于自动重入） */
  storedLastRoom(): string | null {
    try {
      return sys.localStorage.getItem(NetService.LAST_ROOM_KEY);
    } catch {
      return null;
    }
  }

  forgetLastRoom(): void {
    try {
      sys.localStorage.removeItem(NetService.LAST_ROOM_KEY);
    } catch {
      /* 忽略存储异常 */
    }
  }

  private rememberLastRoom(id: string): void {
    try {
      sys.localStorage.setItem(NetService.LAST_ROOM_KEY, id);
    } catch {
      /* 忽略存储异常：仅本次会话可重入 */
    }
  }

  /** 构建 GameClient（首连与重连共用同一套订阅转发）；微信端用注入的 WeChatTransport */
  private buildClient(): GameClient {
    return new GameClient(this.cred!.transport ?? new WebTransport(this.cred!.url), {
      onAuth: (_uid, p, session) => {
        this._profile = p;
        if (session) {
          this.sessionToken = session;
          try {
            sys.localStorage.setItem('ac_session', session);
          } catch {
            /* 忽略存储异常：仅本次会话有效 */
          }
        }
      },
      onGameView: (v) => {
        this.sampleCeremony(v.seating?.presentation);
        this.lastGameViewAt = Date.now();
        // BL-016 缺陷修复（2026-09-20）：对局中重进无 roomView→此处补记记忆房（变更时才写，避免每视图广播写 localStorage）
        if (this.lastRoom !== v.room) {
          this.lastRoom = v.room;
          this.rememberLastRoom(v.room);
        }
        this.viewListeners.forEach((f) => f(v));
      },
      onRoomView: (r) => {
        this.sampleCeremony(r.seating?.presentation);
        this.lastRoom = r.room;
        this.rememberLastRoom(r.room);
        this.roomListeners.forEach((f) => f(r));
      },
      onEvent: (m) => this.eventListeners.forEach((f) => f(m)),
      onRoomEnd: (m) => {
        this.lastRoom = null; // 散场后不再重入
        this.forgetLastRoom();
        this.roomEndListeners.forEach((f) => f(m));
      },
      onClose: () => void this.handleClose(),
    });
  }

  /**
   * 意外断线处理（M-I / FR-断线-02）：退避重连（1/2/4/8s，上限约 60s）→
   * 重新鉴权 → 重入记忆房间（服务端座位重绑 + 全量视图下发 = 完整恢复）。
   */
  private handleClose(): void {
    if (this.intentionalClose || !this.cred || this.reconnecting) return;
    this.client = null;
    this.reconnecting = true;
    this.reconnectListeners.forEach((f) => f('reconnecting'));
    const delays = [1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000];
    const attempt = async (i: number): Promise<void> => {
      if (!this.reconnecting) return;
      try {
        const client = this.buildClient();
        await client.connect();
        const sel = this.authSelection();
        client.auth(sel.token, this.cred!.profile, sel.account);
        await this.waitAuth(client);
        this.client = client;
        if (this.lastRoom) client.join(this.lastRoom); // 重入房间→服务端重绑座位+广播全量视图
        this.reconnecting = false;
        this.reconnectListeners.forEach((f) => f('restored'));
      } catch {
        if (i + 1 >= delays.length) {
          this.reconnecting = false;
          this.reconnectListeners.forEach((f) => f('failed'));
          return;
        }
        setTimeout(() => void attempt(i + 1), delays[i]);
      }
    };
    setTimeout(() => void attempt(0), delays[0] ?? 1000);
  }

  /** 断开并清空会话（返回登录时调用） */
  disconnect(): void {
    this.intentionalClose = true;
    this.reconnecting = false;
    this.client?.close();
    this.client = null;
    this._profile = null;
    this.lastRoom = null;
    this.ceremonyClock = null;
    this.viewClock = null;
    this.clearSession();
  }

  /** 创建房间并等待进入等待页（返回房间视图）；未连接则抛错。BL-017：携带玩法设置（牌墙模式/摸牌位骰） */
  async createRoom(maxRounds = 8, settings?: RoomSettings): Promise<RoomView> {
    if (!this.client) throw new Error('未连接');
    this.lastSettings = settings;
    this.client.create(maxRounds, settings);
    const m = await this.client.waitForNext((x) => x.t === 'roomView');
    return (m as Extract<ServerMsg, { t: 'roomView' }>).room;
  }
  /** BL-018：拉取大厅公开房间列表（仅公开且未关闭房；等待先于对局中） */
  async requestRoomList(): Promise<PublicRoomEntry[]> {
    if (!this.client) throw new Error('未连接');
    const p = this.client.waitForNext((x) => x.t === 'roomList');
    this.client.requestRoomList();
    const m = (await p) as Extract<ServerMsg, { t: 'roomList' }>;
    return m.rooms;
  }
  /** 加入房间并等待进入等待页；房间不存在/已满则抛错（含原因）。
   * BL-016：重进「对局中」房间时服务端直接下发 gameView（无 roomView），同样视为加入成功。 */
  async joinRoom(room: string): Promise<RoomView> {
    if (!this.client) throw new Error('未连接');
    // 先注册等待器再发送，避免 ack 与视图消息间的派发竞态；服务端顺序：视图广播先于 ack
    const p = this.client.waitForNext((x) => x.t === 'roomView' || x.t === 'gameView' || x.t === 'ack');
    this.client.join(room);
    let m = await p;
    if (m.t === 'ack') {
      if (!m.ok) throw new Error(m.reason ?? '加入失败');
      m = await this.client.waitForNext((x) => x.t === 'roomView' || x.t === 'gameView');
    }
    if (m.t === 'gameView') return this.room!; // 对局中重进：调用方不依赖返回值切页（RoomScreen.onView 已订阅 → 自动切牌桌）
    return (m as Extract<ServerMsg, { t: 'roomView' }>).room;
  }
  start(): void {
    this.client?.start();
  }
  /** BL-017：开局仪式掷骰（选位/定庄/摸牌位，语境由服务端阶段决定） */
  roll(ceremonyToken?: CeremonyToken): void {
    this.client?.roll(ceremonyToken);
  }
  /** BL-017：选位最大者选座 */
  pickSeat(seat: number, ceremonyToken?: CeremonyToken): void {
    this.client?.pickSeat(seat, ceremonyToken);
  }
  /** 房主为空位放入 Bot 陪玩（FR-房间-08）；BL-031：可指定打法 personaId（FR-AI-03）。等待房间视图刷新后返回 */
  async addBot(count = 1, personaId?: string): Promise<RoomView> {
    if (!this.client) throw new Error('未连接');
    this.client.addBot(count, personaId);
    const m = await this.client.waitForNext((x) => x.t === 'roomView');
    return (m as Extract<ServerMsg, { t: 'roomView' }>).room;
  }
  /** 房主移除一个 Bot（真人想加入时腾位）；roomView 由服务端广播驱动刷新 */
  removeBot(seat: number): void {
    this.client?.removeBot(seat);
  }
  /** BL-031（FR-AI-03）：房主改已添加 Bot 的打法；roomView 广播驱动刷新 */
  updateBotPersona(seat: number, personaId: string): void {
    this.client?.updateBotPersona(seat, personaId);
  }
  /** BL-031（FR-房间-12）：房主开局前改房间局数/玩法（开局后服务端拒绝）；roomView 广播驱动刷新 */
  updateRoom(patch: { maxRounds?: number; settings?: Partial<RoomSettings> }): void {
    this.client?.updateRoom(patch);
  }
  /** BL-031（FR-AI-04/10）：玩家预设自己掉线托管所用打法（个人级，持久化 FR-AI-11） */
  setTrusteePersona(personaId: string): void {
    this.client?.setTrusteePersona(personaId);
  }
  /** 离开当前房间（回大厅）；保留连接与会话 */
  leave(): void {
    this.ceremonyClock = null;
    this.viewClock = null;
    this.client?.leave();
    if (this.client) { this.client.view = null; this.client.room = null; } // 清陈旧视图缓存（BL-016：防重进切页误判）
  }
  /** 结算后开下一局（相位守卫在服务端，达上限则服务端置 finished） */
  nextRound(): void {
    this.client?.nextRound();
  }

  /** BL-026：结算相位晚进入/晚挂载时请求补发终局事件（重建结算浮层） */
  resendSettlement(): void {
    this.client?.resendSettlement();
  }
  /** 房主主动解散牌局（不限局数时的散场入口）；服务端下发 roomEnd 驱动切散场页 */
  dissolve(): void {
    this.client?.dissolve();
  }
  /** 对局结束后“再来一局”：离开旧房并重新建房（服务端会重新补 Bot 并开局）；BL-017：沿用上次玩法设置 */
  restart(maxRounds = 8): void {
    this.leave(); // 清旧局缓存，避免等待页按旧 playing 状态跳回已结束的牌桌
    this.client?.create(maxRounds, this.lastSettings);
  }

  // —— 对局动作（透传引擎 Action，seat 由调用方按 view.you.seat 提供）——
  draw(seat: number): void {
    this.client?.action({ type: 'draw', seat });
  }
  discard(seat: number, tile: string): void {
    this.client?.action({ type: 'discard', seat, tile });
  }
  declareWin(seat: number): void {
    this.client?.action({ type: 'declareWin', seat });
  }
  kongConcealed(seat: number, tile: string): void {
    this.client?.action({ type: 'kongConcealed', seat, tile });
  }
  kongAdded(seat: number, tile: string): void {
    this.client?.action({ type: 'kongAdded', seat, tile });
  }
  respond(seat: number, move: 'win' | 'pong' | 'kong_exposed' | 'chi' | 'pass', chiTiles?: string[]): void {
    this.client?.action({ type: 'respond', seat, move, chiTiles });
  }

  /** BL-012：战绩/回放列表（房间→局两级；仅本人参赛房间，D-29） */
  async replayList(): Promise<ReplayRoomSummary[]> {
    if (!this.client) throw new Error('未连接');
    this.client.replayList();
    const m = await this.client.waitForNext((x) => x.t === 'replayList' || (x.t === 'ack' && x.ok === false));
    if (m.t === 'ack') throw new Error((m as Extract<ServerMsg, { t: 'ack' }>).reason ?? '战绩加载失败');
    return (m as Extract<ServerMsg, { t: 'replayList' }>).rooms;
  }

  /** BL-012：加载单局回放（快照+动作序列+座号昵称；客户端 rehydrate+applyAction 确定性重演） */
  async replayLoad(gameId: string): Promise<{ snapshot: ReplaySnapshot; actions: ReplayActionRow[]; names: Record<number, string>; viewSeat: number }> {
    if (!this.client) throw new Error('未连接');
    this.client.replayLoad(gameId);
    const m = await this.client.waitForNext((x) => x.t === 'replayData' || (x.t === 'ack' && x.ok === false));
    if (m.t === 'ack') throw new Error((m as Extract<ServerMsg, { t: 'ack' }>).reason ?? '回放加载失败');
    const d = m as Extract<ServerMsg, { t: 'replayData' }>;
    return { snapshot: d.snapshot, actions: d.actions, names: d.names, viewSeat: d.viewSeat };
  }
  /** BL-024：导出单局回放包（参赛四方可导；申诉/复现用，离线可确定性重演） */
  async exportReplayBundle(gameId: string): Promise<ReplayBundle> {
    if (!this.client) throw new Error('未连接');
    this.client.exportReplay(gameId);
    const m = await this.client.waitForNext((x) => x.t === 'replayBundle' || (x.t === 'ack' && x.ok === false));
    if (m.t === 'ack') throw new Error((m as Extract<ServerMsg, { t: 'ack' }>).reason ?? '回放导出失败');
    return (m as Extract<ServerMsg, { t: 'replayBundle' }>).bundle;
  }
}
