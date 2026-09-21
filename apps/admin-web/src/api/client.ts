// 统一 fetch 封装：同源 cookie（credentials:include）+ 写操作 CSRF 头 + 错误信封解包
let csrfToken: string | null = null;
export function setCsrfToken(t: string | null): void {
  csrfToken = t;
}
export function getCsrfToken(): string | null {
  return csrfToken;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type Query = object;

function withQuery(url: string, query?: Query): string {
  if (!query) return url;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${url}?${qs}` : url;
}

async function request<T>(method: string, url: string, opts?: { body?: unknown; query?: Query }): Promise<T> {
  const unsafe = method !== 'GET' && method !== 'HEAD';
  const headers: Record<string, string> = {};
  if (unsafe) {
    headers['content-type'] = 'application/json';
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
  }
  const res = await fetch(withQuery(url, opts?.query), {
    method,
    headers,
    credentials: 'include',
    body: unsafe && opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  // 回放包导出可能较大，仍为 JSON
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string, query?: Query): Promise<T> => request<T>('GET', url, { query }),
  post: <T>(url: string, body?: unknown): Promise<T> => request<T>('POST', url, { body }),
  patch: <T>(url: string, body?: unknown): Promise<T> => request<T>('PATCH', url, { body }),
};
