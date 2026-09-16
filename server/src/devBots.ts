import type { Action } from '@ac-majong/engine';
import type { ServerMsg, ViewState } from '@ac-majong/protocol';
import type { Connection } from './connection';
import type { RoomActor } from './roomActor';

/** 从裁剪后的 ViewState 选择一个保守动作：能胡则胡，否则摸/打/过。 */
function pickAction(view: ViewState): Action | null {
  const seat = view.you.seat;
  const legal = view.you.legal;
  if (view.phase === 'draw' && view.currentSeat === seat && legal.includes('draw')) {
    return { type: 'draw', seat };
  }
  if (view.phase === 'discard' && view.currentSeat === seat) {
    if (legal.includes('win_draw')) return { type: 'declareWin', seat };
    if (legal.includes('discard')) {
      const tile = Object.keys(view.you.concealed)[0];
      return tile ? { type: 'discard', seat, tile } : null;
    }
  }
  if (view.phase === 'response') {
    if (legal.includes('win_discard')) return { type: 'respond', seat, move: 'win' };
    if (legal.includes('pass')) return { type: 'respond', seat, move: 'pass' };
  }
  return null;
}

/**
 * 本地开发专用：为房间补齐 Bot。Bot 走与真实客户端相同的裁剪 ViewState，
 * 但不经过网络；真实 WebSocket 全链路已由 integration.test.ts 单独覆盖。
 */
export function fillDevBots(room: RoomActor, count: number): void {
  for (let i = 1; i <= count; i++) {
    const userId = `dev-bot-${i}`;
    let lastActionKey = '';
    const conn: Connection = {
      userId,
      send(msg: ServerMsg): void {
        if (msg.t !== 'gameView') return;
        const action = pickAction(msg.view);
        if (!action) return;
        const key = JSON.stringify(action) + `@${msg.view.round}:${msg.view.wallRemaining}:${msg.view.lastDiscard?.tile ?? ''}`;
        if (key === lastActionKey) return;
        lastActionKey = key;
        // 延迟一点，避免递归广播堆栈，也让 Cocos 有时间播放动画。
        setTimeout(() => room.handleAction(userId, action), 220 + i * 80);
      },
      close(): void {},
    };
    room.addPlayer(userId, conn);
  }
}
