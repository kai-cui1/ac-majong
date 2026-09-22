import { Node, Label, UITransform, Graphics, UIOpacity } from 'cc';
import { Theme, rgba } from './Theme';
import { uiLabel, uiButton } from './UiKit';
import { AudioManager } from './AudioManager';
import { PERSONAS, DEFAULT_PERSONA, personaById } from '../vendor/ai/index';
import type { Persona } from '../vendor/ai/index';

/**
 * 机器人打法选择/修改弹层（BL-031 P1，100% 还原 room.html .bp-*）。
 * - add 模式：房主点「添加机器人」→ 选打法 → onConfirm(personaId) 后 addBot(1, personaId)。
 * - modify 模式：房主点 Bot 座位「✎ 改打法」→ 预选当前打法 → onConfirm 后 updateBotPersona；
 *   额外提供「移除」按钮（onRemove → removeBot 腾位，PRD 03 §3.1）。
 * 数据驱动 PERSONAS（过滤掉「托管」档：不在陪玩面板出现，PRD11 §4）；锁定档（P2+）置灰「敬请期待」不可点。
 */
export interface BotPersonaModalOpts {
  title?: string;
  sub?: string;
  /** 预选打法（modify 模式传当前 Bot 打法）；非法/锁定回落默认 */
  current?: string;
  okText?: string;
  onConfirm: (personaId: string) => void;
  /** modify 模式：移除该 Bot（腾位给真人） */
  onRemove?: () => void;
}

const PANEL_W = 468;
const PANEL_H = 320;
const CARD_W = 436;
const CARD_H = 40;
const CARD_GAP = 5;
const LIST_TOP = 110; // 首卡顶边（panel 局部坐标，中心原点、y 向上）
const FOOT_Y = -134;

export function openBotPersonaModal(parent: Node, opts: BotPersonaModalOpts): void {
  const DW = Theme.size.designW;
  const DH = Theme.size.designH;
  const root = new Node('BotPersonaModal');
  root.addComponent(UITransform).setContentSize(DW, DH);

  const close = (): void => {
    if (root.isValid) root.destroy();
  };

  // 遮罩（rgba(0,0,0,.55)，点击关闭）
  const mask = new Node('Mask');
  mask.addComponent(UITransform).setContentSize(DW, DH);
  const mg = mask.addComponent(Graphics);
  mg.fillColor = rgba(0, 0, 0, 0.55);
  mg.rect(-DW / 2, -DH / 2, DW, DH);
  mg.fill();
  mask.setParent(root);
  mask.on(Node.EventType.TOUCH_END, close);

  // 面板（rgba(43,22,10,.97) + 金.35 描边 + 圆角 lg）
  const panel = new Node('Panel');
  panel.addComponent(UITransform).setContentSize(PANEL_W, PANEL_H);
  const pg = panel.addComponent(Graphics);
  pg.fillColor = rgba(43, 22, 10, 0.97);
  pg.strokeColor = rgba(212, 165, 55, 0.35);
  pg.lineWidth = 1;
  pg.roundRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, Theme.radius.lg);
  pg.fill();
  pg.stroke();
  panel.setParent(root);

  // 标题 + 副文案
  const title = uiLabel(opts.title ?? '选择机器人打法', { size: 15, color: Theme.color.gold, bold: true });
  title.setParent(panel);
  title.setPosition(0, PANEL_H / 2 - 19, 0);
  const sub = uiLabel(opts.sub ?? '不同打法风格与强度不同，可为每个机器人单独指定', { size: 10, color: Theme.color.textMuted });
  sub.setParent(panel);
  sub.setPosition(0, PANEL_H / 2 - 37, 0);

  // 打法列表（过滤托管档）
  const personas = PERSONAS.filter((p) => p.id !== 'trustee');
  let selected = opts.current ?? DEFAULT_PERSONA;
  if (!personaById(selected)?.available) selected = DEFAULT_PERSONA;

  const list = new Node('List');
  list.addComponent(UITransform).setContentSize(CARD_W, 5 * CARD_H + 4 * CARD_GAP);
  list.setParent(panel);
  // 首卡顶边在 LIST_TOP，卡中心锚点→list 原点位于首卡中心（LIST_TOP - CARD_H/2）；后续卡按 -i*(CARD_H+GAP) 下排
  list.setPosition(0, LIST_TOP - CARD_H / 2, 0);

  const renderList = (): void => {
    list.destroyAllChildren();
    personas.forEach((p, i) => {
      const card = makeCard(p, p.id === selected, () => {
        if (!p.available) return;
        selected = p.id;
        AudioManager.instance.play('click');
        renderList();
      });
      card.setParent(list);
      card.setPosition(0, -i * (CARD_H + CARD_GAP), 0);
    });
  };
  renderList();

  // 底部按钮：[移除] 取消 添加/保存
  const okText = opts.okText ?? (opts.onRemove ? '保存' : '添加');
  const btns: Node[] = [];
  if (opts.onRemove) {
    btns.push(uiButton('移除', () => { close(); opts.onRemove!(); }, {
      variant: 'secondary', fill: rgba(244, 67, 54, 0.15), stroke: rgba(244, 67, 54, 0.45),
      textColor: Theme.color.danger, width: 72, height: 32, radius: 16, fontSize: 12,
    }));
  }
  btns.push(uiButton('取消', close, { variant: 'dark', width: 72, height: 32, radius: 16, fontSize: 12 }));
  btns.push(uiButton(okText, () => { close(); opts.onConfirm(selected); }, { variant: 'primary', width: 72, height: 32, radius: 16, fontSize: 12 }));
  const totalW = btns.length * 72 + (btns.length - 1) * 10;
  btns.forEach((b, i) => {
    b.setParent(panel);
    b.setPosition(-totalW / 2 + 36 + i * 82, FOOT_Y, 0);
  });

  root.setParent(parent);
}

