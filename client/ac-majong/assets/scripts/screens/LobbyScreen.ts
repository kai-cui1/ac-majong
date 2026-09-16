import { Node, Label, UITransform, Graphics } from 'cc';
import { Screen } from '../app/SceneRouter';
import { Theme } from '../ui/Theme';
import { uiBackground, uiLabel, uiButton, uiPanel, uiModal } from '../ui/UiKit';

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

    // 公告
    const notice = uiLabel('v0.1 内测版 · 仅供俱乐部成员体验，积分仅供娱乐', { size: Theme.font.small, color: Theme.color.textSecondary });
    notice.setParent(root);
    notice.setPosition(0, -132, 0);

    // 返回登录（左下，验证双向切换）
    const back = uiButton('← 返回登录', () => this.router.show('login'), { variant: 'secondary', width: 120, height: 34, fontSize: 13 });
    back.setParent(root);
    back.setPosition(-W / 2 + 78, -H / 2 + 28, 0);

    const ver = uiLabel('AC Mahjong Club v0.1.0', { size: Theme.font.mini, color: Theme.color.textMuted });
    ver.setParent(root);
    ver.setPosition(W / 2 - 92, -H / 2 + 16, 0);

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

  /** 用户信息条：头像 + 昵称 + ID + 箭头（M-A 用占位数据，真实资料在 M-B） */
  private makeUserBar(): Node {
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
    al.string = '我';
    al.fontSize = 16;
    al.lineHeight = 20;
    al.color = Theme.color.bgWoodDark;
    al.isBold = true;
    al.horizontalAlign = Label.HorizontalAlign.CENTER;
    al.verticalAlign = Label.VerticalAlign.CENTER;
    alNode.setParent(av);
    av.setParent(bar);
    av.setPosition(-94, 0, 0);

    const nameL = uiLabel('牌友老张', { size: 15, color: Theme.color.textPrimary, bold: true, align: 'left' });
    nameL.setParent(bar);
    nameL.setPosition(-14, 9, 0);
    const idL = uiLabel('ID: 10086', { size: 11, color: Theme.color.textMuted, align: 'left' });
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
    const m = uiModal('创建房间', { width: 340, height: 190 });
    const hint = uiLabel('局数上限选择（4/8/16/不限）与创建逻辑在 M-C 实现', { size: 12, color: Theme.color.textMuted, width: 280 });
    hint.setParent(m.panel);
    hint.setPosition(0, 6, 0);
    m.root.setParent(this.node!);
  }

  private openJoin(): void {
    const m = uiModal('加入房间', { width: 340, height: 190 });
    const hint = uiLabel('6 位房间号输入与加入逻辑在 M-C 实现', { size: 12, color: Theme.color.textMuted, width: 280 });
    hint.setParent(m.panel);
    hint.setPosition(0, 6, 0);
    m.root.setParent(this.node!);
  }

  private openRules(): void {
    const m = uiModal('规则说明', { width: 340, height: 190 });
    const hint = uiLabel('完整规则页（台数速查/算账公式）在 M-H 实现', { size: 12, color: Theme.color.textMuted, width: 280 });
    hint.setParent(m.panel);
    hint.setPosition(0, 6, 0);
    m.root.setParent(this.node!);
  }
}
