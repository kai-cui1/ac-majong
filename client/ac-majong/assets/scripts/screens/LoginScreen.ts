import { Node, Label, UITransform, Graphics, Color } from 'cc';
import { Screen } from '../app/SceneRouter';
import { Theme } from '../ui/Theme';
import { uiBackground, uiLabel, uiButton, setButtonEnabled } from '../ui/UiKit';
import { NetService } from '../game/NetService';
import { SERVER_URL, mockIdentity } from '../app/Config';

/**
 * 登录页（P1，还原 login.html，横向重排到 844×390）。
 * M-B：勾选协议 → 按钮可用 → 点「微信一键登录」走真实登录链路
 * （本地 mock 身份 → 连接服务端 auth → users 落库 + 会话 → authOk 回传资料 → 进大厅）。
 * 真实微信 wx.login/code2Session 在 M-K 接入。
 */
export class LoginScreen extends Screen {
  readonly name = 'login';
  private agreed = false;
  private loggingIn = false;
  private loginBtn: Node | null = null;
  private statusLbl: Label | null = null;

  build(): Node {
    const W = Theme.size.designW;
    const H = Theme.size.designH;
    const root = new Node('LoginScreen');
    root.addComponent(UITransform).setContentSize(W, H);

    uiBackground('table').setParent(root);

    const logo = this.makeLogo(78);
    logo.setParent(root);
    logo.setPosition(0, 104, 0);

    const title = uiLabel('AC 麻将俱乐部', { size: Theme.font.hero, color: Theme.color.gold, bold: true });
    title.setParent(root);
    title.setPosition(0, 34, 0);

    const sub = uiLabel('传统台式麻将 · 好友组局', { size: 13, color: Theme.color.textMuted });
    sub.setParent(root);
    sub.setPosition(0, 10, 0);

    this.loginBtn = uiButton('微信一键登录', () => void this.onLogin(), { variant: 'wx', width: 280, height: 48, enabled: false });
    this.loginBtn.setParent(root);
    this.loginBtn.setPosition(0, -46, 0);

    const statusNode = uiLabel('', { size: Theme.font.mini, color: Theme.color.textSecondary, width: 480 });
    this.statusLbl = statusNode.getComponent(Label);
    statusNode.setParent(root);
    statusNode.setPosition(0, -76, 0);

    const agree = this.makeAgreeRow();
    agree.setParent(root);
    agree.setPosition(0, -92, 0);

    const notice = uiLabel('本游戏内积分均为虚拟积分，不可兑换、不可提现。适度游戏益脑，沉迷游戏伤身。', {
      size: Theme.font.mini,
      color: Theme.color.textMuted,
      width: 480,
    });
    notice.setParent(root);
    notice.setPosition(0, -134, 0);

    const ver = uiLabel('v0.1.0 · 内测版', { size: Theme.font.mini, color: Theme.color.textMuted });
    ver.setParent(root);
    ver.setPosition(W / 2 - 66, -H / 2 + 14, 0);

    return root;
  }

  /** 每次进入登录页重置交互态（从大厅返回时按钮/提示复位） */
  onEnter(): void {
    this.loggingIn = false;
    if (this.loginBtn) setButtonEnabled(this.loginBtn, this.agreed);
    this.setStatus('', Theme.color.textSecondary);
  }

  private async onLogin(): Promise<void> {
    if (!this.agreed || this.loggingIn) return;
    this.loggingIn = true;
    if (this.loginBtn) setButtonEnabled(this.loginBtn, false);
    this.setStatus('登录中…', Theme.color.textSecondary);
    try {
      const id = mockIdentity();
      await NetService.instance.connect(SERVER_URL, id.token, {
        nickname: id.nickname,
        avatarUrl: id.avatarUrl,
      });
      this.router.show('lobby');
    } catch (e) {
      console.error('[LoginScreen] 登录失败:', e);
      this.setStatus('连接失败，请确认服务端已启动', Theme.color.danger);
      if (this.loginBtn) setButtonEnabled(this.loginBtn, true);
      this.loggingIn = false;
    }
  }

  private setStatus(text: string, color: Color): void {
    if (!this.statusLbl) return;
    this.statusLbl.string = text;
    this.statusLbl.color = color;
  }

  /** 金色圆角方块 Logo + 🀄（最终应替换为图片资源） */
  private makeLogo(size: number): Node {
    const n = new Node('Logo');
    n.addComponent(UITransform).setContentSize(size, size);
    const g = n.addComponent(Graphics);
    g.fillColor = Theme.color.gold;
    g.strokeColor = Theme.color.goldLight;
    g.lineWidth = 2;
    g.roundRect(-size / 2, -size / 2, size, size, size * 0.26);
    g.fill();
    g.stroke();
    const ln = new Node('Glyph');
    ln.addComponent(UITransform);
    const lb = ln.addComponent(Label);
    lb.string = '🀄';
    lb.fontSize = Math.round(size * 0.56);
    lb.lineHeight = lb.fontSize + 4;
    lb.horizontalAlign = Label.HorizontalAlign.CENTER;
    lb.verticalAlign = Label.VerticalAlign.CENTER;
    ln.setParent(n);
    return n;
  }

  /** 协议勾选行：圆形勾选框 + 说明文字；切换后联动登录按钮可用态 */
  private makeAgreeRow(): Node {
    const row = new Node('AgreeRow');
    row.addComponent(UITransform).setContentSize(480, 20);

    const box = new Node('Check');
    box.addComponent(UITransform).setContentSize(18, 18);
    const bg = box.addComponent(Graphics);
    this.drawCheck(bg, false);
    box.setPosition(-228, 0, 0);
    box.setParent(row);

    const txt = uiLabel('我已阅读并同意《用户协议》《隐私政策》，并确认已年满 18 周岁', {
      size: Theme.font.tiny,
      color: Theme.color.textMuted,
      align: 'left',
      width: 440,
    });
    txt.setParent(row);
    txt.setPosition(16, 0, 0);

    box.on(Node.EventType.TOUCH_END, () => {
      this.agreed = !this.agreed;
      this.drawCheck(bg, this.agreed);
      if (this.loginBtn) setButtonEnabled(this.loginBtn, this.agreed);
    });
    return row;
  }

  private drawCheck(g: Graphics, checked: boolean): void {
    g.clear();
    g.lineWidth = 1.5;
    g.strokeColor = checked ? Theme.color.gold : Theme.color.textMuted;
    if (checked) g.fillColor = Theme.color.gold;
    g.circle(0, 0, 8);
    if (checked) g.fill();
    g.stroke();
    if (checked) {
      g.lineWidth = 2;
      g.strokeColor = Theme.color.bgWoodDark;
      g.moveTo(-3.5, 0.5);
      g.lineTo(-1, -2.5);
      g.lineTo(4, 3.5);
      g.stroke();
    }
  }
}
