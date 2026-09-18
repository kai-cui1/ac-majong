import { sys } from 'cc';

/** 微信小游戏运行时检测（M-K 平台分支） */
export const IS_WX: boolean = typeof (globalThis as { wx?: unknown }).wx !== 'undefined';
/** Web/H5 运行时（浏览器承载，含微信内置浏览器） */
export const IS_WEB: boolean = !IS_WX && typeof (globalThis as { window?: unknown }).window !== 'undefined';
/** 微信云托管配置：上线前填实际值（云环境 ID / WebSocket 服务名） */
export const WX_CLOUD_ENV = 'prod-REPLACE_ME';
export const WX_CLOUD_SERVICE = 'ac-majong-ws';

/**
 * WS 地址自适应（H5 发布路线）：页面有域名/主机时用同主机 8080 端口（一份构建可部署到任意服务器），
 * 否则回退本地联调地址。https 页面需 wss 时，在此处按 protocol 分支。
 */
function detectServerUrl(): string {
  if (IS_WEB) {
    const loc = (globalThis as { window?: { location?: { hostname?: string } } }).window?.location;
    if (loc?.hostname) return `ws://${loc.hostname}:8080`;
  }
  return 'ws://127.0.0.1:8080';
}
export const SERVER_URL = detectServerUrl();

/** 微信端身份：云托管握手自动注入 x-wx-openid（服务端 WeChatIdentity），token 仅占位 */
export function wxIdentity(): MockIdentity {
  return { token: 'wx-cloud', nickname: '微信玩家', avatarUrl: '' };
}

export interface MockIdentity {
  token: string;
  nickname: string;
  avatarUrl: string;
}

const MOCK_KEY = 'ac_mock_identity';

/**
 * 本地 mock 身份：首次生成并持久化到 localStorage，之后复用同一用户。
 * 对应服务端 MockIdentity（token 即 userId）：users 表恒一行、每次登录刷新 lastLoginAt。
 * 真实微信登录（wx.login → code2Session）在 M-K 接入。
 */
export function mockIdentity(): MockIdentity {
  try {
    const saved = sys.localStorage.getItem(MOCK_KEY);
    if (saved) return JSON.parse(saved) as MockIdentity;
  } catch {
    /* 读取/解析失败则新建 */
  }
  const n = Math.floor(Math.random() * 9000 + 1000);
  const id: MockIdentity = { token: `mock_${n}`, nickname: `牌友${n}`, avatarUrl: '' };
  try {
    sys.localStorage.setItem(MOCK_KEY, JSON.stringify(id));
  } catch {
    /* 写入失败则仅本次生效 */
  }
  return id;
}
