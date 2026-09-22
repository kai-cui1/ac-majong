import type { Hand, MatchedPattern } from './types';
import type { HandAnalysis } from './analyze';
import { isHonor, isSuited, rankOf, suitOf, isNineSpecial } from './tiles';
import { classifyWait } from './winCheck';

const P = (name: string, count = 1): MatchedPattern => ({ name, count });
const SUITS = ['W', 'T', 'B'] as const;
const key = (s: string, r: number) => `${s}${r}`;

/** 花 / 字类 */
function flowerHonor(a: HandAnalysis): MatchedPattern[] {
  const out: MatchedPattern[] = [];
  if (a.flowerCount >= 1) out.push({ name: '见花', count: a.flowerCount, tiles: a.flowerTiles });
  else out.push(P('无花'));
  if (a.honorPungCount >= 1) out.push({ name: '见字', count: a.honorPungCount, tiles: a.honorPungTiles });
  if (!a.hasHonor) out.push(P('无字'));
  if (a.flowerCount === 0 && !a.hasHonor) out.push(P('无花无字'));
  return out;
}

/** 平：小平 / 大平（无字 + 无坎 + 5 副皆顺） */
function ping(a: HandAnalysis): MatchedPattern[] {
  if (a.winKind !== 'standard' || a.seqCount !== 5 || a.hasHonor) return [];
  return a.flowerCount >= 1 ? [P('小平')] : [P('大平')];
}

/** 一色 / 缺门 */
function colorSuit(a: HandAnalysis): MatchedPattern[] {
  const out: MatchedPattern[] = [];
  const t = a.allTiles;
  if (t.length > 0 && t.every(isHonor)) out.push(P('风一色'));
  if (t.length > 0 && t.every((x) => isSuited(x) && (rankOf(x) === 2 || rankOf(x) === 5 || rankOf(x) === 8)))
    out.push(P('将一色'));
  if (a.suits.length === 1 && !a.hasHonor) out.push(P('清一色'));
  if (a.suits.length === 1 && a.hasHonor) out.push(P('混一色'));
  // 缺一门（D-33，2026-09-22 用户确认）：数牌至多两门且**整手（含副露）无字牌**；有字不计
  if (a.suits.length >= 1 && a.suits.length <= 2 && !a.hasHonor) out.push(P('缺一门'));
  return out;
}

/** 风 / 元 */
function windDragon(a: HandAnalysis, hand: Hand): MatchedPattern[] {
  const out: MatchedPattern[] = [];
  const w = a.windPungCount;
  if (w === 4) out.push(P('大四喜'));
  else if (w === 3 && a.pairIsWind) out.push(P('小四喜'));
  else if (w === 3) out.push(P('大三风'));
  else if (w === 2 && a.pairIsWind) out.push(P('小三风'));
  const d = a.dragonPungCount;
  if (d === 3) out.push(P('大三元'));
  else if (d === 2 && a.pairIsDragon) out.push(P('小三元'));
  if (a.hasEastPung) out.push(P(hand.isDealer ? '东风字_庄' : '东风字_非庄'));
  return out;
}

/** 连番：三姊妹 / 四姊妹 / 三相逢 / 一条龙 */
function sequences(a: HandAnalysis): MatchedPattern[] {
  const out: MatchedPattern[] = [];
  const pungSet = new Set(
    a.melds.filter((m) => m.kind !== 'seq' && isSuited(m.base)).map((m) => key(suitOf(m.base), rankOf(m.base))),
  );
  const seqSet = new Set(a.melds.filter((m) => m.kind === 'seq').map((m) => key(suitOf(m.base), rankOf(m.base))));
  for (const s of SUITS) {
    let four = false;
    for (let r = 1; r <= 6; r++)
      if (pungSet.has(key(s, r)) && pungSet.has(key(s, r + 1)) && pungSet.has(key(s, r + 2)) && pungSet.has(key(s, r + 3))) {
        out.push(P('四姊妹'));
        four = true;
        break;
      }
    if (!four)
      for (let r = 1; r <= 7; r++)
        if (pungSet.has(key(s, r)) && pungSet.has(key(s, r + 1)) && pungSet.has(key(s, r + 2))) {
          out.push(P('三姊妹'));
          break;
        }
    if (seqSet.has(key(s, 1)) && seqSet.has(key(s, 4)) && seqSet.has(key(s, 7))) out.push(P('一条龙'));
  }
  for (let r = 1; r <= 7; r++)
    if (seqSet.has(key('W', r)) && seqSet.has(key('T', r)) && seqSet.has(key('B', r))) {
      out.push(P('三相逢'));
      break;
    }
  return out;
}

/** 特殊大牌：十三幺 / 八对半 / 八只花 / 碰碰胡 / 全求人 */
function specials(a: HandAnalysis, hand: Hand): MatchedPattern[] {
  const out: MatchedPattern[] = [];
  if (a.winKind === 'orphans13') out.push(P('十三幺'));
  if (a.winKind === 'pairs8') out.push(P('八对半'));
  if (a.flowerCount === 8) out.push(P('八只花'));
  if (a.winKind === 'standard' && a.melds.length === 5 && a.seqCount === 0) out.push(P('碰碰胡'));
  // 全求人：5 副全亮明（无暗杠）+ 单钓暗牌
  if (
    a.winKind === 'standard' &&
    hand.melds.length === 5 &&
    hand.melds.every((m) => m.type !== 'kong_concealed')
  )
    out.push(P('全求人'));
  return out;
}

