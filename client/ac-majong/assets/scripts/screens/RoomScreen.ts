import { Node, Label, UITransform, Graphics } from 'cc';
import { Screen } from '../app/SceneRouter';
import { Theme, rgba } from '../ui/Theme';
import { uiBackground, uiLabel, uiButton, uiPanel, setButtonEnabled } from '../ui/UiKit';
import { NetService } from '../game/NetService';
import type { RoomView } from '../vendor/protocol/index';

/**
 * 房间等待页（P5，还原 room.html，横向重排到 844×390）。
 * 左栏：房间号卡片（大字房号 + 点击复制 + 局数/底注）+ 微信分享 + 添加机器人；
 * 右栏：2×2 牌友座位（头像/在线点/房主·我·Bot 标签/空位）+ 开始按钮 + 动态提示。
 * Bot 陪玩（FR-房间-08）：房主点空位或「添加机器人」补 Bot，点 Bot 座位可移除腾位给真人。
 * 开局进牌桌（M-E）、真实微信分享/复制（M-K）暂为占位。
 */
export class RoomScreen extends Screen {
  readonly name = 'room';
  private roomNoLbl: Label | null = null;
  private roundsLbl: Label | null = null;
  private playLbl: Label | null = null;
  private countLbl: Label | null = null;
  private statusLbl: Label | null = null;
  private startBtn: Node | null = null;
  private addBotBtn: Node | null = null;
  private seatNodes: Node[] = [];

  build(): Node {
    const W = Theme.size.designW;
    const H = Theme.size.designH;
    const root = new Node('RoomScreen');
    root.addComponent(UITransform).setContentSize(W, H);
    uiBackground('wood').setParent(root);

    // 顶部：标题 + 返回
    const title = uiLabel('房间等待', { size: 20, color: Theme.color.gold, bold: true });
    title.setParent(root);
    title.setPosition(0, H / 2 - 28, 0);
    const back = this.makeBackButton();
    back.setParent(root);
    back.setPosition(-W / 2 + 30, H / 2 - 28, 0);

    // 左栏：房间号卡片
    const card = uiPanel(280, 186, { variant: 'gold', radius: Theme.radius.xl });
    card.setParent(root);
    card.setPosition(-250, 34, 0);
    this.buildRoomCodeCard(card);

    // 左栏：微信分享 + 添加机器人
    const share = uiButton('💬 分享微信好友，一键入座', () => this.onShare(), { variant: 'wx', width: 250, height: 44, fontSize: 15 });
    share.setParent(root);
    share.setPosition(-250, -84, 0);
    this.addBotBtn = uiButton('🤖 添加机器人陪玩', () => void this.onAddBot(1), { variant: 'action', width: 250, height: 40, fontSize: 14 });
    this.addBotBtn.setParent(root);
    this.addBotBtn.setPosition(-250, -134, 0);

    // 右栏：座位区标题 + 计数
    const seatTitle = uiLabel('牌友座位', { size: 14, color: Theme.color.textSecondary });
    seatTitle.setParent(root);
    seatTitle.setPosition(58, 150, 0);
    const count = uiLabel('1 / 4', { size: 14, color: Theme.color.gold, bold: true });
    this.countLbl = count.getComponent(Label)!;
    count.setParent(root);
    count.setPosition(352, 150, 0);

    // 2×2 座位卡片
    const cols = [40, 250];
    const rows = [80, -20];
    this.seatNodes = [];
    for (let seat = 0; seat < 4; seat++) {
      const node = new Node(`Seat_${seat}`);
      node.addComponent(UITransform).setContentSize(200, 88);
      node.setParent(root);
      node.setPosition(cols[seat % 2]!, rows[Math.floor(seat / 2)]!, 0);
      this.seatNodes.push(node);
    }

    // 底部：开始按钮 + 提示
    this.startBtn = uiButton('开始游戏', () => this.onStart(), { variant: 'primary', width: 280, height: 50, enabled: false });
    this.startBtn.setParent(root);
    this.startBtn.setPosition(145, -138, 0);
    const status = uiLabel('', { size: 11, color: Theme.color.textMuted, width: 420 });
    this.statusLbl = status.getComponent(Label)!;
    status.setParent(root);
    status.setPosition(145, -172, 0);

    NetService.instance.onRoom((r) => {
      // BL-017：房主开始后进入仪式阶段 → 切牌桌页展示仪式遮罩（掷骰/选座在牌桌上进行）
      if (r.phase === 'seating') {
        this.router.show('table');
        return;
      }
      this.render(r);
    });
    // 开局后服务端下发 gameView → 切牌桌（M-E）
    NetService.instance.onView(() => this.router.show('table'));
    return root;
  }

