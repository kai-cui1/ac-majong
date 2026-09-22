import { Node, Label, Graphics, UITransform } from 'cc';
import { Theme, rgba } from './Theme';
import { uiLabel, uiButton, uiModal } from './UiKit';
import { AudioManager } from './AudioManager';
import { Diag } from '../app/Diag';
import { NetService } from '../game/NetService';

/** 断线托管打法预设选项（FR-AI-10，对齐 settings.html .st-pills） */
const TRUSTEE_OPTIONS = [
  { label: '保守', pid: 'trustee' },
  { label: '新手', pid: 'efficiency-novice' },
  { label: '最大概率', pid: 'efficiency-normal' },
];

/**
 * 设置弹层（M-H / P10，FR-设置-01~04）。
 * 大厅与牌桌共用：音效/静音（AudioManager + localStorage 持久化）、断线托管打法预设（仅房间内，FR-AI-10）、
 * 退出房间（可选）、返回登录、诊断包与协议入口。面板高度随行数自适应（room+leave=326 对齐原型）。
 */
export function openSettingsModal(
  parent: Node,
  hooks: { onLeaveRoom?: () => void; onRelogin: () => void },
): void {
  const w = 320;
  const withLeave = !!hooks.onLeaveRoom;
  const room = NetService.instance.room;
  const inRoom = room != null && NetService.instance.userId != null;
  // 原型 settings.html .st-panel：基础 252（无退出行）；+退出行 40；+托管行 34（room+leave=326）
  const h = 252 + (withLeave ? 40 : 0) + (inRoom ? 34 : 0);
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

  // 动态纵向布局：首行距顶 56，行距 38，页脚距底 22（中心原点、y 向上）
  const IX = w / 2 - 18;
  const pitch = 38;
  let cursor = h / 2 - 56;
  const soundY = cursor; cursor -= pitch;
  const trusteeY = inRoom ? cursor : null; if (inRoom) cursor -= pitch;
  const leaveY = withLeave ? cursor : null; if (withLeave) cursor -= pitch;
  const reloginY = cursor; cursor -= pitch;
  const diagY = cursor;
  const footY = -h / 2 + 22;
  // 原型 .st-btn（金调 pill）与 .st-btn.action（黑.25 pill）
  const goldPill = { variant: 'action' as const, fill: rgba(212, 165, 55, 0.12), stroke: rgba(212, 165, 55, 0.35), radius: 13.5, height: 27, fontSize: 11 };
  const darkPill = { variant: 'dark' as const, fill: rgba(0, 0, 0, 0.25), stroke: rgba(212, 165, 55, 0.2), radius: 13.5, width: 240, height: 27, fontSize: 11 };

  // 音效/静音（BL-014 开关并入设置统一管理）
  const sndLabel = uiLabel('音效', { size: 12, color: Theme.color.textSecondary, align: 'left', anchorX: 0 });
  sndLabel.setParent(m.panel);
  sndLabel.setPosition(-IX, soundY, 0);
  const am = AudioManager.instance;
  const sndBtn = uiButton(am.muted ? '🔇 已静音' : '🔊 已开启', () => {
    const muted = am.toggleMuted();
    const lb = sndBtn.getChildByName('Label')?.getComponent(Label);
    if (lb) lb.string = muted ? '🔇 已静音' : '🔊 已开启';
  }, { ...goldPill, width: 84 });
  sndBtn.setParent(m.panel);
  sndBtn.setPosition(IX - 42, soundY, 0);

  // 断线托管打法预设（FR-AI-04/10，仅房间内；默认保守，持久化 FR-AI-11）
  if (inRoom && trusteeY != null) {
    const tl = uiLabel('断线托管打法', { size: 12, color: Theme.color.textSecondary, align: 'left', anchorX: 0 });
    tl.setParent(m.panel);
    tl.setPosition(-IX, trusteeY + 6, 0);
    const ts = uiLabel('掉线代打所用风格', { size: 8.5, color: Theme.color.textMuted, align: 'left', anchorX: 0 });
    ts.setParent(m.panel);
    ts.setPosition(-IX, trusteeY - 8, 0);
    const me = NetService.instance.userId;
    const mySeat = room!.seats.find((s) => s?.userId === me);
    let trusteeSel = mySeat?.trusteePersona ?? 'trustee';
    const pillsNode = new Node('TrusteePills');
    pillsNode.addComponent(UITransform);
    pillsNode.setParent(m.panel);
    pillsNode.setPosition(0, trusteeY, 0);
    const renderPills = (): void => {
      pillsNode.destroyAllChildren();
      const widths = TRUSTEE_OPTIONS.map((o) => [...o.label].length * 10 + 18);
      const gap = 5;
      const total = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1);
      let x = IX - total;
      TRUSTEE_OPTIONS.forEach((o, i) => {
        const sel = o.pid === trusteeSel;
        const bw = widths[i]!;
        const btn = uiButton(o.label, () => {
          trusteeSel = o.pid;
          NetService.instance.setTrusteePersona(o.pid);
          renderPills();
        }, {
          variant: 'secondary',
          fill: sel ? rgba(212, 165, 55, 0.15) : rgba(0, 0, 0, 0),
          stroke: sel ? Theme.color.goldLight : rgba(212, 165, 55, 0.25),
          textColor: sel ? Theme.color.goldLight : Theme.color.textSecondary,
          width: bw, height: 22, radius: 11, fontSize: 10,
        });
        btn.setParent(pillsNode);
        btn.setPosition(x + bw / 2, 0, 0);
        x += bw + gap;
      });
    };
    renderPills();
  }

  if (withLeave && leaveY != null) {
    // 原型 .st-row：标签+副注左、退出 pill 右
    const lv = uiLabel('退出房间', { size: 12, color: Theme.color.textSecondary, align: 'left', anchorX: 0 });
    lv.setParent(m.panel);
    lv.setPosition(-IX, leaveY + 6, 0);
    const lvSub = uiLabel('对局中退出＝离线托管流程', { size: 9, color: Theme.color.textMuted, align: 'left', anchorX: 0 });
    lvSub.setParent(m.panel);
    lvSub.setPosition(-IX, leaveY - 8, 0);
    const leave = uiButton('退出', () => { m.close(); hooks.onLeaveRoom!(); }, { ...goldPill, width: 56 });
    leave.setParent(m.panel);
    leave.setPosition(IX - 28, leaveY, 0);
  }
  const relogin = uiButton('返回登录', () => { m.close(); hooks.onRelogin(); }, darkPill);
  relogin.setParent(m.panel);
  relogin.setPosition(0, reloginY, 0);

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
  diag.setPosition(0, diagY, 0);

  // 页脚（原型 .st-foot：gap10 居中组，非两端对齐）：协议/隐私 + 版本号
  const verW = 118;
  const footW = 62 + 10 + verW;
  const agree = uiButton('协议/隐私', () => openAgreement(parent), { variant: 'secondary', fill: rgba(255, 255, 255, 0.06), stroke: rgba(255, 255, 255, 0.12), radius: 9, width: 62, height: 18, fontSize: 10 });
  agree.setParent(m.panel);
  agree.setPosition(-footW / 2 + 31, footY, 0);
  const ver = uiLabel('AC Mahjong Club v0.1.0', { size: 9, color: Theme.color.textMuted, align: 'left', anchorX: 0 });
  ver.setParent(m.panel);
  ver.setPosition(-footW / 2 + 72, footY, 0);
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
