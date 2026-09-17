import type { MatchedPattern, ScoreOptions, ScoreResult } from './types';
import { dedup, patternTai } from './containment';

/** 胡牌最低台数门槛（业务基线：≥6 台，否则诈胡；D-15） */
export const MIN_WIN_TAI = 6;

/**
 * 由「已成立番种集」计算台数（规格书第 5 章主流程的算分部分）。
 * 流程：必然包含去重 → 求和 → 最小胡(1→8) / 门槛(<6 → 诈胡)。
 *
 * 说明：最小胡需满足四条件（规格书 3.13），由识别层判定后经 opts.minimal 传入；
 *       算分层只负责按 opts.minimal 做 1→8 覆盖。
 */
export function computeTai(patterns: MatchedPattern[], opts: ScoreOptions = {}): ScoreResult {
  const kept = dedup(patterns);
  const detail = kept.map((p) => ({
    name: p.name,
    tai: patternTai(p),
    ...(p.count != null ? { count: p.count } : {}),
    ...(p.tiles && p.tiles.length ? { tiles: p.tiles } : {}),
  }));
  const sum = detail.reduce((s, d) => s + d.tai, 0);

  if (opts.minimal) {
    // 最小胡：1 变 8（覆盖）
    return { total: 8, detail: [{ name: '最小胡', tai: 8 }], zhaHu: false, minimalHu: true };
  }
  if (sum < MIN_WIN_TAI) {
    return { total: sum, detail, zhaHu: true, minimalHu: false };
  }
  return { total: sum, detail, zhaHu: false, minimalHu: false };
}
