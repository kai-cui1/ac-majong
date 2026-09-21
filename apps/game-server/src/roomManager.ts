import { RoomActor, type GameHooks, type RoomRestore, type RoomTimings } from './roomActor';
import type { Connection } from './connection';
import type { GameStore } from '@ac-majong/persistence';
import type { RoomSettings, PublicRoomEntry } from '@ac-majong/protocol';

/** 房间管理：创建/查询/回收，分配 6 位房间号（全局唯一、永不复用，BL-016） */
export class RoomManager {
  private rooms = new Map<string, RoomActor>();
  private seedBase: number;
  private hooks?: GameHooks;
  private store?: GameStore;

  /** BL-018：聚合公开且未关闭房（等待先于对局中，同组按创建时间倒序，上限 20 行，FR-房间-11）；viewer 用于标记 mine（自己的房可重入） */
  publicRooms(viewer?: string): PublicRoomEntry[] {
    const list: { e: PublicRoomEntry; created: number }[] = [];
    for (const r of this.rooms.values()) {
      const e = r.listEntry();
      if (e) list.push({ e: { ...e, mine: viewer ? r.isMember(viewer) : false }, created: r.createdAt });
    }
    list.sort((a, b) => (a.e.status === b.e.status ? b.created - a.created : a.e.status === 'waiting' ? -1 : 1));
    return list.slice(0, 20).map((x) => x.e);
  }

  constructor(seedBase = Date.now() % 1_000_000, hooks?: GameHooks, store?: GameStore, private readonly defaultTimings?: RoomTimings) {
    this.seedBase = seedBase;
    this.hooks = hooks;
    this.store = store;
  }

  /** BL-016：发号双重查重——内存活跃房间 + `rooms` 历史表；房号永不复用（FR-房间-07） */
  async genUniqueId(): Promise<string> {
    for (;;) {
      const id = String(Math.floor(100000 + Math.random() * 900000));
      if (this.rooms.has(id)) continue;
      try {
        if (this.store && (await this.store.roomIdExists(id))) continue;
      } catch { /* 查重弱依赖：DB 不可用时退化为仅内存查重，createRoom 主键冲突仍会暴露 */ }
      return id;
    }
  }

  create(hostUserId: string, conn: Connection, maxRounds = 8, nickname?: string, timings?: RoomTimings, id?: string, settings?: RoomSettings): RoomActor {
    const roomId = id ?? this.genId();
    const room = new RoomActor(roomId, hostUserId, maxRounds, this.seedBase++, this.hooks, timings ?? this.defaultTimings, settings);
    this.rooms.set(roomId, room);
    room.addPlayer(hostUserId, conn, nickname);
    return room;
  }

  /** BL-016：注册事件溯源重建的房间（网关 rebuild 后入表，后续 join 直接命中内存） */
  register(room: RoomActor): void {
    this.rooms.set(room.id, room);
  }

  /** BL-016：用恢复快照新建并注册重建房间（不走 addPlayer，座位由 restore 注入） */
  createRestored(roomId: string, hostUserId: string, maxRounds: number, restore: RoomRestore, timings?: RoomTimings, settings?: RoomSettings): RoomActor {
    const room = new RoomActor(roomId, hostUserId, maxRounds, this.seedBase++, this.hooks, timings ?? this.defaultTimings, settings);
    room.restore(restore);
    this.rooms.set(roomId, room);
    return room;
  }

  /** BL-022 dev 自检：活跃房间列表（仅 diag HTTP /dev/rooms 用） */
  list(): RoomActor[] {
    return [...this.rooms.values()];
  }

  get(id: string): RoomActor | undefined {
    return this.rooms.get(id);
  }

  remove(id: string): void {
    this.rooms.get(id)?.dispose();
    this.rooms.delete(id);
  }

  /** 网关停服仅回收内存资源，不生成散场结算或覆盖持久化房间状态。 */
  dispose(): void {
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
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
