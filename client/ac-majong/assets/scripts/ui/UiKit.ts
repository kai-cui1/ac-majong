import { Node, Label, UITransform, Graphics, Color, UIOpacity, EditBox } from 'cc';
import { Theme, rgba } from './Theme';
import { AudioManager } from './AudioManager';

/**
 * UiKit —— 通用 UI 组件工厂（还原 style.css 的组件规范）。
 * 全部运行时用 Graphics + Label 动态构建，无需预制体，跨微信/Web 一致。
 * 说明：CSS 的线性渐变/letter-spacing 在 Cocos 无直接对应，这里用「纯色 + 描边」近似，
 *      视觉精修（渐变贴图/字体）留到 M-E 牌桌与后续表现层。
 */

/** 在节点本地坐标（锚点 0.5）画圆角矩形路径 */
function roundRectPath(g: Graphics, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.roundRect(-w / 2, -h / 2, w, h, rr);
}

// ============ 背景 ============

/** 全屏背景：深绿桌布 / 红木。用半透明暗部近似渐变。 */
export function uiBackground(kind: 'table' | 'wood' = 'table', w = Theme.size.designW, h = Theme.size.designH): Node {
  const node = new Node('Background');
  node.addComponent(UITransform).setContentSize(w, h);
  const g = node.addComponent(Graphics);
  const base = kind === 'wood' ? Theme.color.bgWood : Theme.color.bgTable;
  const dark = kind === 'wood' ? Theme.color.bgWoodDark : Theme.color.bgTableDark;
  g.fillColor = base;
  g.rect(-w / 2, -h / 2, w, h);
  g.fill();
  g.fillColor = rgba(dark.r, dark.g, dark.b, 0.4); // 底部压暗，近似渐变
  g.rect(-w / 2, -h / 2, w, h * 0.45);
  g.fill();
  return node;
}

// ============ 文本 ============

export interface LabelOpts {
  size?: number;
  color?: Color;
  bold?: boolean;
  width?: number; // 给定宽度则自动换行（RESIZE_HEIGHT）
  align?: 'left' | 'center' | 'right';
}

export function uiLabel(text: string, opts: LabelOpts = {}): Node {
  const node = new Node('Label');
  const tf = node.addComponent(UITransform);
  const lb = node.addComponent(Label);
  lb.string = text;
  lb.fontSize = opts.size ?? Theme.font.body;
  lb.lineHeight = lb.fontSize + 5;
  lb.color = opts.color ?? Theme.color.textPrimary;
  lb.isBold = opts.bold ?? false;
  const a = opts.align ?? 'center';
  lb.horizontalAlign = a === 'left' ? Label.HorizontalAlign.LEFT : a === 'right' ? Label.HorizontalAlign.RIGHT : Label.HorizontalAlign.CENTER;
  lb.verticalAlign = Label.VerticalAlign.CENTER;
  if (opts.width) {
    tf.setContentSize(opts.width, lb.lineHeight);
    lb.overflow = Label.Overflow.RESIZE_HEIGHT;
  }
  return node;
}

// ============ 按钮 ============

export type ButtonVariant = 'primary' | 'action' | 'secondary' | 'wx';
export interface ButtonOpts {
  variant?: ButtonVariant;
  width?: number;
  height?: number;
  fontSize?: number;
  enabled?: boolean;
}

const disabledMap = new WeakMap<Node, boolean>();

/** 设置按钮可用态（禁用时压暗且不响应点击）——用于登录「勾选协议后才可点」等场景 */
export function setButtonEnabled(node: Node, enabled: boolean): void {
  disabledMap.set(node, !enabled);
  const op = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
  op.opacity = enabled ? 255 : 140;
}

