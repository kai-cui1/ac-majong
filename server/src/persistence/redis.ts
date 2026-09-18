import Redis from 'ioredis';
import type { ActionRow, RealtimeStore, SessionData } from './entities';

/** Redis 热存储实现：会话 / 房间快照 / 实例路由 / 动作缓冲（Stream 用 List 简化实现） */
export class RedisRealtime implements RealtimeStore {
  private constructor(private readonly r: Redis) {}

  static create(url: string): RedisRealtime {
    return new RedisRealtime(new Redis(url));
  }

  async saveSession(token: string, data: SessionData, ttlSec: number): Promise<void> {
    await this.r.set(`sess:${token}`, JSON.stringify(data), 'EX', Math.max(1, Math.round(ttlSec)));
  }
  async getSession(token: string): Promise<SessionData | null> {
    const v = await this.r.get(`sess:${token}`);
    return v ? (JSON.parse(v) as SessionData) : null;
  }
  async delSession(token: string): Promise<void> {
    await this.r.del(`sess:${token}`);
  }

  async saveRoomSnapshot(roomId: string, viewJson: string): Promise<void> {
    await this.r.set(`snap:${roomId}`, viewJson);
  }
  async getRoomSnapshot(roomId: string): Promise<string | null> {
    return this.r.get(`snap:${roomId}`);
  }

  async setRoomInstance(roomId: string, instanceId: string): Promise<void> {
    await this.r.set(`inst:${roomId}`, instanceId);
  }
  async getRoomInstance(roomId: string): Promise<string | null> {
    return this.r.get(`inst:${roomId}`);
  }

  async bufferActions(gameId: string, rows: ActionRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.r.rpush(`buf:${gameId}`, ...rows.map((r) => JSON.stringify(r)));
  }
  async drainActions(gameId: string): Promise<ActionRow[]> {
    const key = `buf:${gameId}`;
    const res = await this.r.multi().lrange(key, 0, -1).del(key).exec();
    const items = (res?.[0]?.[1] as string[] | null) ?? [];
    return items.map((s) => JSON.parse(s) as ActionRow);
  }
  async peekActions(gameId: string): Promise<ActionRow[]> {
    const items = await this.r.lrange(`buf:${gameId}`, 0, -1);
    return items.map((s) => JSON.parse(s) as ActionRow);
  }
  async close(): Promise<void> {
    await this.r.quit();
  }
}
