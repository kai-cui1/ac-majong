import type { Action } from '../engine/index';
import type { ClientMsg, ServerMsg, ViewState, RoomView } from '../protocol/index';
import type { Transport } from './transport';

export interface GameClientHandlers {
  onGameView?: (v: ViewState) => void;
  onRoomView?: (r: RoomView) => void;
  onEvent?: (events: ServerMsg & { t: 'event' }) => void;
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
  userId: string | null = null;

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
        break;
      case 'roomView':
        this.room = m.room;
        this.handlers.onRoomView?.(m.room);
        break;
      case 'gameView':
        this.view = m.view;
        this.handlers.onGameView?.(m.view);
        break;
      case 'event':
        this.handlers.onEvent?.(m);
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

  private send(msg: ClientMsg): void {
    this.transport.send(JSON.stringify(msg));
  }
  private nextSeq(): number {
    return ++this.seq;
  }

  auth(token: string): void {
    this.send({ t: 'auth', seq: this.nextSeq(), token });
  }
  create(maxRounds = 8): void {
    this.send({ t: 'create', seq: this.nextSeq(), maxRounds });
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
  action(action: Action): void {
    this.send({ t: 'action', seq: this.nextSeq(), action });
  }
  ping(): void {
    this.send({ t: 'ping', seq: this.nextSeq() });
  }
  close(): void {
    this.transport.close();
  }
}
