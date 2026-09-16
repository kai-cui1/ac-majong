import { GameClient, WebTransport } from '../vendor/client-core/index';
import type { ViewState, RoomView, ServerMsg } from '../vendor/protocol/index';

export type ViewListener = (v: ViewState) => void;
export type RoomListener = (r: RoomView) => void;
export type EventListener = (m: Extract<ServerMsg, { t: 'event' }>) => void;

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
  private viewListeners: ViewListener[] = [];
  private roomListeners: RoomListener[] = [];
  private eventListeners: EventListener[] = [];

  onView(cb: ViewListener): void {
    this.viewListeners.push(cb);
  }
  onRoom(cb: RoomListener): void {
    this.roomListeners.push(cb);
  }
  onEvent(cb: EventListener): void {
    this.eventListeners.push(cb);
  }

  get view(): ViewState | null {
    return this.client?.view ?? null;
  }

  async connect(url: string, token: string): Promise<void> {
    const client = new GameClient(new WebTransport(url), {
      onGameView: (v) => this.viewListeners.forEach((f) => f(v)),
      onRoomView: (r) => this.roomListeners.forEach((f) => f(r)),
      onEvent: (m) => this.eventListeners.forEach((f) => f(m)),
    });
    this.client = client;
    await client.connect();
    client.auth(token);
    await client.waitFor((m) => m.t === 'authOk');
  }

  createRoom(maxRounds = 8): void {
    this.client?.create(maxRounds);
  }
  joinRoom(room: string): void {
    this.client?.join(room);
  }
  start(): void {
    this.client?.start();
  }
  /** 结算后开下一局（相位守卫在服务端，达上限则服务端置 finished） */
  nextRound(): void {
    this.client?.nextRound();
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
