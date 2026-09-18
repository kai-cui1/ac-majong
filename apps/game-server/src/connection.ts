import type { ServerMsg } from '@ac-majong/protocol';

/** 平台无关的连接抽象：WS 网关包装真实 socket，测试用 mock */
export interface Connection {
  userId: string;
  send(msg: ServerMsg): void;
  close(code?: number, reason?: string): void;
}
