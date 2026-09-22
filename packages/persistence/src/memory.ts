import type {
  ActionRow,
  EndType,
  GameRow,
  GameStore,
  InitialStateRow,
  MemberEventRow,
  RealtimeStore,
  RoomMetaPatch,
  RoomRow,
  ScoreMap,
  SessionData,
  UserRow,
} from './entities';

const clone = <T>(v: T): T => (v == null ? v : structuredClone(v));

/** 内存版持久存储：无外部依赖，用于单元测试与本地无 Docker 兜底 */
export class MemoryGameStore implements GameStore {
  private users = new Map<string, UserRow>();
  private rooms = new Map<string, RoomRow>();
  private memberEvents: MemberEventRow[] = [];
  private games = new Map<string, GameRow>();
  private initials = new Map<string, InitialStateRow>();
  private actions = new Map<string, ActionRow[]>();

  async upsertUser(u: UserRow): Promise<void> {
    const prev = this.users.get(u.openid);
    this.users.set(u.openid, {
      ...prev,
      ...u,
      createdAt: prev?.createdAt ?? u.createdAt ?? new Date(),
    });
  }
  async getUser(openid: string): Promise<UserRow | null> {
    return clone(this.users.get(openid) ?? null);
  }

  async createRoom(r: RoomRow): Promise<void> {
    this.rooms.set(r.roomId, { ...clone(r)!, createdAt: r.createdAt ?? new Date() });
  }
  async getRoom(roomId: string): Promise<RoomRow | null> {
    return clone(this.rooms.get(roomId) ?? null);
  }
  async roomIdExists(roomId: string): Promise<boolean> {
    return this.rooms.has(roomId);
  }
  async markRoomPlaying(roomId: string): Promise<void> {
    const r = this.rooms.get(roomId);
    if (r) r.status = 'playing';
  }
  async updateRoomScores(roomId: string, memberScores: ScoreMap): Promise<void> {
    const r = this.rooms.get(roomId);
    if (r) r.memberScores = clone(memberScores)!;
  }
  async updateRoomSeating(roomId: string, seating: unknown): Promise<void> {
    const r = this.rooms.get(roomId);
    if (r) r.seating = clone(seating);
  }
  async updateRoomMeta(roomId: string, patch: RoomMetaPatch): Promise<void> {
    const r = this.rooms.get(roomId);
    if (!r) return;
    if (patch.maxRounds != null) r.maxRounds = patch.maxRounds;
    if (patch.settings !== undefined) r.settings = patch.settings ?? null;
    if (patch.botPersonas !== undefined) r.botPersonas = clone(patch.botPersonas ?? null) ?? null;
    if (patch.trusteePersonas !== undefined) r.trusteePersonas = clone(patch.trusteePersonas ?? null) ?? null;
  }
  async closeRoom(roomId: string, finalScore: ScoreMap, closedAt: Date): Promise<void> {
    const r = this.rooms.get(roomId);
    if (r) {
      r.status = 'closed';
      r.finalScore = finalScore;
      r.closedAt = closedAt;
    }
  }

  async addMemberEvent(e: MemberEventRow): Promise<void> {
    this.memberEvents.push({ ...e, at: e.at ?? new Date() });
  }
  async listMemberEvents(roomId: string): Promise<MemberEventRow[]> {
    return clone(this.memberEvents.filter((e) => e.roomId === roomId));
  }

  async createGame(g: GameRow): Promise<void> {
    this.games.set(g.gameId, { ...clone(g)!, startedAt: g.startedAt ?? new Date() });
  }
  async saveInitialState(s: InitialStateRow): Promise<void> {
    this.initials.set(s.gameId, clone(s)!);
  }
  async appendActions(rows: ActionRow[]): Promise<void> {
    for (const r of rows) {
      const arr = this.actions.get(r.gameId) ?? [];
      arr.push(clone(r)!);
      this.actions.set(r.gameId, arr);
    }
  }
  async finishGame(gameId: string, endType: EndType, result: unknown, endedAt: Date): Promise<void> {
    const g = this.games.get(gameId);
    if (g) {
      g.endType = endType;
      g.result = result;
      g.endedAt = endedAt;
    }
  }
  async getGame(gameId: string): Promise<GameRow | null> {
    return clone(this.games.get(gameId) ?? null);
  }
  async getInitialState(gameId: string): Promise<InitialStateRow | null> {
    return clone(this.initials.get(gameId) ?? null);
  }
  async listActions(gameId: string): Promise<ActionRow[]> {
    return clone([...(this.actions.get(gameId) ?? [])].sort((a, b) => a.seq - b.seq));
  }
  async listRoomsByPlayer(openid: string): Promise<RoomRow[]> {
    const ids = new Set<string>();
    for (const r of this.rooms.values()) if (r.hostOpenid === openid) ids.add(r.roomId);
    for (const m of this.memberEvents.values()) if (m.openid === openid) ids.add(m.roomId);
    return clone(
      [...ids]
        .map((id) => this.rooms.get(id)!)
        .filter(Boolean)
        .sort((x, y) => (y.createdAt?.getTime() ?? 0) - (x.createdAt?.getTime() ?? 0))
        .slice(0, 200),
    );
  }

  async listGames(roomId: string): Promise<GameRow[]> {
    return clone(
      [...this.games.values()].filter((g) => g.roomId === roomId).sort((a, b) => a.roundNo - b.roundNo),
    );
  }
  async close(): Promise<void> {}
}

/** 内存版热存储：会话 / 快照 / 路由 / 动作缓冲 */
export class MemoryRealtime implements RealtimeStore {
  private sessions = new Map<string, { data: SessionData; expireAt: number }>();
  private snapshots = new Map<string, string>();
  private instances = new Map<string, string>();
  private buffers = new Map<string, ActionRow[]>();

  async saveSession(token: string, data: SessionData, ttlSec: number): Promise<void> {
    this.sessions.set(token, { data: { ...data }, expireAt: Date.now() + ttlSec * 1000 });
  }
  async getSession(token: string): Promise<SessionData | null> {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expireAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return { ...s.data };
  }
  async delSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async saveRoomSnapshot(roomId: string, viewJson: string): Promise<void> {
    this.snapshots.set(roomId, viewJson);
  }
  async getRoomSnapshot(roomId: string): Promise<string | null> {
    return this.snapshots.get(roomId) ?? null;
  }

  async setRoomInstance(roomId: string, instanceId: string): Promise<void> {
    this.instances.set(roomId, instanceId);
  }
  async getRoomInstance(roomId: string): Promise<string | null> {
    return this.instances.get(roomId) ?? null;
  }

  async bufferActions(gameId: string, rows: ActionRow[]): Promise<void> {
    const arr = this.buffers.get(gameId) ?? [];
    arr.push(...rows.map((r) => ({ ...r })));
    this.buffers.set(gameId, arr);
  }
  async drainActions(gameId: string): Promise<ActionRow[]> {
    const arr = this.buffers.get(gameId) ?? [];
    this.buffers.delete(gameId);
    return arr;
  }
  async peekActions(gameId: string): Promise<ActionRow[]> {
    return [...(this.buffers.get(gameId) ?? [])].map((r) => ({ ...r }));
  }
  async close(): Promise<void> {}
}
