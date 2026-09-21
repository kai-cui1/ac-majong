import http from 'node:http';
import type { RoomManager } from './roomManager';
import { buildReplayBundle, type GameStore } from '@ac-majong/persistence';
import { createLogger } from './logger';

const log = createLogger('diag');

/**
 * BL-022/BL-024 dev-only 自检 HTTP（仅 DEV_TOOLS=1 启动，见 index.ts）：
 * - GET /dev/rooms            活跃房列表（id+phase）
 * - GET /dev/room/:id         房间权威状态 dump（RoomActor.inspect，定位「在等谁/卡在哪」）
 * - GET /dev/export/:gameId   单局回放包（离线可确定性重演/申诉取证）
 * 不做鉴权，仅本地诊断用；生产不启用该端口。
 */
export function startDiagHttp(port: number, rooms: RoomManager, store: GameStore): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body, null, 2));
    };
    if (url === '/dev/rooms') return json(200, rooms.list().map((r) => ({ room: r.id, phase: r.phase })));
    let m = url.match(/^\/dev\/room\/(\w+)$/);
    if (m) {
      const room = rooms.get(m[1]!);
      return room ? json(200, room.inspect()) : json(404, { error: 'room not found' });
    }
    m = url.match(/^\/dev\/export\/([\w:-]+)$/);
    if (m) {
      buildReplayBundle(store, decodeURIComponent(m[1]!))
        .then((b) => (b ? json(200, b) : json(404, { error: 'game not found' })))
        .catch((e) => json(500, { error: String(e) }));
      return;
    }
    return json(404, { error: 'not found' });
  });
  server.listen(port, () => log.info(`diag HTTP listening on :${port} (DEV_TOOLS)`));
  return server;
}
