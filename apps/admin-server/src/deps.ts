import type { AdminGameQueries, AdminRole, AdminStore } from '@ac-majong/persistence';
import type { AdminConfig } from './config';
import type { ReplayService } from './lib/replay';
import type { GameInspect } from './lib/gameInspect';

/** 登录态写入 session 的管理员精简信息 */
export interface AdminSession {
  id: number;
  username: string;
  role: AdminRole;
}

/** 应用依赖（可注入，便于 inject 测试用假实现替换真实 DB / 回放） */
export interface AppDeps {
  config: AdminConfig;
  /** admin 自有表读写（管理员 / 仲裁 / 审计） */
  admin: AdminStore;
  /** 游戏数据只读检索 */
  game: AdminGameQueries;
  /** 回放帧服务 + 回放包导出 */
  replay: ReplayService;
  /** FR-Admin-10：game-server 内网 inspect 代理（实时房间监控） */
  monitor: GameInspect;
}
