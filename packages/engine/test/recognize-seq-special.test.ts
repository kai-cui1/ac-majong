import { describe, it, expect } from 'vitest';
import { H, meld, recognizedNames, isWinning } from './helpers';

const FIVE_PONGS = [
  meld('pong', 'W111'),
  meld('pong', 'T222'),
  meld('pong', 'B333'),
  meld('pong', 'W444'),
  meld('pong', 'T555'),
];

describe('番种识别 · 连番', () => {
  it('三姊妹（同门3连刻）', () => {
    const h = H('B666B777B888W123T456B99', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('三姊妹');
  });
  it('四姊妹（同门4连刻）', () => {
    const h = H('B555B666B777B888W123B99', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('四姊妹');
  });
  it('三相逢（三门同序顺）', () => {
    const h = H('W678T678B678W123T456B99', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('三相逢');
  });
  it('一条龙（同门1-9）', () => {
    const h = H('W123W456W789T111T234B99', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('一条龙');
  });
});

describe('番种识别 · 特殊大牌', () => {
  it('十三幺', () => {
    const h = H('Z11Z2Z3Z4Z5Z6Z7W1W9T1T9B1B9B555', { winTile: 'B5' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('十三幺');
  });
  it('八对半', () => {
    const h = H('W11W22W33W44W55W66W77B999', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('八对半');
  });
  it('八只花（8 花）', () => {
    const h = H('B55', { melds: FIVE_PONGS, flowers: 'H12345678', winTile: 'B5' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('八只花');
  });
});

describe('番种识别 · 九筒 / 九万', () => {
  it('胡九筒（点炮 B9）', () => {
    const h = H('B99', { melds: FIVE_PONGS, winTile: 'B9', winBy: 'dianpao' });
    expect(recognizedNames(h)).toContain('胡九筒');
  });
  it('自摸九筒（自摸 B9）', () => {
    const h = H('B99', { melds: FIVE_PONGS, winTile: 'B9', winBy: 'zimo' });
    expect(recognizedNames(h)).toContain('自摸九筒');
  });
  it('3九筒（手中 3 张 B9）', () => {
    const h = H('B999W123W456T789T123W99', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('3九筒');
  });
  it('明杠九筒', () => {
    const h = H('W123W456T789T123W99', { melds: [meld('kong_exposed', 'B9999')], winTile: 'W9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('明杠九筒');
  });
  it('暗杠九万', () => {
    const h = H('W123W456T789T123B99', { melds: [meld('kong_concealed', 'W9999')], winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('暗杠九万');
  });
});
