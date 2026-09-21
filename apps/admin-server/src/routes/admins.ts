import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminRole, AdminStatus } from '@ac-majong/persistence';
import { requireRole } from '../lib/rbac';
import { withAudit } from '../lib/audit';
import { hashPassword, validatePassword, validateUsername } from '../lib/password';
import { badRequest, conflict, notFound } from '../lib/errors';
import { pageFields } from '../lib/query';

const listQuery = z.object({ ...pageFields });
const createBody = z.object({ username: z.string(), password: z.string(), role: z.enum(['super', 'operator', 'viewer']) });
const patchBody = z.object({
  role: z.enum(['super', 'operator', 'viewer']).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  password: z.string().optional(),
});

/** 管理员账号管理（仅 super，FR-Admin-03） */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const { admin } = app.deps;

  app.get('/api/admins', { preHandler: requireRole('super') }, async (req) => {
    const q = listQuery.parse(req.query);
    return admin.listAdmins(q);
  });

  app.post('/api/admins', { preHandler: requireRole('super') }, async (req) => {
    const body = createBody.parse(req.body);
    const badName = validateUsername(body.username);
    const badPass = validatePassword(body.password);
    if (badName) throw badRequest(badName);
    if (badPass) throw badRequest(badPass);
    if (await admin.getAdminByUsername(body.username)) throw conflict('用户名已存在');
    const passHash = await hashPassword(body.password);
    return withAudit(
      admin,
      req,
      { action: 'admin.create', targetType: 'admin', after: { username: body.username, role: body.role } },
      async () => {
        const created = await admin.createAdmin({ username: body.username, passHash, role: body.role as AdminRole });
        return created;
      },
    );
  });

  app.patch('/api/admins/:id', { preHandler: requireRole('super') }, async (req) => {
    const { id } = req.params as { id: string };
    const adminId = Number(id);
    if (!Number.isInteger(adminId) || adminId <= 0) throw badRequest('非法管理员 id');
    const body = patchBody.parse(req.body);
    const before = await admin.getAdmin(adminId);
    if (!before) throw notFound('管理员不存在');
    if (body.password !== undefined) {
      const badPass = validatePassword(body.password);
      if (badPass) throw badRequest(badPass);
    }
    const patch: { role?: AdminRole; status?: AdminStatus; passHash?: string } = {};
    if (body.role !== undefined) patch.role = body.role as AdminRole;
    if (body.status !== undefined) patch.status = body.status as AdminStatus;
    if (body.password !== undefined) patch.passHash = await hashPassword(body.password);
    // 审计不落密码：after 仅记 role/status 变更
    const after = { role: body.role, status: body.status, passwordChanged: body.password !== undefined };
    return withAudit(admin, req, { action: 'admin.update', targetType: 'admin', targetId: id, before, after }, () => admin.updateAdmin(adminId, patch));
  });
}
