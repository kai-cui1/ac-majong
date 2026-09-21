import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../lib/rbac';
import { badRequest, notFound } from '../lib/errors';
import { dateRangeFields, pageFields } from '../lib/query';

const listQuery = z.object({
  adminId: z.coerce.number().int().positive().optional(),
  action: z.string().max(48).optional(),
  targetType: z.string().max(32).optional(),
  ...dateRangeFields,
  ...pageFields,
});

/** 审计日志查询（仅 super，FR-Admin-07） */
export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const { admin } = app.deps;

  app.get('/api/audit', { preHandler: requireRole('super') }, async (req) => {
    const q = listQuery.parse(req.query);
    return admin.queryAudit(q);
  });

  app.get('/api/audit/:id', { preHandler: requireRole('super') }, async (req) => {
    const { id } = req.params as { id: string };
    const auditId = Number(id);
    if (!Number.isInteger(auditId) || auditId <= 0) throw badRequest('非法审计 id');
    const row = await admin.getAudit(auditId);
    if (!row) throw notFound('审计记录不存在');
    return row;
  });
}
