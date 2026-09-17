import type { Action } from '@ac-majong/engine';
import type { ServerMsg, ViewState } from '@ac-majong/protocol';
import type { Connection } from './connection';
import type { RoomActor } from './roomActor';
import { createLogger } from './logger';

const log = createLogger('bot');

/** 从裁剪后的 ViewState 选择一个保守动作：能胡则胡，否则摸/打/过（不主动吃碰杠）。 */
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
 * 创建一个 Bot 连接：走与真实客户端相同的裁剪 ViewState，用保守策略代打（不经网络）。
 * 用于「房主主动陪玩」（RoomActor.addBot，FR-房间-08）与「开发期自动补齐」（AUTO_BOTS）；
 * 同一套 pickAction 亦为 M-I 断线托管的策略基础。
 */
export function makeBotConnection(room: RoomActor, userId: string, delayMs = 260): Connection {
  let lastActionKey = '';
  return {
    userId,
    send(msg: ServerMsg): void {
      if (msg.t !== 'gameView') return;
      const action = pickAction(msg.view);
      if (!action) {
        log.trace(`Bot 无可执行动作: ${userId} phase=${msg.view.phase}`);
        return;
      }
      // 去重：同一动作在同一局面下只发一次，避免重复广播堆栈
      const key =
        JSON.stringify(action) +
        `@${msg.view.round}:${msg.view.wallRemaining}:${msg.view.lastDiscard?.tile ?? ''}`;
      if (key === lastActionKey) return;
      lastActionKey = key;
      log.debug(`Bot 决策: ${userId} action=${action.type} delay=${delayMs}ms`);
      // 延迟一点，避免递归广播堆栈，也给客户端动画留时间
      setTimeout(() => room.handleAction(userId, action), delayMs);
    },
    close(): void {},
  };
}

/**
 * 开发期自动补齐（网关 AUTO_BOTS>0）：为房间空位补 count 个 Bot。
 * 正式的「房主主动陪玩」走 RoomActor.addBot（同为 bot- 前缀，roomView 标记 isBot）。
 */
export function fillDevBots(room: RoomActor, count: number): void {
  for (let i = 0; i < count && room.playerCount() < 4; i++) {
    const botId = `bot-auto-${i}-${room.id}`;
    room.addPlayer(botId, makeBotConnection(room, botId, 220 + i * 80));
  }
}
