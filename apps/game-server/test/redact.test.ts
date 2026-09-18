import { describe, it, expect } from 'vitest';
import { createTable } from '@ac-majong/engine';
import { redact } from '../src/redact';

describe('redact · 防透视（安全边界）', () => {
  const state = createTable(0, 42);

  it('自己拿到完整暗牌（庄家 17 张）+ 合法动作', () => {
    const v = redact(state, 0, 'R1', 8);
    const cnt = Object.values(v.you.concealed).reduce((a, b) => a + b, 0);
    expect(cnt).toBe(17);
    expect(v.you.legal.length).toBeGreaterThan(0);
  });

  it('他家只给暗牌张数，绝不泄漏具体牌', () => {
    const v = redact(state, 0, 'R1', 8);
    expect(v.others).toHaveLength(3);
    for (const o of v.others) {
      expect(o.concealedCount).toBe(16);
      expect((o as Record<string, unknown>).concealed).toBeUndefined();
    }
    // 序列化后不出现裸 "concealed" 键（只有 concealedCount）
    expect(JSON.stringify(v.others)).not.toContain('concealed"');
  });

  it('不同座位各自看到自己的暗牌，互不相同', () => {
    const v0 = redact(state, 0, 'R1', 8);
    const v1 = redact(state, 1, 'R1', 8);
    expect(v0.you.concealed).not.toEqual(v1.you.concealed);
    // v1 的视角里，seat0 只以 concealedCount 出现
    expect(v1.others.find((o) => o.seat === 0)?.concealedCount).toBe(17);
  });
});

describe('redact · BL-020 先看吃再碰 pendingChi', () => {
  const mk = () => {
    const t = createTable(0, 7);
    t.phase = 'response';
    t.lastDiscard = { seat: 0, tile: 'W2' };
    t.pending[1] = { move: 'chi', chiTiles: ['W1', 'W3'] };
    return t;
  };
  it('开关 ON（含缺省默认）：全桌下发 pendingChi', () => {
    const v = redact(mk(), 2, 'R1', 8, [], { wallMode: 'random', breakDice: false, chiFirstView: true });
    expect(v.pendingChi).toEqual({ seat: 1, tiles: ['W1', 'W3'], called: 'W2' });
    const v1 = redact(mk(), 1, 'R1', 8); // 缺省 settings = 默认开
    expect(v1.pendingChi?.seat).toBe(1);
  });
  it('开关 OFF：不下发（时序不变）', () => {
    const v = redact(mk(), 2, 'R1', 8, [], { wallMode: 'random', breakDice: false, chiFirstView: false });
    expect(v.pendingChi).toBeUndefined();
  });
});
