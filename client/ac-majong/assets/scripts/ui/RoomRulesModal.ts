import { Node, UITransform, Graphics } from 'cc';
import { Theme, rgba } from './Theme';
import { uiLabel, uiButton, uiSwitch, setButtonEnabled } from './UiKit';
import { AudioManager } from './AudioManager';
import type { RoomSettings } from '../vendor/protocol/index';

/**
 * 房间玩法参数弹层（FR-房间-12，100% 还原 room.html .rp-*）。
 * 等待页房主点房号卡「⚙」打开：集中展示 + 开局前可改局数/牌墙/摸牌位骰/先看吃再碰/公开房间；
 * 开局后锁定（locked=true：控件置灰不可点、保存禁用）。保存 → onConfirm → NetService.updateRoom。
 */
export interface RoomRulesModalOpts {
  maxRounds: number; // 0 = 不限
  settings?: Partial<RoomSettings>;
  /** 开局后锁定（仅房主开局前可改） */
  locked?: boolean;
  onConfirm: (patch: { maxRounds: number; settings: Partial<RoomSettings> }) => void;
}

const PANEL_W = 400;
const PANEL_H = 340; // BL-037：+时间档两行（2×ROW_PITCH）
const IX = 182; // 内容左右内缘（padding 18）
const ROW_PITCH = 34;
const ROW1_Y = PANEL_H / 2 - 65;
const FOOT_Y = -PANEL_H / 2 + 32;
const ROUNDS = [4, 8, 16, 0];
const ROUND_LABELS = ['4 局', '8 局', '16 局', '不限'];
const WALL_LABELS = ['物理牌墙展示', '随机发牌'];
// BL-037：时间档档位与建房弹层/服务端 normalizeRoomSettings 同源
const TURN_TIERS = [10, 15, 20, 30];
const RESP_TIERS = [5, 8, 10, 15];
const TIER_LABELS = (ns: number[]): string[] => ns.map((n) => `${n}s`);

export function openRoomRulesModal(parent: Node, opts: RoomRulesModalOpts): void {
  const DW = Theme.size.designW;
  const DH = Theme.size.designH;
  const locked = !!opts.locked;

  let maxRounds = ROUNDS.includes(opts.maxRounds) ? opts.maxRounds : 8;
  let wallMode: 'physical' | 'random' = opts.settings?.wallMode ?? 'random';
  let breakDice = opts.settings?.breakDice ?? false;
  let chiFirstView = opts.settings?.chiFirstView !== false;
  let isPublic = opts.settings?.isPublic !== false;
  let turnSec = TURN_TIERS.includes(opts.settings?.turnSec ?? -1) ? opts.settings!.turnSec! : 15;
  let respSec = RESP_TIERS.includes(opts.settings?.respSec ?? -1) ? opts.settings!.respSec! : 8;

  const root = new Node('RoomRulesModal');
  root.addComponent(UITransform).setContentSize(DW, DH);
  const close = (): void => {
    if (root.isValid) root.destroy();
  };

  const mask = new Node('Mask');
  mask.addComponent(UITransform).setContentSize(DW, DH);
  const mg = mask.addComponent(Graphics);
  mg.fillColor = rgba(0, 0, 0, 0.55);
  mg.rect(-DW / 2, -DH / 2, DW, DH);
  mg.fill();
  mask.setParent(root);
  mask.on(Node.EventType.TOUCH_END, close);

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

  const title = uiLabel('房间玩法', { size: 14, color: Theme.color.gold, bold: true });
  title.setParent(panel);
  title.setPosition(0, PANEL_H / 2 - 20, 0);
  const note = uiLabel(locked ? '房间已启动 · 玩法锁定不可修改' : '仅房主可在开局前修改 · 房间启动后锁定', { size: 9.5, color: Theme.color.textMuted });
  note.setParent(panel);
  note.setPosition(0, PANEL_H / 2 - 38, 0);

  // 内容区（随选择重建以刷新 pills/switch 视觉）
  const body = new Node('Body');
  body.addComponent(UITransform).setContentSize(PANEL_W, PANEL_H);
  body.setParent(panel);

  // 行序对齐原型（BL-037 补时间档两行）：局数 → 牌墙 → 思考 → 响应 → 摸牌位骰 → 先看吃再碰 → 公开房间
  const renderRows = (): void => {
    body.destroyAllChildren();
    pillRow(body, '局数上限', ROUND_LABELS, ROUNDS.indexOf(maxRounds), ROW1_Y, (i) => { maxRounds = ROUNDS[i]!; renderRows(); });
    pillRow(body, '牌墙模式', WALL_LABELS, wallMode === 'physical' ? 0 : 1, ROW1_Y - ROW_PITCH, (i) => { wallMode = i === 0 ? 'physical' : 'random'; renderRows(); });
    pillRow(body, '思考时间', TIER_LABELS(TURN_TIERS), TURN_TIERS.indexOf(turnSec), ROW1_Y - ROW_PITCH * 2, (i) => { turnSec = TURN_TIERS[i]!; renderRows(); });
    pillRow(body, '响应时间', TIER_LABELS(RESP_TIERS), RESP_TIERS.indexOf(respSec), ROW1_Y - ROW_PITCH * 3, (i) => { respSec = RESP_TIERS[i]!; renderRows(); });
    switchRow(body, '摸牌位骰', breakDice, ROW1_Y - ROW_PITCH * 4, (v) => { breakDice = v; });
    switchRow(body, '先看吃再碰', chiFirstView, ROW1_Y - ROW_PITCH * 5, (v) => { chiFirstView = v; });
    switchRow(body, '公开房间', isPublic, ROW1_Y - ROW_PITCH * 6, (v) => { isPublic = v; });
  };
  renderRows();

  // 底部：取消 / 保存
  const cancel = uiButton('取消', close, { variant: 'dark', width: 72, height: 32, radius: 16, fontSize: 12 });
  cancel.setParent(panel);
  cancel.setPosition(-41, FOOT_Y, 0);
  const save = uiButton('保存', () => {
    close();
    opts.onConfirm({ maxRounds, settings: { wallMode, breakDice, chiFirstView, isPublic, turnSec, respSec } });
  }, { variant: 'primary', width: 72, height: 32, radius: 16, fontSize: 12 });
  save.setParent(panel);
  save.setPosition(41, FOOT_Y, 0);
  if (locked) setButtonEnabled(save, false);

  root.setParent(parent);
}

