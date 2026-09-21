import { vi } from 'vitest';
import type { RoomActor, CeremonyTimings } from '../src/roomActor';

/** 真实WS测试压缩展示时长，边界测试仍使用正式时长与假时钟。 */
export const FAST_CEREMONY_MS: CeremonyTimings = { input: 200, auto: 10, rolling: 10, result: 10, summary: 10, seated: 10, final: 10 };

/**
 * BL-017 测试助手：用假时钟走完每个权威步骤，不再假设请求同步完成仪式——
 * 选位骰（四家逐掷，同点自动重掷）→ 最大者选座（保留自己当前座位）→ 定庄摸牌位骰（一掷定庄+开牌点）。
 * 每轮重读 roomView 以适配选座后的座位重排。
 */
export function driveCeremony(room: RoomActor): void {
  const ownsClock = !vi.isFakeTimers();
  if (ownsClock) vi.useFakeTimers({ shouldClearNativeTimers: true, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  // 生命周期回归固定无同点骰序和首庄，避免普通托管测试依赖随机座序而偶发未轮到目标家。
  const faces = [6, 6, 4, 5, 3, 4, 2, 3, 4, 5];
  const random = ownsClock ? vi.spyOn(Math, 'random').mockImplementation(() => ((faces.shift() ?? 4) - 0.5) / 6) : undefined;
  try {
    for (let i = 0; i < 600; i++) {
      const sv = room.roomView().seating;
      if (!sv) return;
      const p = sv.presentation!;
      if (p.phase === 'input' && p.actor) {
        const token = { ceremonyId: p.ceremonyId, stepId: p.stepId };
        const op = sv.stage === 'pick'
          ? room.handlePickSeat(p.actor.userId, p.actor.seat, token)
          : room.handleRoll(p.actor.userId, token);
        if (!op.ok) throw new Error(`仪式操作被拒：${op.reason}`);
      } else {
        vi.advanceTimersByTime(Math.max(0, p.deadline - Date.now()));
      }
    }
    throw new Error('仪式超过600步骤仍未完成');
  } finally {
    random?.mockRestore();
    if (ownsClock) vi.useRealTimers();
  }
}
