/**
 * H5 账号密码鉴权（IDENTITY=account）：注册即登录、scrypt 哈希、Redis 会话令牌。
 * 身份映射：openid = 'h5:' + 小写用户名，与微信/mock 路线共用 users 表与下游全部逻辑。
 * 会话：authOk 回传 sessionToken（30 天 TTL，滑动续期），客户端持久化后重连/复登免密码。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { GameStore, RealtimeStore } from './persistence';

export const SESSION_TTL_SEC = 30 * 24 * 3600;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export function validateUsername(u: string): string | null {
  return USERNAME_RE.test(u) ? null : '账号需 3-20 位字母/数字/下划线';
}
export function validatePassword(p: string): string | null {
  return p.length >= 6 && p.length <= 64 ? null : '密码需 6-64 位';
}

/** scrypt 哈希：`s$<saltHex>$<hashHex>`（N=16384 r=8 p=1） */
export function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) return reject(err);
      resolve(`s$${salt.toString('hex')}$${key.toString('hex')}`);
    });
  });
}

export function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return Promise.resolve(false);
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return Promise.resolve(false);
  const expect = Buffer.from(hashHex, 'hex');
  return new Promise((resolve) => {
    scrypt(password, Buffer.from(saltHex, 'hex'), expect.length, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) return resolve(false);
      resolve(key.length === expect.length && timingSafeEqual(key, expect));
    });
  });
}

export interface AccountResult {
  userId: string;
  nickname: string;
  session: string;
}

/** 注册即登录：账号不存在则建号（带昵称），存在则校验密码；成功签发会话 */
export async function loginOrRegister(
  store: GameStore,
  realtime: RealtimeStore,
  input: { username: string; password: string; nickname?: string },
): Promise<AccountResult | { error: string }> {
  const username = input.username.trim();
  const bad = validateUsername(username) ?? validatePassword(input.password);
  if (bad) return { error: bad };
  const openid = `h5:${username.toLowerCase()}`;
  const existing = await store.getUser(openid);
  let nickname: string;
  if (existing) {
    if (!(await verifyPassword(input.password, existing.passHash))) return { error: '账号或密码错误' };
    nickname = existing.nickname || username;
  } else {
    nickname = (input.nickname ?? '').trim().slice(0, 12) || `牌友${username.slice(0, 6)}`;
    await store.upsertUser({ openid, nickname, avatarUrl: '', passHash: await hashPassword(input.password) });
  }
  const session = randomBytes(24).toString('hex');
  await realtime.saveSession(session, { openid, createdAt: Date.now() }, SESSION_TTL_SEC);
  return { userId: openid, nickname, session };
}

/** 会话令牌 → userId（滑动续期）；无效/过期返回 null */
export async function resolveSession(realtime: RealtimeStore, token: string): Promise<string | null> {
  const data = await realtime.getSession(token);
  if (!data?.openid) return null;
  await realtime.saveSession(token, data, SESSION_TTL_SEC);
  return data.openid;
}
