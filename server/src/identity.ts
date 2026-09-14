/** 可插拔鉴权：微信端读 x-wx-openid，Web 端用 token，本地开发用 mock（决策4） */
export interface AuthContext {
  token?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export interface Identity {
  userId: string;
}

export interface IdentityProvider {
  authenticate(ctx: AuthContext): Promise<Identity | null>;
}

/** 本地开发/测试：token 即 userId */
export class MockIdentity implements IdentityProvider {
  async authenticate(ctx: AuthContext): Promise<Identity | null> {
    const t = ctx.token?.trim();
    return t ? { userId: t } : null;
  }
}

/** 微信云托管：从握手头 x-wx-openid 取身份（connectContainer 自动注入） */
export class WeChatIdentity implements IdentityProvider {
  async authenticate(ctx: AuthContext): Promise<Identity | null> {
    const h = ctx.headers?.['x-wx-openid'];
    const openid = Array.isArray(h) ? h[0] : h;
    return openid ? { userId: openid } : null;
  }
}

/** Web/HTML5：token → userId（此处占位，实际应校验签名/会话；TODO 上线前实现） */
export class TokenIdentity implements IdentityProvider {
  async authenticate(ctx: AuthContext): Promise<Identity | null> {
    const t = ctx.token?.trim();
    if (!t) return null;
    // TODO(t4-b)：校验 JWT/会话，解出 userId
    return { userId: `web:${t}` };
  }
}
