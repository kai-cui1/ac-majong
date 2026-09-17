import { Node, Label, UITransform, Graphics } from 'cc';
import { Screen } from '../app/SceneRouter';
import { Theme } from '../ui/Theme';
import { uiBackground, uiLabel, uiButton, uiPanel, uiModal, uiMuteToggle, type Modal } from '../ui/UiKit';
import { openRulesModal } from '../ui/RulesModal';
import { openSettingsModal } from '../ui/SettingsModal';
import { NetService } from '../game/NetService';

/**
 * 大厅页（P2，还原 home.html，横向重排到 844×390）。M-A 空壳：
 * 品牌 + 用户条 + 创建/加入房间（弹层占位，真实逻辑在 M-C）+ 规则入口 + 返回登录（验证 大厅→登录 双向切换）。
 */
export class LobbyScreen extends Screen {
  readonly name = 'lobby';

  build(): Node {
    const W = Theme.size.designW;
    const H = Theme.size.designH;
    const root = new Node('LobbyScreen');
    root.addComponent(UITransform).setContentSize(W, H);
    uiBackground('table').setParent(root);

    // 品牌区（左上）
    const logo = this.makeLogo(46);
    logo.setParent(root);
    logo.setPosition(-W / 2 + 56, H / 2 - 44, 0);
    const title = uiLabel('AC 麻将', { size: 24, color: Theme.color.gold, bold: true, align: 'left' });
    title.setParent(root);
    title.setPosition(-W / 2 + 150, H / 2 - 38, 0);
    const sub = uiLabel('传统台式麻将 · 自定义台数 · 好友组局', { size: 11, color: Theme.color.textMuted, align: 'left' });
    sub.setParent(root);
    sub.setPosition(-W / 2 + 150, H / 2 - 60, 0);

    // 用户条（右上）
    const userBar = this.makeUserBar();
    userBar.setParent(root);
    userBar.setPosition(W / 2 - 148, H / 2 - 48, 0);

    // 两大入口卡片
    const create = this.makeEntryCard('🎲', '创建房间', '我是房主，开局组局', () => this.openCreate());
    create.setParent(root);
    create.setPosition(-118, 4, 0);
    const join = this.makeEntryCard('🚪', '加入房间', '输入房间号入座', () => this.openJoin());
    join.setParent(root);
    join.setPosition(118, 4, 0);

    // 规则入口
    const rules = uiButton('规则说明 · 台数速查 / 算账公式', () => this.openRules(), { variant: 'secondary', width: 460, height: 40, fontSize: 13 });
    rules.setParent(root);
    rules.setPosition(0, -92, 0);
    // M-H：设置入口（静音/返回登录/版本协议）
    const gear = uiButton('⚙ 设置', () => openSettingsModal(this.node!, {
      onRelogin: () => {
        NetService.instance.disconnect();
        this.router.show('login');
      },
    }), { variant: 'secondary', width: 70, height: 40, fontSize: 13 });
    gear.setParent(root);
    gear.setPosition(272, -92, 0);

    // 公告
    const notice = uiLabel('v0.1 内测版 · 仅供俱乐部成员体验，积分仅供娱乐', { size: Theme.font.small, color: Theme.color.textSecondary });
    notice.setParent(root);
    notice.setPosition(0, -132, 0);

    // 返回登录（左下，验证双向切换）
    const back = uiButton('← 返回登录', () => {
      NetService.instance.disconnect();
      this.router.show('login');
    }, { variant: 'secondary', width: 120, height: 34, fontSize: 13 });
    back.setParent(root);
    back.setPosition(-W / 2 + 78, -H / 2 + 28, 0);

    const ver = uiLabel('AC Mahjong Club v0.1.0', { size: Theme.font.mini, color: Theme.color.textMuted });
    ver.setParent(root);
    ver.setPosition(W / 2 - 92, -H / 2 + 16, 0);

    // 静音开关（BL-014 最简本地开关，右下）
    const mute = uiMuteToggle(32);
    mute.setParent(root);
    mute.setPosition(W / 2 - 30, -H / 2 + 48, 0);

    return root;
  }

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

  /** 用户信息条：头像 + 昵称 + ID + 箭头（M-B：显示登录返回的真实资料） */
  private makeUserBar(): Node {
    const net = NetService.instance;
    const nickname = net.profile?.nickname ?? '牌友';
    const uid = net.userId ?? '—';
    const bar = uiPanel(244, 48, { variant: 'gold', radius: Theme.radius.lg });
    bar.name = 'UserBar';

    const av = new Node('Avatar');
    av.addComponent(UITransform).setContentSize(36, 36);
    const ag = av.addComponent(Graphics);
    ag.fillColor = Theme.color.gold;
    ag.circle(0, 0, 18);
    ag.fill();
    const alNode = new Node('A');
    alNode.addComponent(UITransform);
    const al = alNode.addComponent(Label);
    al.string = nickname.slice(0, 1);
    al.fontSize = 16;
    al.lineHeight = 20;
    al.color = Theme.color.bgWoodDark;
    al.isBold = true;
    al.horizontalAlign = Label.HorizontalAlign.CENTER;
    al.verticalAlign = Label.VerticalAlign.CENTER;
    alNode.setParent(av);
    av.setParent(bar);
    av.setPosition(-94, 0, 0);

    const nameL = uiLabel(nickname, { size: 15, color: Theme.color.textPrimary, bold: true, align: 'left' });
    nameL.setParent(bar);
    nameL.setPosition(-14, 9, 0);
    const idL = uiLabel(`ID: ${uid}`, { size: 11, color: Theme.color.textMuted, align: 'left' });
    idL.setParent(bar);
    idL.setPosition(-14, -9, 0);
    const arrow = uiLabel('›', { size: 18, color: Theme.color.textMuted });
    arrow.setParent(bar);
    arrow.setPosition(104, 0, 0);
    return bar;
  }

