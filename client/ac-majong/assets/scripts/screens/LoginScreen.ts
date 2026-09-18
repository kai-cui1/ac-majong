import { Node, Label, UITransform, Graphics, Color } from 'cc';
import { Screen } from '../app/SceneRouter';
import { Theme } from '../ui/Theme';
import { uiBackground, uiLabel, uiButton, setButtonEnabled, uiInput } from '../ui/UiKit';
import { NetService } from '../game/NetService';
import { SERVER_URL, mockIdentity, IS_WX, IS_WEB, WX_CLOUD_ENV, WX_CLOUD_SERVICE, wxIdentity } from '../app/Config';
import { WeChatTransport } from '../vendor/client-core/index';
import type { EditBox } from 'cc';

/**
 * 登录页（P1，还原 login.html，横向重排到 844×390）。
 * 三模式（M-K/H5 鉴权）：微信端一键登录（云托管头鉴权）；Web/H5 账号密码表单（注册即登录 + 会话免密复登）；
 * 其余（原生壳）mock 一键。勾选协议 → 按钮可用 → 连接服务端 auth → users 落库 → authOk 进大厅。
 */
export class LoginScreen extends Screen {
  readonly name = 'login';
  private agreed = false;
  private loggingIn = false;
  private loginBtn: Node | null = null;
  private statusLbl: Label | null = null;
  private accBox: EditBox | null = null;
  private pwdBox: EditBox | null = null;
  private nickBox: EditBox | null = null;

  build(): Node {
    const W = Theme.size.designW;
    const H = Theme.size.designH;
    const root = new Node('LoginScreen');
    root.addComponent(UITransform).setContentSize(W, H);

    uiBackground('table').setParent(root);

    const logo = this.makeLogo(IS_WEB ? 60 : 78);
    logo.setParent(root);
    logo.setPosition(0, IS_WEB ? 138 : 104, 0);

    const title = uiLabel('AC 麻将俱乐部', { size: IS_WEB ? 30 : Theme.font.hero, color: Theme.color.gold, bold: true });
    title.setParent(root);
    title.setPosition(0, IS_WEB ? 92 : 34, 0);

    const sub = uiLabel('传统台式麻将 · 好友组局', { size: 13, color: Theme.color.textMuted });
    sub.setParent(root);
    sub.setPosition(0, IS_WEB ? 70 : 10, 0);

    if (IS_WEB) {
      // H5 账号路线：账号/密码/昵称（可选）三输入框
      const rows: { y: number; mk: () => { node: Node; box: EditBox }; set: (b: EditBox) => void }[] = [
        { y: 36, mk: () => uiInput({ placeholder: '👤 账号（3-20 位字母/数字/下划线）', maxLength: 20 }), set: (b) => (this.accBox = b) },
        { y: -10, mk: () => uiInput({ placeholder: '🔒 密码（至少 6 位）', password: true, maxLength: 64 }), set: (b) => (this.pwdBox = b) },
        { y: -56, mk: () => uiInput({ placeholder: '✏️ 昵称（可选，首次注册用）', maxLength: 12 }), set: (b) => (this.nickBox = b) },
      ];
      for (const r of rows) {
        const { node, box } = r.mk();
        r.set(box);
        node.setParent(root);
        node.setPosition(0, r.y, 0);
      }
    }

    this.loginBtn = uiButton(IS_WEB ? '登录 / 注册' : IS_WX ? '微信一键登录' : '一键登录', () => void this.onLogin(), {
      variant: 'wx',
      width: 280,
      height: IS_WEB ? 40 : 48,
      enabled: false,
    });
    this.loginBtn.setParent(root);
    this.loginBtn.setPosition(0, IS_WEB ? -104 : -46, 0);

    const statusNode = uiLabel('', { size: Theme.font.mini, color: Theme.color.textSecondary, width: 480 });
    this.statusLbl = statusNode.getComponent(Label);
    statusNode.setParent(root);
    statusNode.setPosition(0, IS_WEB ? -130 : -76, 0);

    const agree = this.makeAgreeRow();
    agree.setParent(root);
    agree.setPosition(0, IS_WEB ? -148 : -92, 0);

    const notice = uiLabel('本游戏内积分均为虚拟积分，不可兑换、不可提现。适度游戏益脑，沉迷游戏伤身。', {
      size: Theme.font.mini,
      color: Theme.color.textMuted,
      width: 480,
    });
    notice.setParent(root);
    notice.setPosition(0, IS_WEB ? -170 : -134, 0);

    const ver = uiLabel('v0.1.0 · 内测版', { size: Theme.font.mini, color: Theme.color.textMuted });
    ver.setParent(root);
    ver.setPosition(W / 2 - 66, -H / 2 + 14, 0);

    return root;
  }

  /** 每次进入登录页重置交互态（从大厅返回时按钮/提示复位）；H5 有会话则免密复登 */
  onEnter(): void {
    this.loggingIn = false;
    if (this.loginBtn) setButtonEnabled(this.loginBtn, this.agreed);
    this.setStatus('', Theme.color.textSecondary);
    if (IS_WEB && NetService.instance.storedSession()) void this.onSessionLogin();
  }

  /** 会话令牌免密复登；失败（过期/服务端拒绝）则留在表单 */
  private async onSessionLogin(): Promise<void> {
    if (this.loggingIn) return;
    this.loggingIn = true;
    this.setStatus('自动登录中…', Theme.color.textSecondary);
    try {
      await NetService.instance.connect(SERVER_URL, { token: NetService.instance.storedSession() ?? undefined });
      this.router.show('lobby');
    } catch (e) {
      console.warn('[LoginScreen] 会话复登失败:', e);
      this.setStatus(e instanceof Error ? e.message : '登录失败，请输入账号密码', Theme.color.danger);
      this.loggingIn = false;
    }
  }

  private async onLogin(): Promise<void> {
    if (!this.agreed || this.loggingIn) return;
    this.loggingIn = true;
    if (this.loginBtn) setButtonEnabled(this.loginBtn, false);
    this.setStatus('登录中…', Theme.color.textSecondary);
    try {
      if (IS_WX) {
        // 微信端：云托管 connectContainer（握手注入 x-wx-openid）
        const id = wxIdentity();
        await NetService.instance.connect('', { token: id.token }, { nickname: id.nickname, avatarUrl: id.avatarUrl },
          new WeChatTransport({ env: WX_CLOUD_ENV, service: WX_CLOUD_SERVICE }));
      } else if (IS_WEB) {
        const username = this.accBox?.string.trim() ?? '';
        const password = this.pwdBox?.string ?? '';
        const nick = this.nickBox?.string.trim() ?? '';
        if (!username || !password) {
          this.setStatus('请输入账号和密码', Theme.color.danger);
          if (this.loginBtn) setButtonEnabled(this.loginBtn, true);
          this.loggingIn = false;
          return;
        }
        await NetService.instance.connect(SERVER_URL, { account: { username, password } }, nick ? { nickname: nick, avatarUrl: '' } : undefined);
      } else {
        const id = mockIdentity();
        await NetService.instance.connect(SERVER_URL, { token: id.token }, { nickname: id.nickname, avatarUrl: id.avatarUrl });
      }
      this.router.show('lobby');
    } catch (e) {
      console.error('[LoginScreen] 登录失败:', e);
      this.setStatus(e instanceof Error ? e.message : '连接失败，请确认服务端已启动', Theme.color.danger);
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
