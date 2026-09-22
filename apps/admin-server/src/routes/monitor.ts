import type { FastifyInstance } from 'fastify';
import type { AdminGameQueries } from '@ac-majong/persistence';
import { requireRole } from '../lib/rbac';
import type { RoomInspect } from '../lib/gameInspect';
import { createLogger } from '../logger';

const log = createLogger('monitor');

/** 降级兜底：MySQL 已落库事实（房间状态 + 积分账本），实时台态不可用时展示（Admin 技术方案 §10.3） */
interface RoomFallback { status: string; memberScores: unknown }

type MonitorResponse =
  | { available: true; roomId: string; inspect: RoomInspect }
  | { available: false; roomId: string; reason: string; fallback: RoomFallback | null };

async function fallbackOf(game: AdminGameQueries, roomId: string): Promise<RoomFallback | null> {
  try {
    const { room } = await game.getRoomDetail(roomId);
    return room ? { status: String(room.status), memberScores: room.memberScores ?? null } : null;
  } catch (e) {
    log.error('降级读取房间已落库事实失败', { roomId, message: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * FR-Admin-10 实时房间监控（operator+，受控只读例外，Admin 技术方案 §10.3）。
 * 拉 game-server 内网 inspect 全量台态转呈前端；不可达 / 未配置 / 房不存在 → 降级 {available:false, fallback:已落库事实}。
 * 审计节流：仅「开启监控 / 手动刷新」(?audit=1) 记一条 monitor.inspect（result 反映 available），自动轮询不逐条记（避免 2s 刷屏）。
 */
export async function monitorRoutes(app: FastifyInstance): Promise<void> {
  const { monitor, game, admin } = app.deps;

  app.get('/api/monitor/rooms/:roomId', { preHandler: requireRole('operator') }, async (req) => {
    const { roomId } = req.params as { roomId: string };
    const query = req.query as { audit?: string };

    let out: MonitorResponse;
    if (!monitor.enabled) {
      out = { available: false, roomId, reason: 'not_configured', fallback: await fallbackOf(game, roomId) };
    } else {
      try {
        out = { available: true, roomId, inspect: await monitor.inspect(roomId) };
      } catch (e) {
        out = { available: false, roomId, reason: e instanceof Error ? e.message : String(e), fallback: await fallbackOf(game, roomId) };
      }
    }

    // 审计节流：仅开启监控 / 手动刷新记一条（best-effort，落库失败不阻断监控响应）
    if (query?.audit === '1') {
      const a = req.admin!;
      void admin
        .writeAudit({
          adminId: a.id, adminUsername: a.username, action: 'monitor.inspect', targetType: 'room', targetId: roomId,
          afterJson: { available: out.available, reason: out.available ? undefined : out.reason },
          ip: req.ip, result: out.available ? 'success' : 'fail',
        })
        .catch((e) => log.error('monitor.inspect 审计落库失败', e));
    }
    return out;
  });
}
