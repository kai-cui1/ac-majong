import { startGateway } from './wsGateway';
import { MockIdentity, WeChatIdentity, TokenIdentity, type IdentityProvider } from './identity';

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

const port = Number(process.env.PORT ?? 8080);
const mode = process.env.IDENTITY ?? 'mock';
const gateway = startGateway({ port, identity: pickIdentity(mode) });

// eslint-disable-next-line no-console
console.log(`[ac-majong server] WS listening on :${port} (identity=${mode})`);

process.on('SIGTERM', () => gateway.close());
process.on('SIGINT', () => gateway.close());