/** 单张打法卡：图标 + 名称(+徽标) + 描述 + 选中圈；锁定档置灰不可点 */
function makeCard(p: Persona, sel: boolean, onClick: () => void): Node {
  const card = new Node(`Card_${p.id}`);
  card.addComponent(UITransform).setContentSize(CARD_W, CARD_H);
  const g = card.addComponent(Graphics);
  g.lineWidth = 1;
  g.fillColor = sel ? rgba(212, 165, 55, 0.12) : rgba(0, 0, 0, 0.2);
  g.strokeColor = sel ? Theme.color.goldLight : rgba(212, 165, 55, 0.18);
  g.roundRect(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, Theme.radius.md);
  g.fill();
  g.stroke();
  if (!p.available) {
    const op = card.addComponent(UIOpacity);
    op.opacity = Math.round(0.42 * 255);
  }

  // 图标圆（渐变灰近似纯色 #5b6472 + #9ca3af 描边）
  const ico = new Node('Ico');
  ico.addComponent(UITransform).setContentSize(30, 30);
  const ig = ico.addComponent(Graphics);
  ig.fillColor = rgba(91, 100, 114, 1);
  ig.circle(0, 0, 15);
  ig.fill();
  ig.strokeColor = rgba(156, 163, 175, 1);
  ig.lineWidth = 1;
  ig.circle(0, 0, 15);
  ig.stroke();
  const icoLbl = new Node('IcoGlyph');
  icoLbl.addComponent(UITransform);
  const il = icoLbl.addComponent(Label);
  il.string = p.icon;
  il.fontSize = 15;
  il.lineHeight = 19;
  il.horizontalAlign = Label.HorizontalAlign.CENTER;
  il.verticalAlign = Label.VerticalAlign.CENTER;
  icoLbl.setParent(ico);
  ico.setParent(card);
  ico.setPosition(-191, 0, 0);

  // 名称（左对齐）
  const nameX = -166;
  const name = uiLabel(p.displayName, { size: 12.5, color: Theme.color.textPrimary, bold: true, align: 'left', anchorX: 0 });
  name.setParent(card);
  name.setPosition(nameX, 7, 0);

  // 徽标：推荐（默认档）/ 敬请期待（锁定档）
  const isRec = p.available && p.id === DEFAULT_PERSONA;
  if (isRec || !p.available) {
    const badge = makeBadge(isRec ? '推荐' : '敬请期待', isRec ? 'rec' : 'soon');
    badge.setParent(card);
    const nameW = [...p.displayName].length * 12.5;
    const bw = isRec ? 28 : 44;
    badge.setPosition(nameX + nameW + 6 + bw / 2, 7, 0);
  }

  // 描述
  const desc = uiLabel(p.description, { size: 9.5, color: Theme.color.textSecondary, align: 'left', anchorX: 0, width: 330 });
  desc.setParent(card);
  desc.setPosition(nameX, -8, 0);

  // 选中圈（仅可选档）
  if (p.available) {
    const chk = new Node('Check');
    chk.addComponent(UITransform).setContentSize(16, 16);
    const cg = chk.addComponent(Graphics);
    if (sel) {
      cg.fillColor = Theme.color.goldLight;
      cg.circle(0, 0, 8);
      cg.fill();
    }
    cg.strokeColor = sel ? Theme.color.goldLight : rgba(212, 165, 55, 0.4);
    cg.lineWidth = 1;
    cg.circle(0, 0, 8);
    cg.stroke();
    const tick = new Node('Tick');
    tick.addComponent(UITransform);
    const tl = tick.addComponent(Label);
    tl.string = '✓';
    tl.fontSize = 10;
    tl.lineHeight = 13;
    tl.color = Theme.color.bgWoodDark;
    tl.isBold = true;
    tl.horizontalAlign = Label.HorizontalAlign.CENTER;
    tl.verticalAlign = Label.VerticalAlign.CENTER;
    tick.setParent(chk);
    chk.setParent(card);
    chk.setPosition(198, 0, 0);
    card.on(Node.EventType.TOUCH_END, onClick);
  }
  return card;
}

/** 小徽标 pill：rec=透金/金边/亮金字；soon=灰调 */
function makeBadge(text: string, kind: 'rec' | 'soon'): Node {
  const bw = kind === 'rec' ? 28 : 44;
  const bh = 13;
  const n = new Node('Badge');
  n.addComponent(UITransform).setContentSize(bw, bh);
  const g = n.addComponent(Graphics);
  g.fillColor = kind === 'rec' ? rgba(212, 165, 55, 0.12) : rgba(122, 106, 82, 0.14);
  g.strokeColor = kind === 'rec' ? rgba(212, 165, 55, 0.5) : rgba(122, 106, 82, 0.55);
  g.lineWidth = 1;
  g.roundRect(-bw / 2, -bh / 2, bw, bh, bh / 2);
  g.fill();
  g.stroke();
  const lbl = uiLabel(text, { size: 8, color: kind === 'rec' ? Theme.color.goldLight : Theme.color.textMuted, bold: true });
  lbl.setParent(n);
  return n;
}
