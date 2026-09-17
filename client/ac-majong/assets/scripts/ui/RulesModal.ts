import { Node, UITransform, Mask, ScrollView, Graphics } from 'cc';
import { Theme } from './Theme';
import { uiLabel, uiModal } from './UiKit';
import { PATTERN_TAI } from '../vendor/engine/index';

/**
 * 规则说明弹层（M-H / P9，FR-规则页-01/02/03）。
 * 大厅与牌桌共用；牌桌内为弹层形态、关闭即回对局不中断。
 * 内容分节（发牌行牌/胡牌牌型/台数番种/结算连庄/终局），番种速查取自引擎 `PATTERN_TAI` 单一来源。
 */

const dispName = (n: string): string => n.replace('_庄', '（庄）').replace('_非庄', '（非庄）');

/** 按台数分组降序，生成「N 台：番种、番种…」行 */
function fanLines(): string[] {
  const byTai = new Map<number, string[]>();
  for (const [name, tai] of Object.entries(PATTERN_TAI)) {
    const arr = byTai.get(tai) ?? [];
    arr.push(dispName(name));
    byTai.set(tai, arr);
  }
  const lines: string[] = [];
  for (const tai of [...byTai.keys()].sort((a, b) => b - a)) {
    lines.push(`${tai} 台：${byTai.get(tai)!.join('、')}`);
  }
  return lines;
}

const SECTIONS: { title: string; bullets: string[] }[] = [
  {
    title: '一、发牌与行牌',
    bullets: [
      '· 每家起手 16 张、庄家 17 张（含开局首摸）；庄家先行打出一张。',
      '· 轮转摸一张打一张；摸到花牌立即补摸（花不计入手牌结构）。',
      '· 弃牌后响应优先级：胡 ＞ 碰/杠 ＞ 吃（吃仅限上家弃牌）。',
    ],
  },
  {
    title: '二、胡牌牌型',
    bullets: [
      '· 标准型：5 副（顺/刻/杠）+ 1 将 = 17 张。',
      '· 八对半：8 个对子 + 1 单张。',
      '· 十三幺：么九字牌全 + 任一将。',
    ],
  },
  {
    title: '三、台数与番种',
    bullets: [
      '· 起胡门槛 6 台，不足 6 台的「胡」为诈胡并罚分。',
      '· 叠加按「必然包含」原则：A 必然包含 B 时只计 A，不重复计 B。',
      '· 番种速查见下方台数表（与算台引擎同一来源）。',
    ],
  },
  {
    title: '四、结算与连庄',
    bullets: [
      '· 1 台 = 20 积分；点炮 = 点炮方独付，自摸 = 三家各付。',
      '· 庄胡连庄（连庄 +1 追加），闲胡换庄；荒庄不计分、庄家连庄。',
    ],
  },
  {
    title: '五、终局与摊牌',
    bullets: [
      '· 胡牌 / 荒庄流局 / 诈胡 三类结束均摊开四家手牌供核对。',
      '· 诈胡方付其它每家固定罚分，本局结束。',
    ],
  },
];

/** 估行高：size 11 单行≈15px；按宽度估算换行数（CJK≈字号、ASCII≈6） */
function estHeight(text: string, width: number, size: number): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 255 ? size : size * 0.55;
  const perLine = Math.max(1, Math.floor(width / size));
  const cjkish = Math.ceil(w / size);
  const lines = Math.max(1, Math.ceil(cjkish / perLine));
  return lines * (size + 5);
}

export function openRulesModal(parent: Node): void {
  const W = Theme.size.designW;
  const H = Theme.size.designH;
  const w = Math.min(700, W - 60);
  const h = Math.min(350, H - 24);
  const m = uiModal('📖 规则说明', { width: w, height: h });
  m.root.setParent(parent);
  // 实底底衬（gold 变体偏透，长文阅读需不透明）
  const bg = new Node('SolidBg');
  bg.addComponent(UITransform).setContentSize(w - 8, h - 8);
  const bgg = bg.addComponent(Graphics);
  bgg.fillColor = Theme.color.bgWood;
  bgg.roundRect(-(w - 8) / 2, -(h - 8) / 2, w - 8, h - 8, Theme.radius.lg);
  bgg.fill();
  bg.setParent(m.panel);
  bg.setSiblingIndex(0);

  const vw = w - 36;
  const vh = h - 76;
  const svNode = new Node('RulesScroll');
  svNode.addComponent(UITransform).setContentSize(vw, vh);
  const sv = svNode.addComponent(ScrollView);
  sv.horizontal = false;
  sv.vertical = true;
  sv.inertia = true;
  svNode.setParent(m.panel);
  svNode.setPosition(0, -12, 0);

  const view = new Node('View');
  view.addComponent(UITransform).setContentSize(vw, vh);
  view.addComponent(Mask);
  view.setParent(svNode);

  // 内容行（标题 + 条目 + 番种速查），高度估算累加
  const items: { text: string; kind: 'title' | 'body' }[] = [];
  for (const s of SECTIONS) {
    items.push({ text: s.title, kind: 'title' });
    for (const b of s.bullets) items.push({ text: b, kind: 'body' });
  }
  items.push({ text: '附·番种台数速查（降序）', kind: 'title' });
  for (const l of fanLines()) items.push({ text: l, kind: 'body' });

  let contentH = 8;
  for (const it of items) contentH += (it.kind === 'title' ? 22 : 0) + estHeight(it.text, vw - 8, it.kind === 'title' ? 13 : 11) + 4;
  const content = new Node('Content');
  const ct = content.addComponent(UITransform);
  ct.setContentSize(vw, contentH);
  ct.setAnchorPoint(0.5, 1);
  content.setParent(view);
  content.setPosition(0, vh / 2, 0);

  let y = -4;
  for (const it of items) {
    if (it.kind === 'title') y -= 22;
    const lh = estHeight(it.text, vw - 8, it.kind === 'title' ? 13 : 11);
    const lb = uiLabel(it.text, {
      size: it.kind === 'title' ? 13 : 11,
      color: it.kind === 'title' ? Theme.color.gold : Theme.color.textSecondary,
      bold: it.kind === 'title',
      align: 'left',
      width: vw - 8,
    });
    lb.setParent(content);
    lb.setPosition(0, y - lh / 2, 0);
    y -= lh + 4;
  }
  sv.content = content;

  const tip = uiLabel('滑动查看 · 点 ✕ 或遮罩关闭', { size: 9, color: Theme.color.textMuted });
  tip.setParent(m.panel);
  tip.setPosition(0, -h / 2 + 12, 0);
}
