import { _decorator, Component } from 'cc';
import { SceneRouter } from './SceneRouter';
import { LoginScreen } from '../screens/LoginScreen';
import { LobbyScreen } from '../screens/LobbyScreen';
import { RoomScreen } from '../screens/RoomScreen';
import { TableScreen } from '../game/TableScreen';
import { ResultScreen } from '../screens/ResultScreen';

const { ccclass } = _decorator;

/**
 * 应用根控制器（挂在场景 Canvas 上）。
 * 职责：装配 SceneRouter、注册各屏幕、从登录页启动。
 * M-A：登录 ↔ 大厅 空壳切换（路由 + 设计系统）；M-C：接入房间等待页（登录 ↔ 大厅 ↔ 房间）；后续牌桌/结算逐步接入。
 */
@ccclass('App')
export class App extends Component {
  private router!: SceneRouter;

  start(): void {
    this.router = new SceneRouter(this.node);
    this.router.register(new LoginScreen()).register(new LobbyScreen()).register(new RoomScreen()).register(new TableScreen()).register(new ResultScreen());
    this.router.show('login');
  }
}
