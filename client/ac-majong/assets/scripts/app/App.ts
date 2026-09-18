import * as cc from 'cc';
import { _decorator, Component, Node, UITransform, Graphics } from 'cc';
import { SceneRouter } from './SceneRouter';
import { LoginScreen } from '../screens/LoginScreen';
import { LobbyScreen } from '../screens/LobbyScreen';
import { RoomScreen } from '../screens/RoomScreen';
import { TableScreen } from '../game/TableScreen';
import { ResultScreen } from '../screens/ResultScreen';
import { ReplayListScreen } from '../screens/ReplayListScreen';
import { ReplayPlayerScreen } from '../screens/ReplayPlayerScreen';
import { IS_WEB } from './Config';
import { Theme } from '../ui/Theme';
import { uiLabel } from '../ui/UiKit';
import { NetService } from '../game/NetService';

const { ccclass } = _decorator;

/**
 * 应用根控制器（挂在场景 Canvas 上）。
 * 职责：装配 SceneRouter、注册各屏幕、从登录页启动。
 * M-A：登录 ↔ 大厅 空壳切换（路由 + 设计系统）；M-C：接入房间等待页（登录 ↔ 大厅 ↔ 房间）；后续牌桌/结算逐步接入。
 */
@ccclass('App')
export class App extends Component {
  private router!: SceneRouter;
  /** H5 路线：竖屏旋转提示遮罩（横屏游戏，浏览器无法强制转屏） */
  private rotateHint: Node | null = null;

  start(): void {
    this.router = new SceneRouter(this.node);
    this.router.register(new LoginScreen()).register(new LobbyScreen()).register(new RoomScreen()).register(new TableScreen()).register(new ResultScreen())
      .register(new ReplayListScreen())
      .register(new ReplayPlayerScreen());
    this.router.show('login');
    // 调试/自动化钩子（e2e/CDP 驱动：节点树定位点击 + 网络状态断言）
    (globalThis as Record<string, unknown>).__AC__ = { router: this.router, net: NetService.instance, cc };
    if (IS_WEB) {
      this.updateRotateHint();
      (globalThis as { window: Window }).window.addEventListener('resize', () => this.updateRotateHint());
    }
  }

  private updateRotateHint(): void {
    const w = (globalThis as { window: Window }).window;
    const portrait = w.innerHeight > w.innerWidth;
    if (portrait && !this.rotateHint) {
      const mask = new Node('RotateHint');
      mask.setParent(this.node);
      mask.layer = this.node.layer;
      const ut = mask.addComponent(UITransform);
      ut.setContentSize(Math.max(w.innerWidth, w.innerHeight), Math.max(w.innerWidth, w.innerHeight));
      const g = mask.addComponent(Graphics);
      g.fillColor = Theme.color.bgTable;
      g.rect(-2000, -2000, 4000, 4000);
      g.fill();
      uiLabel('请横屏游玩（旋转手机）', { size: 22, bold: true, color: Theme.color.text }).parent = mask;
      this.rotateHint = mask;
      mask.setSiblingIndex(9999);
    } else if (!portrait && this.rotateHint) {
      this.rotateHint.destroy();
      this.rotateHint = null;
    }
  }
}
