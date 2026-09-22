/**
 * @ac-majong/ai —— A&C 麻将可扩展 AI 机器人（BL-031）。
 *
 * 分层：特征层(features/shanten) → 策略层(strategies/*) → 决策层(autoPlayer) → 人格层(personas)。
 * 铁律：合法性/算分/听牌判定一律复用 @ac-majong/engine，本包只做「在合法动作里选哪个」。
 */
export * from './types';
export * from './rng';
export * from './personas';
export * from './features/shanten';
export * from './strategies/efficiency';
export * from './strategies/trustee';
export * from './strategies/registry';
export * from './autoPlayer';
