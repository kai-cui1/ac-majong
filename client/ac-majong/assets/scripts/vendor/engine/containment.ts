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
 * 注意（N8/N9）：
 * - 小平/清一色 与「无字」按算例1是**叠加**（shape 番不吸收原子缺失番），不列入本表；
 * - 无花无字(3) **吸收** 无花(1)+无字(1)（N9，同属"缺失"维度）；
 * - 大平/将一色 **必然无花无字** → 吸收无花无字（N9）；清一色**可能有花** → 不吸收无花无字（N9）。
 */
export const ABSORBS: Record<string, string[]> = {
  '八只花': ['见花'],
  '大四喜': ['大三风', '东风字_非庄', '东风字_庄'],
  '小四喜': ['大三风', '小三风'],
  '无花无字': ['无花', '无字'],
  '大平': ['无花无字'],
  '将一色': ['无花无字'],
  '清一色': ['缺一门'],
  '混一色': ['缺一门'],
  '四姊妹': ['三姊妹'],
  '五暗坎': ['碰碰胡'],
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

/**
 * 实例级吸收（BL-008/规格 4.3 注）：高阶番只吸收其自身用到的刻实例的见字，
 * 其余字刻的见字仍计（如大三元 + 额外风刻 → 见字 ×1 保留）。
 */
const INST_ABSORB: Record<string, { target: string; cap: number }> = {
  '大三元': { target: '见字', cap: 3 },
  '小三元': { target: '见字', cap: 2 },
  '大三风': { target: '见字', cap: 3 },
  '小三风': { target: '见字', cap: 2 },
  '大四喜': { target: '见字', cap: 4 },
  '小四喜': { target: '见字', cap: 3 },
};

/** 名称级去重 + 见字实例级削减：被更大番种必然包含的番种剔除/减计 */
export function dedup(patterns: MatchedPattern[]): MatchedPattern[] {
  const present = new Set(patterns.map((p) => p.name));
  const absorbed = new Set<string>();
  for (const a of patterns) {
    for (const b of ABSORBS[a.name] ?? []) {
      if (present.has(b)) absorbed.add(b);
    }
  }
  const survived = patterns.filter((p) => !absorbed.has(p.name));
  // 实例级：存活吸收者按 cap 削减见字实例数
  let cut = 0;
  for (const p of survived) {
    const rule = INST_ABSORB[p.name];
    if (rule) cut += rule.cap;
  }
  if (cut === 0) return survived;
  const out: MatchedPattern[] = [];
  for (const p of survived) {
    if (p.name === '见字' && p.count != null) {
      const left = p.count - cut;
      if (left > 0) out.push({ ...p, count: left, tiles: p.tiles?.slice(0, left) });
    } else {
      out.push(p);
    }
  }
  return out;
}