  /** 入口卡片：图标 + 标题 + 描述，整卡可点 */
  private makeEntryCard(icon: string, text: string, desc: string, onClick: () => void): Node {
    const card = uiPanel(210, 128, { variant: 'gold', radius: Theme.radius.lg });
    card.name = `Entry_${text}`;
    const ic = uiLabel(icon, { size: 30 });
    ic.setParent(card);
    ic.setPosition(0, 34, 0);
    const tx = uiLabel(text, { size: 17, color: Theme.color.textPrimary, bold: true });
    tx.setParent(card);
    tx.setPosition(0, -8, 0);
    const ds = uiLabel(desc, { size: 11, color: Theme.color.textMuted });
    ds.setParent(card);
    ds.setPosition(0, -34, 0);
    card.on(Node.EventType.TOUCH_END, onClick);
    return card;
  }

  private openCreate(): void {
    const m = uiModal('创建房间', { width: 360, height: 230 });
    const tip = uiLabel('选择局数上限（「不限」= 无限续局，直到房主解散）', { size: 12, color: Theme.color.textMuted, width: 310 });
    tip.setParent(m.panel);
    tip.setPosition(0, 56, 0);
    const status = uiLabel('', { size: 12, color: Theme.color.textSecondary, width: 310 });
    const statusLbl = status.getComponent(Label)!;
    status.setParent(m.panel);
    status.setPosition(0, -88, 0);
    const opts: [string, number][] = [['4 局', 4], ['8 局', 8], ['16 局', 16], ['不限', 0]];
    opts.forEach(([text, rounds], i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const btn = uiButton(text, () => void this.doCreate(rounds, m, statusLbl), { variant: 'primary', width: 140, height: 44 });
      btn.setParent(m.panel);
      btn.setPosition(-78 + col * 156, 12 - row * 52, 0);
    });
    m.root.setParent(this.node!);
  }

  private async doCreate(maxRounds: number, m: Modal, statusLbl: Label): Promise<void> {
    statusLbl.string = '创建中…';
    statusLbl.color = Theme.color.textSecondary;
    try {
      await NetService.instance.createRoom(maxRounds);
      m.close();
      this.router.show('room');
    } catch (e) {
      console.error('[Lobby] 创建房间失败:', e);
      statusLbl.string = '创建失败，请重试';
      statusLbl.color = Theme.color.danger;
    }
  }

  private openJoin(): void {
    const m = uiModal('加入房间', { width: 340, height: 320 });
    let input = '';
    const display = uiLabel('— — — — — —', { size: 24, color: Theme.color.gold, bold: true });
    const displayLbl = display.getComponent(Label)!;
    display.setParent(m.panel);
    display.setPosition(0, 100, 0);
    const status = uiLabel('输入 6 位房间号', { size: 12, color: Theme.color.textMuted, width: 290 });
    const statusLbl = status.getComponent(Label)!;
    status.setParent(m.panel);
    status.setPosition(0, 72, 0);
    const refresh = (): void => {
      displayLbl.string = input.padEnd(6, '—').split('').join(' ');
    };
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '加入'];
    keys.forEach((k, i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const isJoin = k === '加入';
      const btn = uiButton(k, () => {
        if (k === '⌫') {
          input = input.slice(0, -1);
          refresh();
          return;
        }
        if (isJoin) {
          void this.doJoin(input, m, statusLbl);
          return;
        }
        if (input.length < 6) {
          input += k;
          refresh();
        }
      }, { variant: isJoin ? 'primary' : 'action', width: 86, height: 42, fontSize: isJoin ? 15 : 18 });
      btn.setParent(m.panel);
      btn.setPosition(-92 + col * 92, 34 - row * 46, 0);
    });
    m.root.setParent(this.node!);
  }

  private async doJoin(room: string, m: Modal, statusLbl: Label): Promise<void> {
    if (room.length !== 6) {
      statusLbl.string = '请输入 6 位房间号';
      statusLbl.color = Theme.color.warning;
      return;
    }
    statusLbl.string = '加入中…';
    statusLbl.color = Theme.color.textSecondary;
    try {
      await NetService.instance.joinRoom(room);
      m.close();
      this.router.show('room');
    } catch (e) {
      statusLbl.string = e instanceof Error ? e.message : '加入失败';
      statusLbl.color = Theme.color.danger;
    }
  }

  private openRules(): void {
    openRulesModal(this.node!);
  }
}
