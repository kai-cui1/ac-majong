import type { MatchedPattern } from './types';
import { PATTERN_TAI } from './patterns';

/**
 * 必然包含（吸收）矩阵：A ⊇ B → 出现 A 则 B 不重复计（业务基线第 3 章「必然包含原则」）。
 *
 * M0 采用「名称级」去重（实例级去重是后续精化，见规格书 4.3 注）。
 * 仅收录已确认、且与业务基线算例一致的项：
 * - 八只花⊇见花、大/小三元⊇见字、四喜/三风⊇见字与大三风等（同一批牌不重复计）；
 * - 清一色/混一色⊇缺一门（N7）；四姊妹⊇三姊妹；对碰⊇1独（D-13）；
 * - 九筒/九万高阶番⊇其基础番（特例1）。
 *
 * 注意：小平/大平 与 无字/无花 按算例1是「叠加」而非吸收，故不列入本表（见第 11 章待确认项）。
 */
export const ABSORBS: Record<string, string[]> = {
  '八只花': ['见花'],
  '大三元': ['见字'],
  '小三元': ['见字'],
  '大四喜': ['大三风', '东风字_非庄', '东风字_庄', '见字'],
  '小四喜': ['大三风', '小三风', '见字'],
  '大三风': ['见字'],
  '小三风': ['见字'],
  '清一色': ['缺一门'],
  '混一色': ['缺一门'],
  '四姊妹': ['三姊妹'],
  '对碰': ['1独'],
  '自摸九筒': ['自摸'],
  '自摸九万': ['自摸'],
  '明杠九筒': ['明杠'],
  '明杠九万': ['明杠'],
  '暗杠九筒': ['暗杠'],
  '暗杠九万': ['暗杠'],
};

/** 单个番种台数 = 显式 tai ?? (表值 × count) */
export function patternTai(p: MatchedPattern): number {
  if (p.tai != null) return p.tai;
  const base = PATTERN_TAI[p.name];
  if (base == null) throw new Error(`未知番种: ${p.name}`);
  return base * (p.count ?? 1);
}

/** 名称级去重：被更大番种必然包含的番种剔除 */
export function dedup(patterns: MatchedPattern[]): MatchedPattern[] {
  const present = new Set(patterns.map((p) => p.name));
  const absorbed = new Set<string>();
  for (const a of patterns) {
    for (const b of ABSORBS[a.name] ?? []) {
      if (present.has(b)) absorbed.add(b);
    }
  }
  return patterns.filter((p) => !absorbed.has(p.name));
}
