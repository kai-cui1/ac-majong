import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, IncomingHttpHeaders } from 'node:http';
import type { ClientMsg, ServerMsg } from '@ac-majong/protocol';
import type { Connection } from './connection';
import type { IdentityProvider } from './identity';
import { RoomManager } from './roomManager';
import { fillDevBots } from './devBots';

interface Session {
  ws: WebSocket;
  userId: string | null;
  roomId: string | null;
  alive: boolean;
  headers: IncomingHttpHeaders;
}

export interface GatewayOptions {
  port: number;
  identity: IdentityProvider;
  heartbeatMs?: number;
  /** 本地开发专用：真人建房后自动补 Bot 并开局（生产必须为0） */
  autoBots?: number;
}

export interface Gateway {
  wss: WebSocketServer;
  rooms: RoomManager;
  close: () => void;
}

/** 启动 WS 网关（平台无关；微信/Web 客户端都连这里，仅 identity 不同） */
export function startGateway(opts: GatewayOptions): Gateway {
  const rooms = new RoomManager();
  const wss = new WebSocketServer({ port: opts.port });
  const sessions = new Set<Session>();

  const send = (s: Session, msg: ServerMsg) => {
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(msg));
  };

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const session: Session = { ws, userId: null, roomId: null, alive: true, headers: req.headers };
    sessions.add(session);
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
        return send(session, { t: 'error', reason: 'bad json' });
      }
      void handleMsg(session, conn, msg, rooms, opts.identity, opts.autoBots ?? 0, send);
    });
    ws.on('close', () => {
      sessions.delete(session);
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

async function handleMsg(
  session: Session,
  conn: Connection,
  msg: ClientMsg,
  rooms: RoomManager,
  identity: IdentityProvider,
  autoBots: number,
  send: (s: Session, m: ServerMsg) => void,
): Promise<void> {
  switch (msg.t) {
    case 'auth': {
      const idn = await identity.authenticate({ token: msg.token, headers: session.headers });
      if (!idn) return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '鉴权失败' });
      session.userId = idn.userId;
      send(session, { t: 'authOk', userId: idn.userId });
      return send(session, { t: 'ack', seq: msg.seq, ok: true });
    }
    case 'create': {
      if (!session.userId) return send(session, { t: 'error', reason: '未鉴权' });
      const room = rooms.create(session.userId, conn, msg.maxRounds ?? 8);
      session.roomId = room.id;
      const botCount = Math.max(0, Math.min(3, autoBots));
      if (botCount > 0) {
        fillDevBots(room, botCount);
        if (room.playerCount() === 4) room.start(session.userId);
      }
      return send(session, { t: 'ack', seq: msg.seq, ok: true, reason: room.id });
    }
    case 'join': {
      if (!session.userId) return send(session, { t: 'error', reason: '未鉴权' });
      const room = rooms.get(msg.room);
      if (!room) return send(session, { t: 'ack', seq: msg.seq, ok: false, reason: '房间不存在' });
      const r = room.addPlayer(session.userId, conn);
      if (r.ok) session.roomId = room.id;
      return send(session, { t: 'ack', seq: msg.seq, ok: r.ok, reason: r.reason });
    }
    case 'leave': {
      if (session.roomId && session.userId) rooms.get(session.roomId)?.removePlayer(session.userId);
      session.roomId = null;
      return send(session, { t: 'ack', seq: msg.seq, ok: true });
    }
    case 'start': {
      if (!session.roomId || !session.userId) return send(session, { t: 'error', reason: '无房间' });
      const r = rooms.get(session.roomId)?.start(session.userId) ?? { ok: false, reason: '无房间' };
      return send(session, { t: 'ack', seq: msg.seq, ok: r.ok, reason: r.reason });
    }
    case 'nextRound': {
      if (!session.roomId || !session.userId) return send(session, { t: 'error', reason: '无房间' });
      const r = rooms.get(session.roomId)?.nextRound(session.userId) ?? { ok: false, reason: '无房间' };
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
