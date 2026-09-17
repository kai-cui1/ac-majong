import { Node, Label, Graphics, UITransform } from 'cc';
import { Theme } from './Theme';
import { uiLabel, uiButton, uiModal } from './UiKit';
import { AudioManager } from './AudioManager';

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
  const h = hooks.onLeaveRoom ? 268 : 236;
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

  let y = h / 2 - 64;
  // 音效/静音（BL-014 开关并入设置统一管理）
  const sndLabel = uiLabel('音效', { size: 12, color: Theme.color.textSecondary, align: 'left', width: 60 });
  sndLabel.setParent(m.panel);
  sndLabel.setPosition(-w / 2 + 40, y, 0);
  const am = AudioManager.instance;
  const sndBtn = uiButton(am.muted ? '🔇 已静音' : '🔊 已开启', () => {
    const muted = am.toggleMuted();
    const lb = sndBtn.getChildByName('Label')?.getComponent(Label);
    if (lb) lb.string = muted ? '🔇 已静音' : '🔊 已开启';
  }, { variant: 'action', width: 110, height: 30, fontSize: 12 });
  sndBtn.setParent(m.panel);
  sndBtn.setPosition(w / 2 - 70, y, 0);
  y -= 40;

  if (hooks.onLeaveRoom) {
    const leave = uiButton('退出房间', () => { m.close(); hooks.onLeaveRoom!(); }, { variant: 'action', width: 240, height: 34, fontSize: 13 });
    leave.setParent(m.panel);
    leave.setPosition(0, y, 0);
    y -= 42;
  }
  const relogin = uiButton('返回登录', () => { m.close(); hooks.onRelogin(); }, { variant: 'action', width: 240, height: 34, fontSize: 13 });
  relogin.setParent(m.panel);
  relogin.setPosition(0, y, 0);
  y -= 42;

  const ver = uiLabel('AC Mahjong Club v0.1.0', { size: 10, color: Theme.color.textMuted });
  ver.setParent(m.panel);
  ver.setPosition(-60, y, 0);
  const agree = uiButton('协议/隐私', () => openAgreement(parent), { variant: 'secondary', width: 90, height: 26, fontSize: 11 });
  agree.setParent(m.panel);
  agree.setPosition(90, y, 0);
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
