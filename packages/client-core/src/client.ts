import type { Action } from '@ac-majong/engine';
import type { ClientMsg, ServerMsg, ViewState, RoomView, UserProfile, RoomSettings, CeremonyToken } from '@ac-majong/protocol';
import type { Transport } from './transport';

export interface GameClientHandlers {
  onAuth?: (userId: string, profile: UserProfile, session?: string) => void;
  onGameView?: (v: ViewState) => void;
  onRoomView?: (r: RoomView) => void;
  onEvent?: (events: ServerMsg & { t: 'event' }) => void;
  onRoomEnd?: (m: Extract<ServerMsg, { t: 'roomEnd' }>) => void;
  onAck?: (a: Extract<ServerMsg, { t: 'ack' }>) => void;
  onClose?: () => void;
}

/** 平台无关的对局客户端：只依赖 Transport，微信/Web 通用 */
export class GameClient {
  private seq = 0;
  private received: ServerMsg[] = [];
  private waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
  view: ViewState | null = null;
  room: RoomView | null = null;
  /** 散场战绩（roomEnd）：最终排名 + 局数回顾，供散场页展示 */
  finalResult: Extract<ServerMsg, { t: 'roomEnd' }> | null = null;
  userId: string | null = null;
  profile: UserProfile | null = null;

  constructor(private transport: Transport, private handlers: GameClientHandlers = {}) {}

  async connect(): Promise<void> {
    this.transport.onMessage((data) => this.onMsg(JSON.parse(data) as ServerMsg));
    this.transport.onClose(() => this.handlers.onClose?.());
    await this.transport.connect();
  }

