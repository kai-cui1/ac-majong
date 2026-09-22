import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import csrf from '@fastify/csrf-protection';
import rateLimit from '@fastify/rate-limit';
import './augments';
import type { AppDeps } from './deps';
import type { SimpleSessionStore } from './lib/sessionStore';
import { registerErrorHandler } from './lib/errors';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { roomRoutes } from './routes/rooms';
import { gameRoutes } from './routes/games';
import { adminRoutes } from './routes/admins';
import { auditRoutes } from './routes/audit';
import { monitorRoutes } from './routes/monitor';
import { diagRoutes } from './routes/diag';

export interface BuildAppOptions {
  deps: AppDeps;
  /** 会话存储；缺省用 @fastify/session 默认内存 store（仅 dev/test；prod 传 Redis store） */
  sessionStore?: SimpleSessionStore;
}

/**
 * 组装 admin-server 应用（依赖注入，便于 inject 测试）。
 * 插件顺序：cookie → session → csrf → rate-limit；路由直接注册到根上下文，
 * 使根上的 CSRF preHandler / 限流 onRoute 一致生效（避免子封装上下文的 hook 继承歧义）。
 */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { deps, sessionStore } = opts;
  const { config } = deps;
  const app = Fastify({ logger: false, trustProxy: true });
  app.decorate('deps', deps);

  await app.register(cookie);
  await app.register(session, {
    secret: config.sessionSecret,
    cookieName: 'admin_sid',
    cookie: { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', maxAge: config.sessionTtlSec * 1000 },
    rolling: true,
    saveUninitialized: false,
    ...(sessionStore ? { store: sessionStore } : {}),
  });
  await app.register(csrf, { sessionPlugin: '@fastify/session' });
  if (config.rateLimit) await app.register(rateLimit, { global: false });

  // 全局 CSRF：对非安全方法校验，豁免登录（登录前尚无会话/令牌）
  if (config.csrf) {
    app.addHook('preHandler', (req, reply, done) => {
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return done();
      if (req.url === '/api/auth/login') return done();
      return app.csrfProtection(req, reply, done);
    });
  }

  registerErrorHandler(app);

  app.get('/api/health', async () => ({ ok: true }));

  await authRoutes(app);
  await userRoutes(app);
  await roomRoutes(app);
  await gameRoutes(app);
  await adminRoutes(app);
  await auditRoutes(app);
  await monitorRoutes(app);
  await diagRoutes(app);

  await app.ready();
  return app;
}
