/**
 * @ac-majong/engine —— A&C 麻将台数计算引擎（前后端共享）。
 *
 * M0 已实现：牌模型(tiles) / 台数表(patterns) / 必然包含去重(containment)
 * / 算分(scoring) / 结算(settlement) / 胡牌判定与听牌(winCheck)
 * / 牌面分析(analyze) / 番种识别(recognize) / 完整流水线(pipeline)。
 */
export * from './types';
export * from './tiles';
export * from './patterns';
export * from './containment';
export * from './scoring';
export * from './settlement';
export * from './winCheck';
export * from './analyze';
export * from './recognize';
export * from './pipeline';
export * from './table';
export * from './actions';
export * from './reducer';
export * from './rehydrate';
