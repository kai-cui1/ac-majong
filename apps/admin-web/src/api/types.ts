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