  onEnter(): void {
    const r = NetService.instance.room;
    if (r) this.render(r);
  }

  /** 房间号卡片：标签 + 大字房号（点击复制）+ 分隔线 + 局数/底注 */
  private buildRoomCodeCard(card: Node): void {
    const label = uiLabel('房 间 号', { size: 11, color: Theme.color.textMuted });
    label.setParent(card);
    label.setPosition(0, 62, 0);

    const num = uiLabel('——————', { size: 34, color: Theme.color.gold, bold: true });
    this.roomNoLbl = num.getComponent(Label)!;
    num.setParent(card);
    num.setPosition(0, 28, 0);
    num.on(Node.EventType.TOUCH_END, () => this.onCopyRoom());

    const copy = uiLabel('点击号码复制', { size: 10, color: Theme.color.textMuted });
    copy.setParent(card);
    copy.setPosition(0, 2, 0);

    const line = new Node('Divider');
    line.addComponent(UITransform).setContentSize(240, 1);
    const lg = line.addComponent(Graphics);
    lg.strokeColor = Theme.color.goldHairline;
    lg.lineWidth = 1;
    lg.moveTo(-120, 0);
    lg.lineTo(120, 0);
    lg.stroke();
    line.setParent(card);
    line.setPosition(0, -16, 0);

    const rounds = uiLabel('局数上限 —', { size: 12, color: Theme.color.textSecondary });
    this.roundsLbl = rounds.getComponent(Label)!;
    rounds.setParent(card);
    rounds.setPosition(-64, -42, 0);

    const ante = uiLabel('底 1 台 = 1 积分', { size: 12, color: Theme.color.textSecondary }); // D-25：积分与台数 1:1（废除 1 台=20 倍率），对齐 room.html 房卡
    ante.setParent(card);
    ante.setPosition(66, -42, 0);

    // BL-017 玩法参数展示（FR-房间-10，还原 room.html 房卡底行）
    const play = uiLabel('玩法 —', { size: 11, color: Theme.color.textMuted, width: 250 });
    this.playLbl = play.getComponent(Label)!;
    play.setParent(card);
    play.setPosition(0, -70, 0);
  }

  private render(r: RoomView): void {
    if (this.roomNoLbl) this.roomNoLbl.string = r.room;
    if (this.roundsLbl) this.roundsLbl.string = r.maxRounds > 0 ? `局数上限 ${r.maxRounds} 局` : '局数不限';
    if (this.playLbl) {
      const wall = r.settings?.wallMode === 'physical' ? '物理牌墙' : '随机发牌';
      const brk = r.settings?.breakDice ? '摸牌位骰开' : '摸牌位骰关';
      const cfv = r.settings?.chiFirstView !== false ? '先看吃再碰开' : '先看吃再碰关';
      this.playLbl.string = `玩法 ${wall} · ${brk} · ${cfv} · 选位仪式恒开`;
    }
    const filled = r.seats.filter((s) => s != null).length;
    if (this.countLbl) this.countLbl.string = `${filled} / 4`;
    const me = NetService.instance.userId;
    const isHost = me === r.hostUserId;
    const full = filled >= 4;

    for (let seat = 0; seat < 4; seat++) this.renderSeat(this.seatNodes[seat]!, r, seat, me, isHost);

    if (this.addBotBtn) this.addBotBtn.active = isHost && r.phase === 'waiting' && !full;
    if (this.startBtn) {
      const showStart = isHost && r.phase === 'waiting';
      this.startBtn.active = showStart;
      if (showStart) setButtonEnabled(this.startBtn, full);
    }
    if (this.statusLbl) {
      if (r.phase === 'playing') {
        this.statusLbl.string = '对局进行中…（牌桌 M-E 接入）';
        this.statusLbl.color = Theme.color.textSecondary;
      } else if (isHost) {
        this.statusLbl.string = full ? '✓ 人齐，可以开始' : '⚠ 满 4 人方可开始（点空位或「添加机器人」补位）';
        this.statusLbl.color = full ? Theme.color.success : Theme.color.warning;
      } else {
        this.statusLbl.string = `等待房主开始（${filled}/4）`;
        this.statusLbl.color = Theme.color.textMuted;
      }
    }
  }

