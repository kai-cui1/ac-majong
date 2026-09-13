/**
 * @ac-majong/engine —— A&C 麻将台数计算引擎（前后端共享）。
 *
 * M0 首个增量已实现：牌模型(tiles) / 台数表(patterns) / 必然包含去重(containment)
 * / 算分主流程(scoring) / 结算(settlement)。
 * 待后续增量：胡牌判定(winCheck) 与 番种识别(patterns-from-tiles)。
 */
export * from './types';
export * from './tiles';
export * from './patterns';
export * from './containment';
export * from './scoring';
export * from './settlement';
