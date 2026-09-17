import { GameClient, WebTransport } from '../vendor/client-core/index';
import type { ViewState, RoomView, ServerMsg, UserProfile } from '../vendor/protocol/index';

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
  private cred: { url: string; token: string; profile?: UserProfile } | null = null;
  private lastRoom: string | null = null;
  private intentionalClose = false;
  private reconnecting = false;

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
   * @param profile 客户端上报的展示资料（昵称/头像）；服务端登录后 upsertUser 落库
   */
  async connect(url: string, token: string, profile?: UserProfile): Promise<void> {
    if (this.client) return;
    this.cred = { url, token, profile };
    this.intentionalClose = false;
    const client = this.buildClient();
    this.client = client;
    await client.connect();
    client.auth(token, profile);
    await client.waitFor((m) => m.t === 'authOk');
  }

  /** 构建 GameClient（首连与重连共用同一套订阅转发） */
  private buildClient(): GameClient {
    return new GameClient(new WebTransport(this.cred!.url), {
      onAuth: (_uid, p) => {
        this._profile = p;
      },
      onGameView: (v) => this.viewListeners.forEach((f) => f(v)),
      onRoomView: (r) => {
        this.lastRoom = r.room;
        this.roomListeners.forEach((f) => f(r));
      },
      onEvent: (m) => this.eventListeners.forEach((f) => f(m)),
      onRoomEnd: (m) => {
        this.lastRoom = null; // 散场后不再重入
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
        client.auth(this.cred!.token, this.cred!.profile);
        await client.waitFor((m) => m.t === 'authOk');
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
  }

  /** 创建房间并等待进入等待页（返回房间视图）；未连接则抛错 */
  async createRoom(maxRounds = 8): Promise<RoomView> {
    if (!this.client) throw new Error('未连接');
    this.client.create(maxRounds);
    const m = await this.client.waitForNext((x) => x.t === 'roomView');
    return (m as Extract<ServerMsg, { t: 'roomView' }>).room;
  }
  /** 加入房间并等待进入等待页；房间不存在/已满/已开始则抛错（含原因） */
  async joinRoom(room: string): Promise<RoomView> {
    if (!this.client) throw new Error('未连接');
    this.client.join(room);
    const m = await this.client.waitForNext((x) => x.t === 'roomView' || (x.t === 'ack' && x.ok === false));
    if (m.t === 'ack') throw new Error(m.reason ?? '加入失败');
    return (m as Extract<ServerMsg, { t: 'roomView' }>).room;
  }
  start(): void {
    this.client?.start();
  }
  /** 房主为空位放入 Bot 陪玩（FR-房间-08）；等待房间视图刷新后返回 */
  async addBot(count = 1): Promise<RoomView> {
    if (!this.client) throw new Error('未连接');
    this.client.addBot(count);
    const m = await this.client.waitForNext((x) => x.t === 'roomView');
    return (m as Extract<ServerMsg, { t: 'roomView' }>).room;
  }
  /** 房主移除一个 Bot（真人想加入时腾位）；roomView 由服务端广播驱动刷新 */
  removeBot(seat: number): void {
    this.client?.removeBot(seat);
  }
  /** 离开当前房间（回大厅）；保留连接与会话 */
  leave(): void {
    this.client?.leave();
  }
  /** 结算后开下一局（相位守卫在服务端，达上限则服务端置 finished） */
  nextRound(): void {
    this.client?.nextRound();
  }
  /** 房主主动解散牌局（不限局数时的散场入口）；服务端下发 roomEnd 驱动切散场页 */
  dissolve(): void {
    this.client?.dissolve();
  }
  /** 对局结束后“再来一局”：离开旧房并重新建房（服务端会重新补 Bot 并开局） */
  restart(maxRounds = 8): void {
    this.client?.leave();
    this.client?.create(maxRounds);
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
}
