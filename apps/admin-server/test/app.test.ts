import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AdminGameQueries, AdminStore } from '@ac-majong/persistence';
import { buildApp } from '../src/app';
import type { AdminConfig } from '../src/config';
import type { AppDeps } from '../src/deps';
import type { ReplayService } from '../src/lib/replay';
import type { GameInspect } from '../src/lib/gameInspect';
import { hashPassword } from '../src/lib/password';

const config: AdminConfig = {
  port: 0,
  databaseUrl: 'mysql://localhost/none',
  sessionSecret: 'test-secret-'.repeat(4), // ≥32
  sessionTtlSec: 3600,
  logLevel: 'silent',
  csrf: false,
  rateLimit: false,
  cookieSecure: false,
};

interface AuditRec { action: string; result?: string; [k: string]: unknown }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let app: FastifyInstance;
let audits: AuditRec[];
let superCookie = '';
let viewerCookie = '';
// FR-Admin-10 可控监控 mock 状态：默认 enabled=false（降级）；用例切 enabled/payload 验证可用/降级/审计节流
const monitorState = { enabled: false, payload: null as unknown };

function cookieOf(res: { headers: Record<string, string | string[] | undefined> }): string {
  const sc = res.headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : sc ? [sc] : [];
  return arr.map((c) => c.split(';')[0]).join('; ');
}

beforeAll(async () => {
  const HASH = await hashPassword('pass1234');
  const admins: Any[] = [
    { id: 1, username: 'root', passHash: HASH, role: 'super', status: 'active', createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null },
    { id: 2, username: 'view', passHash: HASH, role: 'viewer', status: 'active', createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null },
  ];
  audits = [];
  const arbitrations: Any[] = [];
  let arbSeq = 0;
  const strip = (a: Any) => { const { passHash: _p, ...rest } = a; return rest; };

  const admin = {
    getAdminByUsername: async (u: string) => admins.find((a) => a.username === u) ?? null,
    getAdmin: async (id: number) => { const a = admins.find((x) => x.id === id); return a ? strip(a) : null; },
    createAdmin: async (i: Any) => { const a = { id: 100 + admins.length, ...i, status: 'active', createdAt: new Date(), updatedAt: new Date(), lastLoginAt: null }; admins.push(a); return strip(a); },
    listAdmins: async () => ({ items: admins.map(strip), total: admins.length, page: 1, size: 20 }),
    updateAdmin: async (id: number, p: Any) => { const a = admins.find((x) => x.id === id); if (a) Object.assign(a, p); return a ? strip(a) : null; },
    touchAdminLogin: async (id: number, at: Date) => { const a = admins.find((x) => x.id === id); if (a) a.lastLoginAt = at; },
    countAdmins: async () => admins.length,
    createArbitration: async (i: Any) => { const r = { status: 'pending', verdict: null, note: null, createdAt: new Date(), updatedAt: new Date(), ...i, id: ++arbSeq }; arbitrations.push(r); return r; },
    updateArbitration: async (id: number, p: Any) => { const r = arbitrations.find((x) => x.id === id); if (r) Object.assign(r, p); return r ?? null; },
    getArbitration: async (id: number) => arbitrations.find((x) => x.id === id) ?? null,
    listArbitrationsByGame: async (gid: string) => arbitrations.filter((x) => x.gameId === gid),
    writeAudit: async (l: AuditRec) => { audits.push(l); },
    queryAudit: async () => ({ items: audits, total: audits.length, page: 1, size: 20 }),
    getAudit: async () => null,
  } as unknown as AdminStore;

  const game = {
    queryUsers: async () => ({ items: [{ openid: 'u1', nickname: '甲', avatarUrl: '' }], total: 1, page: 1, size: 20 }),
    getUserDetail: async (o: string) => ({ profile: { openid: o, nickname: '甲', avatarUrl: '' }, rooms: [], games: [] }),
    queryRooms: async () => ({ items: [], total: 0, page: 1, size: 20 }),
    getRoomDetail: async () => ({ room: null, memberEvents: [], games: [] }),
    queryGames: async () => ({ items: [], total: 0, page: 1, size: 20 }),
    getGameDetail: async (id: string) => ({ game: { gameId: id, roomId: 'R1', roundNo: 1, dealerSeat: 0, seed: 1, endType: null, result: null }, actionCount: 0 }),
    replaySource: () => ({}),
  } as unknown as AdminGameQueries;

  const replay = {
    frames: async (gameId: string) => ({ meta: { gameId, roomId: 'R1', roundNo: 1, dealerSeat: 0, names: {}, endType: null, result: null }, frames: [{ seq: 0, action: null, events: [], state: {} }] }),
    bundle: async (gameId: string) => ({ v: 1, exportedAt: 0, room: { id: 'R1' }, game: { gameId }, snapshot: {}, actions: [], names: {} }),
  } as unknown as ReplayService;

  // FR-Admin-10 监控代理：可控 mock（enabled=false → 抛错降级；用例切 monitorState 验证可用/降级/审计节流）
  const monitor = {
    get enabled() { return monitorState.enabled; },
    inspect: async () => {
      if (!monitorState.enabled) throw new Error('monitor_unreachable');
      return monitorState.payload;
    },
  } as unknown as GameInspect;

  const deps: AppDeps = { config, admin, game, replay, monitor };
  app = await buildApp({ deps });
});

