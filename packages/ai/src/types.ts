import type { Action, Meld, TaiPreview, TileId } from '@ac-majong/engine';
import type { ViewState } from '@ac-majong/protocol';

/**
 * 人格 / 难度配置：同一策略经参数产出多档（逻辑设计 §7）。
 * 全部为 0~1 或毫秒的数值，便于序列化与人格化。
 */
export interface BotConfig {
  /** 激进(冲张) ↔ 保守(防守) */
  aggression: number;
  /** 打点权重（大牌偏好） */
  scoreWeight: number;
  /** 转防守的危险度阈值（P3 起生效） */
  defenseThreshold: number;
  /** 随机扰动（降低难度 / 拟人化） */
  noise: number;
  /** 决策延迟（毫秒，接入层用，拟人化） */
  thinkMs: number;
  /** 是否主动胡（托管=false） */
  canWin: boolean;
  /** 是否主动吃/碰/杠（托管=false） */
  allowMeld: boolean;
}

/** 决策上下文：ViewState + 引擎派生特征 + 配置 + 随机源（只读）。 */
export interface BotContext {
  view: ViewState;
  seat: number;
  cfg: BotConfig;
  /** 可注入随机源（复现 / 测试） */
  rng: () => number;
  /** engine.previewTai 结果：听牌/听张/实时台数/viaDiscard/secured（已内建 6 台门槛） */
  preview: TaiPreview;
}

/**
 * 机器人策略：纯函数，给定上下文返回一个合法动作（null=不行动）。
 * 新增一种打法 = 新增一个实现 + 注册，不改接入层与引擎。
 */
export interface BotStrategy {
  readonly name: string;
  readonly displayName: string;
  decide(ctx: BotContext): Action | null;
}

/** 派生特征（按阶段填充 / 缓存）。P1 主要用 shanten/ukeire。 */
export interface DerivedFeatures {
  shanten: number | null;
  ukeire: number | null;
}

/** 打牌候选评分结果（供策略内部与测试复用）。 */
export interface DiscardEval {
  tile: TileId;
  shanten: number;
  ukeire: number;
  tenpai: boolean;
  tai: number;
  score: number;
}

export type { Action, Meld, TileId, ViewState, TaiPreview };
