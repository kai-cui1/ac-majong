import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CeremonyPresentation, RoomSettings, RoomView, SeatingView, ViewState } from '@ac-majong/protocol';

// 仅验证真实生产代码的生命周期、节点状态及绘制指令，不模拟截图、字体或 GPU。
const scripts = new URL('../../../client/ac-majong/assets/scripts/', import.meta.url);
function source(relative: string): ts.SourceFile {
  const path = fileURLToPath(new URL(relative, scripts));
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
const tableSource = source('game/TableScreen.ts');
const netSource = source('game/NetService.ts');
const themeSource = source('ui/Theme.ts');
function productionClass(file: ts.SourceFile, name: string): ts.ClassDeclaration {
  const matches = file.statements.filter(ts.isClassDeclaration).filter(n => n.name?.text === name);
  if (matches.length !== 1) throw new Error(`必须唯一定位生产类：${name}`);
  return matches[0]!;
}
function members(file: ts.SourceFile, className: string, names: string[]): string {
  const cls = productionClass(file, className);
  return names.map(name => {
    const matches = cls.members.filter(n => n.name?.getText(file) === name);
    if (matches.length !== 1) throw new Error(`必须唯一定位生产成员：${className}.${name}`);
    return matches[0]!.getText(file);
  }).join('\n');
}
function constants(file: ts.SourceFile, names: string[]): string {
  return names.map(name => {
    const declarations = file.statements.filter(ts.isVariableStatement)
      .flatMap(n => [...n.declarationList.declarations]).filter(n => n.name.getText(file) === name);
    if (declarations.length !== 1) throw new Error(`必须唯一定位生产常量：${name}`);
    return `const ${declarations[0]!.getText(file)};`;
  }).join('\n');
}
function compile(text: string, filename: string): string {
  const result = ts.transpileModule(text, {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true },
  });
  const errors = result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => '', getCanonicalFileName: f => f, getNewLine: () => '\n',
  }));
  return result.outputText;
}
// 不替换方法体、不复制仪式算法；外层只抽取管理此面板所需的真实成员。
const runtimeCode = compile([
  constants(tableSource, ['W', 'H', 'TOP', 'LEFT']),
  productionClass(tableSource, 'CeremonyPanel').getText(tableSource),
  `class TableLifecycle { ${members(tableSource, 'TableScreen', [
    'renderSeating', 'hideSeating', 'renderRollPick', 'renderCompass', 'drawClassicDie',
  ])} }`,
  `class NetRuntime { ${members(netSource, 'NetService', [
    'client', 'lastSettings', 'ceremonyClock', 'monotonicNow', 'sampleCeremony', 'ceremonyNow',
    'userId', 'view', 'roll', 'pickSeat', 'leave', 'restart',
  ])} }`,
  '({ CeremonyPanel, TableLifecycle, NetRuntime });',
].join('\n'), tableSource.fileName);
const themeCode = compile(themeSource.statements.filter(n => !ts.isImportDeclaration(n))
  .map(n => n.getText(themeSource)).join('\n'), themeSource.fileName);

function strictEnum<T extends Record<string, number | string>>(values: T): Readonly<T> {
  return new Proxy(Object.freeze(values), {
    get(target, key, receiver) {
      if (typeof key === 'string' && !Object.hasOwn(target, key)) throw new Error(`未声明的枚举：${key}`);
      return Reflect.get(target, key, receiver);
    },
  });
}
class Color {
  constructor(public r = 0, public g = 0, public b = 0, public a = 255) {
    if (![r, g, b, a].every(Number.isFinite)) throw new Error('颜色必须为有限数值');
  }
}
class Component { node!: MockNode; }
class UITransform extends Component {
  width = 0;
  height = 0;
  setContentSize(width: number, height: number): void {
    if (![width, height].every(Number.isFinite)) throw new Error('节点尺寸必须为有限数值');
    this.width = width; this.height = height;
  }
}
class UIOpacity extends Component { opacity = 255; }
class BlockInputEvents extends Component {}
class Label extends Component {
  static Overflow = strictEnum({ NONE: 0, CLAMP: 1, SHRINK: 2, RESIZE_HEIGHT: 3 });
  static HorizontalAlign = strictEnum({ LEFT: 0, CENTER: 1, RIGHT: 2 });
  static VerticalAlign = strictEnum({ TOP: 0, CENTER: 1, BOTTOM: 2 });
  string = '';
  color = new Color();
  fontSize = 16;
  lineHeight = 21;
  isBold = false;
  enableWrapText = true;
  overflow = Label.Overflow.NONE;
  horizontalAlign = Label.HorizontalAlign.CENTER;
  verticalAlign = Label.VerticalAlign.CENTER;
}
type Draw = {
  op: 'rect' | 'roundRect' | 'circle' | 'fill' | 'stroke'; args: number[];
  fill: number[]; stroke: number[]; lineWidth: number;
};
class Graphics extends Component {
  fillColor = new Color();
  strokeColor = new Color();
  lineWidth = 1;
  calls: Draw[] = [];
  clears = 0;
  clear(): void { this.calls = []; this.clears++; }
  private record(op: Draw['op'], args: number[]): void {
    if (!this.node.isValid || !args.every(Number.isFinite)) throw new Error('无效节点或绘制参数');
    const color = (c: Color) => [c.r, c.g, c.b, c.a];
    this.calls.push({ op, args, fill: color(this.fillColor), stroke: color(this.strokeColor), lineWidth: this.lineWidth });
  }
  rect(...args: [number, number, number, number]): void { this.record('rect', args); }
  roundRect(...args: [number, number, number, number, number]): void { this.record('roundRect', args); }
  circle(...args: [number, number, number]): void { this.record('circle', args); }
  fill(): void { this.record('fill', []); }
  stroke(): void { this.record('stroke', []); }
}
type ComponentClass<T extends Component = Component> = new () => T;
const componentTypes = new Set<ComponentClass>([UITransform, UIOpacity, Graphics, Label, BlockInputEvents]);
type EventHandler = (event?: unknown) => void;
type Listener = { callback: EventHandler; target?: object };
let nextUuid = 0;
class MockNode {
  static EventType = strictEnum({ TOUCH_START: 'touch-start', TOUCH_END: 'touch-end', TOUCH_CANCEL: 'touch-cancel',
    MOUSE_ENTER: 'mouse-enter', MOUSE_LEAVE: 'mouse-leave' });
  private readonly events = new Map<string, Listener[]>();
  readonly uuid = `node-${++nextUuid}`;
  readonly children: MockNode[] = [];
  private readonly components = new Map<ComponentClass, Component>();
  parent: MockNode | null = null;
  isValid = true;
  active = true;
  angle = 0;
  position = { x: 0, y: 0, z: 0 };
  scale = { x: 1, y: 1, z: 1 };
  constructor(public name = '') {}
  get activeInHierarchy(): boolean { return this.active && (this.parent?.activeInHierarchy ?? true); }
  addComponent<T extends Component>(type: ComponentClass<T>): T {
    if (!this.isValid || !componentTypes.has(type)) throw new Error('不支持的组件或无效节点');
    if (this.components.has(type)) throw new Error(`测试不允许重复添加组件：${type.name}`);
    const component = new type(); component.node = this; this.components.set(type, component); return component;
  }
  getComponent<T extends Component>(type: ComponentClass<T>): T | null {
    if (!componentTypes.has(type)) throw new Error('不支持的组件类型');
    return (this.components.get(type) as T | undefined) ?? null;
  }
  private checkEvent(type: string): void {
    if (!Object.values(MockNode.EventType).includes(type)) throw new Error(`未声明的事件：${type}`);
  }
  on(type: string, callback: EventHandler, target?: object): EventHandler {
    this.checkEvent(type);
    if (!this.isValid || typeof callback !== 'function') throw new Error('无效节点或事件处理器');
    const listeners = this.events.get(type) ?? [];
    if (!listeners.some(l => l.callback === callback && l.target === target)) listeners.push({ callback, target });
    this.events.set(type, listeners); return callback;
  }
  off(type: string, callback?: EventHandler, target?: object): void {
    this.checkEvent(type);
    if (callback === undefined) this.events.delete(type);
    else this.events.set(type, (this.events.get(type) ?? []).filter(l => l.callback !== callback || l.target !== target));
  }
  emit(type: string, ...args: [event?: unknown]): void {
    this.checkEvent(type);
    for (const listener of [...this.events.get(type) ?? []]) {
      if (this.events.get(type)?.includes(listener)) listener.callback.apply(listener.target ?? this, args);
    }
  }
  handlers(type: string): readonly EventHandler[] {
    this.checkEvent(type); return (this.events.get(type) ?? []).map(l => l.callback);
  }
  getChildByName(name: string): MockNode | null { return this.children.find(n => n.name === name) ?? null; }
  setParent(parent: MockNode | null): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = parent; parent?.children.push(this);
  }
  setPosition(x: number, y: number, z = 0): void { this.position = { x, y, z }; }
  setScale(x: number, y = x, z = 1): void { this.scale = { x, y, z }; }
  destroyAllChildren(): void { [...this.children].forEach(n => n.destroy()); }
  // 销毁同步生效；不声称覆盖 Cocos 的帧末延迟销毁机制。
  destroy(): boolean {
    if (!this.isValid) return false;
    this.destroyAllChildren(); this.events.clear(); this.setParent(null); this.isValid = false; return true;
  }
}
function component<T extends Component>(node: MockNode, type: ComponentClass<T>): T {
  const found = node.getComponent(type);
  if (!found) throw new Error(`${node.name} 缺少 ${type.name}`);
  return found;
}
function at(root: MockNode, path: string): MockNode {
  return path.split('/').reduce((node, name) => {
    const child = node.getChildByName(name);
    if (!child) throw new Error(`${node.name} 缺少子节点 ${name}`);
    return child;
  }, root);
}
function text(root: MockNode, path: string): string { return component(at(root, path), Label).string; }
function tree(root: MockNode): MockNode[] { return [root, ...root.children.flatMap(tree)]; }
function die(node: MockNode) {
  const tf = component(node, UITransform);
  const circles = component(node, Graphics).calls.filter(c => c.op === 'circle');
  return { uuid: node.uuid, size: [tf.width, tf.height], pips: circles.length,
    circles: circles.map(c => c.args), angle: node.angle, scale: { ...node.scale } };
}
function faces(root: MockNode, prefix: string): number[] { return [0, 1].map(i => die(at(root, `${prefix}${i}`)).pips); }
function expectDealerGlow(root: MockNode, seat: number, blur: number): void {
  const glow = at(root, `CompassCard${seat}/Glow`), calls = component(glow, Graphics).calls;
  const outlines = calls.filter(c => c.op === 'roundRect');
  expect(outlines).toHaveLength(12); expect(calls.filter(c => c.op === 'stroke')).toHaveLength(12);
  expect(calls).toHaveLength(24);
  const outer = [-59 - blur / 2, -23 - blur / 2, 118 + blur, 46 + blur, 10 + blur / 2];
  outlines[0]!.args.forEach((value, i) => expect(value).toBeCloseTo(outer[i]!, 3));
  expect(outlines.at(-1)!.args[4]).toBeCloseTo(10 + blur / 24, 3);
  outlines.forEach((outline, i) => {
    expect(outline.stroke.slice(0, 3)).toEqual([212, 165, 55]);
    expect(outline.lineWidth).toBeCloseTo(1 + blur / 12, 3);
    expect(outline.stroke[3]).toBeGreaterThan(0); expect(outline.stroke[3]).toBeLessThan(24);
    if (i) {
      expect(outline.args[4]).toBeLessThan(outlines[i - 1]!.args[4]!);
      expect(outline.stroke[3]).toBeGreaterThanOrEqual(outlines[i - 1]!.stroke[3]!);
    }
  });
  expect(glow.getComponent(UIOpacity)).toBeNull();
  expect(component(at(root, `CompassCard${seat}/Highlight`), UIOpacity).opacity).toBe(255);
}

