import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AdminGameQueries, AdminStore } from '@ac-majong/persistence';
import { buildApp } from '../src/app';
import type { AdminConfig } from '../src/config';
import type { AppDeps } from '../src/deps';
import type { ReplayService } from '../src/lib/replay';
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

  const deps: AppDeps = { config, admin, game, replay };
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
});
