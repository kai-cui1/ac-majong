import { Node, Label, Graphics, UITransform } from 'cc';
import { Theme, rgba } from './Theme';
import { uiLabel, uiButton, uiModal } from './UiKit';
import { AudioManager } from './AudioManager';
import { Diag } from '../app/Diag';

/**
 * 设置弹层（M-H / P10，FR-设置-01~04）。
 * 大厅与牌桌共用：音效/静音（AudioManager + localStorage 持久化）、退出房间（可选）、
 * 返回登录、版本号与协议入口（占位内容）。
 */
export function openSettingsModal(
  parent: Node,
  hooks: { onLeaveRoom?: () => void; onRelogin: () => void },
): void {
  const w = 320;
  const withLeave = !!hooks.onLeaveRoom;
  const h = withLeave ? 292 : 252; // 原型 settings.html .st-panel（含/不含退出房间行）
  const m = uiModal('⚙ 设置', { width: w, height: h });
  m.root.setParent(parent);
  // 实底底衬（与规则弹层一致）
  const bg = new Node('SolidBg');
  bg.addComponent(UITransform).setContentSize(w - 8, h - 8);
  const bgg = bg.addComponent(Graphics);
  bgg.fillColor = Theme.color.bgWood;
  bgg.roundRect(-(w - 8) / 2, -(h - 8) / 2, w - 8, h - 8, Theme.radius.lg);
  bgg.fill();
  bg.setParent(m.panel);
  bg.setSiblingIndex(0);

  // 原型几何：行宽 284（.st-panel padding 18）；垂直位自 flex 布局换算（中心原点、y 向上）
  const IX = w / 2 - 18;
  const Y: { row1: number; row2?: number; a1: number; a2: number; foot: number } = withLeave
    ? { row1: 90, row2: 52, a1: 14, a2: -24, foot: -124 }
    : { row1: 70, a1: 34, a2: -4, foot: -104 };
  // 原型 .st-btn（金调 pill）与 .st-btn.action（黑.25 pill）
  const goldPill = { variant: 'action' as const, fill: rgba(212, 165, 55, 0.12), stroke: rgba(212, 165, 55, 0.35), radius: 13.5, height: 27, fontSize: 11 };
  const darkPill = { variant: 'dark' as const, fill: rgba(0, 0, 0, 0.25), stroke: rgba(212, 165, 55, 0.2), radius: 13.5, width: 240, height: 27, fontSize: 11 };

  // 音效/静音（BL-014 开关并入设置统一管理）
  const sndLabel = uiLabel('音效', { size: 12, color: Theme.color.textSecondary, align: 'left', anchorX: 0 });
  sndLabel.setParent(m.panel);
  sndLabel.setPosition(-IX, Y.row1, 0);
  const am = AudioManager.instance;
  const sndBtn = uiButton(am.muted ? '🔇 已静音' : '🔊 已开启', () => {
    const muted = am.toggleMuted();
    const lb = sndBtn.getChildByName('Label')?.getComponent(Label);
    if (lb) lb.string = muted ? '🔇 已静音' : '🔊 已开启';
  }, { ...goldPill, width: 84 });
  sndBtn.setParent(m.panel);
  sndBtn.setPosition(IX - 42, Y.row1, 0);

  if (withLeave) {
    // 原型 .st-row：标签+副注左、退出 pill 右
    const lv = uiLabel('退出房间', { size: 12, color: Theme.color.textSecondary, align: 'left', anchorX: 0 });
    lv.setParent(m.panel);
    lv.setPosition(-IX, Y.row2! + 6, 0);
    const lvSub = uiLabel('对局中退出＝离线托管流程', { size: 9, color: Theme.color.textMuted, align: 'left', anchorX: 0 });
    lvSub.setParent(m.panel);
    lvSub.setPosition(-IX, Y.row2! - 8, 0);
    const leave = uiButton('退出', () => { m.close(); hooks.onLeaveRoom!(); }, { ...goldPill, width: 56 });
    leave.setParent(m.panel);
    leave.setPosition(IX - 28, Y.row2!, 0);
  }
  const relogin = uiButton('返回登录', () => { m.close(); hooks.onRelogin(); }, darkPill);
  relogin.setParent(m.panel);
  relogin.setPosition(0, Y.a1, 0);

  // BL-023：玩家侧诊断包出口（报错/卡顿时复制上下文+消息环给客服/开发复现）
  const diag = uiButton('复制诊断包', () => {
    Diag.copy();
    const lb = diag.getChildByName('Label')?.getComponent(Label);
    if (lb) {
      lb.string = '已复制诊断包 ✓';
      setTimeout(() => { if (lb.isValid) lb.string = '复制诊断包'; }, 2000);
    }
  }, darkPill);
  diag.setParent(m.panel);
  diag.setPosition(0, Y.a2, 0);

  // 页脚（原型 .st-foot：gap10 居中组，非两端对齐）：协议/隐私 + 版本号
  const verW = 118;
  const footW = 62 + 10 + verW;
  const agree = uiButton('协议/隐私', () => openAgreement(parent), { variant: 'secondary', fill: rgba(255, 255, 255, 0.06), stroke: rgba(255, 255, 255, 0.12), radius: 9, width: 62, height: 18, fontSize: 10 });
  agree.setParent(m.panel);
  agree.setPosition(-footW / 2 + 31, Y.foot, 0);
  const ver = uiLabel('AC Mahjong Club v0.1.0', { size: 9, color: Theme.color.textMuted, align: 'left', anchorX: 0 });
  ver.setParent(m.panel);
  ver.setPosition(-footW / 2 + 72, Y.foot, 0);
}

/** 用户协议/隐私政策占位弹层（FR-设置-04，合规文案上线前替换） */
function openAgreement(parent: Node): void {
  const m = uiModal('用户协议与隐私政策', { width: 300, height: 180 });
  m.root.setParent(parent);
  const txt = uiLabel(
    '· 本作为俱乐部内测娱乐产品，积分不具备任何货币价值。\n· 我们仅存储对局所必需的昵称与对局记录，不收集其它隐私信息。\n· 完整协议文本将于上线合规阶段（M-K）提供。',
    { size: 11, color: Theme.color.textSecondary, width: 250 },
  );
  txt.setParent(m.panel);
  txt.setPosition(0, -6, 0);
}