interface Panel {
  root: MockNode; id: string;
  update(sv: SeatingView, room: RoomView | null, view: ViewState | null): void;
  tick(): void;
  dispose(): void;
}
function mockClient() {
  return { userId: 'u0', room: room() as RoomView | null, view: null as ViewState | null,
    roll: vi.fn(), pickSeat: vi.fn(), leave: vi.fn(), create: vi.fn() };
}
interface Net {
  client: ReturnType<typeof mockClient> | null;
  lastSettings?: RoomSettings;
  ceremonyClock: { ceremonyId: string; stepId: number; server: number; local: number } | null;
  sampleCeremony(p?: CeremonyPresentation): void;
  ceremonyNow(p: CeremonyPresentation): number;
  leave(): void;
  restart(maxRounds?: number): void;
}
interface Lifecycle {
  ceremonyPanel: Panel | null; seatingRoot: MockNode; net: Net; router: { currentName: string };
  renderSeating(sv: SeatingView | null, room: RoomView | null): void;
  hideSeating(): void;
  renderRollPick(panel: MockNode, sv: SeatingView, me: number, nameOf: (seat: number) => string, width: number, height: number): void;
  renderCompass(panel: MockNode, sv: SeatingView, me: number, nameOf: (seat: number) => string, room: RoomView | null, width: number, height: number): void;
  drawClassicDie(parent: MockNode, size: number, value: number, x: number, y: number, big?: boolean): void;
}
const cleanup: (() => void)[] = [];
function harness() {
  const enabled = new Map<MockNode, boolean>();
  const callbacks = {
    get(node: MockNode): EventHandler | undefined {
      if (!enabled.has(node)) throw new Error('只能读取已注册按钮的回调');
      const handlers = node.handlers(MockNode.EventType.TOUCH_END);
      if (handlers.length > 1) throw new Error('按钮残留多个 TOUCH_END 处理器');
      return handlers[0];
    },
  };
  const play = vi.fn((sound: string) => { if (sound !== 'click') throw new Error(`未声明的音效：${sound}`); });
  const stopAllByTarget = vi.fn();
  const dicePair = vi.fn(() => { throw new Error('旧协议禁止按总点数伪造两枚骰面'); });
  const cc = Object.freeze({ Node: MockNode, UITransform, UIOpacity, Graphics, Color, Label, BlockInputEvents,
    Tween: Object.freeze({ stopAllByTarget }) });
  const themeExports: Record<string, unknown> = {};
  runInNewContext(themeCode, { Color, exports: themeExports }, { filename: themeSource.fileName, timeout: 1000 });
  function uiPanel(width: number, height: number): MockNode {
    const node = new MockNode('Panel');
    node.addComponent(UITransform).setContentSize(width, height); node.addComponent(Graphics); return node;
  }
  function uiLabel(value: string, opts: { size?: number; width?: number; color?: Color; bold?: boolean } = {}): MockNode {
    const node = new MockNode('Label');
    node.addComponent(UITransform).setContentSize(opts.width ?? 0, (opts.size ?? 16) + 5);
    const label = node.addComponent(Label);
    label.string = value; label.fontSize = opts.size ?? 16; label.isBold = opts.bold ?? false;
    if (opts.color) label.color = opts.color;
    return node;
  }
  function uiButton(value: string, callback: () => void, opts: { width: number; height: number; enabled?: boolean; fontSize?: number }): MockNode {
    const node = uiPanel(opts.width, opts.height); node.addComponent(UIOpacity);
    uiLabel(value, { size: opts.fontSize }).setParent(node); enabled.set(node, opts.enabled !== false);
    node.on(MockNode.EventType.TOUCH_END, () => {
      if (!enabled.get(node)) return;
      play('click'); callback();
    });
    return node;
  }
  function setButtonEnabled(node: MockNode, value: boolean): void {
    if (!enabled.has(node)) throw new Error('只能设置真实按钮 mock 的可用态');
    enabled.set(node, value); component(node, UIOpacity).opacity = value ? 255 : 140;
  }
  let randomIndex = 0;
  const random = vi.fn(() => [0, 0.99, 0.2, 0.8, 0.4, 0.6][randomIndex++ % 6]!);
  const math = Object.create(Math) as Math;
  Object.defineProperty(math, 'random', { value: random });
  const runtime = runInNewContext(runtimeCode, {
    ...cc, ...themeExports, uiPanel, uiLabel, uiButton, setButtonEnabled,
    AudioManager: Object.freeze({ instance: Object.freeze({ play }) }), dicePair,
    setInterval, clearInterval, Date, performance: { now: () => Date.now() }, Math: math,
  }, { filename: tableSource.fileName, timeout: 1000 }) as {
    CeremonyPanel: new (parent: MockNode, net: Net, id: string) => Panel;
    TableLifecycle: new () => Lifecycle; NetRuntime: new () => Net;
  };
  const net = new runtime.NetRuntime();
  const client = mockClient(); net.client = client;
  const parent = new MockNode('SeatingLayer');
  const screen = Object.assign(new runtime.TableLifecycle(), {
    net, seatingRoot: parent, ceremonyPanel: null, router: { currentName: 'table' },
  }) as Lifecycle;
  cleanup.push(() => screen.hideSeating());
  return {
    ...runtime, net, client, parent, screen, enabled, callbacks, random, stopAllByTarget, play, dicePair,
    legacy(sv: SeatingView): MockNode {
      const root = uiPanel(640, 330); root.setParent(parent);
      const nameOf = (seat: number) => `玩家${seat + 1}`;
      if (sv.stage === 'roll' || sv.stage === 'pick') screen.renderRollPick(root, sv, 0, nameOf, 640, 330);
      else screen.renderCompass(root, sv, 0, nameOf, room(), 640, 330);
      return root;
    },
    show(sv: SeatingView, roomView: RoomView | null = room(), view: ViewState | null = null): Panel {
      client.view = view; client.room = roomView; net.sampleCeremony(sv.presentation);
      screen.renderSeating(sv, roomView);
      if (!screen.ceremonyPanel) throw new Error('生产入口未创建面板');
      return screen.ceremonyPanel;
    },
    press(node: MockNode): boolean {
      if (!node.isValid || !node.activeInHierarchy || !enabled.get(node)) return false;
      const callback = callbacks.get(node);
      if (!callback) throw new Error('按钮缺少回调');
      node.emit(MockNode.EventType.TOUCH_END); return true;
    },
  };
}
function room(wallMode: RoomSettings['wallMode'] = 'random'): RoomView {
  return { room: 'room-a', phase: 'seating', hostUserId: 'u0', maxRounds: 8,
    settings: { wallMode, breakDice: true, chiFirstView: true, isPublic: true },
    seats: [
      { userId: 'u0', seat: 0, nickname: '阿甲' },
      { userId: 'u1', seat: 1, nickname: '阿乙', isBot: true },
      { userId: 'u2', seat: 2, nickname: '阿丙', offline: true },
      { userId: 'u3', seat: 3, nickname: '阿丁', trusteed: true },
    ] };
}
function view(): ViewState {
  return { room: 'room-a', round: 2, maxRounds: 8, names: ['局间甲', '局间乙', '局间丙', '局间丁'],
    phase: 'draw', dealerSeat: 1, currentSeat: 1, wallRemaining: 100, lianzhuangCount: 0,
    lastDiscard: null, discards: [], others: [],
    you: { seat: 2, concealed: {}, drawn: null, melds: [], flowers: [], zi: 2, score: 0, legal: [] } };
}
const results: CeremonyPresentation['resultsByUserId'] = {
  u0: { d1: 6, d2: 1, sum: 7, rerollRound: 0 },
  u1: { d1: 1, d2: 2, sum: 3, rerollRound: 0 },
  u2: { d1: 3, d2: 5, sum: 8, rerollRound: 0 },
  u3: { d1: 4, d2: 6, sum: 10, rerollRound: 0 },
};
function seating(patch: Partial<CeremonyPresentation> = {}, fields: Partial<SeatingView> = {}): SeatingView {
  return { stage: 'roll', rolls: [null, null, null, null], reroll: [false, false, false, false],
    order: [], picker: null, picked: null, dealerDice: null, dealerSeat: null, breakN: null, roller: null,
    ...fields,
    presentation: { ceremonyId: 'ceremony-a', stepId: 1, startedAt: 10_000, deadline: 20_000, serverNow: 10_000,
      phase: 'input', actor: { userId: 'u0', seat: 0 }, rerollRound: 0,
      pendingRollUserIds: ['u0', 'u1', 'u2', 'u3'], resultsByUserId: {}, ceremonyDice: null, summaryKind: null, ...patch } };
}
const stages: SeatingView['stage'][] = ['roll', 'pick', 'dealerBreak', 'roundBreak'];
const phases: CeremonyPresentation['phase'][] = ['input', 'rolling', 'result', 'summary'];
function panelNode(panel: Panel): MockNode { return at(panel.root, 'CeremonyPanel'); }

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => {
  try { cleanup.splice(0).reverse().forEach(dispose => dispose()); }
  finally { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); }
});