export function uiButton(text: string, onClick: () => void, opts: ButtonOpts = {}): Node {
  const variant = opts.variant ?? 'primary';
  const h = opts.height ?? (variant === 'action' ? 40 : variant === 'wx' ? 50 : 46);
  const w = opts.width ?? (variant === 'action' ? 64 : variant === 'wx' ? 280 : 180);

  let fill: Color;
  let stroke: Color;
  let textColor: Color;
  let radius = Theme.radius.md;
  let lw = 1.5;
  let fontSize = opts.fontSize ?? 16;
  switch (variant) {
    case 'primary':
      fill = Theme.color.gold; stroke = Theme.color.goldLight; textColor = Theme.color.bgWoodDark; radius = h / 2; fontSize = opts.fontSize ?? 17; lw = 1; break;
    case 'wx':
      fill = Theme.color.wxGreen; stroke = Theme.color.wxGreenDark; textColor = Theme.color.white; radius = h / 2; fontSize = opts.fontSize ?? 17; lw = 1; break;
    case 'action':
      fill = Theme.color.bgCard; stroke = Theme.color.goldDark; textColor = Theme.color.gold; fontSize = opts.fontSize ?? 15; break;
    default: // secondary
      fill = rgba(0, 0, 0, 0); stroke = Theme.color.textMuted; textColor = Theme.color.textSecondary; fontSize = opts.fontSize ?? 14; lw = 1; break;
  }

  const node = new Node(`Btn_${text}`);
  node.addComponent(UITransform).setContentSize(w, h);
  node.addComponent(UIOpacity);
  const g = node.addComponent(Graphics);
  g.lineWidth = lw;
  g.fillColor = fill;
  g.strokeColor = stroke;
  roundRectPath(g, w, h, radius);
  if (fill.a > 0) g.fill();
  g.stroke();

  const ln = new Node('Label');
  ln.addComponent(UITransform);
  const lb = ln.addComponent(Label);
  lb.string = text;
  lb.fontSize = fontSize;
  lb.lineHeight = fontSize + 4;
  lb.color = textColor;
  lb.isBold = true;
  lb.horizontalAlign = Label.HorizontalAlign.CENTER;
  lb.verticalAlign = Label.VerticalAlign.CENTER;
  ln.setParent(node);

  node.on(Node.EventType.TOUCH_END, () => {
    if (disabledMap.get(node)) return;
    AudioManager.instance.play('click'); // BL-014：全局按钮统一点击音（静音时自动跳过）
    onClick();
  });
  if (opts.enabled === false) setButtonEnabled(node, false);
  return node;
}

/**
 * 🔊/🔇 静音切换按钮（BL-014 最简静音开关，完整设置弹层归 M-H）。
 * 点击切 `AudioManager` 静音态（写 localStorage 持久化）并刷新图标；跨屏与重启沿用。
 */
