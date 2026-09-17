import { sys } from 'cc';

/** 服务端 WS 地址（本地联调；上线改云托管 WSS，见 M-K） */
export const SERVER_URL = 'ws://127.0.0.1:8080';

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
