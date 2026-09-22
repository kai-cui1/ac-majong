import { describe, it, expect } from 'vitest';
import { computeTai } from '../src/scoring';
import type { MatchedPattern } from '../src/types';

const P = (name: string, count = 1): MatchedPattern => ({ name, count });

describe('台数计算 · 原文算例（校正后，规格书 9.1）', () => {
  it('TC-01 = 6', () => expect(computeTai([P('见花'), P('无字'), P('小平'), P('独独')]).total).toBe(6));
  it('TC-02 = 6', () => expect(computeTai([P('见花'), P('无字'), P('小平'), P('1独'), P('自摸')]).total).toBe(6));
  it('TC-03 = 6', () => expect(computeTai([P('见花', 2), P('见字'), P('独独'), P('自摸')]).total).toBe(6));
  it('TC-04 = 6', () => expect(computeTai([P('见花', 3), P('无字'), P('独独')]).total).toBe(6));
  it('TC-05 = 6', () => expect(computeTai([P('见花', 2), P('2暗坎'), P('独独')]).total).toBe(6));
  it('TC-06 = 7', () => expect(computeTai([P('见花'), P('无字'), P('小平'), P('门清一摸三')]).total).toBe(7));
  it('TC-07 = 38', () => expect(computeTai([P('混一色'), P('小三风'), P('碰碰胡')]).total).toBe(38));
  it('TC-08 = 74', () => expect(computeTai([P('将一色'), P('缺一门'), P('碰碰胡'), P('四暗坎')]).total).toBe(74));
  it('TC-09 = 24', () => expect(computeTai([P('大平'), P('一条龙'), P('三相逢')]).total).toBe(24));
  it('TC-10 = 170', () => expect(computeTai([P('风一色'), P('大四喜'), P('五暗坎')]).total).toBe(170));
});

describe('门槛 / 最小胡（规格书 9.3）', () => {
  it('TC-15 最小胡 → 8', () => {
    const r = computeTai([P('见花')], { minimal: true });
    expect(r.total).toBe(8);
    expect(r.minimalHu).toBe(true);
    expect(r.zhaHu).toBe(false);
  });
  it('TC-16 3台 → 诈胡', () => {
    const r = computeTai([P('见花'), P('独独')]);
    expect(r.total).toBe(3);
    expect(r.zhaHu).toBe(true);
  });
  it('TC-17 6台 → 可胡', () => {
    const r = computeTai([P('见花'), P('无字'), P('小平'), P('独独')]);
    expect(r.zhaHu).toBe(false);
    expect(r.total).toBe(6);
  });
});

describe('必然包含去重（规格书 4）', () => {
  it('八只花吸收见花 → 40', () => expect(computeTai([P('八只花'), P('见花', 8)]).total).toBe(40));
  it('大三元吸收见字 → 30', () => expect(computeTai([P('大三元'), P('见字', 3)]).total).toBe(30));
  it('小四喜吸收大三风/小三风/见字 → 40', () =>
    expect(computeTai([P('小四喜'), P('大三风'), P('小三风'), P('见字', 3)]).total).toBe(40));
  it('清一色吸收缺一门 → 40（N7）', () => expect(computeTai([P('清一色'), P('缺一门')]).total).toBe(40));
  // 新版D-13：对碰/1独 已在识别层互斥（classifyWait 与八对半分支只产出其一），废止「对碰⊇1独」吸收；
  // 若两者被人为同时传入则按叠加计（实际不会出现），此处固化吸收关系已移除。
  it('对碰与1独改为识别层互斥、废止吸收（D-13）', () => expect(computeTai([P('对碰'), P('1独')]).total).toBe(2));
  it('自摸九筒吸收自摸 → 10（特例1）', () => expect(computeTai([P('自摸九筒'), P('自摸')]).total).toBe(10));
  it('将一色不吸收缺一门 → 44（原例8）', () => expect(computeTai([P('将一色'), P('缺一门')]).total).toBe(44));
});

describe('无花无字吸收（N9）', () => {
  it('无花无字吸收 无花+无字 → 3', () =>
    expect(computeTai([P('无花无字'), P('无花'), P('无字')]).total).toBe(3));
  it('大平吸收无花无字（及其无花/无字）→ 8', () =>
    expect(computeTai([P('大平'), P('无花无字'), P('无花'), P('无字')]).total).toBe(8));
  it('将一色吸收无花无字 → 40', () =>
    expect(computeTai([P('将一色'), P('无花无字'), P('无字')]).total).toBe(40));
  it('清一色不吸收无花无字 → 40+3=43', () =>
    expect(computeTai([P('清一色'), P('无花无字')]).total).toBe(43));
  it('清一色不吸收无字（叠加）→ 40+1=41', () =>
    expect(computeTai([P('清一色'), P('无字')]).total).toBe(41));
});
