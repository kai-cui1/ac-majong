// 后端 DTO 类型（对齐 admin-server REST 契约，Admin 技术方案 §5）
export type AdminRole = 'super' | 'operator' | 'viewer';
export type RoomStatus = 'idle' | 'playing' | 'closed';
export type ArbitrationStatus = 'pending' | 'accepted' | 'rejected' | 'resolved';

export interface AdminSession {
  id: number;
  username: string;
  role: AdminRole;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/** 用户（对外不含 passHash） */
export interface UserDTO {
  openid: string;
  nickname: string;
  avatarUrl: string;
  createdAt?: string | null;
  lastLoginAt?: string | null;
}

export interface RoomDTO {
  roomId: string;
  hostOpenid: string;
  maxRounds: number;
  initialScore: Record<string, number>;
  memberScores?: Record<string, number> | null;
  finalScore: Record<string, number> | null;
  status: RoomStatus;
  createdAt?: string | null;
  closedAt?: string | null;
}
export interface RoomSummary {
  room: RoomDTO;
  hostNickname: string | null;
  gameCount: number;
}
export interface MemberEventDTO {
  roomId: string;
  openid: string;
  seat: number | null;
  event: 'create' | 'join' | 'leave' | 'ready';
  at?: string | null;
}
export interface GameDTO {
  gameId: string;
  roomId: string;
  roundNo: number;
  dealerSeat: number;
  seed: number;
  endType: 'win' | 'exhaustive' | null;
  result: unknown;
  startedAt?: string | null;
  endedAt?: string | null;
}
export interface GameSummary {
  game: GameDTO;
  actionCount: number;
}

export interface AdminDTO {
  id: number;
  username: string;
  role: AdminRole;
  status: 'active' | 'disabled';
  createdAt?: string | null;
  updatedAt?: string | null;
  lastLoginAt?: string | null;
}

export interface ArbitrationDTO {
  id: number;
  gameId: string;
  adminId: number;
  status: ArbitrationStatus;
  verdict: string | null;
  note: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AuditDTO {
  id: number;
  adminId: number | null;
  adminUsername: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  ip: string | null;
  result: 'success' | 'fail';
  at?: string | null;
}

/** 回放帧（全信息台态；state 结构随引擎 TableState，前端按需取用） */
export interface ReplayFrame {
  seq: number;
  action: unknown;
  events: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
}
export interface ReplayData {
  meta: {
    gameId: string;
    roomId: string;
    roundNo: number;
    dealerSeat: number;
    names: Record<number, string>;
    endType: string | null;
    result: unknown;
  };
  frames: ReplayFrame[];
}

/** FR-Admin-10 实时房间监控：game-server inspect() 全量台态（上帝全知视角），经 admin-server 内网代理转呈 */
export interface MonitorInspect {
  room: string;
  phase: string;
  maxRounds: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  settings: any;
  names: Record<number, string>;
  seats: ({ userId: string; isBot: boolean } | null)[];
  gameId: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any; // 完整 TableState 投影（牌墙实牌/四家暗牌/牌河/副露花子分/响应意图），Monitor.tsx 按 <TableBoard> BoardState 消费
  game: { round: number; phase: string; currentSeat: number; wallLen: number; legalBySeat: unknown[] } | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  seating: any;
  timers: { trusteePending: string[]; offlineSince: [string, number][]; seatingInputActive: boolean };
  stall: { lastActionAt: number; idleMs: number };
}
/** 监控响应：可用=全量台态；不可用=降级为 MySQL 已落库事实（rooms.status / member_scores） */
export type MonitorResponse =
  | { available: true; roomId: string; inspect: MonitorInspect }
  | { available: false; roomId: string; reason: string; fallback: { status: string; memberScores: Record<number, number> | null } | null };

/** FR-Admin-09 诊断包受理：后端 zod 校验/规范化后回传的结构（不落诊断包本体） */
export interface NormDiagError {
  at: number | null;
  msg: string | null;
  stack: string | null;
  stackTruncated: boolean;
  ctx: Record<string, unknown> | null;
  ring: string[];
}
export interface DiagIntakeResult {
  at: number | null;
  ctx: { screen: string | null; room: string | null; round: number | null; phase: string | null; cur: number | null; mySeat: number | null };
  ring: string[];
  ringTruncated: boolean;
  errors: NormDiagError[];
  errorsTruncated: boolean;
  truncated: boolean;
  /** 派生回放 gameId `{room}-g{round}`；room 或 round 缺则 null */
  gameId: string | null;
  room: string | null;
}
