import type { GameRow, MemberEventRow, RoomRow, UserRow } from '../entities';
import type { ReplaySource } from '../replayBundle';

/** Admin 领域类型与查询契约（BL-015 / Admin 技术方案 §3.2、§5）。 */

export type AdminRole = 'super' | 'operator' | 'viewer';
export type AdminStatus = 'active' | 'disabled';
export type ArbitrationStatus = 'pending' | 'accepted' | 'rejected' | 'resolved';
export type AuditResult = 'success' | 'fail';
export type RoomStatusFilter = 'idle' | 'playing' | 'closed';

export interface AdminRow {
  id: number;
  username: string;
  passHash: string;
  role: AdminRole;
  status: AdminStatus;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}
/** 对外（不含密码哈希） */
export type AdminPublic = Omit<AdminRow, 'passHash'>;

export interface ArbitrationRow {
  id: number;
  gameId: string;
  adminId: number;
  status: ArbitrationStatus;
  verdict: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditLogRow {
  id: number;
  adminId: number | null;
  adminUsername: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  ip: string | null;
  result: AuditResult;
  at: Date;
}

/** 通用分页信封（对齐 Admin 技术方案 §5） */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}
export interface PageQuery {
  page?: number;
  size?: number;
}

export interface UserFilter extends PageQuery {
  /** 模糊匹配 openid / nickname */
  q?: string;
  from?: Date;
  to?: Date;
}
export interface RoomFilter extends PageQuery {
  roomId?: string;
  host?: string;
  status?: RoomStatusFilter;
  from?: Date;
  to?: Date;
}
export interface GameFilter extends PageQuery {
  roomId?: string;
  from?: Date;
  to?: Date;
}
export interface AuditFilter extends PageQuery {
  adminId?: number;
  action?: string;
  targetType?: string;
  from?: Date;
  to?: Date;
}

/** 房间列表行（轻量投影，附房主昵称/局数便于列表展示） */
export interface RoomSummary {
  room: RoomRow;
  hostNickname: string | null;
  gameCount: number;
}
/** 对局列表行（附所属房号已在 GameRow；这里保留原行 + 动作数） */
export interface GameSummary {
  game: GameRow;
  actionCount: number;
}

/** admin 自有表读写（管理员 / 仲裁 / 审计） */
export interface AdminStore {
  createAdmin(input: { username: string; passHash: string; role: AdminRole }): Promise<AdminPublic>;
  getAdminByUsername(username: string): Promise<AdminRow | null>;
  getAdmin(id: number): Promise<AdminPublic | null>;
  listAdmins(q?: PageQuery): Promise<Page<AdminPublic>>;
  updateAdmin(id: number, patch: { role?: AdminRole; status?: AdminStatus; passHash?: string }): Promise<AdminPublic | null>;
  touchAdminLogin(id: number, at: Date): Promise<void>;
  countAdmins(): Promise<number>;

  createArbitration(input: { gameId: string; adminId: number; status?: ArbitrationStatus; verdict?: string | null; note?: string | null }): Promise<ArbitrationRow>;
  updateArbitration(id: number, patch: { status?: ArbitrationStatus; verdict?: string | null; note?: string | null }): Promise<ArbitrationRow | null>;
  getArbitration(id: number): Promise<ArbitrationRow | null>;
  listArbitrationsByGame(gameId: string): Promise<ArbitrationRow[]>;

  writeAudit(log: {
    adminId: number | null;
    adminUsername: string | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    beforeJson?: unknown;
    afterJson?: unknown;
    ip?: string | null;
    result?: AuditResult;
  }): Promise<void>;
  queryAudit(filter?: AuditFilter): Promise<Page<AuditLogRow>>;
  getAudit(id: number): Promise<AuditLogRow | null>;
}

/** 游戏数据只读检索（分页 / 多条件 / 聚合）+ 回放数据源 */
export interface AdminGameQueries {
  queryUsers(filter?: UserFilter): Promise<Page<UserRow>>;
  getUserDetail(openid: string): Promise<{ profile: UserRow | null; rooms: RoomRow[]; games: GameRow[] }>;

  queryRooms(filter?: RoomFilter): Promise<Page<RoomSummary>>;
  getRoomDetail(roomId: string): Promise<{ room: RoomRow | null; memberEvents: MemberEventRow[]; games: GameRow[] }>;

  queryGames(filter?: GameFilter): Promise<Page<GameSummary>>;
  getGameDetail(gameId: string): Promise<{ game: GameRow | null; actionCount: number }>;

  /** 供 buildReplayBundle 使用的 Drizzle 只读数据源（回放帧 / 导出回放包） */
  replaySource(): ReplaySource;
}
