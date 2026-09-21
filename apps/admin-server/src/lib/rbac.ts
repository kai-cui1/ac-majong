import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AdminRole } from '@ac-majong/persistence';
import { forbidden, unauthorized } from './errors';

/** 角色层级：super > operator > viewer（Admin 技术方案 §4 / PRD10 §3） */
const RANK: Record<AdminRole, number> = { viewer: 1, operator: 2, super: 3 };

type Done = (err?: Error) => void;

/** 需登录：从 session 取管理员挂到 req.admin，否则 401 */
export function requireAuth(req: FastifyRequest, _reply: FastifyReply, done: Done): void {
  const s = req.session?.get('admin');
  if (!s) return done(unauthorized());
  req.admin = s;
  done();
}

/** 需最低角色（含更高层级）：未登录 401、角色不足 403 */
export function requireRole(min: AdminRole) {
  return (req: FastifyRequest, _reply: FastifyReply, done: Done): void => {
    const s = req.admin ?? req.session?.get('admin');
    if (!s) return done(unauthorized());
    if (RANK[s.role] < RANK[min]) return done(forbidden());
    req.admin = s;
    done();
  };
}