/** 单行输入框（H5 账号登录用）：暗底圆角 + 金色 accent 竖条 + 聚焦高亮；web 端聚焦时 Cocos 自动弹 DOM 输入层 */
export function uiInput(opts: { placeholder?: string; password?: boolean; width?: number; height?: number; maxLength?: number } = {}): { node: Node; box: EditBox } {
  const w = opts.width ?? 280;
  const h = opts.height ?? 42;
  const node = new Node('Input');
  // UITransform 比视觉框窄 18px：引擎按 LEFT_PADDING=2 定位 label，借此换来文字 ~11px 内边距（accent 竖条不遮字）
  node.addComponent(UITransform).setContentSize(w - 18, h);
  const g = node.addComponent(Graphics);
  const draw = (focused: boolean): void => {
    g.clear();
    // 底
    g.fillColor = Theme.color.bgWoodDark;
    roundRectPath(g, w, h, 10);
    g.fill();
    // 边框：常态半透明金，聚焦亮金加粗
    g.strokeColor = focused ? Theme.color.gold : Theme.color.goldFaint;
    g.lineWidth = focused ? 1.6 : 1;
    roundRectPath(g, w, h, 10);
    g.stroke();
    // 左侧 accent 竖条（视觉左缘内 5~8px；文字自 ~11px 起，不遮挡）
    g.fillColor = focused ? Theme.color.gold : Theme.color.goldDark;
    g.roundRect(-w / 2 + 5, -h / 2 + 9, 3, h - 18, 1.5);
    g.fill();
  };
  draw(false);
  const mkLabel = (name: string, color: Color, text: string): Label => {
    const n = new Node(name);
    n.setParent(node);
    const ut = n.addComponent(UITransform);
    ut.setContentSize(w - 20, h);
    ut.anchorX = 0;
    ut.anchorY = 1; // EditBox 引擎按 label 左上锚点自管布局
    n.setPosition(0, 0);
    const lb = n.addComponent(Label);
    lb.fontSize = 15;
    lb.lineHeight = h;
    lb.color = color;
    lb.string = text;
    lb.horizontalAlign = Label.HorizontalAlign.LEFT;
    lb.verticalAlign = Label.VerticalAlign.CENTER;
    lb.overflow = Label.Overflow.CLAMP;
    return lb;
  };
  // 修复：原误用不存在的 Theme.color.text（undefined→近黑），改用 textPrimary 暖白
  const textLabel = mkLabel('TEXT', Theme.color.textPrimary, '');
  const placeholder = mkLabel('PH', Theme.color.textMuted, opts.placeholder ?? '');
  const box = node.addComponent(EditBox);
  box.textLabel = textLabel;
  box.placeholderLabel = placeholder;
  box.maxLength = opts.maxLength ?? 32;
  box.inputFlag = opts.password ? EditBox.InputFlag.PASSWORD : EditBox.InputFlag.DEFAULT;
  // 关键：默认 InputMode.ANY 会被引擎强制 textLabel 顶部对齐（_updateTextLabel），改 SINGLE_LINE 保留 CENTER 垂直居中
  box.inputMode = EditBox.InputMode.SINGLE_LINE;
  box.returnType = EditBox.KeyboardReturnType.DONE;
  box.node.on(EditBox.EventType.EDITING_DID_BEGAN, () => draw(true));
  box.node.on(EditBox.EventType.EDITING_DID_ENDED, () => draw(false));
  return { node, box };
}

// ============ 开关（BL-017 建房玩法设置，还原 home.html .switch） ============

/** 开关控件：40×22 轨道 + 16 圆点；点击切换并回调（金色=开）。interactive=false 时不自身响应点击（由外层行统一处理，避免双触发） */
export function uiSwitch(initial: boolean, onChange: (on: boolean) => void, opts: { w?: number; h?: number; interactive?: boolean } = {}): { node: Node; set: (on: boolean) => void } {
  const w = opts.w ?? 40;
  const h = opts.h ?? 22;
  const node = new Node('Switch');
  node.addComponent(UITransform).setContentSize(w, h);
  const g = node.addComponent(Graphics);
  let on = initial;
  const draw = (): void => {
    g.clear();
    g.fillColor = on ? rgba(212, 165, 55, 0.4) : rgba(255, 255, 255, 0.12);
    g.strokeColor = on ? Theme.color.gold : Theme.color.goldFaint;
    g.lineWidth = 1;
    roundRectPath(g, w, h, h / 2);
    g.fill();
    g.stroke();
    g.fillColor = on ? Theme.color.goldLight : Theme.color.textSecondary;
    g.circle(on ? w / 2 - h / 2 : -w / 2 + h / 2, 0, h / 2 - 3);
    g.fill();
  };
  draw();
  if (opts.interactive !== false) {
    node.on(Node.EventType.TOUCH_END, () => {
      on = !on;
      draw();
      AudioManager.instance.play('click');
      onChange(on);
    });
  }
  return { node, set: (v: boolean) => { on = v; draw(); } };
}

