import { _decorator, Component } from 'cc';
import { SceneRouter } from './SceneRouter';
import { LoginScreen } from '../screens/LoginScreen';
import { LobbyScreen } from '../screens/LobbyScreen';

const { ccclass } = _decorator;

/**
 * 应用根控制器（挂在场景 Canvas 上）。
 * 职责：装配 SceneRouter、注册各屏幕、从登录页启动。
 * M-A：仅「登录 ↔ 大厅」空壳切换，验证 路由 + 设计系统(UiKit)；后续屏幕（房间/牌桌/结算）逐步接入。
 */
@ccclass('App')
export class App extends Component {
  private router!: SceneRouter;

  start(): void {
    this.router = new SceneRouter(this.node);
    this.router.register(new LoginScreen()).register(new LobbyScreen());
    this.router.show('login');
  }
}
