import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { createLogger } from '../logger';

const log = createLogger('http');

/** 统一错误信封（Admin 技术方案 §5）：`{ error: { code, message } }`。 */
export class HttpError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message = '请求参数错误', code = 'BAD_REQUEST'): HttpError => new HttpError(400, code, message);
export const unauthorized = (message = '未登录或会话已过期', code = 'UNAUTHORIZED'): HttpError => new HttpError(401, code, message);
export const forbidden = (message = '权限不足', code = 'FORBIDDEN'): HttpError => new HttpError(403, code, message);
export const notFound = (message = '资源不存在', code = 'NOT_FOUND'): HttpError => new HttpError(404, code, message);
export const conflict = (message = '资源冲突', code = 'CONFLICT'): HttpError => new HttpError(409, code, message);

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    // zod 校验失败 → 400（路由用 schema.parse 时冒泡）
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message } });
    }
    // 请求体/查询校验失败（zod 经 schema 或 fastify 内建）
    if (err.validation) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: err.message } });
    }
    // 插件抛出的 4xx（CSRF 失败 403 / 限流 429 等）透传状态码
    const sc = err.statusCode;
    if (typeof sc === 'number' && sc >= 400 && sc < 500) {
      return reply.status(sc).send({ error: { code: err.code ?? 'ERROR', message: err.message } });
    }
    log.error('未处理异常', { path: req.url, message: err.message });
    return reply.status(500).send({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });
}
