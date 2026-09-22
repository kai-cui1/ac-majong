import { describe, it, expect } from 'vitest';
import { H, meld, recognizedNames, isWinning } from './helpers';

describe('番种识别 · 平 / 一色 / 缺门', () => {
  it('小平（无字+无坎+1花+5顺）', () => {
    const h = H('W123W456T789T123B456B99', { flowers: 'H1', winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('小平');
  });
  it('大平（同小平但无花）', () => {
    const h = H('W123W456T789T123B456B99', { winTile: 'B9' });
    expect(recognizedNames(h)).toContain('大平');
  });
  it('清一色（一门无字）', () => {
    const h = H('W123W456W789W111W234W99', { winTile: 'W9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('清一色');
  });
  it('混一色（一门+字）', () => {
    const h = H('W123W456W789Z111Z222W99', { winTile: 'W9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('混一色');
    expect(recognizedNames(h)).not.toContain('缺一门'); // D-33：混一色含字，与缺一门互斥
  });
  it('缺一门（两门，非清一色）', () => {
    const h = H('W123W456T234T567T789W99', { winTile: 'W9' });
    expect(isWinning(h)).toBe(true);
    const n = recognizedNames(h);
    expect(n).toContain('缺一门');
    expect(n).not.toContain('清一色');
  });
  it('缺一门须无字：两门数牌＋字牌 → 不计缺一门（D-33，2026-09-22 用户报障口径）', () => {
    const h = H('W123W456T123T456Z111Z22', { winTile: 'Z2' });
    expect(isWinning(h)).toBe(true);
    const n = recognizedNames(h);
    expect(n).not.toContain('缺一门');
    expect(n).toContain('见字');
  });
  it('缺一门无字检查含副露：两门数牌＋碰字刻 → 不计缺一门（D-33）', () => {
    const h = H('W123W456T123T456W99', { melds: [meld('pong', 'Z111')], winTile: 'W9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).not.toContain('缺一门');
  });
  it('将一色（全 2/5/8）', () => {
    const h = H('W222W555W888T222T555T88', { winTile: 'T8' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('将一色');
  });
  it('风一色（全字）', () => {
    const h = H('Z111Z222Z333Z444Z555Z66', { winTile: 'Z6' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('风一色');
  });
});

describe('番种识别 · 风 / 元', () => {
  it('小三风（2风刻+风对）', () => {
    const h = H('Z111Z222Z33W123W456T789', { winTile: 'T9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('小三风');
  });
  it('大三风（3风刻，非风对）', () => {
    const h = H('Z111Z222Z333W123W456B99', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('大三风');
  });
  it('小四喜（3风刻+风对）', () => {
    const h = H('Z111Z222Z333Z44W123W456', { winTile: 'W6' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('小四喜');
  });
  it('大四喜（4风刻）', () => {
    const h = H('Z111Z222Z333Z444W123B99', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('大四喜');
  });
  it('东风字（东刻，非庄）', () => {
    const h = H('Z111W123T456B789T123B99', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('东风字_非庄');
  });
  it('小三元（2元刻+元对）', () => {
    const h = H('Z555Z666Z77W123T456B789', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('小三元');
  });
  it('大三元（3元刻）', () => {
    const h = H('Z555Z666Z777W123T456B99', { winTile: 'B9' });
    expect(isWinning(h)).toBe(true);
    expect(recognizedNames(h)).toContain('大三元');
  });
});
