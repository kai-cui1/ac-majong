import { describe, it, expect } from 'vitest';
import {
  isWin,
  isPairs8,
  isOrphans13,
  waitingTiles,
  classifyWait,
  decomposeMelds,
} from '../src/winCheck';

describe('标准型胡牌判定', () => {
  it('5副+1对（W1-9三顺 + B111 + B222 + B99将）→ 胡', () => {
    const c = { W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, W7: 1, W8: 1, W9: 1, B1: 3, B2: 3, B9: 2 };
    expect(isWin(c, 0)).toBe(true);
  });

  it('17 张全单无将 → 不胡', () => {
    const c = { W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, W7: 1, W8: 1, W9: 1, T1: 1, T2: 1, T3: 1, T4: 1, T5: 1, T6: 1, T7: 1, T8: 1 };
    expect(isWin(c, 0)).toBe(false);
  });

  it('decomposeMelds 枚举 234455 → 含 245+345? 应能拆 234+456 类', () => {
    // W2W3W4W4W5W6 可拆 234+456
    const ds = decomposeMelds({ W2: 1, W3: 1, W4: 2, W5: 1, W6: 1 });
    expect(ds.length).toBeGreaterThan(0);
    expect(ds.every((d) => d.length === 2)).toBe(true);
  });
});

describe('八对半（N1）', () => {
  it('7对+1刻 → isPairs8', () => {
    const c = { W1: 2, W2: 2, W3: 2, W4: 2, W5: 2, W6: 2, W7: 2, B9: 3 };
    expect(isPairs8(c, 0)).toBe(true);
    expect(isWin(c, 0)).toBe(true);
  });
  it('8对+1单 → isPairs8', () => {
    const c = { W1: 2, W2: 2, W3: 2, W4: 2, W5: 2, W6: 2, W7: 2, W8: 2, B9: 1 };
    expect(isPairs8(c, 0)).toBe(true);
  });
  it('有成型副则不是八对半', () => {
    const c = { W1: 2, W2: 2, W3: 2, W4: 2, W5: 2, W6: 2, W7: 2, B9: 2 };
    expect(isPairs8(c, 1)).toBe(false);
  });
});

describe('十三幺', () => {
  it('13 幺九字(Z1成对) + B555 一副 → isOrphans13', () => {
    const c = { Z1: 2, Z2: 1, Z3: 1, Z4: 1, Z5: 1, Z6: 1, Z7: 1, W1: 1, W9: 1, T1: 1, T9: 1, B1: 1, B9: 1, B5: 3 };
    expect(isOrphans13(c, 0)).toBe(true);
    expect(isWin(c, 0)).toBe(true);
  });
  it('缺一种幺九 → 不是十三幺', () => {
    const c = { Z1: 2, Z2: 1, Z3: 1, Z4: 1, Z5: 1, Z6: 1, W1: 1, W9: 1, T1: 1, T9: 1, B1: 1, B9: 1, B5: 3, B6: 2 };
    expect(isOrphans13(c, 0)).toBe(false);
  });
});

describe('听牌型分类（TC-18~TC-22，规格书 9.4）', () => {
  it('TC-18 5567 胡5 → 1独；听张={5,8}', () => {
    const ready = { B5: 2, B6: 1, B7: 1 };
    expect(waitingTiles(ready, 4).sort()).toEqual(['B5', 'B8']);
    expect(classifyWait(ready, 4, 'B5')).toBe('1独');
  });
  it('TC-19 5567 胡8 → 非1独', () => {
    expect(classifyWait({ B5: 2, B6: 1, B7: 1 }, 4, 'B8')).toBe(null);
  });
  it('TC-20 23445+99 胡3 → 1独；胡6 → 非；听张={W3,W6}', () => {
    const ready = { W2: 1, W3: 1, W4: 2, W5: 1, B9: 2 };
    expect(waitingTiles(ready, 3).sort()).toEqual(['W3', 'W6']);
    expect(classifyWait(ready, 3, 'W3')).toBe('1独');
    expect(classifyWait(ready, 3, 'W6')).toBe(null);
  });
  it('TC-21 单钓将 → 独独', () => {
    const ready = { B9: 1 };
    expect(waitingTiles(ready, 5)).toEqual(['B9']);
    expect(classifyWait(ready, 5, 'B9')).toBe('独独');
  });
  it('TC-22 两对等成刻(5577) → 对碰', () => {
    const ready = { B5: 2, B7: 2 };
    expect(waitingTiles(ready, 4).sort()).toEqual(['B5', 'B7']);
    expect(classifyWait(ready, 4, 'B5')).toBe('对碰');
  });
});

