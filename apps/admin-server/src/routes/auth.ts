import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyPassword } from '../lib/password';
import { badRequest, unauthorized } from '../lib/errors';

const loginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(128) });

/** 认证路由：登录 / 登出 / 当前管理员（FR-Admin-01） */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { admin, config } = app.deps;

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = loginBody.safeParse(req.body);
      if (!parsed.success) throw badRequest('用户名/密码必填');
      const { username, password } = parsed.data;

      const row = await admin.getAdminByUsername(username);
      const ok = !!row && row.status === 'active' && (await verifyPassword(password, row.passHash));
      if (!row || !ok) {
        // 失败也留痕（result=fail），便于审计暴力尝试
        await admin.writeAudit({ adminId: row?.id ?? null, adminUsername: username, action: 'login', ip: req.ip, result: 'fail' });
        throw unauthorized('用户名或密码错误');
      }

      req.session.set('admin', { id: row.id, username: row.username, role: row.role });
      await admin.touchAdminLogin(row.id, new Date());
      await admin.writeAudit({ adminId: row.id, adminUsername: row.username, action: 'login', targetType: 'admin', targetId: String(row.id), ip: req.ip, result: 'success' });

      const csrfToken = config.csrf ? reply.generateCsrf() : undefined;
      return reply.send({ admin: { id: row.id, username: row.username, role: row.role }, csrfToken });
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const a = req.session.get('admin');
    if (a) await admin.writeAudit({ adminId: a.id, adminUsername: a.username, action: 'logout', ip: req.ip, result: 'success' });
    await req.session.destroy();
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (req, reply) => {
    const a = req.session.get('admin');
    if (!a) throw unauthorized();
    // 会话恢复后补发 CSRF 令牌（供刷新后的写操作使用）
    const csrfToken = config.csrf ? reply.generateCsrf() : undefined;
    return { admin: a, csrfToken };
  });
}
