import { useCallback, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type {
  AdminDTO,
  ArbitrationDTO,
  AuditDTO,
  DiagIntakeResult,
  GameDTO,
  GameSummary,
  MemberEventDTO,
  MonitorResponse,
  Page,
  ReplayData,
  RoomDTO,
  RoomSummary,
  UserDTO,
} from './types';

const enc = encodeURIComponent;

// ---- 只读查询 ----
export interface UserQuery { q?: string; from?: string; to?: string; page?: number; size?: number }
export const useUsers = (params: UserQuery) =>
  useQuery({ queryKey: ['users', params], queryFn: () => api.get<Page<UserDTO>>('/api/users', params) });

export const useUserDetail = (openid: string | null) =>
  useQuery({
    queryKey: ['user', openid],
    queryFn: () => api.get<{ profile: UserDTO; rooms: RoomDTO[]; games: GameDTO[] }>(`/api/users/${enc(openid!)}`),
    enabled: !!openid,
  });

export interface RoomQuery { roomId?: string; host?: string; status?: string; from?: string; to?: string; page?: number; size?: number }
export const useRooms = (params: RoomQuery) =>
  useQuery({ queryKey: ['rooms', params], queryFn: () => api.get<Page<RoomSummary>>('/api/rooms', params) });

export const useRoomDetail = (roomId: string | null) =>
  useQuery({
    queryKey: ['room', roomId],
    queryFn: () => api.get<{ room: RoomDTO; memberEvents: MemberEventDTO[]; games: GameDTO[] }>(`/api/rooms/${enc(roomId!)}`),
    enabled: !!roomId,
  });

export interface GameQuery { roomId?: string; from?: string; to?: string; page?: number; size?: number }
export const useGames = (params: GameQuery) =>
  useQuery({ queryKey: ['games', params], queryFn: () => api.get<Page<GameSummary>>('/api/games', params) });

export const useGameDetail = (gameId: string | null) =>
  useQuery({
    queryKey: ['game', gameId],
    queryFn: () => api.get<{ game: GameDTO; actionCount: number; arbitrations: ArbitrationDTO[] }>(`/api/games/${enc(gameId!)}`),
    enabled: !!gameId,
  });

export const useReplay = (gameId: string | null) =>
  useQuery({
    queryKey: ['replay', gameId],
    queryFn: () => api.get<ReplayData>(`/api/games/${enc(gameId!)}/replay`),
    enabled: !!gameId,
    staleTime: Infinity,
  });

export const useArbitrationsByGame = (gameId: string | null) =>
  useQuery({
    queryKey: ['arbitrations', gameId],
    queryFn: () => api.get<ArbitrationDTO[]>(`/api/games/${enc(gameId!)}/arbitrations`),
    enabled: !!gameId,
  });

export const useAdmins = (params: { page?: number; size?: number }) =>
  useQuery({ queryKey: ['admins', params], queryFn: () => api.get<Page<AdminDTO>>('/api/admins', params) });

export interface AuditQuery { adminId?: number; action?: string; targetType?: string; from?: string; to?: string; page?: number; size?: number }
export const useAudit = (params: AuditQuery) =>
  useQuery({ queryKey: ['audit', params], queryFn: () => api.get<Page<AuditDTO>>('/api/audit', params) });

/**
 * FR-Admin-10 实时房间监控：快照轮询 ~2s（admin 不持 WS、非推送）。
 * 审计节流——仅「开启监控 / 手动刷新」记一条（换房首拉或 refreshWithAudit 带 ?audit=1），自动轮询不逐条记（避免 2s 刷屏）。
 */
export function useMonitorRoom(roomId: string | null, autoRefresh: boolean) {
  const auditedRoom = useRef<string | null>(null);
  const q = useQuery({
    queryKey: ['monitor', roomId],
    queryFn: () => {
      const audit = auditedRoom.current !== roomId;
      auditedRoom.current = roomId;
      return api.get<MonitorResponse>(`/api/monitor/rooms/${enc(roomId!)}`, audit ? { audit: '1' } : undefined);
    },
    enabled: !!roomId,
    refetchInterval: autoRefresh ? 2000 : false,
    refetchOnWindowFocus: false,
  });
  const refreshWithAudit = useCallback(() => { auditedRoom.current = null; void q.refetch(); }, [q]);
  return { data: q.data, isFetching: q.isFetching, error: q.error, refreshWithAudit };
}

/** 导出回放包（GET，带 cookie 触发浏览器下载；无需 CSRF） */
export function downloadReplayBundle(gameId: string): void {
  window.location.assign(`/api/games/${enc(gameId)}/replay-bundle`);
}

// ---- 写操作 ----
export const useCreateAdmin = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { username: string; password: string; role: string }) => api.post<AdminDTO>('/api/admins', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admins'] }),
  });
};

export const useUpdateAdmin = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { role?: string; status?: string; password?: string } }) =>
      api.patch<AdminDTO>(`/api/admins/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admins'] }),
  });
};

export const useCreateArbitration = (gameId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { status?: string; verdict?: string | null; note?: string | null }) =>
      api.post<ArbitrationDTO>(`/api/games/${enc(gameId)}/arbitrations`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['arbitrations', gameId] });
      qc.invalidateQueries({ queryKey: ['game', gameId] });
    },
  });
};

export const useUpdateArbitration = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { status?: string; verdict?: string | null; note?: string | null } }) =>
      api.patch<ArbitrationDTO>(`/api/arbitrations/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['arbitrations'] }),
  });
};

/** FR-Admin-09 诊断包受理：POST 粘贴的 ac-diag JSON（已 JSON.parse），后端 zod 规范化 + 记审计（不落本体） */
export const useDiagIntake = () =>
  useMutation({ mutationFn: (pkg: unknown) => api.post<DiagIntakeResult>('/api/diag/intake', pkg) });