describe('听牌型分类·单听优先新口径（TC-1D-01~06 + §9.5，规格书 9.4/9.5）', () => {
  it('TC-1D-01 44556+99 胡6 → 不计1独（原有同牌不足为据）', () => {
    const ready = { W4: 2, W5: 2, W6: 1, B9: 2 };
    expect(waitingTiles(ready, 3).sort()).toEqual(['W3', 'W6']);
    expect(classifyWait(ready, 3, 'W6')).toBe(null);
  });
  it('TC-1D-02 5678 胡5/胡8 → 均1独（新胡张作将）', () => {
    const ready = { W5: 1, W6: 1, W7: 1, W8: 1 };
    expect(waitingTiles(ready, 4).sort()).toEqual(['W5', 'W8']);
    expect(classifyWait(ready, 4, 'W5')).toBe('1独');
    expect(classifyWait(ready, 4, 'W8')).toBe('1独');
  });
  it('TC-1D-03 2345678 胡2/5/8 → 均1独（新胡张作将）', () => {
    const ready = { W2: 1, W3: 1, W4: 1, W5: 1, W6: 1, W7: 1, W8: 1 };
    expect(waitingTiles(ready, 3).sort()).toEqual(['W2', 'W5', 'W8']);
    expect(classifyWait(ready, 3, 'W2')).toBe('1独');
    expect(classifyWait(ready, 3, 'W5')).toBe('1独');
    expect(classifyWait(ready, 3, 'W8')).toBe('1独');
  });
  it('TC-1D-04 56789+99 胡4/胡7 → 不计1独（须整手剩余成副）', () => {
    const ready = { W5: 1, W6: 1, W7: 1, W8: 1, W9: 1, B9: 2 };
    expect(waitingTiles(ready, 3).sort()).toEqual(['W4', 'W7']);
    expect(classifyWait(ready, 3, 'W4')).not.toBe('1独');
    expect(classifyWait(ready, 3, 'W7')).not.toBe('1独');
  });
  it('TC-1D-05 45+B33 胡W3/W6 → 不计1独（同点不同花色）', () => {
    const ready = { W4: 1, W5: 1, B3: 2 };
    expect(waitingTiles(ready, 4).sort()).toEqual(['W3', 'W6']);
    expect(classifyWait(ready, 4, 'W3')).toBe(null);
    expect(classifyWait(ready, 4, 'W6')).toBe(null);
  });
  it('TC-1D-06 单听双角色 4556999+123456+789 只听5万 → 独独（多摆法不升级）', () => {
    const ready = { W4: 1, W5: 2, W6: 1, W9: 3, B1: 1, B2: 1, B3: 1, B4: 1, B5: 1, B6: 1, T7: 1, T8: 1, T9: 1 };
    expect(waitingTiles(ready, 0)).toEqual(['W5']);
    expect(classifyWait(ready, 0, 'W5')).toBe('独独');
  });
  it('§9.5 W1112233344+B123+T123 听W2/W3/W4/W5：胡W2→1独（卡张）、胡W3→1独（作将）、胡W4/W5→无附加（整手属1独型）', () => {
    const ready = { W1: 3, W2: 2, W3: 3, W4: 2 };
    expect(waitingTiles(ready, 2).sort()).toEqual(['W2', 'W3', 'W4', 'W5']);
    expect(classifyWait(ready, 2, 'W2')).toBe('1独'); // 1(2)3+123+123+44 卡张见证
    expect(classifyWait(ready, 2, 'W3')).toBe('1独'); // 111+234+234+33 将牌见证
    expect(classifyWait(ready, 2, 'W4')).toBe(null); // 仅作刻第三张，且整手有卡张见证→不归对碰
    expect(classifyWait(ready, 2, 'W5')).toBe(null); // 仅 W345 端部，无见证
  });
});
