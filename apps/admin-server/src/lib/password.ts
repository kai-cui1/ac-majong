/**
 * 管理员密码：scrypt 哈希（复刻 accountAuth 参数 N=16384 r=8 p=1，跨 app 不 import game-server，见架构 §4）。
 * 存储格式 `s$<saltHex>$<hashHex>`。
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

export function validateUsername(u: string): string | null {
  return USERNAME_RE.test(u) ? null : '用户名需 3-32 位字母/数字/下划线';
}
export function validatePassword(p: string): string | null {
  return p.length >= 8 && p.length <= 64 ? null : '密码需 8-64 位';
}

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