/** 一行 pills：左标签 + 右对齐 pill 组（单选） */
function pillRow(parent: Node, label: string, items: string[], selIdx: number, y: number, onPick: (i: number) => void): void {
  const lb = uiLabel(label, { size: 11.5, color: Theme.color.textSecondary, align: 'left', anchorX: 0 });
  lb.setParent(parent);
  lb.setPosition(-IX, y, 0);
  const widths = items.map((t) => [...t].length * 10.5 + 24);
  const gap = 6;
  const total = widths.reduce((a, b) => a + b, 0) + gap * (items.length - 1);
  let x = IX - total;
  items.forEach((t, i) => {
    const w = widths[i]!;
    const pill = makePill(t, i === selIdx, () => {
      if (i === selIdx) return;
      AudioManager.instance.play('click');
      onPick(i);
    });
    pill.setParent(parent);
    pill.setPosition(x + w / 2, y, 0);
    x += w + gap;
  });
}

function makePill(text: string, sel: boolean, onClick: () => void): Node {
  const w = [...text].length * 10.5 + 24;
  const h = 22;
  const n = new Node('Pill');
  n.addComponent(UITransform).setContentSize(w, h);
  const g = n.addComponent(Graphics);
  g.lineWidth = 1;
  g.fillColor = sel ? rgba(212, 165, 55, 0.15) : rgba(0, 0, 0, 0);
  g.strokeColor = sel ? Theme.color.goldLight : rgba(212, 165, 55, 0.25);
  g.roundRect(-w / 2, -h / 2, w, h, h / 2);
  if (sel) g.fill();
  g.stroke();
  const lbl = uiLabel(text, { size: 10.5, color: sel ? Theme.color.goldLight : Theme.color.textSecondary, bold: sel });
  lbl.setParent(n);
  n.on(Node.EventType.TOUCH_END, onClick);
  return n;
}

/** 一行开关：左标签 + 右 34×18 开关（对齐 .rp-sw） */
function switchRow(parent: Node, label: string, on: boolean, y: number, onChange: (v: boolean) => void): void {
  const lb = uiLabel(label, { size: 11.5, color: Theme.color.textSecondary, align: 'left', anchorX: 0 });
  lb.setParent(parent);
  lb.setPosition(-IX, y, 0);
  const sw = uiSwitch(on, (v) => {
    AudioManager.instance.play('click');
    onChange(v);
  }, { w: 34, h: 18 });
  sw.node.setParent(parent);
  sw.node.setPosition(IX - 17, y, 0);
}