describe('CeremonyPanel：真实生产类的非视觉运行时回归', () => {
  it('严格 mock 不会为未添加的组件、节点或未知枚举兜底', () => {
    const node = new MockNode('strict');
    expect(node.getComponent(UIOpacity)).toBeNull();
    expect(node.getComponent(Graphics)).toBeNull();
    expect(node.getChildByName('不存在')).toBeNull();
    const opacity = node.addComponent(UIOpacity);
    expect(node.getComponent(UIOpacity)).toBe(opacity);
    expect(() => node.getComponent(undefined as unknown as ComponentClass)).toThrow();
    expect(() => Reflect.get(Label.Overflow, 'UNKNOWN')).toThrow('未声明的枚举');
    expect(() => Reflect.get(MockNode.EventType, 'UNKNOWN')).toThrow('未声明的枚举');
    expect(Label.Overflow.SHRINK).toBe(2);
  });

  it('严格事件替身按类型及目标注册、去重、解绑，emit 保留实参并在销毁后清理', () => {
    const node = new MockNode('events'), other = {}, end = MockNode.EventType.TOUCH_END;
    const calls: unknown[][] = [];
    const handler = function(this: unknown, ...args: [event?: unknown]) { calls.push([this, ...args]); };
    expect(node.on(end, handler)).toBe(handler); node.on(end, handler); node.on(end, handler, other);
    expect(node.handlers(end)).toEqual([handler, handler]);
    const event = { native: true }; node.emit(end, event); node.emit(end);
    expect(calls).toEqual([[node, event], [other, event], [node], [other]]);
    node.off(end, handler, other); expect(node.handlers(end)).toEqual([handler]);
    const start = vi.fn(); node.on(MockNode.EventType.TOUCH_START, start);
    node.off(end); node.emit(end); expect(calls).toHaveLength(4);
    node.emit(MockNode.EventType.TOUCH_START); expect(start).toHaveBeenCalledTimes(1);
    for (const action of [() => node.on('unknown', handler), () => node.off('unknown'), () => node.emit('unknown')]) {
      expect(action).toThrow('未声明的事件');
    }
    expect(() => node.on(end, null as unknown as EventHandler)).toThrow('事件处理器');
    node.destroy(); node.emit(MockNode.EventType.TOUCH_START); expect(start).toHaveBeenCalledTimes(1);
    expect(node.handlers(end)).toEqual([]);
  });

  it.each(stages)('%s：step1 旧 end 闭包不能借同一用户的 step7 input 发送新 token', stage => {
    const h = harness(), root = panelNode(h.show(seating({}, { stage })));
    const button = at(root, stage === 'pick' ? 'CeremonyPick3' : 'CeremonyRoll');
    const oldEnd = h.callbacks.get(button)!;
    const on = vi.spyOn(button, 'on'), off = vi.spyOn(button, 'off');
    h.show(seating({ stepId: 7 }, { stage }));
    expect(h.callbacks.get(button)).not.toBe(oldEnd);
    expect(off.mock.calls).toEqual([['touch-start'], ['touch-end'], ['touch-cancel']]);
    expect(on).toHaveBeenCalledTimes(3);
    for (const type of ['touch-start', 'touch-end', 'touch-cancel']) expect(button.handlers(type)).toHaveLength(1);
    oldEnd(); oldEnd({ native: true });
    expect(h.client.roll).not.toHaveBeenCalled(); expect(h.client.pickSeat).not.toHaveBeenCalled();
    expect(h.play).not.toHaveBeenCalled(); expect(h.enabled.get(button)).toBe(true);
    expect(h.press(button)).toBe(true);
    const send = stage === 'pick' ? h.client.pickSeat : h.client.roll;
    expect(send.mock.calls).toEqual([stage === 'pick' ? [3, { ceremonyId: 'ceremony-a', stepId: 7 }] : [{ ceremonyId: 'ceremony-a', stepId: 7 }]]);
    expect(h.play.mock.calls).toEqual([['click']]);
  });

  it.each(['roll', 'pick'] as const)('%s：跨步原生松手和取消后的松手被拒绝，重新按下松开才提交', stage => {
    const h = harness(), root = panelNode(h.show(seating({}, { stage })));
    const button = at(root, stage === 'pick' ? 'CeremonyPick1' : 'CeremonyRoll'), event = { native: true };
    button.emit(MockNode.EventType.TOUCH_START, event);
    h.show(seating({ stepId: 7 }, { stage }));
    button.emit(MockNode.EventType.TOUCH_END, event);
    button.emit(MockNode.EventType.TOUCH_START, event); button.emit(MockNode.EventType.TOUCH_CANCEL, event);
    button.emit(MockNode.EventType.TOUCH_END, event);
    expect(h.client.roll).not.toHaveBeenCalled(); expect(h.client.pickSeat).not.toHaveBeenCalled();
    expect(h.play).not.toHaveBeenCalled();
    button.emit(MockNode.EventType.TOUCH_START, event); button.emit(MockNode.EventType.TOUCH_END, event);
    button.emit(MockNode.EventType.TOUCH_END, event);
    const send = stage === 'pick' ? h.client.pickSeat : h.client.roll;
    expect(send.mock.calls).toEqual([stage === 'pick' ? [1, { ceremonyId: 'ceremony-a', stepId: 7 }] : [{ ceremonyId: 'ceremony-a', stepId: 7 }]]);
    expect(h.play.mock.calls).toEqual([['click']]);
  });

  it.each(stages)('%s：同 step 广播不重新绑定任一按钮，按下至松开的同一步手势保持有效', stage => {
    const h = harness(), sv = seating({}, { stage }), root = panelNode(h.show(sv));
    const buttons = ['CeremonyRoll', ...[0, 1, 2, 3].map(i => `CeremonyPick${i}`)].map(name => at(root, name));
    const types = [MockNode.EventType.TOUCH_START, MockNode.EventType.TOUCH_END, MockNode.EventType.TOUCH_CANCEL];
    const handlers = buttons.map(b => types.map(type => b.handlers(type)[0]!));
    const spies = buttons.flatMap(b => [vi.spyOn(b, 'on'), vi.spyOn(b, 'off')]);
    const chosen = buttons[stage === 'pick' ? 3 : 0]!, event = { native: true };
    chosen.emit(MockNode.EventType.TOUCH_START, event); h.show(structuredClone(sv));
    buttons.forEach((b, i) => types.forEach((type, j) => {
      expect(b.handlers(type)).toHaveLength(1); expect(b.handlers(type)[0]).toBe(handlers[i]![j]);
    }));
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    chosen.emit(MockNode.EventType.TOUCH_END, event);
    expect(stage === 'pick' ? h.client.pickSeat : h.client.roll).toHaveBeenCalledTimes(1);
    expect(h.play.mock.calls).toEqual([['click']]);
  });

  it.each(['root', 'parent'] as const)('%s 隐藏期间直接旧回调不提交也不响，恢复后仍可正常提交', hidden => {
    const h = harness(), panel = h.show(seating()), root = panelNode(panel);
    const button = at(root, 'CeremonyRoll'), end = h.callbacks.get(button)!;
    const target = hidden === 'root' ? panel.root : h.parent;
    target.active = false; end();
    button.emit(MockNode.EventType.TOUCH_START, {}); button.emit(MockNode.EventType.TOUCH_END, {});
    expect(h.press(button)).toBe(false); expect(h.client.roll).not.toHaveBeenCalled(); expect(h.play).not.toHaveBeenCalled();
    target.active = true;
    expect(h.press(button)).toBe(true); expect(h.client.roll).toHaveBeenCalledTimes(1);
    expect(h.play.mock.calls).toEqual([['click']]);
  });

  it.each(['dispose', '退出仪式'] as const)('%s 后保存的按钮/昵称回调无音效、网络或节点更新副作用', exit => {
    const h = harness(), panel = h.show(seating()), root = panelNode(panel);
    const buttons = ['CeremonyRoll', ...[0, 1, 2, 3].map(i => `CeremonyPick${i}`)].map(name => at(root, name));
    const callbacks = buttons.map(b => h.callbacks.get(b)!);
    const nick = at(root, 'RollCard0/Nickname');
    const names = [MockNode.EventType.TOUCH_END, MockNode.EventType.MOUSE_ENTER].map(type => nick.handlers(type)[0]!);
    const tooltip = at(root, 'NameTooltip'), fullName = component(at(tooltip, 'FullName'), Label);
    const beforeName = fullName.string;
    if (exit === 'dispose') panel.dispose(); else h.screen.renderSeating(null, null);
    expect(panel.root.isValid).toBe(false); expect(vi.getTimerCount()).toBe(0);
    const draws = component(root, Graphics).clears;
    expect(() => {
      callbacks.forEach(end => { end(); end({ native: true }); }); names.forEach(show => show());
      panel.update(seating({ stepId: 7 }), room(), null); panel.tick(); vi.advanceTimersByTime(2500);
    }).not.toThrow();
    buttons.forEach(b => expect(h.callbacks.get(b)).toBeUndefined());
    expect(tooltip.active).toBe(false); expect(fullName.string).toBe(beforeName);
    expect(component(root, Graphics).clears).toBe(draws);
    expect(h.client.roll).not.toHaveBeenCalled(); expect(h.client.pickSeat).not.toHaveBeenCalled();
    expect(h.play).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('构建后未收到快照也能 tick，组件显式齐备且渐变绘制参数有效', () => {
    const h = harness();
    const panel = new h.CeremonyPanel(h.parent, h.net, 'ceremony-a');
    h.screen.ceremonyPanel = panel;
    expect(() => vi.advanceTimersByTime(99)).not.toThrow();
    expect(vi.getTimerCount()).toBe(1);
    expect(component(panel.root, UITransform)).toMatchObject({ width: 844, height: 390 });
    expect(panel.root.getComponent(BlockInputEvents)).not.toBeNull();
    const root = panelNode(panel);
    for (const kind of ['Roll', 'Compass']) for (let seat = 0; seat < 4; seat++) {
      expect(at(root, `${kind}Card${seat}/Highlight`).getComponent(UIOpacity)).not.toBeNull();
    }
    const strips = component(root, Graphics).calls.filter(c => c.op === 'rect');
    expect(strips).toHaveLength(330);
    expect(strips[0]!.fill).not.toEqual(strips.at(-1)!.fill);
    expect(faces(root, 'RollCard0/Dice')).toEqual([0, 0]);
    expect(die(at(root, 'RollCard0/Dice0')).size).toEqual([32, 32]);
    expect(die(at(root, 'RollCard0/OldDice0')).size).toEqual([16, 16]);
    expect(die(at(root, 'CenterDice0')).size).toEqual([40, 40]);
  });

  it.each(stages)('%s：input/rolling/result/summary 的 update 与定时 tick 不发生空组件异常', stage => {
    const h = harness();
    let uuids: string[] | undefined;
    phases.forEach((phase, index) => {
      const sv = seating({ stepId: index + 1, phase, actor: phase === 'summary' ? null : { userId: 'u0', seat: 0 },
        resultsByUserId: results, ceremonyDice: phase === 'result' ? { d1: 6, d2: 1, sum: 7 } : null,
        summaryKind: phase === 'summary' ? 'ranking' : null }, { stage, dealerSeat: 1 });
      let panel!: Panel;
      expect(() => { panel = h.show(sv, index % 2 ? null : room(), stage === 'roundBreak' ? view() : null); }).not.toThrow();
      expect(() => vi.advanceTimersByTime(330)).not.toThrow();
      const current = tree(panel.root).map(n => n.uuid);
      if (uuids) expect(current).toEqual(uuids);
      uuids = current;
      expect(vi.getTimerCount()).toBe(1);
      expect(h.client.roll).not.toHaveBeenCalled();
      expect(h.client.pickSeat).not.toHaveBeenCalled();
    });
  });

  it('四家方程使用服务端原始两骰面而非按总和反推', () => {
    const h = harness();
    const root = panelNode(h.show(seating({ phase: 'summary', actor: null, summaryKind: 'ranking', resultsByUserId: results },
      { rolls: [7, 3, 8, 10], order: [3, 2, 0, 1] })));
    const expected = [[6, 1], [1, 2], [3, 5], [4, 6]];
    ['6＋1＝7点', '1＋2＝3点', '3＋5＝8点', '4＋6＝10点'].forEach((equation, seat) => {
      expect(text(root, `RollCard${seat}/Sum`)).toBe(equation);
      expect(faces(root, `RollCard${seat}/Dice`)).toEqual(expected[seat]);
      for (const i of [0, 1]) {
        const snapshot = die(at(root, `RollCard${seat}/Dice${i}`));
        expect(snapshot.size).toEqual([32, 32]);
        expect(snapshot.angle).toBe(0);
        snapshot.circles.forEach(([x, y, radius]) => {
          expect(Math.abs(x!)).toBeLessThan(16); expect(Math.abs(y!)).toBeLessThan(16);
          expect(radius).toBeCloseTo(3.36);
        });
      }
    });
  });

  it.each(['roll', 'dealerBreak', 'roundBreak'] as const)('%s：90ms 跳点、持续角度/缩放，落定后恢复真实骰面', stage => {
    const h = harness();
    const panel = h.show(seating({ phase: 'rolling', deadline: 11_200 }, { stage, dealerSeat: 0 }), room(), view());
    const root = panelNode(panel), prefix = stage === 'roll' ? 'RollCard0/Dice' : 'CenterDice';
    expect(faces(root, prefix)).toEqual([1, 6]);
    expect(h.random).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(66);
    expect(faces(root, prefix)).toEqual([1, 6]);
    expect(h.random).toHaveBeenCalledTimes(2);
    const before = die(at(root, `${prefix}0`));
    expect(before.angle).not.toBe(0); expect(before.scale.x).not.toBe(1);
    vi.advanceTimersByTime(33);
    expect(faces(root, prefix)).toEqual([2, 5]);
    expect(h.random).toHaveBeenCalledTimes(4);
    const after = die(at(root, `${prefix}0`));
    expect(after.angle).not.toBe(before.angle);
    expect(Math.abs(after.angle)).toBeLessThanOrEqual(26);
    expect(after.scale.x).toBeGreaterThanOrEqual(0.94); expect(after.scale.x).toBeLessThanOrEqual(1.08);
    expect(after.size).toEqual(stage === 'roll' ? [32, 32] : [40, 40]);
    h.show(seating({ stepId: 2, phase: 'result', startedAt: 10_099, serverNow: 10_099, deadline: 12_099,
      resultsByUserId: { u0: results.u0! }, ceremonyDice: { d1: 6, d2: 1, sum: 7 } }, { stage, dealerSeat: 0 }), room(), view());
    expect(faces(root, prefix)).toEqual([6, 1]);
    expect(die(at(root, `${prefix}0`))).toMatchObject({ angle: 0, scale: { x: 1, y: 1, z: 1 } });
    vi.advanceTimersByTime(99);
    expect(h.random).toHaveBeenCalledTimes(4);
    if (stage === 'roll') {
      expect(at(root, 'RollCard0').scale.x).toBeGreaterThan(1);
      vi.advanceTimersByTime(132); expect(at(root, 'RollCard0').scale.x).toBe(1);
    }
  });

  it('骰子关键帧逐点还原原型，两枚骰子同相位且CSS旋转方向正确转换', () => {
    const h = harness();
    const panel = h.show(seating({ stepId: 2, phase: 'rolling', deadline: 11_200 }));
    const root = panelNode(panel);
    for (const [ms, angle, scale] of [[0, 24, 1], [50, 10.4, 1.032], [125, -10, 1.08], [250, -26, 1], [375, 8, 0.94], [500, 24, 1]]) {
      vi.setSystemTime(ms!); panel.tick();
      for (let i = 0; i < 2; i++) {
        const d = die(at(root, `RollCard0/Dice${i}`));
        expect(d.angle).toBeCloseTo(angle!); expect(d.scale.x).toBeCloseTo(scale!); expect(d.scale.y).toBeCloseTo(scale!);
      }
    }
  });

  it('首输入250ms按CSS ease淡入，相同步骤不重播，中途重入直接显示', () => {
    const h = harness(), panel = h.show(seating());
    const opacity = component(panel.root, UIOpacity);
    expect(opacity.opacity).toBe(0);
    vi.advanceTimersByTime(125); panel.tick();
    expect(opacity.opacity).toBeCloseTo(205, 0);
    const previous = opacity.opacity;
    h.show(seating({ serverNow: 10_125 }));
    expect(opacity.opacity).toBe(previous);
    vi.advanceTimersByTime(125); panel.tick(); expect(opacity.opacity).toBe(255);
    h.show(seating({ stepId: 2, phase: 'rolling', startedAt: 10_250, serverNow: 10_250, deadline: 11_450 }));
    expect(opacity.opacity).toBe(255);
    h.screen.hideSeating();
    const resumed = h.show(seating({ ceremonyId: 'resumed-first-input', serverNow: 11_000 }));
    expect(component(resumed.root, UIOpacity).opacity).toBe(255);
  });

  it.each(stages.flatMap(stage => ['touch', 'hover'].map(activation => ({ stage, activation }))))(
    '$stage/$activation：长昵称显示完整 raw，2s 到点隐藏，移开/点击提示/换步亦隐藏', ({ stage, activation }) => {
      const h = harness(), r = room(), v = view(), raw = '  超长昵称甲乙丙丁戊己庚辛壬癸ABCDEFGHIJKLMN  ';
      r.seats[0]!.nickname = raw; r.seats[1]!.nickname = raw;
      v.names[0] = raw; v.names[1] = raw;
      if (stage === 'roundBreak') r.seats[0]!.nickname = '不应优先使用房间昵称';
      const sv = seating({}, { stage }), panel = h.show(sv, r, v), root = panelNode(panel);
      const prefix = stage === 'dealerBreak' || stage === 'roundBreak' ? 'Compass' : 'Roll';
      const nick = at(root, `${prefix}Card0/Nickname`), other = at(root, `${prefix}Card1/Nickname`);
      const tooltip = at(root, 'NameTooltip');
      expect(component(nick, Label).string).toBe(raw.slice(0, 10) + '…'); expect(tooltip.active).toBe(false);
      const type = activation === 'touch' ? MockNode.EventType.TOUCH_END : MockNode.EventType.MOUSE_ENTER;
      nick.emit(type, {});
      expect(tooltip.active).toBe(true); expect(text(tooltip, 'FullName')).toBe(`东座 · ${raw}`);
      vi.advanceTimersByTime(1999); panel.tick(); expect(tooltip.active).toBe(true);
      h.show(structuredClone(sv), r, v); expect(tooltip.active).toBe(true);
      vi.advanceTimersByTime(1); panel.tick(); expect(tooltip.active).toBe(false);
      other.emit(type, {}); expect(text(tooltip, 'FullName')).toBe(`南座 · ${raw}`);
      expect(tooltip.active).toBe(true);
      other.emit(MockNode.EventType.MOUSE_LEAVE, {}); expect(tooltip.active).toBe(false);
      nick.emit(type, {}); tooltip.emit(MockNode.EventType.TOUCH_END, {}); expect(tooltip.active).toBe(false);
      nick.emit(type, {}); expect(tooltip.active).toBe(true);
      h.show(seating({ stepId: 2 }, { stage }), r, v); expect(tooltip.active).toBe(false);
      expect(h.client.roll).not.toHaveBeenCalled(); expect(h.client.pickSeat).not.toHaveBeenCalled();
      expect(h.play).not.toHaveBeenCalled();
    });

  it.each([0, 1, 2, 3])('选座 summary：选定 %s 座仍金色，四按钮均可见禁用且不可重复发送', picked => {
    const h = harness(), panel = h.show(seating({}, { stage: 'pick', picker: 0 })), root = panelNode(panel);
    const buttons = [0, 1, 2, 3].map(i => at(root, `CeremonyPick${i}`));
    expect(h.press(buttons[picked]!)).toBe(true);
    h.show(seating({ stepId: 2, phase: 'summary', actor: null, summaryKind: 'seated', resultsByUserId: results },
      { stage: 'pick', picked, picker: picked, order: [picked, (picked + 1) % 4, (picked + 2) % 4, (picked + 3) % 4] }));
    vi.advanceTimersByTime(330);
    buttons.forEach((button, seat) => {
      expect(button.active).toBe(true); expect(h.enabled.get(button)).toBe(false);
      expect(component(button, UIOpacity).opacity).toBe(115);
      const outline = component(button, Graphics).calls.find(c => c.op === 'roundRect')!;
      expect(outline.args).toEqual([-27, -13.5, 54, 27, 8]);
      expect(outline.fill).toEqual(seat === picked ? [212, 165, 55, 46] : [0, 0, 0, 77]);
      expect(outline.stroke).toEqual(seat === picked ? [212, 165, 55, 255] : [212, 165, 55, 77]);
      expect(component(at(button, 'Label'), Label).color).toEqual(seat === picked ? new Color(232, 199, 107) : new Color(184, 160, 120));
      expect(h.press(button)).toBe(false); h.callbacks.get(button)!();
    });
    expect(at(root, 'CeremonyRoll').active).toBe(false);
    expect(h.client.pickSeat.mock.calls).toEqual([[picked, { ceremonyId: 'ceremony-a', stepId: 1 }]]);
    expect(h.client.roll).not.toHaveBeenCalled(); expect(h.play.mock.calls).toEqual([['click']]);
  });

  it.each(stages)('%s：各 phase 主钮文案/可用态正确，74px 时钟在面板内且与按钮不重叠', stage => {
    const h = harness(); let stepId = 0;
    const durations = { input: 10_000, rolling: 1200, result: 2000, summary: 2400 };
    const prefixes = { input: '剩余', rolling: '滚动', result: '展示', summary: '汇总' };
    for (const phase of phases) for (const mine of [true, false]) {
      const root = panelNode(h.show(seating({ stepId: ++stepId, phase, deadline: 10_000 + durations[phase],
        actor: phase === 'summary' ? null : { userId: mine ? 'u0' : 'u1', seat: mine ? 0 : 1 } }, { stage })));
      const roll = at(root, 'CeremonyRoll'), clock = at(root, 'CeremonyClock');
      const expected = phase === 'input' ? mine ? '掷骰' : '等待当前玩家' : phase === 'rolling' ? '掷骰中…'
        : phase === 'result' ? stage === 'dealerBreak' || stage === 'roundBreak' ? '即将自动发牌' : '查看结果' : '仪式进行中…';
      expect(text(roll, 'Label')).toBe(expected); expect(roll.active).toBe(stage !== 'pick');
      expect(h.enabled.get(roll)).toBe(phase === 'input' && mine);
      const picks = [0, 1, 2, 3].map(i => at(root, `CeremonyPick${i}`));
      picks.forEach((b, seat) => {
        expect(text(b, 'Label')).toBe(['东', '南', '西', '北'][seat]);
        expect(b.active).toBe(stage === 'pick'); expect(h.enabled.get(b)).toBe(phase === 'input' && mine);
      });
      expect(text(root, 'CeremonyClock')).toBe(`${prefixes[phase]} ${(durations[phase] / 1000).toFixed(1)}s`);
      const tf = component(clock, UITransform);
      expect(tf.width).toBe(74); expect(clock.position).toEqual({ x: stage === 'pick' ? 150 : 89, y: -139.5, z: 0 });
      const clockLeft = clock.position.x - tf.width / 2;
      for (const b of stage === 'pick' ? picks : [roll]) {
        const bt = component(b, UITransform);
        expect(b.position.x + bt.width / 2).toBeLessThan(clockLeft);
        expect(b.position.x - bt.width / 2).toBeGreaterThanOrEqual(-320);
        expect(b.position.y - bt.height / 2).toBeGreaterThanOrEqual(-165);
        expect(b.position.y + bt.height / 2).toBeLessThanOrEqual(165);
      }
      expect(clockLeft).toBeGreaterThanOrEqual(-320); expect(clock.position.x + tf.width / 2).toBeLessThanOrEqual(320);
      expect(clock.position.y - tf.height / 2).toBeGreaterThanOrEqual(-165);
      expect(clock.position.y + tf.height / 2).toBeLessThanOrEqual(165);
    }
  });

  it.each(['roll', 'pick'].flatMap(stage => [99, 100, 101].map(ms => ({ stage: stage as 'roll' | 'pick', ms }))))(
    '$stage：截止前/截止点/截止后 $ms ms，只有严格早于 deadline 的真实手势可提交并响一次', ({ stage, ms }) => {
      const h = harness(), panel = h.show(seating({ deadline: 10_100 }, { stage })), root = panelNode(panel);
      const button = at(root, stage === 'pick' ? 'CeremonyPick0' : 'CeremonyRoll');
      button.emit(MockNode.EventType.TOUCH_START, {}); vi.setSystemTime(ms);
      button.emit(MockNode.EventType.TOUCH_END, {}); panel.tick();
      expect(stage === 'pick' ? h.client.pickSeat : h.client.roll).toHaveBeenCalledTimes(ms < 100 ? 1 : 0);
      expect(h.play.mock.calls).toEqual(ms < 100 ? [['click']] : []);
      expect(h.enabled.get(button)).toBe(false);
      expect(text(root, 'CeremonyClock')).toBe(ms < 100 ? '剩余 0.0s' : '等待同步…');
    });

  it.each(['roll', 'pick'] as const)('%s：待掷/滚动 sum 为 10px 弱色常规字，结果恢复 13px 金色粗体', stage => {
    const h = harness(), root = panelNode(h.show(seating({}, { stage })));
    const pending = component(at(root, 'RollCard0/Sum'), Label);
    const weak = { fontSize: 10, isBold: false, lineHeight: 20, color: new Color(122, 106, 82) };
    expect(pending).toMatchObject({ ...weak, string: '待掷' });
    h.show(seating({ stepId: 2, phase: 'rolling', resultsByUserId: { u0: results.u0!, u1: results.u1! } }, { stage }));
    expect(pending).toMatchObject({ ...weak, string: '掷骰中…' });
    expect(component(at(root, 'RollCard2/Sum'), Label)).toMatchObject({ ...weak, string: '待掷' });
    const settled = { fontSize: 13, isBold: true, lineHeight: 20, color: new Color(232, 199, 107) };
    expect(component(at(root, 'RollCard1/Sum'), Label)).toMatchObject({ ...settled, string: '1＋2＝3点' });
    h.show(seating({ stepId: 3, phase: 'result', resultsByUserId: { u0: results.u0! } }, { stage }));
    expect(pending).toMatchObject({ ...settled, string: '6＋1＝7点' });
  });

  it.each(stages)('%s：自己的 input 提示为金色粗体，1s ease-in-out 脉冲，换人或滚动即恢复', stage => {
    const h = harness(), panel = h.show(seating({}, { stage })), root = panelNode(panel);
    const hint = component(at(root, 'CeremonyHint'), Label), opacity = component(hint.node, UIOpacity);
    expect(hint.color).toEqual(new Color(232, 199, 107)); expect(hint.isBold).toBe(true);
    expect(hint.string).toContain('轮到你了');
    // 独立采样 CSS cubic-bezier(.42,0,.58,1)，不调用生产 ease 计算期望值。
    for (const [ms, alpha] of [[0, 255], [125, 240], [250, 198], [375, 155], [500, 140], [625, 155], [750, 198], [875, 240], [1000, 255], [1125, 240]] as const) {
      vi.setSystemTime(ms); panel.tick(); expect(opacity.opacity).toBe(alpha);
    }
    for (const [i, phase] of ['input', 'rolling'].entries()) {
      h.show(seating({ stepId: i + 2, phase: phase as 'input' | 'rolling', actor: { userId: i ? 'u0' : 'u1', seat: i ? 0 : 1 } }, { stage }));
      expect(hint.color).toEqual(new Color(184, 160, 120)); expect(hint.isBold).toBe(false);
      vi.advanceTimersByTime(250); panel.tick(); expect(opacity.opacity).toBe(255);
    }
  });

  it('落定按两段 CSS ease 在 90ms 达到 1.03 峰值、200ms 归一，不影响其他卡片或骰面', () => {
    const h = harness(), panel = h.show(seating({ phase: 'result', resultsByUserId: results })), root = panelNode(panel);
    const before = faces(root, 'RollCard0/Dice');
    for (const [ms, scale] of [[0, 1], [45, 1.0240721], [90, 1.03], [145, 1.0059279], [200, 1], [300, 1]] as const) {
      vi.setSystemTime(ms); panel.tick();
      expect(at(root, 'RollCard0').scale.x).toBeCloseTo(scale, 6);
      expect(at(root, 'RollCard0').scale.y).toBeCloseTo(scale, 6);
      for (const seat of [1, 2, 3]) expect(at(root, `RollCard${seat}`).scale).toEqual({ x: 1, y: 1, z: 1 });
      expect(faces(root, 'RollCard0/Dice')).toEqual(before);
    }
    expect(h.random).not.toHaveBeenCalled();
  });

  it.each(['dealerBreak', 'roundBreak'] as const)('%s：庄家外发光 0/500/1000ms 为 blur14/24/14，描边半径按 CSS ease 变化', stage => {
    const h = harness(), panel = h.show(seating({ phase: 'result', ceremonyDice: { d1: 6, d2: 1, sum: 7 } }, { stage, dealerSeat: 1 }));
    const root = panelNode(panel), other = component(at(root, 'CompassCard2/Glow'), Graphics);
    expect(other.calls).toEqual([]);
    for (const [ms, blur] of [[0, 14], [125, 18.085106], [250, 22.024034], [500, 24], [750, 15.975966], [1000, 14], [1250, 14]] as const) {
      vi.setSystemTime(ms); panel.tick(); expectDealerGlow(root, 1, blur); expect(other.calls).toEqual([]);
    }
    h.show(seating({ stepId: 2, phase: 'input' }, { stage, dealerSeat: 1 }));
    expect(component(at(root, 'CompassCard1/Glow'), Graphics).calls).toEqual([]);
  });

  it.each(['dealerBreak', 'roundBreak'] as const)('%s：四风徽章 (55,21) 与庄徽 (76,-16) 的实际绘制边界不叠且不越面板', stage => {
    const h = harness();
    for (let seat = 0; seat < 4; seat++) {
      const root = panelNode(h.show(seating({ stepId: seat + 1, phase: 'result', ceremonyDice: { d1: 6, d2: 1, sum: 7 } }, { stage, dealerSeat: seat })));
      const card = at(root, `CompassCard${seat}`), wind = at(card, 'WindBadge'), dealer = at(card, 'DealerBadge');
      expect(wind.position).toEqual({ x: 55, y: 21, z: 0 }); expect(dealer.position).toEqual({ x: 76, y: -16, z: 0 });
      expect(wind.activeInHierarchy).toBe(true); expect(dealer.activeInHierarchy).toBe(true);
      expect(text(wind, 'Wind')).toBe(['东', '南', '西', '北'][seat]); expect(text(dealer, 'BadgeText')).toBe('庄家');
      const circle = component(wind, Graphics).calls.find(c => c.op === 'circle')!;
      const rect = component(dealer, Graphics).calls.find(c => c.op === 'roundRect')!;
      expect(circle.args).toEqual([0, 0, 10]); expect(rect.args).toEqual([-17, -7, 34, 14, 4]);
      const radius = circle.args[2]! + circle.lineWidth / 2, halfStroke = rect.lineWidth / 2;
      const wb = { left: wind.position.x - radius, right: wind.position.x + radius, bottom: wind.position.y - radius, top: wind.position.y + radius };
      const db = { left: dealer.position.x + rect.args[0]! - halfStroke, right: dealer.position.x + rect.args[0]! + rect.args[2]! + halfStroke,
        bottom: dealer.position.y + rect.args[1]! - halfStroke, top: dealer.position.y + rect.args[1]! + rect.args[3]! + halfStroke };
      expect(wb).toEqual({ left: 44.5, right: 65.5, bottom: 10.5, top: 31.5 });
      expect(db).toEqual({ left: 58.5, right: 93.5, bottom: -23.5, top: -8.5 });
      expect(db.top).toBeLessThan(wb.bottom);
      for (const b of [wb, db]) {
        expect(card.position.x + b.left).toBeGreaterThanOrEqual(-320); expect(card.position.x + b.right).toBeLessThanOrEqual(320);
        expect(card.position.y + b.bottom).toBeGreaterThanOrEqual(-165); expect(card.position.y + b.top).toBeLessThanOrEqual(165);
      }
    }
  });

  it('同名机器人在提示、排名及定庄结果中使用当前风位区分', () => {
    const h = harness(), r = room();
    for (const member of r.seats.slice(1)) { member!.nickname = '机器人'; member!.isBot = true; }
    const panel = h.show(seating({ actor: { userId: 'u2', seat: 2 } }), r), root = panelNode(panel);
    expect(text(root, 'CeremonyHint')).toContain('等待 机器人（西）');
    h.show(seating({ stepId: 2, phase: 'summary', actor: null, resultsByUserId: results }, { order: [3, 2, 0, 1] }), r);
    for (const wind of ['南', '西', '北']) expect(text(root, 'CeremonyInfo')).toContain(`机器人（${wind}）`);
    expect(text(root, 'CeremonyInfo')).toContain('阿甲（我）');
    expect(text(root, 'RollCard1/Nickname')).toBe('机器人');
    h.show(seating({ stepId: 3, phase: 'result', ceremonyDice: { d1: 4, d2: 3, sum: 7 } }, { stage: 'dealerBreak', dealerSeat: 1, picker: 2 }), r);
    expect(text(root, 'CeremonyHint')).toBe('机器人（南）坐庄 · 机器人（西）上1子 + 机器人（南）上庄1子');
  });

  it('下一家等待、滚动及落定期间，前序结果和骰面始终保留', () => {
    const h = harness();
    const root = panelNode(h.show(seating({ phase: 'result', resultsByUserId: { u0: results.u0! } })));
    const previous = [0, 1].map(i => die(at(root, `RollCard0/Dice${i}`)));
    for (const [index, phase] of ['input', 'rolling', 'result'].entries()) {
      h.show(seating({ stepId: index + 2, phase: phase as CeremonyPresentation['phase'], actor: { userId: 'u1', seat: 1 },
        resultsByUserId: phase === 'result' ? { u0: results.u0!, u1: results.u1! } : { u0: results.u0! } }));
      vi.advanceTimersByTime(99);
      expect(text(root, 'RollCard0/Sum')).toBe('6＋1＝7点');
      expect([0, 1].map(i => die(at(root, `RollCard0/Dice${i}`)))).toEqual(previous);
    }
    expect(text(root, 'RollCard1/Sum')).toBe('1＋2＝3点');
  });

  it.each(stages)('%s：当前用户每个 step 仅发一次准确 token，重复广播/排队点击不能重发', stage => {
    const h = harness();
    const sv = seating({}, { stage });
    const root = panelNode(h.show(sv));
    const button = at(root, stage === 'pick' ? 'CeremonyPick2' : 'CeremonyRoll');
    const send = stage === 'pick' ? h.client.pickSeat : h.client.roll;
    const args = (stepId: number) => stage === 'pick' ? [2, { ceremonyId: 'ceremony-a', stepId }] : [{ ceremonyId: 'ceremony-a', stepId }];
    expect(h.enabled.get(button)).toBe(true);
    expect(h.press(button)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledWith(...args(1));
    expect(h.play.mock.calls).toEqual([['click']]);
    expect(h.play.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(h.enabled.get(button)).toBe(false);
    h.callbacks.get(button)!(); // 绕过按钮禁用，模拟已排队的第二次回调。
    h.show(structuredClone(sv)); h.callbacks.get(button)!();
    expect(h.press(button)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1); expect(h.play).toHaveBeenCalledTimes(1);
    expect(stage === 'pick' ? h.client.roll : h.client.pickSeat).not.toHaveBeenCalled();
    h.show(seating({ stepId: 2 }, { stage }));
    expect(h.press(button)).toBe(true);
    expect(send).toHaveBeenLastCalledWith(...args(2)); expect(send).toHaveBeenCalledTimes(2);
    expect(h.play.mock.calls).toEqual([['click'], ['click']]);
  });

  it.each(stages)('%s：其他人不可操作，包括直接触发已保存的按钮回调', stage => {
    const h = harness();
    const root = panelNode(h.show(seating({ actor: { userId: 'u1', seat: 1 } }, { stage })));
    expect(at(root, 'CeremonyRoll').active).toBe(stage !== 'pick');
    for (let seat = 0; seat < 4; seat++) expect(at(root, `CeremonyPick${seat}`).active).toBe(stage === 'pick');
    for (const name of ['CeremonyRoll', 'CeremonyPick0', 'CeremonyPick1', 'CeremonyPick2', 'CeremonyPick3']) {
      const button = at(root, name);
      expect(h.enabled.get(button)).toBe(false); expect(h.press(button)).toBe(false);
      h.callbacks.get(button)!();
    }
    expect(h.client.roll).not.toHaveBeenCalled(); expect(h.client.pickSeat).not.toHaveBeenCalled();
    expect(h.play).not.toHaveBeenCalled();
  });

  it('超时或非 input 阶段即使回调被直接触发也不提交、不自行推进步骤', () => {
    const h = harness();
    const root = panelNode(h.show(seating({ deadline: 10_100 })));
    vi.advanceTimersByTime(132);
    expect(text(root, 'CeremonyClock')).toBe('等待同步…');
    for (const phase of phases) {
      h.show(seating({ stepId: phases.indexOf(phase) + 2, phase, deadline: phase === 'input' ? 10_100 : 20_000 }));
      for (const name of ['CeremonyRoll', 'CeremonyPick0']) h.callbacks.get(at(root, name))!();
    }
    expect(h.client.roll).not.toHaveBeenCalled(); expect(h.client.pickSeat).not.toHaveBeenCalled();
    expect(h.play).not.toHaveBeenCalled();
  });

  it('重复 step 保留整树 uuid、滚动帧及 interval；旧 step 完全忽略', () => {
    const h = harness();
    const sv = seating({ stepId: 8, phase: 'rolling', deadline: 11_200 });
    const panel = h.show(sv), root = panelNode(panel), ids = tree(panel.root).map(n => n.uuid);
    vi.advanceTimersByTime(99);
    expect(h.show(structuredClone(sv))).toBe(panel);
    expect(tree(panel.root).map(n => n.uuid)).toEqual(ids);
    expect(h.random).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(1);
    const latest = { clock: text(root, 'CeremonyClock'), stage: text(root, 'CeremonyStage'),
      dice: [0, 1].map(i => die(at(root, `RollCard0/Dice${i}`))), sample: { ...h.net.ceremonyClock } };
    h.show(seating({ stepId: 7, phase: 'input', serverNow: 90_000 }, { stage: 'pick' }));
    expect({ clock: text(root, 'CeremonyClock'), stage: text(root, 'CeremonyStage'),
      dice: [0, 1].map(i => die(at(root, `RollCard0/Dice${i}`))), sample: { ...h.net.ceremonyClock } }).toEqual(latest);
    expect(tree(panel.root).map(n => n.uuid)).toEqual(ids);
    expect(h.screen.ceremonyPanel).toBe(panel); expect(h.stopAllByTarget).not.toHaveBeenCalled();
  });

  it('只有新 ceremonyId 才替换面板，退出仪式清空，非 table 页面不构建', () => {
    const h = harness();
    const first = h.show(seating({ stepId: 9 }));
    const second = h.show(seating({ ceremonyId: 'ceremony-b', stepId: 1 }));
    expect(second).not.toBe(first); expect(first.root.isValid).toBe(false);
    expect(h.parent.children).toEqual([second.root]); expect(vi.getTimerCount()).toBe(1);
    expect(h.stopAllByTarget).toHaveBeenCalledTimes(1);
    h.screen.renderSeating(null, null);
    expect(h.screen.ceremonyPanel).toBeNull(); expect(h.parent.children).toEqual([]); expect(vi.getTimerCount()).toBe(0);
    h.screen.router.currentName = 'lobby'; h.screen.renderSeating(seating(), room());
    expect(h.screen.ceremonyPanel).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });

  it('同点重掷保留两枚 16px old 骰面，徽章闪烁且非重掷者不受影响', () => {
    const h = harness();
    const tied = { ...results, u1: { d1: 2, d2: 5, sum: 7, rerollRound: 0 } };
    const fields = { reroll: [true, true, false, false], rolls: [7, 7, 8, 10] };
    const root = panelNode(h.show(seating({ phase: 'summary', summaryKind: 'reroll', actor: null, resultsByUserId: tied }, fields)));
    const old = [0, 1].map(i => die(at(root, `RollCard0/OldDice${i}`)));
    expect(old.map(d => d.pips)).toEqual([6, 1]); old.forEach(d => expect(d.size).toEqual([16, 16]));
    expect(text(root, 'RollCard0/PreviousResult')).toContain('7点');
    expect(text(root, 'RollCard0/RerollBadge/BadgeText')).toBe('同点重掷');
    expect(at(root, 'RollCard0/RerollBadge').active).toBe(true);
    h.show(seating({ stepId: 2, phase: 'rolling', rerollRound: 1, resultsByUserId: tied }, fields));
    vi.advanceTimersByTime(330);
    expect(text(root, 'RollCard0/Sum')).toBe('掷骰中…');
    expect([0, 1].map(i => die(at(root, `RollCard0/OldDice${i}`)))).toEqual(old);
    expect(component(at(root, 'RollCard0/RerollBadge'), UIOpacity).opacity).toBe(64);
    expect(faces(root, 'RollCard1/Dice')).toEqual([2, 5]);
    expect(at(root, 'RollCard1/OldDice0').active).toBe(true);
    expect(at(root, 'RollCard2/OldDice0').active).toBe(false);
    expect(at(root, 'RollCard2/RerollBadge').active).toBe(false);
    vi.advanceTimersByTime(297);
    expect(component(at(root, 'RollCard0/RerollBadge'), UIOpacity).opacity).toBe(255);
    h.show(seating({ stepId: 3, phase: 'result', rerollRound: 1,
      resultsByUserId: { ...tied, u0: { d1: 1, d2: 1, sum: 2, rerollRound: 1 } } }, { reroll: [false, true, false, false] }));
    expect(faces(root, 'RollCard0/Dice')).toEqual([1, 1]);
    expect(at(root, 'RollCard0/OldDice0').active).toBe(false); expect(at(root, 'RollCard0/RerollBadge').active).toBe(false);
  });

  it('选座重排按稳定 userId 绑定结果；同昵称不混淆“我”、机器人和离线/托管标记', () => {
    const h = harness(), r = room();
    r.seats[0]!.nickname = '同名'; r.seats[2]!.nickname = '同名';
    const panel = h.show(seating({ phase: 'summary', resultsByUserId: results }), r);
    const root = panelNode(panel), ids = tree(panel.root).map(n => n.uuid);
    const reordered = { ...r, seats: [2, 0, 3, 1].map((old, seat) => ({ ...r.seats[old]!, seat })) };
    h.show(seating({ stepId: 2, phase: 'summary', actor: null, summaryKind: 'seated', resultsByUserId: results },
      { stage: 'pick', picked: 2, picker: 2, order: [2, 0, 1, 3] }), reordered);
    expect(tree(panel.root).map(n => n.uuid)).toEqual(ids);
    [[3, 5], [6, 1], [4, 6], [1, 2]].forEach((expected, seat) => {
      expect(faces(root, `RollCard${seat}/Dice`)).toEqual(expected);
      expect(at(root, `RollCard${seat}/MineBadge`).active).toBe(seat === 1);
      expect(text(root, `RollCard${seat}/Nickname`)).toBe(reordered.seats[seat]!.nickname);
    });
    expect(text(root, 'RollCard1/MineBadge/MineText')).toBe('我');
    expect(text(root, 'RollCard0/Identity')).toBe('东座 · 真人 · 离线');
    expect(text(root, 'RollCard2/Identity')).toBe('西座 · 真人 · 托管');
    expect(text(root, 'RollCard3/Identity')).toBe('北座 · 机器人');
  });

  it('局间沿用庄家与子数，使用 gameView 的昵称和“我”，庄徽章/高亮环可安全 tick', () => {
    const h = harness(), v = view();
    const sv = seating({ phase: 'result', actor: { userId: 'u1', seat: 1 }, ceremonyDice: { d1: 4, d2: 6, sum: 10 } },
      { stage: 'roundBreak', dealerSeat: 1, roller: 1, ziCounts: [0, 5, 2, 1] });
    const original = structuredClone(sv);
    const panel = h.show(sv, null, v), root = panelNode(panel);
    expect(text(root, 'CeremonyTitle')).toBe('局间定摸牌位');
    expect(text(root, 'CeremonyHint')).toBe('局间乙坐庄 · 本次仅定摸牌位，不额外加子');
    expect(text(root, 'CenterSum')).toBe('4＋6＝10点'); expect(faces(root, 'CenterDice')).toEqual([4, 6]);
    for (let seat = 0; seat < 4; seat++) {
      expect(text(root, `CompassCard${seat}/Nickname`)).toBe(v.names[seat]);
      expect(at(root, `CompassCard${seat}/MineBadge`).active).toBe(seat === 2);
      expect(at(root, `CompassCard${seat}/DealerBadge`).active).toBe(seat === 1);
      expect(at(root, `RollCard${seat}`).active).toBe(false);
    }
    expect(text(root, 'CompassCard1/DealerBadge/BadgeText')).toBe('庄家');
    expect(text(root, 'CompassCard1/CardStatus')).toBe('庄家 · 子 5 · 当前操作');
    for (const [ms, blur] of [[0, 14], [500, 24], [1000, 14]] as const) {
      vi.setSystemTime(ms); panel.tick(); expectDealerGlow(root, 1, blur);
    }
    expect(sv).toEqual(original);
  });

  it.each([{ d1: 1, d2: 1, sum: 2 }, { d1: 6, d2: 1, sum: 7 }, { d1: 6, d2: 6, sum: 12 }])(
    '物理牌墙 N=$sum：18 组中仅右端第 N+1 组为开牌点', dice => {
      const h = harness();
      const root = panelNode(h.show(seating({ phase: 'result', ceremonyDice: dice }, { stage: 'dealerBreak', dealerSeat: 2 }), room('physical')));
      const stacks = component(at(root, 'WallStrip'), Graphics).calls.filter(c => c.op === 'roundRect');
      expect(stacks).toHaveLength(18);
      const marked = stacks.filter(c => c.lineWidth === 2);
      expect(marked).toHaveLength(1);
      const fromRight = [...stacks].sort((a, b) => b.args[0]! - a.args[0]!);
      expect(fromRight.indexOf(marked[0]!) + 1).toBe(dice.sum + 1);
      expect(text(root, 'CeremonyDetail')).toBe(`阿丙门前 · 右端跳${dice.sum}组（${dice.sum * 2}张）· 第${dice.sum + 1}组开摸 ← 从右向左`);
      expect(at(root, 'CeremonyInfo').active).toBe(false);
    });

  it('缺少房间设置时使用真实 wallInfo；随机墙明确清除旧物理位置，不虚构开牌点', () => {
    const h = harness(), v = view();
    v.wallInfo = { rows: [], breakSeat: 1, breakGroups: 7 };
    const sv = seating({ phase: 'result', ceremonyDice: { d1: 6, d2: 1, sum: 7 } }, { stage: 'roundBreak', dealerSeat: 1 });
    const root = panelNode(h.show(sv, null, v));
    expect(component(at(root, 'WallStrip'), Graphics).calls.filter(c => c.op === 'roundRect')).toHaveLength(18);
    h.show(seating({ ...sv.presentation, stepId: 2 }, { stage: 'roundBreak', dealerSeat: 1 }), room('random'), v);
    expect(component(at(root, 'WallStrip'), Graphics).calls).toEqual([]);
    expect(at(root, 'CeremonyInfo').active).toBe(true);
    expect(text(root, 'CeremonyInfo')).toBe('随机牌墙 · 不展示物理开牌位置');
    expect(text(root, 'CeremonyDetail')).toBe('');
    h.show(seating({ stepId: 3 }, { stage: 'dealerBreak' }), room('physical'));
    expect(component(at(root, 'WallStrip'), Graphics).calls).toEqual([]);
    expect(text(root, 'CeremonyInfo')).toBe('落定后展示庄家门前牌墙开摸位置');
  });

  it('隐藏父节点时暂停节点更新；dispose 清 interval、停止 tween 并销毁整树', () => {
    const h = harness();
    const panel = h.show(seating({ phase: 'rolling', deadline: 11_200 }));
    const nodes = tree(panel.root), target = panelNode(panel);
    h.parent.active = false;
    vi.advanceTimersByTime(330); expect(h.random).toHaveBeenCalledTimes(2);
    h.parent.active = true;
    vi.advanceTimersByTime(33); expect(h.random).toHaveBeenCalledTimes(4);
    expect(text(target, 'CeremonyClock')).toBe('滚动 0.8s');
    expect(vi.getTimerCount()).toBe(1);
    panel.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.stopAllByTarget).toHaveBeenCalledTimes(1); expect(h.stopAllByTarget).toHaveBeenCalledWith(target);
    expect(nodes.every(n => !n.isValid)).toBe(true); expect(h.parent.children).toEqual([]);
    expect(() => { panel.tick(); vi.advanceTimersByTime(5000); }).not.toThrow();
    expect(h.random).toHaveBeenCalledTimes(4);
  });

  it.each([
    { phase: 'input', total: 10_000, prefix: '剩余' }, { phase: 'rolling', total: 1200, prefix: '滚动' },
    { phase: 'result', total: 2000, prefix: '展示' }, { phase: 'summary', total: 2400, prefix: '汇总' },
  ] as const)('$phase：晚订阅/恢复只展示余时，重复旧快照不重启时钟，不补播已错过阶段', ({ phase, total, prefix }) => {
    const h = harness();
    const sv = seating({ stepId: 20, phase, startedAt: 10_000, deadline: 10_000 + total,
      serverNow: 10_000 + total - 900, resultsByUserId: results });
    h.net.sampleCeremony(sv.presentation); // 真实网络采样先发生，页面晚 300ms 才订阅。
    vi.advanceTimersByTime(300);
    const panel = h.show(sv), root = panelNode(panel), ids = tree(panel.root).map(n => n.uuid);
    expect(text(root, 'CeremonyClock')).toBe(`${prefix} 0.6s`);
    const progress = component(at(root, 'CeremonyProgress'), Graphics).calls.find(c => c.op === 'rect');
    expect(progress!.args[2]).toBeCloseTo(520 * 600 / total);
    expect(text(root, 'RollCard1/Sum')).toBe('1＋2＝3点');
    vi.advanceTimersByTime(330);
    h.show(structuredClone(sv));
    expect(text(root, 'CeremonyClock')).toBe(`${prefix} 0.3s`);
    expect(tree(panel.root).map(n => n.uuid)).toEqual(ids);
    vi.advanceTimersByTime(330);
    expect(text(root, 'CeremonyClock')).toBe('等待同步…');
    expect(component(at(root, 'CeremonyProgress'), Graphics).calls.some(c => c.op === 'rect')).toBe(false);
    expect(h.enabled.get(at(root, 'CeremonyRoll'))).toBe(false);
    expect(h.client.roll).not.toHaveBeenCalled(); expect(h.client.pickSeat).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('旧仪式 renderer：AST 抽取真实方法，仅验证总点数语义，不代表 Browser/GPU 验收', () => {
  function expectNoDice(h: ReturnType<typeof harness>, root: MockNode): void {
    expect(h.dicePair).not.toHaveBeenCalled(); expect(h.screen.drawClassicDie).not.toHaveBeenCalled();
    expect(tree(root).filter(n => /^(Die|Dice|CenterDice|OldDice)/.test(n.name))).toEqual([]);
    expect(tree(root).flatMap(n => n.getComponent(Graphics)?.calls ?? []).filter(c => c.op === 'circle')).toEqual([]);
    expect(h.random).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  }

  it.each(['renderRollPick', 'renderCompass'])('%s 的 AST 无 dicePair 或 drawClassicDie 引用，未以拆分总和伪造终值', name => {
    const cls = productionClass(tableSource, 'TableScreen');
    const method = cls.members.find(n => n.name?.getText(tableSource) === name)!;
    const forbidden: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isIdentifier(node) && ['dicePair', 'drawClassicDie'].includes(node.text)) forbidden.push(node.text);
      ts.forEachChild(node, visit);
    }
    visit(method); expect(forbidden).toEqual([]);
  });

  it.each(['roll', 'pick'] as const)('%s：旧横排仅显示 2/7/12 总点数及待掷文案，无骰面节点或绘制调用', stage => {
    const h = harness(); vi.spyOn(h.screen, 'drawClassicDie');
    // 总点数区域独立于排名/庄徽装饰；不放宽重复组件及缺失组件检查。
    const sv = seating({}, { stage, rolls: [2, 7, 12, null], reroll: [false, false, false, true] });
    delete sv.presentation;
    const root = h.legacy(sv);
    for (const [seat, sum] of [2, 7, 12].entries()) {
      const labels = tree(at(root, `PCard${seat}`)).flatMap(n => n.getComponent(Label)?.string ?? []);
      expect(labels).toContain(String(sum)); expect(labels).toContain('旧版仅提供总点数');
      expect(labels.some(s => /[＋＝]/.test(s))).toBe(false);
    }
    const pending = tree(at(root, 'PCard3')).flatMap(n => n.getComponent(Label)?.string ?? []);
    expect(pending).toContain('待重掷'); expect(pending).not.toContain('旧版仅提供总点数');
    expectNoDice(h, root);
  });

  it.each(['dealerBreak', 'roundBreak'].flatMap(stage => [null, 2, 7, 12].map(sum => ({ stage: stage as 'dealerBreak' | 'roundBreak', sum }))))(
    '$stage：旧罗盘总和 $sum 不拆骰，且区分 dealerDice/breakN 来源', ({ stage, sum }) => {
      const h = harness(); vi.spyOn(h.screen, 'drawClassicDie');
      const sv = seating({}, { stage, dealerDice: stage === 'dealerBreak' ? sum : 11, breakN: stage === 'roundBreak' ? sum : 11 });
      delete sv.presentation;
      const root = h.legacy(sv), labels = tree(root).flatMap(n => n.getComponent(Label)?.string ?? []);
      expect(labels).toContain(sum == null ? '等待掷骰…' : `总点数 ${sum} 点`);
      expect(labels.filter(s => /^总点数 /.test(s))).toEqual(sum == null ? [] : [`总点数 ${sum} 点`]);
      expectNoDice(h, root);
    });
});

describe('NetService.restart：隔离执行真实 restart 与 leave 方法', () => {
  it.each([undefined, 12])('maxRounds=%s：先 this.leave() 清理陈旧缓存，再沿用设置 create', maxRounds => {
    const h = harness(), settings = room('physical').settings!;
    h.net.lastSettings = settings; h.client.view = view(); h.client.room = room();
    h.net.sampleCeremony(seating().presentation);
    expect(h.net.ceremonyClock).not.toBeNull();
    const leave = vi.spyOn(h.net, 'leave');
    h.client.create.mockImplementation(() => {
      expect(h.client.view).toBeNull(); expect(h.client.room).toBeNull(); expect(h.net.ceremonyClock).toBeNull();
    });
    h.net.restart(maxRounds);
    expect(leave).toHaveBeenCalledTimes(1); expect(h.client.leave).toHaveBeenCalledTimes(1);
    expect(h.client.create).toHaveBeenCalledTimes(1); expect(h.client.create).toHaveBeenCalledWith(maxRounds ?? 8, settings);
    expect(leave.mock.invocationCallOrder[0]).toBeLessThan(h.client.leave.mock.invocationCallOrder[0]!);
    expect(h.client.leave.mock.invocationCallOrder[0]).toBeLessThan(h.client.create.mock.invocationCallOrder[0]!);
    expect(h.client.create.mock.calls[0]![1]).toBe(settings);
    expect(h.net.client).toBe(h.client);
  });

  it('断开连接时 restart 仍清理仪式时钟且不抛异常、不尝试创建房间', () => {
    const h = harness(); h.net.sampleCeremony(seating().presentation); h.net.client = null;
    const leave = vi.spyOn(h.net, 'leave');
    expect(() => h.net.restart()).not.toThrow();
    expect(leave).toHaveBeenCalledTimes(1); expect(h.net.ceremonyClock).toBeNull();
    expect(h.client.leave).not.toHaveBeenCalled(); expect(h.client.create).not.toHaveBeenCalled();
  });
});
