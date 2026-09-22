import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { RoomManager } from './roomManager';
import { createLogger } from './logger';

const log = createLogger('internal');

/** 常量时间比较预共享密钥（防时序侧信道） */
function tokenMatches(got: string, want: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * FR-Admin-10 实时房间监控：内网 + 预共享密钥 + 只读 inspect 端点（供 admin-server 服务端代理调用）。
 * 独立于 dev-only 无鉴权 `/dev/*`（见 diag.ts）；仅当 `INTERNAL_TOKEN` 配置时启动（index.ts），生产不对公网开放。
 * - GET /internal/rooms/:id/inspect → RoomActor.inspect()（含完整 `state: TableState` 上帝全知台态）
 * 鉴权：请求头 `x-internal-token` == `INTERNAL_TOKEN`（不符 401）；只读无副作用：仅调 inspect()，不触 WS/RoomManager 写路径、不影响对局。
 */
export function startInternalHttp(port: number, rooms: RoomManager, token: string): http.Server {
  const server = http.createServer((req, res) => {
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const got = req.headers['x-internal-token'];
    if (typeof got !== 'string' || !tokenMatches(got, token)) return json(401, { error: 'unauthorized' });
    const m = (req.url ?? '').match(/^\/internal\/rooms\/(\w+)\/inspect$/);
    if (m) {
      const room = rooms.get(m[1]!);
      return room ? json(200, room.inspect()) : json(404, { error: 'room not found' });
    }
    return json(404, { error: 'not found' });
  });
  server.listen(port, () => log.info(`internal HTTP listening on :${port} (FR-Admin-10 inspect, token-auth)`));
  return server;
}
