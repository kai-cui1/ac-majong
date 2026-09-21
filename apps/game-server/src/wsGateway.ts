import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, IncomingHttpHeaders } from 'node:http';
import type { ClientMsg, ServerMsg, UserProfile, ReplayRoomSummary, ReplayRoundSummary, ReplaySnapshot, RoundReview } from '@ac-majong/protocol';
import type { TableState, Action } from '@ac-majong/engine';
import { replayRound } from '@ac-majong/engine';
import type { Connection } from './connection';
import type { IdentityProvider } from './identity';
import { RoomManager } from './roomManager';
import { buildReplayBundle } from '@ac-majong/persistence';
import type { GameHooks, RoomRestore, RoomTimings } from './roomActor';
import type { GameStore, RealtimeStore, MemberEventRow, ScoreMap } from '@ac-majong/persistence';
import { toRoundSnapshot } from '@ac-majong/persistence';
import { MemoryGameStore, MemoryRealtime } from '@ac-majong/persistence';
import { loginOrRegister, resolveSession } from './accountAuth';
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
  /** 鉴权失败计数（累计 5 次断开，防穷举） */
  authFails?: number;
}

export interface GatewayOptions {
  port: number;
  identity: IdentityProvider;
  heartbeatMs?: number;
  /** 本地开发专用：真人建房后自动补 Bot 并开局（生产必须为0） */
  autoBots?: number;
  /** 持久化（缺省内存实现）；登录会 upsertUser + 写会话（BL-013 接线） */
  persistence?: { store: GameStore; realtime: RealtimeStore };
  /** H5 账号路线（IDENTITY=account）：auth 走账号密码/会话令牌，而非 IdentityProvider */
  accountMode?: boolean;
  /** 集成测试可注入时长；未提供时严格使用正式仪式节奏。 */
  roomTimings?: RoomTimings;
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
          await persistence.store.saveInitialState({ gameId, wall: snap.wall, hands: snap.players, lianzhuangCount: snap.lianzhuangCount, layout: snap.layout ?? null, breakGroup: snap.breakGroups ?? null });
          // BL-016：开局置 status='playing'（重进/重建判定依据；覆盖 AUTO_BOTS 自动开局与 start 两条路径，幂等）
          await persistence.store.markRoomPlaying(roomId);
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
    onGameEnd(roomId, gameId, endType, result, scores) {
      log.info(`对局结束: game=${gameId} endType=${endType} scores=${JSON.stringify(scores)}`);
      void (async () => {
        try {
          const rows = await persistence.realtime.drainActions(gameId);
          if (rows.length) await persistence.store.appendActions(rows);
          await persistence.store.finishGame(gameId, endType, result, new Date());
          // BL-016：每局末写积分账本（重进/重启恢复依据，FR-房间-09）
          await persistence.store.updateRoomScores(roomId, scores);
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
    // BL-017：开局仪式日志落 rooms.seating（弱依赖 fire-and-forget）
    onSeating(roomId, seating) {
      void (async () => {
        try {
          await persistence.store.updateRoomSeating(roomId, seating);
        } catch (err) {
          log.error(`仪式日志落库失败: room=${roomId}`, err);
        }
      })();
    },
  };
  const rooms = new RoomManager(undefined, gameHooks, persistence.store, opts.roomTimings);

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
      void handleMsg(session, conn, msg, rooms, opts.identity, opts.autoBots ?? 0, send, persistence, opts.accountMode ?? false);
    });
    ws.on('close', () => {
      sessions.delete(session);
      log.info(`连接断开: user=${session.userId ?? '(未鉴权)'} room=${session.roomId ?? '-'} 剩余在线=${sessions.size}`);
      // M-I：对局中掉线→离线标记+超时托管；等待期仅清连接（座位均保留）
      if (session.roomId && session.userId) rooms.get(session.roomId)?.playerDisconnected(session.userId);
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
      rooms.dispose();
      for (const session of sessions) session.ws.close(1001, '服务器关闭');
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
  accountMode = false,
): Promise<void> {
  switch (msg.t) {
    case 'auth': {
      // H5 账号路线：账号密码注册即登录 / 会话令牌复登（签发新 session 回传）
      if (accountMode) {
        const fail = (reason: string) => {
          session.authFails = (session.authFails ?? 0) + 1;
          log.warn(`鉴权失败(${session.authFails}/5): ${reason}`);
          if (session.authFails >= 5) session.ws.close(4001, 'too many auth failures');
          return send(session, { t: 'ack', seq: msg.seq, ok: false, reason });
        };
        let userId: string;
        let nickname: string;
        let sessionToken: string | undefined;
        if (msg.account) {
          const r = await loginOrRegister(persistence.store, persistence.realtime, {
            username: msg.account.username,
            password: msg.account.password,
            nickname: msg.profile?.nickname,
          });
          if ('error' in r) return fail(r.error);
          userId = r.userId;
          nickname = r.nickname;
          sessionToken = r.session;
          try {
            await persistence.store.upsertUser({ openid: userId, nickname, avatarUrl: '', lastLoginAt: new Date() });
          } catch (err) {
            log.error(`登录落库失败: user=${userId}`, err);
          }
        } else {
          const openid = msg.token ? await resolveSession(persistence.realtime, msg.token) : null;
          if (!openid) return fail('会话过期，请重新登录');
          const u = await persistence.store.getUser(openid);
          userId = openid;
          nickname = u?.nickname || '牌友';
        }
        session.userId = userId;
        const profile: UserProfile = { nickname, avatarUrl: '' };
        session.profile = profile;
        log.info(`账号鉴权成功: user=${userId} via=${msg.account ? 'password' : 'session'}`);
        send(session, { t: 'authOk', userId, profile, session: sessionToken });
        return send(session, { t: 'ack', seq: msg.seq, ok: true });
      }
      const idn = await identity.authenticate({ token: msg.token, headers: session.headers });
      if (!idn) {
        session.authFails = (session.authFails ?? 0) + 1;
        if (session.authFails >= 5) session.ws.close(4001, 'too many auth failures');
        log.warn(`鉴权失败: token=${msg.token?.slice(0, 8)}...`);
        return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '鉴权 失败' });
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
        if (msg.token) {
          await persistence.realtime.saveSession(
            msg.token,
            { openid: idn.userId, createdAt: Date.now() },
            SESSION_TTL_SEC,
          );
        }
      } catch (err) {
        log.error(`登录落库失败: user=${idn.userId}`, err);
      }
      send(session, { t: 'authOk', userId: idn.userId, profile });
      return send(session, { t: 'ack', seq: msg.seq, ok: true });
    }
    case 'create': {
      if (!session.userId) return send(session, { t: 'error', reason: '未鉴权' });
      const maxRounds = msg.maxRounds ?? 8; // 0 = 不限（无限续局至房主解散，见 PRD 03 FR-房间-01）
      const rs = msg.settings; // BL-017/BL-020/BL-018 玩法参数（缺省字段补默认：先看吃再碰/公开房间默认开）
      const settings = { wallMode: rs?.wallMode ?? ('random' as const), breakDice: rs?.breakDice ?? false, chiFirstView: rs?.chiFirstView ?? true, isPublic: rs?.isPublic ?? true };
      // BL-016：房号全局唯一、永不复用（内存活跃房 + rooms 历史表双重查重，FR-房间-07）
      const roomId = await rooms.genUniqueId();
      const room = rooms.create(session.userId, conn, maxRounds, session.profile?.nickname, undefined, roomId, settings);
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
          settings,
        });
      } catch (err) {
        log.error(`房间创建落库失败: room=${room.id}`, err);
      }
      // 房主创建 → room_member_events:create（弱依赖）
      await logMember(persistence.store, { roomId: room.id, openid: session.userId, seat: 0, event: 'create' });
      const botCount = Math.max(0, Math.min(3, autoBots));
      if (botCount > 0) {
        room.addBot(session.userId, botCount); // 开发期自动补齐（房主身份）
        // BL-016：Bot 入座补记成员流水（服务重启重建时恢复 Bot 座位；弱依赖）
        for (const s of room.roomView().seats) {
          if (s?.isBot) await logMember(persistence.store, { roomId: room.id, openid: s.userId, seat: s.seat, event: 'join' });
        }
        if (room.playerCount() === 4) room.start(session.userId);
      }
      return send(session, { t: 'ack', seq: msg.seq, ok: true, reason: room.id });
    }
    case 'join': {
      if (!session.userId) return send(session, { t: 'error', reason: '未鉴权' });
      // BL-016：内存未命中时走 DB——已关闭拒绝；未关闭且本人曾入座→事件溯源重建（积分/座位保留，FR-房间-09）
      let room = rooms.get(msg.room);
      let noRoomReason = '房间不存在';
      if (!room) {
        const rebuilt = await rebuildRoomFromStore(rooms, persistence.store, persistence.realtime, msg.room);
        room = rebuilt?.room ?? undefined;
        if (rebuilt?.reason) noRoomReason = rebuilt.reason;
      }
      if (!room) return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: noRoomReason });
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
        // 对局中退出按断线/托管处理（PRD08 FR-设置-02）；等待期退出仅清连接
        if (room?.phase === 'seating' || room?.phase === 'playing') room.playerDisconnected(session.userId);
        else room?.removePlayer(session.userId);
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
    case 'roll': {
      if (!session.roomId || !session.userId) return send(session, { t: 'error', reason: '无房间' });
      const r = rooms.get(session.roomId)?.handleRoll(session.userId, msg.ceremonyToken) ?? { ok: false, reason: '无房间' };
      return send(session, { t: 'ack', seq: msg.seq, ok: r.ok, reason: r.reason });
    }
    case 'pickSeat': {
      if (!session.roomId || !session.userId) return send(session, { t: 'error', reason: '无房间' });
      const r = rooms.get(session.roomId)?.handlePickSeat(session.userId, msg.seat, msg.ceremonyToken) ?? { ok: false, reason: '无房间' };
      return send(session, { t: 'ack', seq: msg.seq, ok: r.ok, reason: r.reason });
    }
    case 'roomList': { // BL-018：大厅公开房间列表（仅登录态可拉）
      if (!session.userId) return send(session, { t: 'error', reason: '未鉴权' });
      send(session, { t: 'roomList', rooms: rooms.publicRooms(session.userId ?? undefined) });
      return send(session, { t: 'ack', seq: msg.seq, ok: true });
    }
    case 'addBot': {
      if (!session.roomId || !session.userId) return send(session, { t: 'error', reason: '无房间' });
      const room = rooms.get(session.roomId);
      const before = room ? room.roomView().seats.map((s) => s?.userId ?? null) : [];
      const r = room?.addBot(session.userId, msg.count ?? 1) ?? { ok: false, reason: '无房间' };
      // BL-016：Bot 入座补记成员流水（服务重启重建时恢复 Bot 座位；弱依赖）
      if (r.ok && room) {
        const after = room.roomView().seats;
        for (const s of after) {
          if (s && s.isBot && before[s.seat] !== s.userId) {
            await logMember(persistence.store, { roomId: room.id, openid: s.userId, seat: s.seat, event: 'join' });
          }
        }
      }
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
    case 'resendSettlement': { // BL-026：结算相位晚进入/晚挂载补发终局事件（重建结算浮层）
      if (!session.roomId || !session.userId) return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '无房间' });
      const ev = rooms.get(session.roomId)?.resendSettlement(session.userId) ?? null;
      if (!ev) return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '无终局事件' });
      send(session, { t: 'event', events: [ev] });
      return send(session, { t: 'ack', seq: msg.seq, ok: true });
    }
    // BL-012：战绩/回放列表（房间→局两级，仅本人参赛房间）
    case 'replayList': {
      if (!session.userId) return send(session, { t: 'error', reason: '未鉴权' });
      try {
        const roomRows = await persistence.store.listRoomsByPlayer(session.userId);
        const out: ReplayRoomSummary[] = [];
        for (const r of roomRows) {
          const memEv = await persistence.store.listMemberEvents(r.roomId);
          const seatNames: Record<number, string> = {};
          for (const m of memEv) {
            if (m.seat == null || seatNames[m.seat] !== undefined) continue;
            const u = await persistence.store.getUser(m.openid);
            if (u) seatNames[m.seat] = u.nickname;
          }
          const games = await persistence.store.listGames(r.roomId);
          const rounds: ReplayRoundSummary[] = games.map((g) => {
            const ev = (g.result ?? null) as { winners?: { seat: number; tai: number }[] } | null;
            const winners = ev?.winners ?? [];
            return {
              gameId: g.gameId,
              roundNo: g.roundNo,
              endType: g.endType ?? 'exhaustive',
              winnerSeats: winners.map((w) => w.seat),
              taiBySeat: Object.fromEntries(winners.map((w) => [w.seat, w.tai])),
              at: g.endedAt ? g.endedAt.toISOString() : null,
            };
          });
          out.push({ roomId: r.roomId, createdAt: r.createdAt ? r.createdAt.toISOString() : '', status: r.status, seatNames, rounds });
        }
        return send(session, { t: 'replayList', rooms: out });
      } catch (err) {
        log.error('回放列表查询失败', err);
        return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '战绩加载失败' });
      }
    }
    // BL-012：加载单局回放（D-29：仅参赛四方可看；快照+动作序列交客户端确定性重演）
    case 'replayLoad': {
      if (!session.userId) return send(session, { t: 'error', reason: '未鉴权' });
      try {
        const game = await persistence.store.getGame(msg.gameId);
        if (!game) return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '对局不存在' });
        const room = await persistence.store.getRoom(game.roomId);
        const memEv = await persistence.store.listMemberEvents(game.roomId);
        const participants = new Set<string>(memEv.map((m) => m.openid));
        if (room?.hostOpenid) participants.add(room.hostOpenid);
        if (!participants.has(session.userId)) return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '无权查看该对局' });
        const snapRow = await persistence.store.getInitialState(msg.gameId);
        if (!snapRow) return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '回放数据缺失' });
        const actionRows = await persistence.store.listActions(msg.gameId);
        const names: Record<number, string> = {};
        const seenSeat = new Set<number>();
        for (const m of memEv) {
          if (m.seat == null || seenSeat.has(m.seat)) continue;
          seenSeat.add(m.seat);
          const u = await persistence.store.getUser(m.openid);
          names[m.seat] = u?.nickname ?? m.openid.slice(0, 8);
        }
        const snapshot: ReplaySnapshot = {
          wall: snapRow.wall as string[],
          players: snapRow.hands.map((pl) => ({ seat: pl.seat, concealed: pl.concealed as Record<string, number>, melds: pl.melds, flowers: pl.flowers as string[], zi: pl.zi, score: pl.score })),
          dealerSeat: game.dealerSeat,
          currentSeat: game.dealerSeat,
          lianzhuangCount: snapRow.lianzhuangCount,
          round: game.roundNo,
        };
        const viewSeat = memEv.find((m) => m.openid === session.userId && m.seat != null)?.seat ?? 0;
        return send(session, {
          t: 'replayData',
          gameId: msg.gameId,
          snapshot,
          actions: actionRows.map((ar) => ({ seq: ar.seq, seat: ar.seat, action: ar.payload })),
          names,
          viewSeat,
        });
      } catch (err) {
        log.error('回放加载失败', err);
        return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '回放加载失败' });
      }
    }
    case 'exportReplay': {
      // BL-024：导出单局回放包（参赛四方可导，申诉/复现用）；成员校验同 replayLoad（D-29）
      if (!session.userId) return send(session, { t: 'error', reason: '未鉴权' });
      try {
        const game = await persistence.store.getGame(msg.gameId);
        if (!game) return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '对局不存在' });
        const room = await persistence.store.getRoom(game.roomId);
        const memEv = await persistence.store.listMemberEvents(game.roomId);
        const participants = new Set<string>(memEv.map((m) => m.openid));
        if (room?.hostOpenid) participants.add(room.hostOpenid);
        if (!participants.has(session.userId)) return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '无权导出该对局' });
        const bundle = await buildReplayBundle(persistence.store, msg.gameId);
        if (!bundle) return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '回放数据缺失' });
        return send(session, { t: 'replayBundle', bundle });
      } catch (err) {
        log.error('回放导出失败', err);
        return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '回放导出失败' });
      }
    }
    case 'ping':
      return send(session, { t: 'pong' });
  }
}

