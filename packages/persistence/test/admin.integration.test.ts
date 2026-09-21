import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createAdminPersistence, buildReplayBundle } from '../src/index';
import type { AdminPersistence } from '../src/index';

// 仅当 DB_IT=1 且提供 DATABASE_URL 时运行（需 deploy/docker compose up -d 且已 drizzle-kit migrate 建 admin 三表）
const DB_IT = process.env.DB_IT === '1';

describe.skipIf(!DB_IT)('Admin 数据层集成（Drizzle · DB_IT=1 启用）', () => {
  let p: AdminPersistence;
  const sfx = Date.now();

  beforeAll(async () => {
    p = await createAdminPersistence();
  });
  afterAll(async () => {
    await p?.close();
  });

  it('管理员：创建 / 按名查 / 列表分页 / 改角色状态 / 记登录', async () => {
    const username = `adm_${sfx}`;
    const created = await p.admin.createAdmin({ username, passHash: 's$salt$hash', role: 'viewer' });
    expect(created.id).toBeGreaterThan(0);
    expect((created as { passHash?: string }).passHash).toBeUndefined(); // 对外不含哈希

    const byName = await p.admin.getAdminByUsername(username);
    expect(byName?.role).toBe('viewer');
    expect(byName?.passHash).toBe('s$salt$hash'); // 内部可读哈希用于校验

    const updated = await p.admin.updateAdmin(created.id, { role: 'operator', status: 'active' });
    expect(updated?.role).toBe('operator');

    await p.admin.touchAdminLogin(created.id, new Date());
    expect((await p.admin.getAdmin(created.id))?.lastLoginAt).toBeInstanceOf(Date);

    const list = await p.admin.listAdmins({ page: 1, size: 5 });
    expect(list.items.length).toBeLessThanOrEqual(5);
    expect(list.total).toBeGreaterThanOrEqual(1);
    expect(list.items.every((a) => (a as { passHash?: string }).passHash === undefined)).toBe(true);
  });

  it('仲裁：录入 / 编辑 / 按局列出（纯留痕）', async () => {
    const gameId = `IT${sfx}:1`;
    const arb = await p.admin.createArbitration({ gameId, adminId: 1, status: 'pending', note: '待核' });
    expect(arb.id).toBeGreaterThan(0);
    const upd = await p.admin.updateArbitration(arb.id, { status: 'resolved', verdict: 'valid', note: '判定有效' });
    expect(upd?.status).toBe('resolved');
    expect(upd?.verdict).toBe('valid');
    const list = await p.admin.listArbitrationsByGame(gameId);
    expect(list.map((a) => a.id)).toContain(arb.id);
  });

  it('审计：写入 + 多条件分页检索 + 单条含 before/after', async () => {
    await p.admin.writeAudit({
      adminId: 1, adminUsername: 'root', action: 'arbitration.update',
      targetType: 'arbitration', targetId: '1', beforeJson: { status: 'pending' }, afterJson: { status: 'resolved' },
      ip: '127.0.0.1', result: 'success',
    });
    const page = await p.admin.queryAudit({ action: 'arbitration.update', page: 1, size: 10 });
    expect(page.total).toBeGreaterThanOrEqual(1);
    const one = await p.admin.getAudit(page.items[0]!.id);
    expect(one?.afterJson).toMatchObject({ status: 'resolved' });
  });

  it('游戏只读检索 + 回放数据源：queryUsers / buildReplayBundle', async () => {
    const page = await p.game.queryUsers({ page: 1, size: 10 });
    expect(page.page).toBe(1);
    expect(Array.isArray(page.items)).toBe(true);
    // replaySource 满足 buildReplayBundle 的最小只读契约（缺失对局返回 null，不抛错）
    const bundle = await buildReplayBundle(p.game.replaySource(), `nope_${sfx}`);
    expect(bundle).toBeNull();
  });
});
