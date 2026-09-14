/** 平台无关传输抽象：游戏网络层只依赖它，微信/Web 各一份实现（决策3） */
export interface Transport {
  connect(): Promise<void>;
  send(data: string): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (code?: number, reason?: string) => void): void;
  close(): void;
}

type MsgCb = (data: string) => void;
type CloseCb = (code?: number, reason?: string) => void;

/**
 * 浏览器 / Node 原生 WebSocket（HTML5 版 + 本地测试）。
 * 依赖全局 WebSocket（浏览器原生；Node ≥22 内置；也可注入 polyfill）。
 */
export class WebTransport implements Transport {
  private ws?: WebSocket;
  private msgCbs: MsgCb[] = [];
  private closeCbs: CloseCb[] = [];

  constructor(private url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
      if (!WS) return reject(new Error('当前环境无全局 WebSocket'));
      const ws = new WS(this.url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('WebSocket 连接错误'));
      ws.onmessage = (ev: MessageEvent) => {
        const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
        for (const cb of this.msgCbs) cb(data);
      };
      ws.onclose = (ev: CloseEvent) => {
        for (const cb of this.closeCbs) cb(ev.code, ev.reason);
      };
    });
  }

  send(data: string): void {
    this.ws?.send(data);
  }
  onMessage(cb: MsgCb): void {
    this.msgCbs.push(cb);
  }
  onClose(cb: CloseCb): void {
    this.closeCbs.push(cb);
  }
  close(): void {
    this.ws?.close();
  }
}

/**
 * 微信小游戏：wx.cloud.connectContainer（云托管 WebSocket，免配域名，返回标准 socketTask）。
 * 仅在微信运行时可用；此处以 globalThis.wx 弱引用，避免非微信环境编译/运行报错。
 */
export class WeChatTransport implements Transport {
  private task?: {
    send(o: { data: string }): void;
    close(o: Record<string, unknown>): void;
    onOpen(cb: () => void): void;
    onMessage(cb: (res: { data: unknown }) => void): void;
    onClose(cb: (res: { code?: number; reason?: string }) => void): void;
    onError(cb: (e: unknown) => void): void;
  };
  private msgCbs: MsgCb[] = [];
  private closeCbs: CloseCb[] = [];

  constructor(private opts: { env: string; service: string; path?: string }) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wx = (globalThis as { wx?: { cloud?: { connectContainer?: (o: unknown) => Promise<{ socketTask: never }> } } }).wx;
      const cc = wx?.cloud?.connectContainer;
      if (!cc) return reject(new Error('非微信环境或缺少 wx.cloud.connectContainer'));
      cc.call(wx!.cloud, {
        config: { env: this.opts.env },
        service: this.opts.service,
        path: this.opts.path ?? '/',
      })
        .then(({ socketTask }) => {
          this.task = socketTask as unknown as typeof this.task;
          this.task!.onOpen(() => resolve());
          this.task!.onError(() => reject(new Error('connectContainer 连接错误')));
          this.task!.onMessage((res) => {
            const data = typeof res.data === 'string' ? res.data : String(res.data);
            for (const cb of this.msgCbs) cb(data);
          });
          this.task!.onClose((res) => {
            for (const cb of this.closeCbs) cb(res?.code, res?.reason);
          });
        })
        .catch(() => reject(new Error('connectContainer 调用失败')));
    });
  }

  send(data: string): void {
    this.task?.send({ data });
  }
  onMessage(cb: MsgCb): void {
    this.msgCbs.push(cb);
  }
  onClose(cb: CloseCb): void {
    this.closeCbs.push(cb);
  }
  close(): void {
    this.task?.close({});
  }
}