/** games.result 里 win 事件的重演取值形状（仅重建回顾用） */
type StoredWinResult = { winners?: { seat: number; tai: number; detail?: { name: string; tai: number }[] }[] } | null;

/**
 * BL-016：成员重进时房间不在内存（服务重启/进程回收）——由 MySQL 事件溯源重建 RoomActor：
 * 座位/昵称 ← room_member_events + users；积分现场 ← 最新一局快照 + 动作日志（含 Redis
 * 未落盘缓冲 peekActions）replayRound 重演；回顾/胡数 ← games.result。已关闭房间返回 null
 * 并记日志（网关据此提示）；本人无座位记录交由 addPlayer 按新用户处理（waiting 可入座）。
 */
export async function rebuildRoomFromStore(
  rooms: RoomManager,
  store: GameStore,
  realtime: RealtimeStore,
  roomId: string,
): Promise<{ room: ReturnType<RoomManager['get']>; reason?: string } | null> {
  let roomRow;
  try {
    roomRow = await store.getRoom(roomId);
  } catch (err) {
    log.error(`房间重建查询失败: room=${roomId}`, err);
    return null;
  }
  if (!roomRow) return null;
  if (roomRow.status === 'closed') {
    log.info(`加入已关闭房间被拒: room=${roomId}`);
    return { room: undefined, reason: '房间已关闭' }; // 房号永不复用（FR-房间-07）；积分已定格、线下结算（FR-积分-06）
  }
  const memEv = await store.listMemberEvents(roomId);
  const seats: (string | null)[] = [null, null, null, null];
  const names: (string | null)[] = [null, null, null, null];
  for (const m of memEv) {
    if (m.seat == null || m.seat < 0 || m.seat > 3 || seats[m.seat]) continue;
    seats[m.seat] = m.openid;
    const u = await store.getUser(m.openid);
    names[m.seat] = u?.nickname ?? (m.openid.startsWith('bot-') ? '机器人' : m.openid);
  }
  const games = await store.listGames(roomId);
  const gameSeq = games.length;
  // 回顾/胡数：由已落库 games.result 重建（散场战绩页用）
  const roundLog: RoundReview[] = [];
  const winCount: Record<number, number> = {};
  for (const g of games) {
    if (g.endType === 'win') {
      const res = g.result as StoredWinResult;
      const w0 = res?.winners?.[0];
      if (w0) {
        winCount[w0.seat] = (winCount[w0.seat] ?? 0) + 1;
        const top = [...(w0.detail ?? [])].sort((a, b) => b.tai - a.tai)[0];
        roundLog.push({ round: g.roundNo, endType: 'win', winnerSeat: w0.seat, tai: w0.tai, topFan: top?.name ?? null, zimo: false });
      }
    } else if (g.endType === 'exhaustive') {
      roundLog.push({ round: g.roundNo, endType: 'exhaustive', winnerSeat: null, tai: 0, topFan: null, zimo: false });
    }
  }
  // 对局现场：重演最新一局（DB 动作 + Redis 未落盘缓冲）；重演失败/快照缺失则降级 waiting（积分保留在账本，下局以账本为初始分）
  let phase: 'waiting' | 'playing' = games.length === 0 ? 'waiting' : 'playing';
  let state: TableState | null = null;
  let gameId: string | null = null;
  let actionSeq = 0;
  const memberScores: ScoreMap = roomRow.memberScores ?? {};
  const last = games[games.length - 1];
  if (last) {
    const snapRow = await store.getInitialState(last.gameId);
    if (snapRow) {
      const dbActions = await store.listActions(last.gameId);
      let acts: Action[] = dbActions.map((r) => r.payload);
      if (last.endType == null) {
        try {
          const buffered = await realtime.peekActions(last.gameId);
          const dbSeqs = dbActions.map((r) => r.seq);
          acts = acts.concat(buffered.filter((r) => !dbSeqs.includes(r.seq)).map((r) => r.payload));
        } catch (err) {
          log.error(`重建读取动作缓冲失败: game=${last.gameId}`, err);
        }
      }
      try {
        // 积分以账本为准注入快照（账本=上一局末权威累计分，与局开局快照同源；确保降级/重演两路径积分都不丢）
        const snap = toRoundSnapshot(last, snapRow);
        snap.players = snap.players.map((p) => ({ ...p, score: typeof memberScores[p.seat] === 'number' ? memberScores[p.seat]! : p.score }));
        const rep = replayRound(snap, acts);
        state = rep.state;
        gameId = last.gameId;
        actionSeq = acts.length;
      } catch (err) {
        log.error(`重演重建失败，降级 waiting（积分保留在账本）: game=${last.gameId}`, err);
        state = null;
        gameId = null;
        actionSeq = 0;
      }
    }
    if (state == null) phase = 'waiting';
  }
  const restore: RoomRestore = {
    phase,
    state,
    gameId,
    gameSeq,
    actionSeq,
    seed: last ? Number(last.seed) + 1 : undefined,
    seats,
    names,
    roundLog,
    winCount,
    ledgerScores: memberScores,
    absentUsers: phase === 'playing' ? seats.filter((u): u is string => !!u && !u.startsWith('bot-')) : [],
  };
  const room = rooms.createRestored(roomId, roomRow.hostOpenid, roomRow.maxRounds, restore, undefined, roomRow.settings ?? undefined);
  seats.forEach((u, i) => {
    if (u && u.startsWith('bot-')) room.attachBot(u, 300 + i * 80);
  });
  log.info(`房间重建完成: room=${roomId} phase=${phase} game=${gameId ?? '-'} scores=${JSON.stringify(memberScores)}`);
  return { room };
}