  /** 单个座位：空位（虚线框 + 加号，房主可点加 Bot）或已就座（头像 + 昵称 + 标签，房主可点 Bot 移除） */
  private renderSeat(node: Node, r: RoomView, seat: number, me: string | null, isHost: boolean): void {
    node.destroyAllChildren();
    node.off(Node.EventType.TOUCH_END);
    const waiting = r.phase === 'waiting';
    const occ = r.seats[seat];
    if (!occ) {
      this.drawEmptySeat(node, isHost && waiting);
      if (isHost && waiting) node.on(Node.EventType.TOUCH_END, () => void this.onAddBot(1));
      return;
    }
    const panel = uiPanel(200, 88, { variant: 'panel', radius: Theme.radius.lg });
    panel.setParent(node);

    const isBot = !!occ.isBot;
    const isHostSeat = occ.userId === r.hostUserId;
    const isMe = occ.userId === me;
    const name = isMe ? '你' : isBot ? '机器人' : (occ.nickname || this.displayName(occ.userId));

    const av = this.makeAvatar(name.slice(0, 1), isBot);
    av.setParent(node);
    av.setPosition(-66, 0, 0);

    const nameL = uiLabel(name, { size: 15, color: Theme.color.textPrimary, bold: true });
    nameL.setParent(node);
    nameL.setPosition(18, 16, 0);

    const removable = isHost && isBot && waiting;
    const tag = isHostSeat ? '👑 房主' : isMe ? '我' : removable ? '🤖 点击移除' : isBot ? '🤖 Bot' : '已就位';
    const tagColor = isHostSeat ? Theme.color.gold : isMe ? Theme.color.success : removable ? Theme.color.warning : Theme.color.textMuted;
    const tagL = uiLabel(tag, { size: 11, color: tagColor, bold: isHostSeat || isMe });
    tagL.setParent(node);
    tagL.setPosition(removable ? 8 : -14, -16, 0);

    if (removable) node.on(Node.EventType.TOUCH_END, () => this.onRemoveBot(seat));
  }

  private drawEmptySeat(node: Node, clickable: boolean): void {
    const box = new Node('EmptyBox');
    box.addComponent(UITransform).setContentSize(200, 88);
    const g = box.addComponent(Graphics);
    g.lineWidth = 1.5;
    g.strokeColor = clickable ? Theme.color.goldFaint : Theme.color.goldHairline;
    g.roundRect(-100, -44, 200, 88, Theme.radius.lg);
    g.stroke();
    g.strokeColor = Theme.color.goldFaint;
    g.circle(-66, 0, 22);
    g.stroke();
    box.setParent(node);

    const plus = uiLabel('+', { size: 26, color: Theme.color.gold });
    plus.setParent(node);
    plus.setPosition(-66, 0, 0);

    const txt = uiLabel(clickable ? '点击添加机器人' : '等待牌友加入…', { size: 12, color: Theme.color.textMuted });
    txt.setParent(node);
    txt.setPosition(24, 0, 0);
  }

