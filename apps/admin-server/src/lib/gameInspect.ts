import type { TableState } from '@ac-majong/engine';
import type { AdminConfig } from '../config';
import { createLogger } from '../logger';

const log = createLogger('monitor');

/** 单次拉取超时（ms）：前端 ~2s 轮询即天然重试，故短超时、不额外重试（Admin 技术方案 §10.3） */
const FETCH_TIMEOUT_MS = 3000;

/** game-server `RoomActor.inspect()` 全量台态投影（FR-Admin-10 上帝全知视角）。
 * `state` 为完整 TableState（牌墙实牌 / 四家暗牌 / 牌河 / 副露花子分 / 响应意图），admin 特权侧不裁剪。 */
export interface RoomInspect {
  room: string;
  phase: string;
  maxRounds: number;
  names: Record<number, string>;
  seats: ({ userId: string; isBot: boolean } | null)[];
  gameId: string | null;
  state: TableState | null;
  game: { round: number; phase: string; currentSeat: number; wallLen: number; legalBySeat: unknown[] } | null;
  seating: unknown;
  timers: { trusteePending: string[]; offlineSince: [string, number][]; seatingInputActive: boolean };
  stall: { lastActionAt: number; idleMs: number };
}

export interface GameInspect {
  /** 是否已配置内部端点（未配置则监控走降级） */
  enabled: boolean;
  /** 拉取房间实时全量台态；不可达 / 房不存在 / 未配置 → 抛错，由路由降级 */
  inspect(roomId: string): Promise<RoomInspect>;
}

/** 服务端代理：携预共享密钥调 game-server 内网只读 inspect 端点（密钥绝不下发前端，Admin 技术方案 §10.3）。 */
export function createGameInspect(config: AdminConfig): GameInspect {
  const enabled = !!config.gameInternalUrl && !!config.internalToken;
  if (!enabled) log.warn('未配置 GAME_INTERNAL_URL/INTERNAL_TOKEN，实时房间监控将降级为已落库事实');
  return {
    enabled,
    async inspect(roomId) {
      if (!config.gameInternalUrl || !config.internalToken) throw new Error('monitor_not_configured');
      const base = config.gameInternalUrl.replace(/\/+$/, '');
      const url = `${base}/internal/rooms/${encodeURIComponent(roomId)}/inspect`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, { headers: { 'x-internal-token': config.internalToken }, signal: ctrl.signal });
        if (!res.ok) throw new Error(`inspect_http_${res.status}`);
        return (await res.json()) as RoomInspect;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
