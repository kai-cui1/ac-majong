import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UserRow } from '@ac-majong/persistence';
import { requireAuth } from '../lib/rbac';
import { notFound } from '../lib/errors';
import { dateRangeFields, pageFields } from '../lib/query';

const listQuery = z.object({ q: z.string().max(64).optional(), ...dateRangeFields, ...pageFields });

/** 对外投影：剔除玩家密码哈希（admin 前端无需，避免泄露） */
const publicUser = (u: UserRow): Omit<UserRow, 'passHash'> => {
  const { passHash: _omit, ...rest } = u;
  void _omit;
  return rest;
};

/** 用户查询（只读，FR-Admin-04） */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  const { game } = app.deps;

  app.get('/api/users', { preHandler: requireAuth }, async (req) => {
    const q = listQuery.parse(req.query);
    const page = await game.queryUsers(q);
    return { ...page, items: page.items.map(publicUser) };
  });

  app.get('/api/users/:openid', { preHandler: requireAuth }, async (req) => {
    const { openid } = req.params as { openid: string };
    const detail = await game.getUserDetail(openid);
    if (!detail.profile) throw notFound('用户不存在');
    return { ...detail, profile: publicUser(detail.profile) };
  });
}
