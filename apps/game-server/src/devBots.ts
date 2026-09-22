import { createAutoPlayer, DEFAULT_PERSONA, TRUSTEE_PERSONA, hashString, seededRng, type AutoPlayer } from '@ac-majong/ai';
import type { ServerMsg } from '@ac-majong/protocol';
import type { Connection } from './connection';
import type { RoomActor } from './roomActor';
import { createLogger } from './logger';

const log = createLogger('bot');

/**
 * 创建一个 Bot 连接：走与真实客户端相同的裁剪 ViewState，由 `@ac-majong/ai`
 * 的统一决策器（AutoPlayer + 可插拔策略）代打（不经网络）。
 * 用于「房主主动陪玩」（RoomActor.addBot，FR-房间-08）与「开发期自动补齐」（AUTO_BOTS）。
 * personaId 缺省为默认打法（最大概率打法）；后续 FR-AI-03 由房主选择传入。
 */
export function makeBotConnection(
  room: RoomActor,
  userId: string,
  delayMs = 260,
  getPersona: () => string = () => DEFAULT_PERSONA,
): Connection {
  return makeAutoConnection(room, userId, delayMs, getPersona, 'Bot');
}

/**
 * 托管代打连接（M-I / FR-断线-03）：绑定「托管（保守）」人格——自动摸打 + 响应一律「过」，
 * **不主动吃/碰/杠/胡**，直至玩家重连接管或本局结束。语义不因新框架回退。
 */
export function makeTrusteeConnection(
  room: RoomActor,
  userId: string,
  delayMs = 400,
  getPersona: () => string = () => TRUSTEE_PERSONA,
): Connection {
  return makeAutoConnection(room, userId, delayMs, getPersona, '托管');
}

function makeAutoConnection(room: RoomActor, userId: string, delayMs: number, getPersona: () => string, tag: string): Connection {
  // 独立种子随机源：不干扰全局 Math.random（测试骰面夹具），且给定 userId 可复现
  const players = new Map<string, AutoPlayer>();
  const playerFor = (pid: string): AutoPlayer => {
    let p = players.get(pid);
    if (!p) {
      p = createAutoPlayer(pid, seededRng(hashString(userId)));
      players.set(pid, p);
    }
    return p;
  };
  let lastActionKey = '';
  return {
    userId,
    send(msg: ServerMsg): void {
      if (msg.t !== 'gameView') return;
      // 每次决策现取 persona：支持房主中途改打法 / 玩家预设托管打法即时生效
      const player = playerFor(getPersona());
      const action = player.decide(msg.view, msg.view.you.seat);
      if (!action) {
        log.trace(`${tag} 无可执行动作: ${userId} phase=${msg.view.phase}`);
        return;
      }
      // 去重：同一动作在同一局面下只发一次，避免重复广播堆栈
      const key =
        JSON.stringify(action) +
        `@${msg.view.round}:${msg.view.wallRemaining}:${msg.view.lastDiscard?.tile ?? ''}`;
      if (key === lastActionKey) return;
      lastActionKey = key;
      log.debug(`${tag} 决策: ${userId} persona=${player.personaId} action=${action.type} delay=${delayMs}ms`);
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
