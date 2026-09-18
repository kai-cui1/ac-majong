import { describe, it, expect } from 'vitest';
import {
  buildPhysicalLayout,
  drawOrderFromLayout,
  createTable,
  wallInfo,
  snapshotRound,
  rehydrate,
  fullWall,
  GROUPS_PER_ROW,
  DEAD_WALL,
} from '../src/index';
import type { TileId } from '../src/index';

/** BL-017 物理牌墙与开牌点（FR-对局-19/20）：确定性、摸牌序、快照往返、栈高推算 */
describe('BL-017 · 物理牌墙 buildPhysicalLayout', () => {
  it('同 seed 确定性：4 排 × 36 张，牌集合与整墙一致', () => {
    const a = buildPhysicalLayout(42);
    const b = buildPhysicalLayout(42);
    expect(a).toEqual(b);
    expect(a.length).toBe(4);
    for (const row of a) expect(row.length).toBe(36);
    const flat = a.flat().slice().sort();
    expect(flat).toEqual(fullWall().slice().sort());
  });

  it('不同 seed 布局不同', () => {
    expect(buildPhysicalLayout(1)).not.toEqual(buildPhysicalLayout(2));
  });
});

describe('BL-017 · 开牌点摸牌序 drawOrderFromLayout', () => {
  const layout = buildPhysicalLayout(7);
  const g = (row: number, idx: number): TileId[] => [layout[row]![(idx - 1) * 2]!, layout[row]![(idx - 1) * 2 + 1]!];

  it('N=5 庄家=2：首摸=庄家排 g6，续上手家排，跳区 g1..5 位于序列末尾', () => {
    const seq = drawOrderFromLayout(layout, 2, 5);
    expect(seq.length).toBe(144);
    // 庄家排 g(N+1) 起（组内先上后下）
    expect(seq.slice(0, 2)).toEqual(g(2, 6));
    // 庄家排 13 组 × 2 = 26 张后 → 上手家排（seat1）g1 起
    expect(seq.slice(26, 28)).toEqual(g(1, 1));
    // 排尽续上手家排：seat1 → seat0 → seat3
    expect(seq.slice(26 + 36, 26 + 36 + 2)).toEqual(g(0, 1));
    expect(seq.slice(26 + 72, 26 + 72 + 2)).toEqual(g(3, 1));
    // 末尾循环回庄家排跳区 g1..5
    expect(seq.slice(144 - 10, 144 - 8)).toEqual(g(2, 1));
    expect(seq.slice(144 - 2)).toEqual(g(2, 5));
    // 全序列为整墙排列
    expect(seq.slice().sort()).toEqual(fullWall().slice().sort());
  });

  it('N=0：从庄家排右端第 1 组开摸，无跳区', () => {
    const seq = drawOrderFromLayout(layout, 0, 0);
    expect(seq.slice(0, 2)).toEqual(g(0, 1));
    expect(seq.length).toBe(144);
  });

  it('同 layout+庄家+N 确定性一致', () => {
    expect(drawOrderFromLayout(layout, 3, 8)).toEqual(drawOrderFromLayout(layout, 3, 8));
  });
});

describe('BL-017 · createTable 物理墙集成', () => {
  it('发牌序=摸牌序：手牌+余墙拼接与 drawOrderFromLayout 前缀一致；initialZi 生效', () => {
    const layout = buildPhysicalLayout(99);
    const st = createTable(1, 99, [0, 1, 2, 3], { layout, breakGroups: 6, initialZi: { 1: 2, 3: 1 } });
    const seq = drawOrderFromLayout(layout, 1, 6);
    // 无花补摸时：各家手牌按发牌序拼接 + 余墙 = 完整摸牌序（花会打断，故按余墙后缀校验）
    expect(st.wall).toEqual(seq.slice(seq.length - st.wall.length));
    expect(st.initialWallLen).toBe(144);
    expect(st.layout).toEqual(layout);
    expect(st.breakGroups).toBe(6);
    // 仪式子：A 上子 + 首庄庄子
    expect(st.players.find((p) => p.seat === 1)!.zi).toBe(2);
    expect(st.players.find((p) => p.seat === 3)!.zi).toBe(1);
    expect(st.players.find((p) => p.seat === 0)!.zi).toBe(0);
  });

  it('random 模式（无 layout）：不携带物理墙字段', () => {
    const st = createTable(0, 5);
    expect(st.layout).toBeUndefined();
    expect(st.breakGroups).toBeUndefined();
    expect(st.initialWallLen).toBeUndefined();
    expect(wallInfo(st)).toBeNull();
  });

  it('快照往返：snapshotRound → rehydrate 保留 layout/breakGroups/initialWallLen', () => {
    const layout = buildPhysicalLayout(123);
    const st = createTable(2, 123, [0, 1, 2, 3], { layout, breakGroups: 9 });
    const back = rehydrate(snapshotRound(st));
    expect(back.layout).toEqual(st.layout);
    expect(back.breakGroups).toBe(9);
    expect(back.initialWallLen).toBe(144);
    expect(back.wall).toEqual(st.wall);
  });
});

describe('BL-017 · 牌墙展示 wallInfo 栈高推算', () => {
  it('发牌后：按摸牌序消耗推算各排栈高，总余量=wall.length', () => {
    const layout = buildPhysicalLayout(55);
    const st = createTable(3, 55, [0, 1, 2, 3], { layout, breakGroups: 4 });
    const info = wallInfo(st)!;
    expect(info.breakSeat).toBe(3);
    expect(info.breakGroups).toBe(4);
    expect(info.rows.length).toBe(4);
    const total = info.rows.reduce((s, r) => s + r.stacks.reduce((a, b) => a + b, 0), 0);
    expect(total).toBe(st.wall.length);
    // 首摸组（庄家排 g5）必已被发牌消耗
    const dealerRow = info.rows.find((r) => r.seat === 3)!;
    expect(dealerRow.stacks[4]).toBe(0);
    // 末尾死牌区（开牌点前 g1..4 最后 2 组）仍满栈（未摸）
    expect(dealerRow.stacks[0]).toBe(2);
  });

  it('每组栈高 ∈ {0,1,2}，长度为 18', () => {
    const layout = buildPhysicalLayout(77);
    const st = createTable(0, 77, [0, 1, 2, 3], { layout, breakGroups: 0 });
    for (const r of wallInfo(st)!.rows) {
      expect(r.stacks.length).toBe(GROUPS_PER_ROW);
      for (const h of r.stacks) expect([0, 1, 2]).toContain(h);
    }
    // 死牌 4 张永远留在墙尾：总栈高 ≥ DEAD_WALL
    const total = wallInfo(st)!.rows.reduce((s, r) => s + r.stacks.reduce((a, b) => a + b, 0), 0);
    expect(total).toBeGreaterThanOrEqual(DEAD_WALL);
  });
});
