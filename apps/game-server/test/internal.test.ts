import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { RoomManager } from '../src/roomManager';
import { startInternalHttp } from '../src/internal';
import type { Connection } from '../src/connection';
import type { ServerMsg } from '@ac-majong/protocol';

class MockConn implements Connection {
  userId: string;
  sent: ServerMsg[] = [];
  constructor(userId: string) { this.userId = userId; }
  send(msg: ServerMsg): void { this.sent.push(msg); }
  close(): void {}
}

const TOKEN = 'test-internal-secret';
let rm: RoomManager;
let server: http.Server;
let base: string;
let roomId: string;

// FR-Admin-10 内网只读 inspect 端点：预共享密钥鉴权 + 只读转呈 RoomActor.inspect()（真定时器 + 真 HTTP）
beforeAll(async () => {
  rm = new RoomManager();
  const room = rm.create('u0', new MockConn('u0'), 8, 'u0'); // waiting 相位即可验证端点鉴权/转呈
  roomId = room.id;
  server = startInternalHttp(0, rm, TOKEN); // 端口 0 = 系统分配空闲端口
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rm.dispose();
});

const withToken = (t: string): { headers: Record<string, string> } => ({ headers: { 'x-internal-token': t } });

describe('FR-Admin-10 内网 inspect 端点鉴权', () => {
  it('缺失密钥 → 401', async () => {
    const res = await fetch(`${base}/internal/rooms/${roomId}/inspect`);
    expect(res.status).toBe(401);
  });

  it('错误密钥 → 401', async () => {
    const res = await fetch(`${base}/internal/rooms/${roomId}/inspect`, withToken('wrong-token'));
    expect(res.status).toBe(401);
  });

  it('正确密钥 + 存在的房 → 200，转呈 inspect（含 state/gameId/stall 键）', async () => {
    const res = await fetch(`${base}/internal/rooms/${roomId}/inspect`, withToken(TOKEN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.room).toBe(roomId);
    expect('state' in body).toBe(true);
    expect('gameId' in body).toBe(true);
    expect('stall' in body).toBe(true);
    expect('timers' in body).toBe(true);
  });

  it('正确密钥 + 不存在的房 → 404', async () => {
    const res = await fetch(`${base}/internal/rooms/000000/inspect`, withToken(TOKEN));
    expect(res.status).toBe(404);
  });

  it('未知路径 → 404（即便带正确密钥，端点只暴露 inspect）', async () => {
    const res = await fetch(`${base}/internal/secret`, withToken(TOKEN));
    expect(res.status).toBe(404);
  });
});
