import { RoomActor, type GameHooks } from './roomActor';
import type { Connection } from './connection';

/** 房间管理：创建/查询/回收，分配 6 位房间号 */
export class RoomManager {
  private rooms = new Map<string, RoomActor>();
  private seedBase: number;
  private hooks?: GameHooks;

  constructor(seedBase = Date.now() % 1_000_000, hooks?: GameHooks) {
    this.seedBase = seedBase;
    this.hooks = hooks;
  }

  create(hostUserId: string, conn: Connection, maxRounds = 8, nickname?: string, timings?: { trusteeAfterMs?: number }): RoomActor {
    const id = this.genId();
    const room = new RoomActor(id, hostUserId, maxRounds, this.seedBase++, this.hooks, timings);
    this.rooms.set(id, room);
    room.addPlayer(hostUserId, conn, nickname);
    return room;
  }

  get(id: string): RoomActor | undefined {
    return this.rooms.get(id);
  }

  remove(id: string): void {
    this.rooms.delete(id);
  }

  size(): number {
    return this.rooms.size;
  }

  private genId(): string {
    for (;;) {
      const id = String(Math.floor(100000 + Math.random() * 900000));
      if (!this.rooms.has(id)) return id;
    }
  }
}
