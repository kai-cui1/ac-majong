import { describe, it, expect } from 'vitest';
import { H, meld, recognizedNames, isWinning } from './helpers';

const SEQ_HAND = 'W123W456T789T123B456B99'; // 5 顺 + B99 将（门清、全暗）

describe('番种识别 · 坎 / 杠', () => {
  it('明杠', () => {
    const h = H('W123W456T789T123B99', { melds: [meld('kong_exposed', 'T5555')], winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('明杠');
  });
  it('暗杠（且暗杠不破门清 N2）', () => {
    const h = H('W123W456T789T123B99', { melds: [meld('kong_concealed', 'T5555')], winTile: 'B9' });
    const n = recognizedNames(h);
    expect(n).toContain('暗杠');
    expect(n).toContain('门清');
  });
  it('2暗坎', () => {
    const h = H('W111W333T456B789T123B99', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('2暗坎');
  });
  it('三暗坎', () => {
    const h = H('W111W333W555T456B789B99', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('三暗坎');
  });
  it('四暗坎', () => {
    const h = H('W111W333W555W777T456B99', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('四暗坎');
  });
  it('五暗坎', () => {
    const h = H('W111W333W555W777W999B99', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('五暗坎');
  });
  // 2026-09-18 用户确认口径：点炮胡时由胡牌张凑成的第三张刻子不算暗坎
  it('点炮：胡牌张凑成的刻子不算暗坎（三暗坎降为 2暗坎）', () => {
    const h = H('W111W333W555T456B789B99', { winTile: 'W5', winBy: 'dianpao' });
    expect(isWinning(h)).toBe(true);
    const names = recognizedNames(h);
    expect(names).toContain('2暗坎');
    expect(names).not.toContain('三暗坎');
  });
  it('自摸：同一手牌胡牌张刻子仍计暗坎（三暗坎成立）', () => {
    const h = H('W111W333W555T456B789B99', { winTile: 'W5', winBy: 'zimo' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('三暗坎');
  });
  it('点炮：胡牌张作将时其余刻子仍全计暗坎', () => {
    const h = H('W111W333W555T456B789B99', { winTile: 'B9', winBy: 'dianpao' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('三暗坎');
  });
});

describe('番种识别 · 补牌胡 / 末尾胡', () => {
  it('杠开胡', () => {
    const h = H(SEQ_HAND, { winTile: 'B6', flow: { winAfterKong: true } });
    expect(recognizedNames(h)).toContain('杠开胡');
  });
  it('花开胡', () => {
    const h = H(SEQ_HAND, { winTile: 'B6', flowers: 'H1', flow: { winAfterFlower: true } });
    expect(recognizedNames(h)).toContain('花开胡');
  });
  it('抢杠胡', () => {
    const h = H(SEQ_HAND, { winTile: 'B6', flow: { robbedKong: true } });
    expect(recognizedNames(h)).toContain('抢杠胡');
  });
  it('海底捞（自摸最后一张）', () => {
    const h = H(SEQ_HAND, { winTile: 'B6', winBy: 'zimo', flow: { isLastDrawable: true } });
    expect(recognizedNames(h)).toContain('海底捞');
  });
});

describe('番种识别 · 门清 / 自摸 覆盖档', () => {
  it('门清（全暗 + 点炮）', () => {
    const h = H(SEQ_HAND, { winTile: 'B6', winBy: 'dianpao' });
    expect(recognizedNames(h)).toContain('门清');
  });
  it('自摸（非门清 + 自摸，非九）', () => {
    const h = H('B55', {
      melds: [meld('pong', 'W111'), meld('pong', 'T222'), meld('pong', 'B333'), meld('pong', 'W444'), meld('pong', 'T555')],
      winTile: 'B5',
      winBy: 'zimo',
    });
    expect(recognizedNames(h)).toContain('自摸');
  });
  it('门清一摸三（门清+自摸，非九非八对半）', () => {
    const h = H(SEQ_HAND, { winTile: 'B6', winBy: 'zimo' });
    expect(recognizedNames(h)).toContain('门清一摸三');
  });
  it('门清一摸二（门清自摸九筒）', () => {
    const h = H(SEQ_HAND, { winTile: 'B9', winBy: 'zimo' });
    expect(recognizedNames(h)).toContain('门清一摸二');
  });
  it('门清一摸一（八对半自摸九筒）', () => {
    const h = H('W11W22W33W44W55W66W77B999', { winTile: 'B9', winBy: 'zimo' });
    expect(recognizedNames(h)).toContain('门清一摸一');
  });
});
