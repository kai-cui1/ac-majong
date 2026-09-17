import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, IncomingHttpHeaders } from 'node:http';
import type { ClientMsg, ServerMsg, UserProfile } from '@ac-majong/protocol';
import type { Connection } from './connection';
import type { IdentityProvider } from './identity';
import { RoomManager } from './roomManager';
import type { GameHooks } from './roomActor';
import type { GameStore, RealtimeStore, MemberEventRow } from './persistence/entities';
import { MemoryGameStore, MemoryRealtime } from './persistence/memory';
import { createLogger } from './logger';

const log = createLogger('gateway');

interface Session {
  ws: WebSocket;
  userId: string | null;
  roomId: string | null;
  alive: boolean;
  headers: IncomingHttpHeaders;
  /** 登录时上报/兜底的展示资料，供建房/入座时写入 ViewState.names */
  profile: UserProfile | null;
}

export interface GatewayOptions {
  port: number;
  identity: IdentityProvider;
  heartbeatMs?: number;
  /** 本地开发专用：真人建房后自动补 Bot 并开局（生产必须为0） */
  autoBots?: number;
  /** 持久化（缺省内存实现）；登录会 upsertUser + 写会话（BL-013 接线） */
  persistence?: { store: GameStore; realtime: RealtimeStore };
}

export interface Gateway {
  wss: WebSocketServer;
  rooms: RoomManager;
  close: () => void;
}

/** 房间成员进出流水落库（弱依赖，失败不阻断，同 rooms 落库策略；见持久化技术方案 §7） */
async function logMember(store: GameStore, e: MemberEventRow): Promise<void> {
  try {
    await store.addMemberEvent(e);
    log.debug(`成员流水落库: room=${e.roomId} user=${e.openid} event=${e.event}`);
  } catch (err) {
    log.error(`成员进出流水落库失败: room=${e.roomId} user=${e.openid}`, err);
  }
}

/** 启动 WS 网关（平台无关；微信/Web 客户端都连这里，仅 identity 不同） */
export function startGateway(opts: GatewayOptions): Gateway {
  const wss = new WebSocketServer({ port: opts.port });
  const sessions = new Set<Session>();
  const persistence = opts.persistence ?? { store: new MemoryGameStore(), realtime: new MemoryRealtime() };
  // 对局落库钩子（M-E）：开局 games+initial_states、局内动作缓冲 Redis、局末 drain→MySQL+finishGame（弱依赖 fire-and-forget）
  const gameHooks: GameHooks = {
    onGameStart(roomId, gameId, snap, dealerSeat, seed, roundNo) {
      log.info(`对局开始: room=${roomId} game=${gameId} round=${roundNo} dealer=${dealerSeat} seed=${seed}`);
      void (async () => {
        try {
          await persistence.store.createGame({ gameId, roomId, roundNo, dealerSeat, seed, endType: null, result: null });
          await persistence.store.saveInitialState({ gameId, wall: snap.wall, hands: snap.players, lianzhuangCount: snap.lianzhuangCount });
        } catch (err) {
          log.error(`对局开局落库失败: game=${gameId}`, err);
        }
      })();
    },
    onGameAction(gameId, seq, seat, action) {
      log.trace(`动作缓冲: game=${gameId} seq=${seq} seat=${seat} type=${action.type}`);
      void (async () => {
        try {
          await persistence.realtime.bufferActions(gameId, [{ gameId, seq, seat, actionType: action.type, payload: action }]);
        } catch (err) {
          log.error(`动作缓冲失败: game=${gameId} seq=${seq}`, err);
        }
      })();
    },
    onGameEnd(gameId, endType, result) {
      log.info(`对局结束: game=${gameId} endType=${endType}`);
      void (async () => {
        try {
          const rows = await persistence.realtime.drainActions(gameId);
          if (rows.length) await persistence.store.appendActions(rows);
          await persistence.store.finishGame(gameId, endType, result, new Date());
        } catch (err) {
          log.error(`对局结算落库失败: game=${gameId}`, err);
        }
      })();
    },
    // 散场落库（M-G）：rooms.final_score + status=closed（弱依赖 fire-and-forget）
    onRoomEnd(roomId, standings) {
      log.info(`房间散场: room=${roomId} standings=${JSON.stringify(standings.map(s => `seat${s.seat}:${s.score}`))}`);
      void (async () => {
        try {
          const finalScore: Record<number, number> = {};
          for (const s of standings) finalScore[s.seat] = s.score;
          await persistence.store.closeRoom(roomId, finalScore, new Date());
        } catch (err) {
          log.error(`散场落库失败: room=${roomId}`, err);
        }
      })();
    },
  };
  const rooms = new RoomManager(undefined, gameHooks);

  const send = (s: Session, msg: ServerMsg) => {
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(msg));
  };

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const session: Session = { ws, userId: null, roomId: null, alive: true, headers: req.headers, profile: null };
    sessions.add(session);
    log.info(`新连接: ip=${req.socket.remoteAddress ?? '?'} 当前在线=${sessions.size}`);
    const conn: Connection = {
      get userId() {
        return session.userId ?? '';
      },
      set userId(v: string) {
        session.userId = v;
      },
      send: (msg) => send(session, msg),
      close: (code, reason) => ws.close(code, reason),
    };

    ws.on('pong', () => {
      session.alive = true;
    });
    ws.on('message', (data) => {
      session.alive = true;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString()) as ClientMsg;
      } catch {
        log.warn('收到无效 JSON 消息');
        return send(session, { t: 'error', reason: 'bad json' });
      }
      log.trace(`收到消息: user=${session.userId ?? '(未鉴权)'} type=${msg.t}`);
      void handleMsg(session, conn, msg, rooms, opts.identity, opts.autoBots ?? 0, send, persistence);
    });
    ws.on('close', () => {
      sessions.delete(session);
      log.info(`连接断开: user=${session.userId ?? '(未鉴权)'} room=${session.roomId ?? '-'} 剩余在线=${sessions.size}`);
      if (session.roomId && session.userId) rooms.get(session.roomId)?.removePlayer(session.userId);
    });
  });

  const hb = setInterval(() => {
    for (const s of sessions) {
      if (!s.alive) {
        s.ws.terminate();
        sessions.delete(s);
        continue;
      }
      s.alive = false;
      s.ws.ping();
    }
  }, opts.heartbeatMs ?? 10_000);

  return {
    wss,
    rooms,
    close: () => {
      clearInterval(hb);
      wss.close();
    },
  };
}

