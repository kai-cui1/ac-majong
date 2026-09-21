import { create } from 'zustand';
import type { AdminSession } from '../api/types';
import { api, setCsrfToken } from '../api/client';

interface AuthState {
  admin: AdminSession | null;
  csrfToken: string | null;
  /** 是否已尝试从会话 cookie 恢复（用于首屏 loading，避免闪现登录页） */
  ready: boolean;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  restore(): Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  admin: null,
  csrfToken: null,
  ready: false,

  async login(username, password) {
    const r = await api.post<{ admin: AdminSession; csrfToken?: string }>('/api/auth/login', { username, password });
    setCsrfToken(r.csrfToken ?? null);
    set({ admin: r.admin, csrfToken: r.csrfToken ?? null, ready: true });
  },

  async logout() {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // 忽略登出失败，前端强制清空
    }
    setCsrfToken(null);
    set({ admin: null, csrfToken: null });
  },

  async restore() {
    try {
      const r = await api.get<{ admin: AdminSession; csrfToken?: string }>('/api/auth/me');
      setCsrfToken(r.csrfToken ?? null);
      set({ admin: r.admin, csrfToken: r.csrfToken ?? null, ready: true });
    } catch {
      setCsrfToken(null);
      set({ admin: null, csrfToken: null, ready: true });
    }
  },
}));

/** 角色层级：super > operator > viewer（与后端 RBAC 一致） */
const RANK: Record<string, number> = { viewer: 1, operator: 2, super: 3 };
export function hasRole(role: string | undefined, min: 'viewer' | 'operator' | 'super'): boolean {
  if (!role) return false;
  return (RANK[role] ?? 0) >= (RANK[min] ?? 0);
}