/** 九筒 / 九万（仅 B9/W9） */
function nine(a: HandAnalysis, hand: Hand): MatchedPattern[] {
  const out: MatchedPattern[] = [];
  const wt = hand.winTile;
  if (wt === 'B9' || wt === 'W9') {
    const sfx = wt === 'B9' ? '九筒' : '九万';
    out.push(P(hand.winBy === 'zimo' ? '自摸' + sfx : '胡' + sfx));
  }
  if (a.nineB >= 3) out.push(P('3九筒'));
  if (a.nineW >= 3) out.push(P('3九万'));
  for (const m of hand.melds) {
    const b = [...m.tiles].sort()[0]!;
    if (b !== 'B9' && b !== 'W9') continue;
    const sfx = b === 'B9' ? '九筒' : '九万';
    if (m.type === 'kong_exposed' || m.type === 'kong_added') out.push(P('明杠' + sfx));
    else if (m.type === 'kong_concealed') out.push(P('暗杠' + sfx));
  }
  return out;
}

/** 坎 / 杠 */
function kongs(a: HandAnalysis): MatchedPattern[] {
  const out: MatchedPattern[] = [];
  if (a.kongExposedCount >= 1) out.push(P('明杠', a.kongExposedCount));
  if (a.kongConcealedCount >= 1) out.push(P('暗杠', a.kongConcealedCount));
  const c = a.concealedPungCount;
  if (c === 2) out.push(P('2暗坎'));
  else if (c === 3) out.push(P('三暗坎'));
  else if (c === 4) out.push(P('四暗坎'));
  else if (c === 5) out.push(P('五暗坎'));
  return out;
}

/** 补牌胡 / 末尾胡 */
function bonusWin(hand: Hand): MatchedPattern[] {
  const out: MatchedPattern[] = [];
  const f = hand.flow ?? {};
  if (f.winAfterKong) out.push(P('杠开胡'));
  if (f.winAfterFlower) out.push(P('花开胡'));
  if (f.robbedKong) out.push(P('抢杠胡'));
  if (f.isLastDrawable && hand.winBy === 'zimo') out.push(P('海底捞'));
  return out;
}

/** 门清 / 自摸（覆盖档，特例 3/4） */
function menqingZimo(a: HandAnalysis, hand: Hand): MatchedPattern[] {
  const mq = a.isMenqing;
  const zm = hand.winBy === 'zimo';
  const nine = isNineSpecial(hand.winTile);
  const p8 = a.winKind === 'pairs8';
  if (mq && zm) {
    if (p8 && nine) return [P('门清一摸一')];
    if (nine || p8) return [P('门清一摸二')];
    return [P('门清一摸三')];
  }
  if (mq) return [P('门清')];
  if (zm && !nine) return [P('自摸')]; // 自摸九筒/九万已单独计
  return [];
}

/**
 * 听牌型：独独 / 1独 / 对碰（全求人的单钓不计独独）。
 * 八对半三种特殊听法（§2.3，2026-09-21 定案）按胡前暗牌中 winTile 的张数分类，不套标准型作将/卡张判据：
 *  - 胡前1张（单张补对，6对＋1刻＋1单）→ 独独2台；
 *  - 胡前2张（8对补第三张）或 3张（5对＋2刻补第四张）→ 1独1台。
 */
function waitType(hand: Hand, a: HandAnalysis, quanQiuren: boolean): MatchedPattern[] {
  const ready = { ...hand.concealed };
  const n = (ready[hand.winTile] ?? 0) - 1;
  if (n <= 0) delete ready[hand.winTile];
  else ready[hand.winTile] = n;

  if (a.winKind === 'pairs8') {
    const readyCount = ready[hand.winTile] ?? 0; // 胡前暗牌中 winTile 张数
    if (readyCount <= 1) return [P('独独')]; // 型1：单张补对
    return [P('1独')]; // 型2（=3，两刻补第四张）／型3（=2，八对补第三张）
  }

  const wt = classifyWait(ready, hand.melds.length, hand.winTile);
  if (wt === '独独') return quanQiuren ? [] : [P('独独')];
  return wt ? [P(wt)] : [];
}

/** 识别一手牌成立的全部番种 */
export function recognizePatterns(hand: Hand, a: HandAnalysis): MatchedPattern[] {
  const sp = specials(a, hand);
  const quanQiuren = sp.some((p) => p.name === '全求人');
  return [
    ...flowerHonor(a),
    ...ping(a),
    ...colorSuit(a),
    ...windDragon(a, hand),
    ...sequences(a),
    ...sp,
    ...nine(a, hand),
    ...kongs(a),
    ...bonusWin(hand),
    ...menqingZimo(a, hand),
    ...waitType(hand, a, quanQiuren),
  ];
}
