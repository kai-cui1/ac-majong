import type { AdminSession, AppDeps } from './deps';

/**
 * Fastify 类型增强：会话中的管理员信息、请求上的当前管理员、实例上的依赖注入。
 * 本文件仅需被 app.ts 以副作用方式 import（`import './augments'`）即可全局生效。
 */
declare module 'fastify' {
  interface Session {
    admin?: AdminSession;
  }
  interface FastifyRequest {
    admin?: AdminSession;
  }
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export {};
