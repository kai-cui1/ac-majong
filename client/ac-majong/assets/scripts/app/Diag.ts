import { sys } from 'cc';

/**
 * BL-023 客户端错误遥测/诊断包：全局捕获 onerror/unhandledrejection，附带上下文（screen/room/round/phase）
 * 与最近服务端消息类型环，持久化到 localStorage 环；dev 经 __AC__.diag.dump()/copy() 取出，
 * 用户报障时可直接贴诊断包复现，无需截图猜上下文。WX 端无 window 时静默降级。
 */
interface DiagError { at: number; msg: string; stack?: string; ctx: Record<string, unknown>; ring: string[] }

const LS_KEY = 'ac-diag';
const RING_CAP = 60;
const ERR_CAP = 5;

class DiagCollector {
  private ring: string[] = [];
  private errors: DiagError[] = [];
  ctx: Record<string, unknown> = {};
  private installed = false;

  install(): void {
    if (this.installed) return;
    this.installed = true;
    try { this.errors = JSON.parse(sys.localStorage.getItem(LS_KEY) ?? '[]') as DiagError[]; } catch { this.errors = []; }
    const g = globalThis as { window?: { onerror?: unknown; addEventListener?: (t: string, f: (e: unknown) => void) => void } };
    if (g.window) {
      const prev = g.window.onerror;
      g.window.onerror = (msg: unknown, src?: unknown, line?: unknown, col?: unknown, err?: Error) => {
        this.record(String(msg), err?.stack);
        if (typeof prev === 'function') (prev as (...a: unknown[]) => void)(msg, src, line, col, err);
        return false;
      };
      g.window.addEventListener?.('unhandledrejection', (e) => {
        const r = (e as { reason?: unknown }).reason;
        this.record('unhandledrejection: ' + String(r instanceof Error ? r.message : r), r instanceof Error ? r.stack : undefined);
      });
    }
  }

  /** 记录一条最近消息/事件类型（环，cap 60） */
  note(tag: string): void {
    this.ring.push(tag);
    if (this.ring.length > RING_CAP) this.ring.shift();
  }

  /** 合并当前上下文（screen/room/round/phase 等），报错时随包带出 */
  setCtx(patch: Record<string, unknown>): void {
    Object.assign(this.ctx, patch);
  }

  private record(msg: string, stack?: string): void {
    const e: DiagError = { at: Date.now(), msg, stack, ctx: { ...this.ctx }, ring: [...this.ring] };
    this.errors.push(e);
    if (this.errors.length > ERR_CAP) this.errors.shift();
    try { sys.localStorage.setItem(LS_KEY, JSON.stringify(this.errors)); } catch { /* 存储不可用则仅内存 */ }
  }

  dump(): { at: number; ctx: Record<string, unknown>; ring: string[]; errors: DiagError[] } {
    return { at: Date.now(), ctx: { ...this.ctx }, ring: [...this.ring], errors: [...this.errors] };
  }

  /** 导出诊断包 JSON 字符串；web 端顺带写剪贴板 */
  copy(): string {
    const s = JSON.stringify(this.dump());
    try { (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => void } } }).navigator?.clipboard?.writeText?.(s); } catch { /* 忽略 */ }
    return s;
  }
}

export const Diag = new DiagCollector();