  private onMsg(m: ServerMsg): void {
    this.received.push(m);
    switch (m.t) {
      case 'authOk':
        this.userId = m.userId;
        this.profile = m.profile;
        this.handlers.onAuth?.(m.userId, m.profile, m.session);
        break;
      case 'roomView':
        this.room = m.room;
        this.handlers.onRoomView?.(m.room);
        break;
      case 'gameView':
        this.view = m.view;
        // BL-016 缺陷修复（2026-09-20）：对局中重进服务端只发 gameView（无 roomView），
        // 新会话（刷新后）this.room 会恒为 null 致 joinRoom 返回 null → 合成占位 room（等待页不展示，仅供路由/房号用）
        if (!this.room) this.room = { room: m.view.room, phase: 'playing', hostUserId: '', maxRounds: 0, seats: [null, null, null, null] };
        this.handlers.onGameView?.(m.view);
        break;
      case 'event':
        this.handlers.onEvent?.(m);
        break;
      case 'roomEnd':
        this.finalResult = m;
        this.handlers.onRoomEnd?.(m);
        break;
      case 'ack':
        this.handlers.onAck?.(m);
        break;
    }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i]!.pred(m)) {
        this.waiters[i]!.res(m);
        this.waiters.splice(i, 1);
      }
    }
  }

  /** 等待满足条件的消息（含已收到的），超时拒绝 */
  waitFor(pred: (m: ServerMsg) => boolean, timeout = 5000): Promise<ServerMsg> {
    return new Promise((resolve, reject) => {
      const hit = this.received.find(pred);
      if (hit) return resolve(hit);
      const to = setTimeout(() => reject(new Error('waitFor 超时')), timeout);
      this.waiters.push({
        pred,
        res: (m) => {
          clearTimeout(to);
          resolve(m);
        },
      });
    });
  }

  /** 只等待此后新到达的消息（不查历史），避免累积消息（多次 ack/roomView）误命中；超时拒绝 */
  waitForNext(pred: (m: ServerMsg) => boolean, timeout = 5000): Promise<ServerMsg> {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('waitForNext 超时')), timeout);
      this.waiters.push({
        pred,
        res: (m) => {
          clearTimeout(to);
          resolve(m);
        },
      });
    });
  }

  private send(msg: ClientMsg): void {
    this.transport.send(JSON.stringify(msg));
  }
  private nextSeq(): number {
    return ++this.seq;
  }

  /** 登录：sessionToken 优先（H5 账号路线重连/复登）；否则账号密码；mock/微信路线传 token */
  auth(token: string | undefined, profile?: UserProfile, account?: { username: string; password: string }): void {
    this.send({ t: 'auth', seq: this.nextSeq(), token, account, profile });
  }
  create(maxRounds = 8, settings?: RoomSettings): void {
    this.send({ t: 'create', seq: this.nextSeq(), maxRounds, settings });
  }
  /** BL-018：拉取大厅公开房间列表（响应 t=roomList） */
  requestRoomList(): void {
    this.send({ t: 'roomList', seq: this.nextSeq() });
  }
  join(room: string): void {
    this.send({ t: 'join', seq: this.nextSeq(), room });
  }
  leave(): void {
    this.send({ t: 'leave', seq: this.nextSeq() });
  }
  start(): void {
    this.send({ t: 'start', seq: this.nextSeq() });
  }
  /** BL-017：掷骰（选位/定庄/摸牌位，语境由服务端阶段决定） */
  roll(ceremonyToken?: CeremonyToken): void {
    this.send({ t: 'roll', seq: this.nextSeq(), ceremonyToken });
  }
  /** BL-017：选位最大者选座 */
  pickSeat(seat: number, ceremonyToken?: CeremonyToken): void {
    this.send({ t: 'pickSeat', seq: this.nextSeq(), seat, ceremonyToken });
  }
  /** 房主为空位放入 Bot 陪玩（FR-房间-08）；BL-031：可指定打法 personaId（FR-AI-03） */
  addBot(count = 1, personaId?: string): void {
    this.send({ t: 'addBot', seq: this.nextSeq(), count, personaId });
  }
  /** 房主移除一个 Bot（真人想加入时腾位） */
  removeBot(seat: number): void {
    this.send({ t: 'removeBot', seq: this.nextSeq(), seat });
  }
  /** BL-031（FR-AI-03）：房主改已添加 Bot 的打法（waiting/playing 均可，即时生效） */
  updateBotPersona(seat: number, personaId: string): void {
    this.send({ t: 'updateBotPersona', seq: this.nextSeq(), seat, personaId });
  }
  /** BL-031（FR-房间-12）：房主开局前改房间局数/玩法（开局后服务端拒绝） */
  updateRoom(patch: { maxRounds?: number; settings?: Partial<RoomSettings> }): void {
    this.send({ t: 'updateRoom', seq: this.nextSeq(), maxRounds: patch.maxRounds, settings: patch.settings });
  }
  /** BL-031（FR-AI-04/10）：玩家预设自己掉线托管所用打法 */
  setTrusteePersona(personaId: string): void {
    this.send({ t: 'setTrusteePersona', seq: this.nextSeq(), personaId });
  }
  nextRound(): void {
    this.send({ t: 'nextRound', seq: this.nextSeq() });
  }
  /** 房主主动解散牌局（不限局数时的散场入口，PRD 03 FR-房间-05） */
  dissolve(): void {
    this.send({ t: 'dissolve', seq: this.nextSeq() });
  }
  action(action: Action): void {
    this.send({ t: 'action', seq: this.nextSeq(), action });
  }  /** BL-012：请求战绩/回放列表（响应 t:'replayList'） */
  replayList(): void {
    this.send({ t: 'replayList', seq: this.nextSeq() });
  }
  /** BL-012：加载单局回放（响应 t:'replayData'；失败为 ack.ok=false 含原因 ） */
  replayLoad(gameId: string): void {
    this.send({ t: 'replayLoad', seq: this.nextSeq(), gameId });
  }
  /** BL-024：导出单局回放包（响应 t:'replayBundle'；失败为 ack.ok=false 含原因） */
  exportReplay(gameId: string): void {
    this.send({ t: 'exportReplay', seq: this.nextSeq(), gameId });
  }

  /** BL-026：结算相位晚进入/晚挂载时请求补发本局终局事件（服务端以 event 消息回投） */
  resendSettlement(): void {
    this.send({ t: 'resendSettlement', seq: this.nextSeq() });
  }

  ping(): void {
    this.send({ t: 'ping', seq: this.nextSeq() });
  }
  close(): void {
    this.transport.close();
  }
}
