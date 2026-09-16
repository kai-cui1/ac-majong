import { Node } from 'cc';

/**
 * 一个「屏幕」（登录 / 大厅 / 房间 / 牌桌 / 结算 …）。
 * 由 SceneRouter 管理显隐与生命周期；屏幕内部用 UiKit 组件构建自己的节点树。
 */
export abstract class Screen {
  abstract readonly name: string;
  /** 由 router 注入，供屏幕内导航：this.router.show('lobby') */
  router!: SceneRouter;
  /** 屏幕根节点（首次 show 时懒构建，之后复用） */
  node: Node | null = null;
  /** 构建屏幕节点树并返回根节点 */
  abstract build(): Node;
  /** 每次进入时调用（可刷新数据/重连状态） */
  onEnter(): void {}
  /** 每次离开时调用 */
  onExit(): void {}
}

/**
 * 场景路由：在单一 Canvas 下管理多个 Screen 的显隐切换。
 * 采用「单场景 + 多屏幕节点」而非 director.loadScene——避免频繁加载、便于共享 NetService 单例与资源，
 * 也更贴合小游戏「一个包体、页面轻量切换」的形态。
 */
export class SceneRouter {
  private screens = new Map<string, Screen>();
  private current: Screen | null = null;

  constructor(private readonly root: Node) {}

  register(screen: Screen): this {
    screen.router = this;
    this.screens.set(screen.name, screen);
    return this;
  }

  show(name: string): void {
    const next = this.screens.get(name);
    if (!next || next === this.current) return;
    if (this.current) {
      this.current.onExit();
      if (this.current.node) this.current.node.active = false;
    }
    if (!next.node) {
      next.node = next.build();
      next.node.setParent(this.root);
    }
    next.node.active = true;
    this.current = next;
    next.onEnter();
  }

  get currentName(): string | null {
    return this.current ? this.current.name : null;
  }
}