  /** 圆形头像：真人金色底 + 首字，Bot 灰色底 + 🤖；右下角在线绿点 */
  private makeAvatar(glyph: string, isBot: boolean): Node {
    const av = new Node('Avatar');
    av.addComponent(UITransform).setContentSize(46, 46);
    const g = av.addComponent(Graphics);
    g.fillColor = isBot ? Theme.color.textMuted : Theme.color.gold;
    g.circle(0, 0, 23);
    g.fill();
    g.strokeColor = isBot ? Theme.color.textSecondary : Theme.color.goldLight;
    g.lineWidth = 2;
    g.circle(0, 0, 23);
    g.stroke();

    const ln = new Node('Glyph');
    ln.addComponent(UITransform);
    const lb = ln.addComponent(Label);
    lb.string = isBot ? '🤖' : glyph;
    lb.fontSize = isBot ? 18 : 17;
    lb.lineHeight = lb.fontSize + 4;
    lb.color = isBot ? Theme.color.white : Theme.color.bgWoodDark;
    lb.isBold = true;
    lb.horizontalAlign = Label.HorizontalAlign.CENTER;
    lb.verticalAlign = Label.VerticalAlign.CENTER;
    ln.setParent(av);

    const dot = new Node('Online');
    dot.addComponent(UITransform).setContentSize(12, 12);
    const dg = dot.addComponent(Graphics);
    dg.fillColor = Theme.color.success;
    dg.circle(0, 0, 5);
    dg.fill();
    dg.strokeColor = Theme.color.bgWoodDark;
    dg.lineWidth = 2;
    dg.circle(0, 0, 5);
    dg.stroke();
    dot.setParent(av);
    dot.setPosition(16, -16, 0);
    return av;
  }

  private makeBackButton(): Node {
    const n = new Node('Back');
    n.addComponent(UITransform).setContentSize(32, 32);
    const g = n.addComponent(Graphics);
    g.fillColor = rgba(255, 255, 255, 0.08);
    g.circle(0, 0, 16);
    g.fill();
    g.strokeColor = Theme.color.goldFaint;
    g.lineWidth = 1;
    g.circle(0, 0, 16);
    g.stroke();
    const ln = new Node('Arrow');
    ln.addComponent(UITransform);
    const lb = ln.addComponent(Label);
    lb.string = '←';
    lb.fontSize = 16;
    lb.lineHeight = 20;
    lb.color = Theme.color.gold;
    lb.horizontalAlign = Label.HorizontalAlign.CENTER;
    lb.verticalAlign = Label.VerticalAlign.CENTER;
    ln.setParent(n);
    n.on(Node.EventType.TOUCH_END, () => this.onLeave());
    return n;
  }

  private displayName(userId: string): string {
    return userId.length > 8 ? `${userId.slice(0, 8)}…` : userId;
  }

  private async onAddBot(count: number): Promise<void> {
    try {
      const r = await NetService.instance.addBot(count);
      this.render(r);
    } catch (e) {
      console.error('[Room] 添加机器人失败:', e);
    }
  }

  private onRemoveBot(seat: number): void {
    NetService.instance.removeBot(seat); // roomView 广播驱动 render
  }

  private onCopyRoom(): void {
    const room = NetService.instance.room?.room;
    if (!room) return;
    if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(room);
    if (this.statusLbl) {
      this.statusLbl.string = `已复制房号 ${room}（微信端复制 M-K）`;
      this.statusLbl.color = Theme.color.success;
    }
  }

  private onShare(): void {
    if (this.statusLbl) {
      this.statusLbl.string = '分享微信好友（真实分享卡片 M-K 接入）';
      this.statusLbl.color = Theme.color.textSecondary;
    }
  }

  private onStart(): void {
    NetService.instance.start(); // 开局后服务端下发 gameView；牌桌页 M-E 接入
  }

  private onLeave(): void {
    NetService.instance.leave();
    this.router.show('lobby');
  }
}