afterAll(async () => { await app?.close(); });

describe('admin-server 应用（inject · 假依赖）', () => {
  it('健康检查 200', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('登录：错误密码 401 且留痕 fail', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'nope' } });
    expect(r.statusCode).toBe(401);
    expect(audits.some((a) => a.action === 'login' && a.result === 'fail')).toBe(true);
  });

  it('登录：正确凭据 200 + 下发会话 cookie', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'root', password: 'pass1234' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().admin).toMatchObject({ username: 'root', role: 'super' });
    superCookie = cookieOf(r);
    expect(superCookie).toContain('admin_sid');
    expect(audits.some((a) => a.action === 'login' && a.result === 'success')).toBe(true);
  });

  it('未带会话访问受保护路由 → 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/users' })).statusCode).toBe(401);
  });

  it('带会话：/me 与只读用户查询打通', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: superCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().admin.username).toBe('root');
    const users = await app.inject({ method: 'GET', url: '/api/users?page=1&size=10', headers: { cookie: superCookie } });
    expect(users.statusCode).toBe(200);
    expect(users.json().items).toHaveLength(1);
  });

  it('RBAC：viewer 访问 /api/admins → 403；super → 200', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'view', password: 'pass1234' } });
    viewerCookie = cookieOf(login);
    expect((await app.inject({ method: 'GET', url: '/api/admins', headers: { cookie: viewerCookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/admins', headers: { cookie: superCookie } })).statusCode).toBe(200);
  });

  it('回放：viewer 可看帧；导出回放包需 operator+（viewer 403 / super 200 带下载头）', async () => {
    const frames = await app.inject({ method: 'GET', url: '/api/games/R1:1/replay', headers: { cookie: viewerCookie } });
    expect(frames.statusCode).toBe(200);
    expect(frames.json().frames[0].seq).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/games/R1:1/replay-bundle', headers: { cookie: viewerCookie } })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'GET', url: '/api/games/R1:1/replay-bundle', headers: { cookie: superCookie } });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers['content-disposition'])).toContain('attachment');
  });

  it('仲裁：operator+ 录入成功并写审计；viewer 403', async () => {
    const denied = await app.inject({ method: 'POST', url: '/api/games/R1:1/arbitrations', headers: { cookie: viewerCookie }, payload: { status: 'pending', note: 'x' } });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/games/R1:1/arbitrations', headers: { cookie: superCookie }, payload: { status: 'resolved', verdict: 'valid', note: '判定有效' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('resolved');
    expect(audits.some((a) => a.action === 'arbitration.create' && a.result === 'success')).toBe(true);
  });

  it('FR-Admin-10 监控：viewer → 403（需 operator+）', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/monitor/rooms/123456', headers: { cookie: viewerCookie } })).statusCode).toBe(403);
  });

  it('FR-Admin-10 监控：不可达/未配置 → 降级 available:false + fallback', async () => {
    monitorState.enabled = false;
    const r = await app.inject({ method: 'GET', url: '/api/monitor/rooms/123456', headers: { cookie: superCookie } });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.available).toBe(false);
    expect(b.reason).toBeTruthy();
  });

  it('FR-Admin-10 监控：可用 → available:true 转呈 inspect 全量台态', async () => {
    monitorState.enabled = true;
    monitorState.payload = { room: '123456', phase: 'playing', gameId: '123456-g1', names: {}, seats: [], state: { wall: ['W1'], players: [], discards: [] }, game: null, seating: null, timers: { trusteePending: [], offlineSince: [], seatingInputActive: false }, stall: { lastActionAt: 0, idleMs: 0 } };
    const r = await app.inject({ method: 'GET', url: '/api/monitor/rooms/123456', headers: { cookie: superCookie } });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.available).toBe(true);
    expect(b.inspect.state.wall).toEqual(['W1']);
    monitorState.enabled = false;
  });

  it('FR-Admin-10 监控：审计节流——?audit=1 记一条、自动轮询不记，降级 result=fail', async () => {
    monitorState.enabled = false;
    const count = (): number => audits.filter((a) => a.action === 'monitor.inspect').length;
    const before = count();
    await app.inject({ method: 'GET', url: '/api/monitor/rooms/123456', headers: { cookie: superCookie } });
    expect(count()).toBe(before); // 无 audit：自动轮询不逐条记
    await app.inject({ method: 'GET', url: '/api/monitor/rooms/123456?audit=1', headers: { cookie: superCookie } });
    expect(count()).toBe(before + 1); // 开启/手动刷新记一条
    expect(audits.filter((a) => a.action === 'monitor.inspect').pop()!.result).toBe('fail'); // 降级 → fail
  });

  it('FR-Admin-09 诊断包：viewer → 403（需 operator+）', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/diag/intake', headers: { cookie: viewerCookie }, payload: { at: 1, ctx: {}, ring: [], errors: [] } });
    expect(r.statusCode).toBe(403);
  });

  it('FR-Admin-09 诊断包：受理规范化 + 派生 gameId + 截断标记', async () => {
    const bigRing = Array.from({ length: 80 }, (_, i) => `msg:m${i}`);
    const manyErrors = Array.from({ length: 8 }, (_, i) => ({ at: i, msg: `err ${i}`, stack: 'x'.repeat(5000) }));
    const pkg = { at: 1758460867000, ctx: { screen: 'table', room: '212817', round: 2, phase: 'exhaustive', cur: 3, mySeat: 0 }, ring: bigRing, errors: manyErrors };
    const r = await app.inject({ method: 'POST', url: '/api/diag/intake', headers: { cookie: superCookie }, payload: pkg });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.gameId).toBe('212817-g2'); // 连字符，对齐 beginGame
    expect(b.room).toBe('212817');
    expect(b.ring).toHaveLength(60); // 截断至 60
    expect(b.ring[59]).toBe('msg:m79'); // 取最近（尾部）
    expect(b.ringTruncated).toBe(true);
    expect(b.errors).toHaveLength(5); // 截断至 5
    expect(b.errorsTruncated).toBe(true);
    expect(b.errors[0].stackTruncated).toBe(true); // stack>4000 截断
    expect(b.truncated).toBe(true);
    expect(b.ctx.round).toBe(2);
  });

  it('FR-Admin-09 诊断包：round 缺 → gameId null（前端据 room 跳房间详情）', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/diag/intake', headers: { cookie: superCookie }, payload: { at: 1, ctx: { room: '212817' }, ring: [], errors: [] } });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.gameId).toBe(null);
    expect(b.room).toBe('212817');
  });

  it('FR-Admin-09 诊断包：记 diag.intake 审计（只记 room/round/errors 数，不落本体）', async () => {
    const before = audits.filter((a) => a.action === 'diag.intake').length;
    await app.inject({ method: 'POST', url: '/api/diag/intake', headers: { cookie: superCookie }, payload: { at: 1, ctx: { room: '999', round: 3 }, ring: ['view:table', 'msg:x'], errors: [{ at: 1, msg: 'boom' }] } });
    const recs = audits.filter((a) => a.action === 'diag.intake');
    expect(recs.length).toBe(before + 1);
    const last = recs[recs.length - 1]!;
    expect(last.result).toBe('success');
    const after = last.afterJson as { room: string; round: number; errors: number; ring: number };
    expect(after.room).toBe('999');
    expect(after.round).toBe(3);
    expect(after.errors).toBe(1);
    // 不落本体：审计 after 不含 ring/errors 内容明细
    expect(JSON.stringify(last.afterJson)).not.toContain('view:table');
    expect(JSON.stringify(last.afterJson)).not.toContain('boom');
  });
});
