import { startGateway, type Gateway } from './wsGateway';
import { startDiagHttp } from './diag';
import { MockIdentity, WeChatIdentity, TokenIdentity, type IdentityProvider } from './identity';
import { createPersistence } from '@ac-majong/persistence';
import { setLogLevel, getLogLevel, createLogger, type LogLevel } from './logger';

const log = createLogger('main');

/** 按部署环境选择鉴权：wechat(x-wx-openid) / web(token) / mock(本地开发) */
function pickIdentity(mode: string | undefined): IdentityProvider {
  switch (mode) {
    case 'wechat':
      return new WeChatIdentity();
    case 'web':
      return new TokenIdentity();
    default:
      return new MockIdentity();
  }
}

async function main(): Promise<void> {
  // 日志级别：环境变量 LOG_LEVEL，支持 silent|error|warn|info|debug|trace
  const logLevel = (process.env.LOG_LEVEL ?? 'info') as LogLevel;
  setLogLevel(logLevel);

  const port = Number(process.env.PORT ?? 8080);
  const mode = process.env.IDENTITY ?? 'mock';
  const autoBots = Number(process.env.AUTO_BOTS ?? 0);
  // 设了 DATABASE_URL + REDIS_URL 用 MySQL+Redis，否则内存（见 .env.example / deploy）
  const persistence = await createPersistence(process.env);
  const gateway: Gateway = startGateway({ port, identity: pickIdentity(mode), autoBots, persistence, accountMode: mode === 'account', roomTimings: { stallWatchdogMs: Number(process.env.STALL_WATCHDOG_MS ?? 20_000) } });

  // BL-022/BL-024：dev-only 自检 HTTP（/dev/rooms、/dev/room/:id dump、/dev/export/:gameId 回放包）；仅 DEV_TOOLS=1 启用，生产不开该端口
  let diagServer: ReturnType<typeof startDiagHttp> | null = null;
  if (process.env.DEV_TOOLS === '1') {
    diagServer = startDiagHttp(Number(process.env.DEV_HTTP_PORT ?? port + 1), gateway.rooms, persistence.store);
  }

  log.info(
    `WS listening on :${port} (identity=${mode}, autoBots=${autoBots}, persistence=${persistence.kind}, logLevel=${getLogLevel()})`,
  );

  const shutdown = () => {
    log.info('收到终止信号，正在关闭...');
    diagServer?.close();
    gateway.close();
    void persistence.store.close();
    void persistence.realtime.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main();
