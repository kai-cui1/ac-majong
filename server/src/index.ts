import { startGateway, type Gateway } from './wsGateway';
import { MockIdentity, WeChatIdentity, TokenIdentity, type IdentityProvider } from './identity';
import { createPersistence } from './persistence/index';

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
  const port = Number(process.env.PORT ?? 8080);
  const mode = process.env.IDENTITY ?? 'mock';
  const autoBots = Number(process.env.AUTO_BOTS ?? 0);
  // 设了 DATABASE_URL + REDIS_URL 用 MySQL+Redis，否则内存（见 .env.example / deploy）
  const persistence = await createPersistence(process.env);
  const gateway: Gateway = startGateway({ port, identity: pickIdentity(mode), autoBots, persistence });

  // eslint-disable-next-line no-console
  console.log(
    `[ac-majong server] WS listening on :${port} (identity=${mode}, autoBots=${autoBots}, persistence=${persistence.kind})`,
  );

  const shutdown = () => {
    gateway.close();
    void persistence.store.close();
    void persistence.realtime.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main();
