import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type {
  ActionRow,
  EndType,
  GameRow,
  GameStore,
  InitialStateRow,
  MemberEventRow,
  RoomRow,
  ScoreMap,
  UserRow,
} from './entities';

/** JSON 列：mysql2 可能返回字符串或已解析对象，统一处理 */
const parseJson = <T>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));
const json = (v: unknown): string => JSON.stringify(v ?? null);

/** MySQL 权威存储实现（6 表）。用 `MysqlGameStore.create(DATABASE_URL)` 构造连接池。 */
export class MysqlGameStore implements GameStore {
  private constructor(private readonly pool: Pool) {}

  static create(url: string): MysqlGameStore {
    return new MysqlGameStore(mysql.createPool(url));
  }

  async upsertUser(u: UserRow): Promise<void> {
    await this.pool.execute(
      `INSERT INTO users (openid, nickname, avatar_url, pass_hash, last_login_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), avatar_url = VALUES(avatar_url),
         pass_hash = COALESCE(VALUES(pass_hash), pass_hash), last_login_at = VALUES(last_login_at)`,
      [u.openid, u.nickname, u.avatarUrl, u.passHash ?? null, u.lastLoginAt ?? null],
    );
  }
  async getUser(openid: string): Promise<UserRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM users WHERE openid = ?', [openid]);
    const r = rows[0];
    if (!r) return null;
    return {
      openid: r.openid, nickname: r.nickname, avatarUrl: r.avatar_url,
      passHash: r.pass_hash ?? null,
      createdAt: r.created_at, lastLoginAt: r.last_login_at,
    };
  }

  async createRoom(rm: RoomRow): Promise<void> {
    await this.pool.execute(
      `INSERT INTO rooms (room_id, host_openid, max_rounds, initial_score, final_score, status, closed_at, settings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [rm.roomId, rm.hostOpenid, rm.maxRounds, json(rm.initialScore), json(rm.finalScore), rm.status, rm.closedAt ?? null, json(rm.settings ?? null)],
    );
  }
  async getRoom(roomId: string): Promise<RoomRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM rooms WHERE room_id = ?', [roomId]);
    const r = rows[0];
    if (!r) return null;
    return {
      roomId: r.room_id, hostOpenid: r.host_openid, maxRounds: r.max_rounds,
      initialScore: parseJson<ScoreMap>(r.initial_score),
      memberScores: r.member_scores == null ? null : parseJson<ScoreMap>(r.member_scores),
      settings: r.settings == null ? null : parseJson<RoomRow['settings']>(r.settings),
      seating: r.seating == null ? null : parseJson<unknown>(r.seating),
      finalScore: r.final_score == null ? null : parseJson<ScoreMap>(r.final_score),
      status: r.status, createdAt: r.created_at, closedAt: r.closed_at,
    };
  }
  async roomIdExists(roomId: string): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT 1 FROM rooms WHERE room_id = ? LIMIT 1', [roomId]);
    return rows.length > 0;
  }
  async markRoomPlaying(roomId: string): Promise<void> {
    await this.pool.execute(`UPDATE rooms SET status = 'playing' WHERE room_id = ?`, [roomId]);
  }
  async updateRoomScores(roomId: string, memberScores: ScoreMap): Promise<void> {
    await this.pool.execute(`UPDATE rooms SET member_scores = ? WHERE room_id = ?`, [json(memberScores), roomId]);
  }
  async updateRoomSeating(roomId: string, seating: unknown): Promise<void> {
    await this.pool.execute(`UPDATE rooms SET seating = ? WHERE room_id = ?`, [json(seating), roomId]);
  }
  async closeRoom(roomId: string, finalScore: ScoreMap, closedAt: Date): Promise<void> {
    await this.pool.execute(
      `UPDATE rooms SET status = 'closed', final_score = ?, closed_at = ? WHERE room_id = ?`,
      [json(finalScore), closedAt, roomId],
    );
  }

  async addMemberEvent(e: MemberEventRow): Promise<void> {
    await this.pool.execute(
      `INSERT INTO room_member_events (room_id, openid, seat, event) VALUES (?, ?, ?, ?)`,
      [e.roomId, e.openid, e.seat, e.event],
    );
  }
  async listMemberEvents(roomId: string): Promise<MemberEventRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM room_member_events WHERE room_id = ? ORDER BY at ASC, id ASC', [roomId]);
    return rows.map((r) => ({ roomId: r.room_id, openid: r.openid, seat: r.seat, event: r.event, at: r.at }));
  }

  async createGame(g: GameRow): Promise<void> {
    await this.pool.execute(
      `INSERT INTO games (game_id, room_id, round_no, dealer_seat, seed, end_type, result) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [g.gameId, g.roomId, g.roundNo, g.dealerSeat, g.seed, g.endType, json(g.result)],
    );
  }
  async saveInitialState(s: InitialStateRow): Promise<void> {
    await this.pool.execute(
      `INSERT INTO game_initial_states (game_id, wall, hands, lianzhuang_count, layout, break_group) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE wall = VALUES(wall), hands = VALUES(hands), lianzhuang_count = VALUES(lianzhuang_count), layout = VALUES(layout), break_group = VALUES(break_group)`,
      [s.gameId, json(s.wall), json(s.hands), s.lianzhuangCount, json(s.layout ?? null), s.breakGroup ?? null],
    );
  }
  async appendActions(rows: ActionRow[]): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const params: (string | number | null)[] = [];
    for (const r of rows) params.push(r.gameId, r.seq, r.seat, r.actionType, json(r.payload));
    await this.pool.execute(
      `INSERT INTO game_actions (game_id, seq, seat, action_type, payload) VALUES ${values}`,
      params,
    );
  }
  async finishGame(gameId: string, endType: EndType, result: unknown, endedAt: Date): Promise<void> {
    await this.pool.execute(
      `UPDATE games SET end_type = ?, result = ?, ended_at = ? WHERE game_id = ?`,
      [endType, json(result), endedAt, gameId],
    );
  }
  async getGame(gameId: string): Promise<GameRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM games WHERE game_id = ?', [gameId]);
    const r = rows[0];
    if (!r) return null;
    return {
      gameId: r.game_id, roomId: r.room_id, roundNo: r.round_no, dealerSeat: r.dealer_seat,
      seed: Number(r.seed), endType: r.end_type,
      result: r.result == null ? null : parseJson(r.result),
      startedAt: r.started_at, endedAt: r.ended_at,
    };
  }
  async getInitialState(gameId: string): Promise<InitialStateRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM game_initial_states WHERE game_id = ?', [gameId]);
    const r = rows[0];
    if (!r) return null;
    return {
      gameId: r.game_id, wall: parseJson(r.wall), hands: parseJson(r.hands), lianzhuangCount: r.lianzhuang_count,
      layout: r.layout == null ? null : parseJson(r.layout), breakGroup: r.break_group == null ? null : Number(r.break_group),
    };
  }
  async listActions(gameId: string): Promise<ActionRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM game_actions WHERE game_id = ? ORDER BY seq ASC', [gameId]);
    return rows.map((r) => ({
      gameId: r.game_id, seq: r.seq, seat: r.seat, actionType: r.action_type,
      payload: parseJson(r.payload), at: r.at,
    }));
  }
  async listRoomsByPlayer(openid: string): Promise<RoomRow[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT r.* FROM rooms r WHERE r.host_openid = ?
       UNION
       SELECT r.* FROM rooms r JOIN room_member_events m ON m.room_id = r.room_id WHERE m.openid = ?
       ORDER BY created_at DESC LIMIT 200`,
      [openid, openid]
    );
    return rows.map((r) => ({
      roomId: r.room_id, hostOpenid: r.host_openid, maxRounds: r.max_rounds,
      initialScore: parseJson<ScoreMap>(r.initial_score),
      memberScores: r.member_scores == null ? null : parseJson<ScoreMap>(r.member_scores),
      settings: r.settings == null ? null : parseJson<RoomRow['settings']>(r.settings),
      seating: r.seating == null ? null : parseJson<unknown>(r.seating),
      finalScore: r.final_score == null ? null : parseJson<ScoreMap>(r.final_score),
      status: r.status, createdAt: r.created_at, closedAt: r.closed_at,
    }));
  }

  async listGames(roomId: string): Promise<GameRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT * FROM games WHERE room_id = ? ORDER BY round_no ASC', [roomId]);
    return rows.map((r) => ({
      gameId: r.game_id, roomId: r.room_id, roundNo: r.round_no, dealerSeat: r.dealer_seat,
      seed: Number(r.seed), endType: r.end_type,
      result: r.result == null ? null : parseJson(r.result),
      startedAt: r.started_at, endedAt: r.ended_at,
    }));
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}