const SESSION_TTL_SEC = 7 * 24 * 3600;

async function handleMsg(
  session: Session,
  conn: Connection,
  msg: ClientMsg,
  rooms: RoomManager,
  identity: IdentityProvider,
  autoBots: number,
  send: (s: Session, m: ServerMsg) => void,
  persistence: { store: GameStore; realtime: RealtimeStore },
): Promise<void> {
  switch (msg.t) {
    case 'auth': {
      const idn = await identity.authenticate({ token: msg.token, headers: session.headers });
      if (!idn) {
        log.warn(`鉴权失败: token=${msg.token?.slice(0, 8)}...`);
        return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '鉴权失败' });
      }
      session.userId = idn.userId;
      log.info(`鉴权成功: user=${idn.userId}`);
      const profile: UserProfile = {
        nickname: msg.profile?.nickname ?? idn.nickname ?? '牌友',
        avatarUrl: msg.profile?.avatarUrl ?? idn.avatarUrl ?? '',
      };
      session.profile = profile;
      // BL-013 首条接线：登录 → users 落库 + 会话写 Redis（失败不阻断登录）
      try {
        await persistence.store.upsertUser({
          openid: idn.userId,
          nickname: profile.nickname,
          avatarUrl: profile.avatarUrl,
          lastLoginAt: new Date(),
        });
        await persistence.realtime.saveSession(
          msg.token,
          { openid: idn.userId, createdAt: Date.now() },
          SESSION_TTL_SEC,
        );
      } catch (err) {
        log.error(`登录落库失败: user=${idn.userId}`, err);
      }
      send(session, { t: 'authOk', userId: idn.userId, profile });
      return send(session, { t: 'ack', seq: msg.seq, ok: true });
    }
    case 'create': {
      if (!session.userId) return send(session, { t: 'error', reason: '未鉴权' });
      const maxRounds = msg.maxRounds ?? 8; // 0 = 不限（无限续局至房主解散，见 PRD 03 FR-房间-01）
      const room = rooms.create(session.userId, conn, maxRounds, session.profile?.nickname);
      session.roomId = room.id;
      log.info(`创建房间: room=${room.id} host=${session.userId} maxRounds=${maxRounds}`);
      // BL-013 M-C 接线：房间创建 → rooms 落库（弱依赖，失败不阻断建房，同登录落库策略）
      try {
        await persistence.store.createRoom({
          roomId: room.id,
          hostOpenid: session.userId,
          maxRounds,
          initialScore: { 0: 0, 1: 0, 2: 0, 3: 0 },
          finalScore: null,
          status: 'idle',
        });
      } catch (err) {
        log.error(`房间创建落库失败: room=${room.id}`, err);
      }
      // 房主创建 → room_member_events:create（弱依赖）
      await logMember(persistence.store, { roomId: room.id, openid: session.userId, seat: 0, event: 'create' });
      const botCount = Math.max(0, Math.min(3, autoBots));
      if (botCount > 0) {
        room.addBot(session.userId, botCount); // 开发期自动补齐（房主身份）
        if (room.playerCount() === 4) room.start(session.userId);
      }
      return send(session, { t: 'ack', seq: msg.seq, ok: true, reason: room.id });
    }
    case 'join': {
      if (!session.userId) return send(session, { t: 'error', reason: '未鉴权' });
      const room = rooms.get(msg.room);
      if (!room) return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '房间不存在' });
      const r = room.addPlayer(session.userId, conn, session.profile?.nickname);
      if (r.ok) {
        session.roomId = room.id;
        // 真人加入 → room_member_events:join（弱依赖）
        await logMember(persistence.store, { roomId: room.id, openid: session.userId, seat: r.seat ?? 0, event: 'join' });
      }
      return send(session, { t: 'ack', seq: msg.seq, ok: r.ok, reason: r.reason });
    }
    case 'leave': {
      if (session.roomId && session.userId) {
        const room = rooms.get(session.roomId);
        const seat = room?.roomView().seats.findIndex((s) => s?.userId === session.userId) ?? -1;
        room?.removePlayer(session.userId);
        // 退出 → room_member_events:leave（弱依赖；Bot 不记流水）
        if (seat >= 0 && !session.userId.startsWith('bot-')) {
          await logMember(persistence.store, { roomId: session.roomId, openid: session.userId, seat, event: 'leave' });
        }
      }
      session.roomId = null;
      return send(session, { t: 'ack', seq: msg.seq, ok: true });
    }
    case 'start': {
      if (!session.roomId || !session.userId) return send(session, { t: 'error', reason: '无房间' });
      const r = rooms.get(session.roomId)?.start(session.userId) ?? { ok: false, reason: '无房间' };
      return send(session, { t: 'ack', seq: msg.seq, ok: r.ok, reason: r.reason });
    }
    case 'addBot': {
      if (!session.roomId || !session.userId) return send(session, { t: 'error', reason: '无房间' });
      const r = rooms.get(session.roomId)?.addBot(session.userId, msg.count ?? 1) ?? { ok: false, reason: '无房间' };
      return send(session, { t: 'ack', seq: msg.seq, ok: r.ok, reason: r.reason });
    }
    case 'removeBot': {
      if (!session.roomId || !session.userId) return send(session, { t: 'error', reason: '无房间' });
      const r = rooms.get(session.roomId)?.removeBot(session.userId, msg.seat) ?? { ok: false, reason: '无房间' };
      return send(session, { t: 'ack', seq: msg.seq, ok: r.ok, reason: r.reason });
    }
    case 'nextRound': {
      if (!session.roomId || !session.userId) return send(session, { t: 'error', reason: '无房间' });
      const room = rooms.get(session.roomId);
      const r = room?.nextRound(session.userId) ?? { ok: false, reason: '无房间' };
      if (room?.phase === 'finished') { session.roomId = null; rooms.remove(room.id); } // 打满上限散场：回收房间
      return send(session, { t: 'ack', seq: msg.seq, ok: r.ok, reason: r.reason });
    }
    case 'dissolve': {
      if (!session.roomId || !session.userId) return send(session, { t: 'error', reason: '无房间' });
      const room = rooms.get(session.roomId);
      const r = room?.dissolve(session.userId) ?? { ok: false, reason: '无房间' };
      if (room?.phase === 'finished') { session.roomId = null; rooms.remove(room.id); } // 房主解散散场：回收房间
      return send(session, { t: 'ack', seq: msg.seq, ok: r.ok, reason: r.reason });
    }
    case 'action': {
      if (!session.roomId || !session.userId) return send(session, { t: 'error', reason: '无房间' });
      const r = rooms.get(session.roomId)?.handleAction(session.userId, msg.action) ?? { ok: false, reason: '无房间' };
      return send(session, { t: 'ack', seq: msg.seq, ok: r.ok, reason: r.reason });
    }
    case 'ping':
      return send(session, { t: 'pong' });
  }
}
