import { describe, it, expect } from 'vitest';
import {
  fullWall,
  isNineSpecial,
  isTerminalOrHonor,
  isHonor,
  isWind,
  isDragon,
  suitOf,
  rankOf,
} from '../src/tiles';

describe('牌模型（规格书 1.1）', () => {
  it('牌墙共 144 张', () => expect(fullWall().length).toBe(144));

  it('牌墙构成：数牌108 + 字28 + 花8', () => {
    const wall = fullWall();
    const count = (pred: (id: string) => boolean) => wall.filter(pred).length;
    expect(count((id) => 'WTB'.includes(suitOf(id)))).toBe(108);
    expect(count(isHonor)).toBe(28);
    expect(count((id) => suitOf(id) === 'H')).toBe(8);
  });

  it('九筒/九万为特殊牌，九条不是', () => {
    expect(isNineSpecial('B9')).toBe(true);
    expect(isNineSpecial('W9')).toBe(true);
    expect(isNineSpecial('T9')).toBe(false);
  });

  it('幺九/字判定', () => {
    expect(isTerminalOrHonor('W1')).toBe(true);
    expect(isTerminalOrHonor('W9')).toBe(true);
    expect(isTerminalOrHonor('W5')).toBe(false);
    expect(isTerminalOrHonor('Z5')).toBe(true);
  });

  it('风/元区分', () => {
    expect(isWind('Z1')).toBe(true);
    expect(isWind('Z4')).toBe(true);
    expect(isDragon('Z5')).toBe(true);
    expect(isDragon('Z1')).toBe(false);
  });

  it(' suitOf / rankOf 解析', () => {
    expect(suitOf('B9')).toBe('B');
    expect(rankOf('B9')).toBe(9);
    expect(rankOf('Z7')).toBe(7);
  });
});
