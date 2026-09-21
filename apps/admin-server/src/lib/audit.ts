import type { FastifyRequest } from 'fastify';
import type { AdminStore } from '@ac-majong/persistence';

/** 审计元信息（Admin 技术方案 §7）：动作 + 目标 + 前后值 */
export interface AuditMeta {
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * 审计切面：执行 fn，成功/失败均落 admin_audit_logs（含当前管理员、ip、result）。
 * 只读查询不走此切面（一期不记只读审计）。
 */
export async function withAudit<T>(admin: AdminStore, req: FastifyRequest, meta: AuditMeta, fn: () => Promise<T>): Promise<T> {
  const a = req.admin ?? req.session?.get('admin') ?? null;
  const base = {
    adminId: a?.id ?? null,
    adminUsername: a?.username ?? null,
    action: meta.action,
    targetType: meta.targetType ?? null,
    targetId: meta.targetId ?? null,
    beforeJson: meta.before ?? null,
    ip: req.ip ?? null,
  };
  try {
    const out = await fn();
    await admin.writeAudit({ ...base, afterJson: meta.after ?? null, result: 'success' });
    return out;
  } catch (e) {
    await admin.writeAudit({ ...base, afterJson: { error: e instanceof Error ? e.message : String(e) }, result: 'fail' });
    throw e;
  }
}
