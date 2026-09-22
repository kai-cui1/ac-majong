import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../lib/rbac';
import { withAudit } from '../lib/audit';

/** ac-diag 诊断包受理规范化上限（对齐客户端 Diag.ts RING_CAP/ERR_CAP；stack/msg 为受理侧防护性截断） */
const RING_CAP = 60;
const ERR_CAP = 5;
const STACK_MAX = 4000;
const MSG_MAX = 500;

const numish = z.union([z.number(), z.string()]).nullish();

/** 现场上下文（客户端 Diag.setCtx 累积，字段可能缺/类型宽松，passthrough 保留额外键） */
const ctxSchema = z
  .object({
    screen: z.string().nullish(),
    room: z.union([z.string(), z.number()]).nullish(),
    round: numish,
    phase: z.string().nullish(),
    cur: numish,
    mySeat: numish,
  })
  .passthrough();

/** 单条报错（客户端 DiagError：{at,msg,stack?,ctx,ring}） */
const errorSchema = z
  .object({
    at: numish,
    msg: z.string().nullish(),
    stack: z.string().nullish(),
    ctx: z.record(z.unknown()).nullish(),
    ring: z.array(z.string()).nullish(),
  })
  .passthrough();

/** ac-diag 诊断包（客户端 Diag.dump() 产出：{at,ctx,ring,errors}），缺字段容错 */
const intakeBody = z
  .object({
    at: numish,
    ctx: ctxSchema.nullish(),
    ring: z.array(z.string()).nullish(),
    errors: z.array(errorSchema).nullish(),
  })
  .passthrough();

function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

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
  /** 任一超限截断（ring/errors/stack）——审计与前端提示用 */
  truncated: boolean;
  /** 派生回放 gameId：`{room}-g{round}`（对齐 game-server beginGame 形态）；room 或 round 缺则 null */
  gameId: string | null;
  room: string | null;
}

/** 校验后规范化：ring 取最近 ≤60（时间正序取尾）、errors 取最近 ≤5、stack/msg 超限截断并标记，缺字段容错 */
function normalizeDiag(b: z.infer<typeof intakeBody>): DiagIntakeResult {
  const ctx = b.ctx ?? {};
  const room = ctx.room == null ? null : String(ctx.room);
  const round = toNum(ctx.round);

  const rawRing = b.ring ?? [];
  const ringTruncated = rawRing.length > RING_CAP;
  const ring = rawRing.slice(-RING_CAP);

  const rawErrors = b.errors ?? [];
  const errorsTruncated = rawErrors.length > ERR_CAP;
  const errors: NormDiagError[] = rawErrors.slice(-ERR_CAP).map((e) => {
    const stack = typeof e.stack === 'string' ? e.stack : null;
    const stackTruncated = !!stack && stack.length > STACK_MAX;
    const msg = typeof e.msg === 'string' ? e.msg : null;
    return {
      at: toNum(e.at),
      msg: msg && msg.length > MSG_MAX ? `${msg.slice(0, MSG_MAX)}…` : msg,
      stack: stack ? (stackTruncated ? `${stack.slice(0, STACK_MAX)}…` : stack) : null,
      stackTruncated,
      ctx: e.ctx ?? null,
      ring: (e.ring ?? []).slice(-RING_CAP),
    };
  });

  return {
    at: toNum(b.at),
    ctx: { screen: ctx.screen ?? null, room, round, phase: ctx.phase ?? null, cur: toNum(ctx.cur), mySeat: toNum(ctx.mySeat) },
    ring,
    ringTruncated,
    errors,
    errorsTruncated,
    truncated: ringTruncated || errorsTruncated || errors.some((e) => e.stackTruncated),
    gameId: room != null && round != null ? `${room}-g${round}` : null,
    room,
  };
}

/**
 * FR-Admin-09 客户端诊断包受理（BL-023 消费面，operator+，Admin 技术方案 §10.2）。
 * 粘贴玩家「复制诊断包」的 ac-diag JSON → zod 校验/规范化（截断超限、缺字段容错）→ 回结构化结果 + 派生 gameId。
 * 审计只记 room/round/errors 数/truncated（**不落诊断包本体**——含玩家昵称/openid，避免敏感全文入库）；无上报管线、不落库本体。
 */
export async function diagRoutes(app: FastifyInstance): Promise<void> {
  const { admin } = app.deps;

  app.post('/api/diag/intake', { preHandler: requireRole('operator') }, async (req) => {
    const norm = normalizeDiag(intakeBody.parse(req.body));
    return withAudit(
      admin,
      req,
      {
        action: 'diag.intake',
        targetType: norm.gameId ? 'game' : norm.room ? 'room' : null,
        targetId: norm.gameId ?? norm.room,
        after: { room: norm.room, round: norm.ctx.round, errors: norm.errors.length, ring: norm.ring.length, truncated: norm.truncated },
      },
      async () => norm,
    );
  });
}