export function uiMuteToggle(size = 34): Node {
  const am = AudioManager.instance;
  const icon = (): string => (am.muted ? '🔇' : '🔊');
  const btn = uiButton(icon(), () => {
    am.toggleMuted();
    const lb = btn.getChildByName('Label')?.getComponent(Label);
    if (lb) lb.string = icon();
  }, { variant: 'secondary', width: size, height: size, fontSize: Math.round(size * 0.5) });
  return btn;
}

// ============ 面板 / 卡片 ============

/** panel：半透明黑 + 金描边；gold：木纹卡 + 金描边（对应 .panel / .panel-gold） */
export function uiPanel(w: number, h: number, opts: { variant?: 'panel' | 'gold'; radius?: number } = {}): Node {
  const variant = opts.variant ?? 'panel';
  const node = new Node('Panel');
  node.addComponent(UITransform).setContentSize(w, h);
  const g = node.addComponent(Graphics);
  g.fillColor = variant === 'gold' ? Theme.color.bgCard : Theme.color.bgPanel;
  g.strokeColor = variant === 'gold' ? Theme.color.goldDark : Theme.color.goldFaint;
  g.lineWidth = 1;
  roundRectPath(g, w, h, opts.radius ?? Theme.radius.lg);
  g.fill();
  g.stroke();
  return node;
}

// ============ 徽章 ============

export function uiBadge(text: string, bg: Color = Theme.color.gold, fg: Color = Theme.color.bgWoodDark): Node {
  const w = Math.max(28, text.length * 9 + 16);
  const h = 18;
  const node = new Node('Badge');
  node.addComponent(UITransform).setContentSize(w, h);
  const g = node.addComponent(Graphics);
  g.fillColor = bg;
  roundRectPath(g, w, h, h / 2);
  g.fill();
  const ln = new Node('Label');
  ln.addComponent(UITransform);
  const lb = ln.addComponent(Label);
  lb.string = text; lb.fontSize = Theme.font.tiny; lb.lineHeight = Theme.font.tiny + 3;
  lb.color = fg; lb.isBold = true;
  lb.horizontalAlign = Label.HorizontalAlign.CENTER; lb.verticalAlign = Label.VerticalAlign.CENTER;
  ln.setParent(node);
  return node;
}

// ============ 弹层（Modal） ============

export interface Modal {
  root: Node;
  /** 内容面板，调用方往里加控件 */
  panel: Node;
  close: () => void;
}

/** 遮罩 + 居中面板 + 标题 + 关闭按钮；点遮罩或 ✕ 关闭。内容自行加到 modal.panel。 */
export function uiModal(title: string, opts: { width?: number; height?: number; onClose?: () => void } = {}): Modal {
  const W = Theme.size.designW;
  const H = Theme.size.designH;
  const w = opts.width ?? 320;
  const h = opts.height ?? 260;

  const root = new Node('Modal');
  root.addComponent(UITransform).setContentSize(W, H);

  const mask = new Node('Mask');
  mask.addComponent(UITransform).setContentSize(W, H);
  const mg = mask.addComponent(Graphics);
  mg.fillColor = Theme.color.mask;
  mg.rect(-W / 2, -H / 2, W, H);
  mg.fill();
  mask.setParent(root);

  const panel = uiPanel(w, h, { variant: 'gold', radius: Theme.radius.xl });
  panel.name = 'ModalPanel';
  panel.setParent(root);

  const t = uiLabel(title, { size: Theme.font.title, color: Theme.color.gold, bold: true });
  t.setParent(panel);
  t.setPosition(0, h / 2 - 30, 0);

  const doClose = (): void => {
    root.destroy();
    opts.onClose?.();
  };
  const close = uiButton('✕', doClose, { variant: 'secondary', width: 30, height: 30, fontSize: 15 });
  close.setParent(panel);
  close.setPosition(w / 2 - 22, h / 2 - 22, 0);

  mask.on(Node.EventType.TOUCH_END, doClose);
  return { root, panel, close: doClose };
}
