import { createAdminPersistence } from '@ac-majong/persistence';
import { loadConfig } from './config';
import { createLogger, setLogLevel } from './logger';
import { buildApp } from './app';
import { createRedisSessionStore } from './lib/sessionStore';
import { createReplayService } from './lib/replay';
import { hashPassword } from './lib/password';

/**
 * admin-server 启动入口。
 * 前置：先 `pnpm --filter @ac-majong/persistence db:migrate` 建 admin 三表（admins/arbitrations/admin_audit_logs）。
 */
async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  const log = createLogger('boot');

  const p = await createAdminPersistence(process.env);

  // 首个超管 bootstrap（admins 为空且配置了凭据时）
  if (config.bootstrapUsername && config.bootstrapPassword) {
    const count = await p.admin.countAdmins();
    if (count === 0) {
      const passHash = await hashPassword(config.bootstrapPassword);
      const created = await p.admin.createAdmin({ username: config.bootstrapUsername, passHash, role: 'super' });
      await p.admin.writeAudit({ adminId: created.id, adminUsername: created.username, action: 'admin.bootstrap', targetType: 'admin', targetId: String(created.id), afterJson: { username: created.username, role: 'super' }, result: 'success' });
      log.info('已创建首个超管', { username: created.username });
    }
  }

  const sessionHandle = config.redisUrl ? createRedisSessionStore(config.redisUrl, config.sessionTtlSec) : undefined;
  const app = await buildApp({
    deps: { config, admin: p.admin, game: p.game, replay: createReplayService(p.game) },
    sessionStore: sessionHandle?.store,
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });
  log.info('admin-server 已启动', { port: config.port, redisSession: !!config.redisUrl, csrf: config.csrf });

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await app.close();
      await sessionHandle?.close();
      await p.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[admin:boot] 启动失败', e);
  process.exit(1);
});
