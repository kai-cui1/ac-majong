import { describe, it, expect } from 'vitest';
import { MockIdentity, WeChatIdentity, TokenIdentity } from '../src/identity';

describe('IdentityProvider（M-K 鉴权分支）', () => {
  it('MockIdentity：token 即 userId', async () => {
    const id = await new MockIdentity().authenticate({ token: 'mock_123' });
    expect(id?.userId).toBe('mock_123');
  });

  it('MockIdentity：空 token → null', async () => {
    expect(await new MockIdentity().authenticate({ token: '  ' })).toBeNull();
  });

  it('WeChatIdentity：云托管握手头 x-wx-openid（字符串）', async () => {
    const id = await new WeChatIdentity().authenticate({ headers: { 'x-wx-openid': 'oABC' } });
    expect(id?.userId).toBe('oABC');
  });

  it('WeChatIdentity：头为数组时取首项', async () => {
    const id = await new WeChatIdentity().authenticate({ headers: { 'x-wx-openid': ['oX', 'oY'] } });
    expect(id?.userId).toBe('oX');
  });

  it('WeChatIdentity：缺头 → null（非云托管环境拒绝）', async () => {
    expect(await new WeChatIdentity().authenticate({ token: 'whatever' })).toBeNull();
  });

  it('TokenIdentity：web 前缀占位', async () => {
    const id = await new TokenIdentity().authenticate({ token: 't1' });
    expect(id?.userId).toBe('web:t1');
  });
});
