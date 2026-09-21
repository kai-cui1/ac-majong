import { and, count, desc, eq, gte, lte } from 'drizzle-orm';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import { adminAuditLogs, admins, arbitrations } from './schema';
import type {
  AdminPublic,
  AdminRow,
  AdminStore,
  ArbitrationRow,
  ArbitrationStatus,
  AuditFilter,
  AuditLogRow,
  Page,
  PageQuery,
} from './types';

const DEFAULT_SIZE = 20;
const MAX_SIZE = 200;

function clampPage(q?: PageQuery): { page: number; size: number; offset: number } {
  const page = Math.max(1, q?.page ?? 1);
  const size = Math.min(MAX_SIZE, Math.max(1, q?.size ?? DEFAULT_SIZE));
  return { page, size, offset: (page - 1) * size };
}

const toPublic = (r: AdminRow): AdminPublic => {
  const { passHash: _omit, ...rest } = r;
  void _omit;
  return rest;
};

/** AdminStore 的 Drizzle 实现（admin 自有表：admins / arbitrations / admin_audit_logs）。 */
export class DrizzleAdminStore implements AdminStore {
  constructor(private readonly db: MySql2Database) {}

  // ---- admins ----
  async createAdmin(input: { username: string; passHash: string; role: AdminRow['role'] }): Promise<AdminPublic> {
    const [res] = await this.db.insert(admins).values({ username: input.username, passHash: input.passHash, role: input.role });
    const id = Number(res.insertId);
    const row = await this.getAdminByIdOrThrow(id);
    return toPublic(row);
  }

  async getAdminByUsername(username: string): Promise<AdminRow | null> {
    const rows = await this.db.select().from(admins).where(eq(admins.username, username)).limit(1);
    return (rows[0] as AdminRow | undefined) ?? null;
  }

  async getAdmin(id: number): Promise<AdminPublic | null> {
    const rows = await this.db.select().from(admins).where(eq(admins.id, id)).limit(1);
    const r = rows[0] as AdminRow | undefined;
    return r ? toPublic(r) : null;
  }

  private async getAdminByIdOrThrow(id: number): Promise<AdminRow> {
    const rows = await this.db.select().from(admins).where(eq(admins.id, id)).limit(1);
    const r = rows[0] as AdminRow | undefined;
    if (!r) throw new Error(`admin not found: ${id}`);
    return r;
  }

  async listAdmins(q?: PageQuery): Promise<Page<AdminPublic>> {
    const { page, size, offset } = clampPage(q);
    const [totalRow, rows] = await Promise.all([
      this.db.select({ value: count() }).from(admins),
      this.db.select().from(admins).orderBy(desc(admins.createdAt)).limit(size).offset(offset),
    ]);
    return { items: (rows as AdminRow[]).map(toPublic), total: Number(totalRow[0]?.value ?? 0), page, size };
  }

  async updateAdmin(id: number, patch: { role?: AdminRow['role']; status?: AdminRow['status']; passHash?: string }): Promise<AdminPublic | null> {
    const set: Partial<typeof admins.$inferInsert> = {};
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.passHash !== undefined) set.passHash = patch.passHash;
    if (Object.keys(set).length === 0) return this.getAdmin(id);
    await this.db.update(admins).set(set).where(eq(admins.id, id));
    return this.getAdmin(id);
  }

  async touchAdminLogin(id: number, at: Date): Promise<void> {
    await this.db.update(admins).set({ lastLoginAt: at }).where(eq(admins.id, id));
  }

  async countAdmins(): Promise<number> {
    const rows = await this.db.select({ value: count() }).from(admins);
    return Number(rows[0]?.value ?? 0);
  }

  // ---- arbitrations ----
  async createArbitration(input: { gameId: string; adminId: number; status?: ArbitrationStatus; verdict?: string | null; note?: string | null }): Promise<ArbitrationRow> {
    const [res] = await this.db.insert(arbitrations).values({
      gameId: input.gameId,
      adminId: input.adminId,
      status: input.status ?? 'pending',
      verdict: input.verdict ?? null,
      note: input.note ?? null,
    });
    const id = Number(res.insertId);
    const rows = await this.db.select().from(arbitrations).where(eq(arbitrations.id, id)).limit(1);
    return rows[0] as ArbitrationRow;
  }

  async updateArbitration(id: number, patch: { status?: ArbitrationStatus; verdict?: string | null; note?: string | null }): Promise<ArbitrationRow | null> {
    const set: Partial<typeof arbitrations.$inferInsert> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.verdict !== undefined) set.verdict = patch.verdict;
    if (patch.note !== undefined) set.note = patch.note;
    if (Object.keys(set).length > 0) await this.db.update(arbitrations).set(set).where(eq(arbitrations.id, id));
    const rows = await this.db.select().from(arbitrations).where(eq(arbitrations.id, id)).limit(1);
    return (rows[0] as ArbitrationRow | undefined) ?? null;
  }

  async getArbitration(id: number): Promise<ArbitrationRow | null> {
    const rows = await this.db.select().from(arbitrations).where(eq(arbitrations.id, id)).limit(1);
    return (rows[0] as ArbitrationRow | undefined) ?? null;
  }

  async listArbitrationsByGame(gameId: string): Promise<ArbitrationRow[]> {
    const rows = await this.db.select().from(arbitrations).where(eq(arbitrations.gameId, gameId)).orderBy(desc(arbitrations.createdAt));
    return rows as ArbitrationRow[];
  }

  // ---- audit ----
  async writeAudit(log: {
    adminId: number | null;
    adminUsername: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    beforeJson?: unknown;
    afterJson?: unknown;
    ip?: string | null;
    result?: 'success' | 'fail';
  }): Promise<void> {
    await this.db.insert(adminAuditLogs).values({
      adminId: log.adminId,
      adminUsername: log.adminUsername,
      action: log.action,
      targetType: log.targetType ?? null,
      targetId: log.targetId ?? null,
      beforeJson: log.beforeJson ?? null,
      afterJson: log.afterJson ?? null,
      ip: log.ip ?? null,
      result: log.result ?? 'success',
    });
  }

  async queryAudit(filter?: AuditFilter): Promise<Page<AuditLogRow>> {
    const { page, size, offset } = clampPage(filter);
    const conds = [];
    if (filter?.adminId !== undefined) conds.push(eq(adminAuditLogs.adminId, filter.adminId));
    if (filter?.action) conds.push(eq(adminAuditLogs.action, filter.action));
    if (filter?.targetType) conds.push(eq(adminAuditLogs.targetType, filter.targetType));
    if (filter?.from) conds.push(gte(adminAuditLogs.at, filter.from));
    if (filter?.to) conds.push(lte(adminAuditLogs.at, filter.to));
    const where = conds.length ? and(...conds) : undefined;
    const [totalRow, rows] = await Promise.all([
      this.db.select({ value: count() }).from(adminAuditLogs).where(where),
      this.db.select().from(adminAuditLogs).where(where).orderBy(desc(adminAuditLogs.at)).limit(size).offset(offset),
    ]);
    return { items: rows as AuditLogRow[], total: Number(totalRow[0]?.value ?? 0), page, size };
  }

  async getAudit(id: number): Promise<AuditLogRow | null> {
    const rows = await this.db.select().from(adminAuditLogs).where(eq(adminAuditLogs.id, id)).limit(1);
    return (rows[0] as AuditLogRow | undefined) ?? null;
  }
}
