import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ArbitrationStatus } from '@ac-majong/persistence';
import { requireAuth, requireRole } from '../lib/rbac';
import { withAudit } from '../lib/audit';
import { badRequest, notFound } from '../lib/errors';
import { dateRangeFields, pageFields } from '../lib/query';

const listQuery = z.object({ roomId: z.string().max(16).optional(), ...dateRangeFields, ...pageFields });
const arbBody = z.object({
  status: z.enum(['pending', 'accepted', 'rejected', 'resolved']).default('pending'),
  verdict: z.string().max(32).nullish(),
  note: z.string().max(2000).nullish(),
});

/** 对局查询 / 回放 / 导出回放包 / 仲裁（FR-Admin-05/06/08）。
 * 写操作的 CSRF 校验由 app.ts 的全局钩子统一处理，此处仅置角色守卫。 */
export async function gameRoutes(app: FastifyInstance): Promise<void> {
  const { game, admin, replay } = app.deps;

  app.get('/api/games', { preHandler: requireAuth }, async (req) => {
    const q = listQuery.parse(req.query);
    return game.queryGames(q);
  });

  app.get('/api/games/:gameId', { preHandler: requireAuth }, async (req) => {
    const { gameId } = req.params as { gameId: string };
    const detail = await game.getGameDetail(gameId);
    if (!detail.game) throw notFound('对局不存在');
    const arbitrations = await admin.listArbitrationsByGame(gameId);
    return { ...detail, arbitrations };
  });

  // 逐帧回放（viewer+）
  app.get('/api/games/:gameId/replay', { preHandler: requireAuth }, async (req) => {
    const { gameId } = req.params as { gameId: string };
    const data = await replay.frames(gameId);
    if (!data) throw notFound('回放数据缺失');
    return data;
  });

  // 导出回放包（operator+，申诉取证 BL-024）
  app.get('/api/games/:gameId/replay-bundle', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { gameId } = req.params as { gameId: string };
    const bundle = await replay.bundle(gameId);
    if (!bundle) throw notFound('回放数据缺失');
    reply.header('content-disposition', `attachment; filename="${gameId.replace(':', '_')}.replay.json"`);
    return reply.type('application/json').send(bundle);
  });

  // 某局仲裁列表（viewer+）
  app.get('/api/games/:gameId/arbitrations', { preHandler: requireAuth }, async (req) => {
    const { gameId } = req.params as { gameId: string };
    return admin.listArbitrationsByGame(gameId);
  });

  // 录入仲裁（operator+，纯留痕）
  app.post('/api/games/:gameId/arbitrations', { preHandler: requireRole('operator') }, async (req) => {
    const { gameId } = req.params as { gameId: string };
    const body = arbBody.parse(req.body);
    const g = await game.getGameDetail(gameId);
    if (!g.game) throw notFound('对局不存在');
    return withAudit(
      admin,
      req,
      { action: 'arbitration.create', targetType: 'game', targetId: gameId, after: body },
      () => admin.createArbitration({ gameId, adminId: req.admin!.id, status: body.status as ArbitrationStatus, verdict: body.verdict ?? null, note: body.note ?? null }),
    );
  });

  // 编辑仲裁（operator+）
  app.patch('/api/arbitrations/:id', { preHandler: requireRole('operator') }, async (req) => {
    const { id } = req.params as { id: string };
    const arbId = Number(id);
    if (!Number.isInteger(arbId) || arbId <= 0) throw badRequest('非法仲裁 id');
    const patch = arbBody.partial().parse(req.body);
    const before = await admin.getArbitration(arbId);
    if (!before) throw notFound('仲裁记录不存在');
    return withAudit(
      admin,
      req,
      { action: 'arbitration.update', targetType: 'arbitration', targetId: id, before, after: patch },
      () => admin.updateArbitration(arbId, patch as { status?: ArbitrationStatus; verdict?: string | null; note?: string | null }),
    );
  });
}
