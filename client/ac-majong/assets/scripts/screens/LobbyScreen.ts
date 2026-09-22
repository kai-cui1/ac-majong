import { Node, Label, UITransform, Graphics, Color, director, Director } from 'cc';
import { Screen } from '../app/SceneRouter';
import { Theme } from '../ui/Theme';
import { uiBackground, uiLabel, uiButton, uiPanel, uiModal, uiMuteToggle, uiSwitch, type Modal } from '../ui/UiKit';
import { openRulesModal } from '../ui/RulesModal';
import { openSettingsModal } from '../ui/SettingsModal';
import { NetService } from '../game/NetService';
import type { PublicRoomEntry } from '../vendor/protocol/index';

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

    // 品牌区（左上，还原原型 .lb-brand：left24 top14、logo40、gap12、title20/900、sub10）
    const logo = this.makeLogo(40);
    logo.setParent(root);
    logo.setPosition(-W / 2 + 44, H / 2 - 34, 0);
    const title = uiLabel('AC 麻将', { size: 20, color: Theme.color.gold, bold: true, align: 'left' });
    title.setParent(root);
    title.getComponent(UITransform)!.anchorX = 0;
    title.setPosition(-W / 2 + 76, H / 2 - 27, 0);
    const sub = uiLabel('传统台式麻将 · 自定义台数 · 好友组局', { size: 10, color: Theme.color.textMuted, align: 'left' });
    sub.setParent(root);
    sub.getComponent(UITransform)!.anchorX = 0;
    sub.setPosition(-W / 2 + 76, H / 2 - 45, 0);

    // 用户条（右上，还原原型 .lb-user：right24 top12 216×44）
    const userBar = this.makeUserBar();
    userBar.setParent(root);
    userBar.setPosition(W / 2 - 132, H / 2 - 34, 0);

    // 两大入口卡片（左列横卡，还原原型 .lb-entry）
    const create = this.makeEntryCard('🎲', '创建房间', '我是房主，开局组局', () => this.openCreate());
    create.setParent(root);
    create.setPosition(-248, 73, 0);
    const join = this.makeEntryCard('🚪', '加入房间', '输入房间号入座', () => this.openJoin());
    join.setParent(root);
    join.setPosition(-248, -27, 0);

    // 次要入口三钮（还原原型 .lb-subrow）
    const replay = uiButton('🎬 战绩/回放', () => this.router.show('replayList'), { variant: 'dark', width: 96, height: 36, fontSize: 11 });
    replay.setParent(root);
    replay.setPosition(-350, -99, 0);
    const rules = uiButton('📋 规则速查', () => this.openRules(), { variant: 'dark', width: 96, height: 36, fontSize: 11 });
    rules.setParent(root);
    rules.setPosition(-248, -99, 0);
    const gear = uiButton('⚙ 设置', () => openSettingsModal(this.node!, {
      onRelogin: () => {
        NetService.instance.disconnect();
        this.router.show('login');
      },
    }), { variant: 'dark', width: 96, height: 36, fontSize: 11 });
    gear.setParent(root);
    gear.setPosition(-146, -99, 0);

    // 右列：公开房间列表（BL-018，进大厅拉取 + 5s 自动轮询 + 手动钮）
    this.buildRoomList(root);

    // 返回登录（左下，还原原型 .lb-back：left24 top348 h30 padding14 font11）
    const back = uiButton('← 返回登录', () => {
      NetService.instance.disconnect();
      this.router.show('login');
    }, { variant: 'dark', width: 86, height: 30, fontSize: 11, radius: 15 });
    back.setParent(root);
    back.setPosition(-W / 2 + 67, -H / 2 + 27, 0);

    // 版本号（还原原型 .lb-ver：right64 top356 font9，右缘对齐）
    const ver = uiLabel('AC Mahjong Club v0.1.0', { size: Theme.font.mini, color: Theme.color.textMuted });
    ver.setParent(root);
    ver.getComponent(UITransform)!.anchorX = 1;
    ver.setPosition(W / 2 - 64, -H / 2 + 28, 0);

    // 静音开关（BL-014，还原原型 .lb-mute：right24 top348 28×28）
    const mute = uiMuteToggle(28);
    mute.setParent(root);
    mute.setPosition(W / 2 - 38, -H / 2 + 28, 0);

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

  /** 用户信息条：头像 + 昵称 + ID + 箭头（还原原型 .lb-user 216×44：padding12 gap10、avatar30、name13、id9） */
  private makeUserBar(): Node {
    const net = NetService.instance;
    const nickname = net.profile?.nickname ?? '牌友';
    const uid = net.userId ?? '—';
    const bar = uiPanel(216, 44, { variant: 'gold', radius: Theme.radius.lg });
    bar.name = 'UserBar';

    const av = new Node('Avatar');
    av.addComponent(UITransform).setContentSize(30, 30);
    const ag = av.addComponent(Graphics);
    ag.fillColor = Theme.color.gold;
    ag.circle(0, 0, 15);
    ag.fill();
    const alNode = new Node('A');
    alNode.addComponent(UITransform);
    const al = alNode.addComponent(Label);
    al.string = nickname.slice(0, 1);
    al.fontSize = 13;
    al.lineHeight = 16;
    al.color = Theme.color.bgWoodDark;
    al.isBold = true;
    al.horizontalAlign = Label.HorizontalAlign.CENTER;
    al.verticalAlign = Label.VerticalAlign.CENTER;
    alNode.setParent(av);
    av.setParent(bar);
    av.setPosition(-81, 0, 0);

    const nameL = uiLabel(nickname, { size: 13, color: Theme.color.textPrimary, bold: true, align: 'left' });
    nameL.setParent(bar);
    nameL.getComponent(UITransform)!.anchorX = 0;
    nameL.setPosition(-56, 8, 0);
    const idL = uiLabel(`ID: ${uid}`, { size: 9, color: Theme.color.textMuted, align: 'left' });
    idL.setParent(bar);
    idL.getComponent(UITransform)!.anchorX = 0;
    idL.setPosition(-56, -8, 0);
    const arrow = uiLabel('›', { size: 13, color: Theme.color.textMuted });
    arrow.setParent(bar);
    arrow.setPosition(92, 0, 0);
    return bar;
  }

  /** 入口卡片（横屏横卡 300×92：图标左 + 文案左对齐双行，还原原型 .lb-entry） */
  private makeEntryCard(icon: string, text: string, desc: string, onClick: () => void): Node {
    const card = uiPanel(300, 92, { variant: 'gold', radius: Theme.radius.lg });
    card.name = `Entry_${text}`;
    // 图标容器（还原原型 .lb-entry-icon：46×46 圆角12 + 金色淡底描边）
    const ib = new Node('IconBox');
    ib.addComponent(UITransform).setContentSize(46, 46);
    const ig = ib.addComponent(Graphics);
    ig.fillColor = new Color(212, 165, 55, 30);
    ig.strokeColor = new Color(212, 165, 55, 64);
    ig.lineWidth = 1;
    ig.roundRect(-23, -23, 46, 46, 12);
    ig.fill();
    ig.stroke();
    ib.setParent(card);
    ib.setPosition(-111, 0, 0);
    const ic = uiLabel(icon, { size: 23 });
    ic.setParent(ib);
    ic.setPosition(0, 0, 0);
    const tx = uiLabel(text, { size: 15, color: Theme.color.textPrimary, bold: true, align: 'left' });
    tx.setParent(card);
    tx.getComponent(UITransform)!.anchorX = 0;
    tx.setPosition(-74, 10, 0);
    const ds = uiLabel(desc, { size: 10, color: Theme.color.textMuted, align: 'left' });
    ds.setParent(card);
    ds.getComponent(UITransform)!.anchorX = 0;
    ds.setPosition(-74, -12, 0);
    card.on(Node.EventType.TOUCH_END, onClick);
    return card;
  }

  // ============ BL-018 公开房间列表 ============
  private listBody: Node | null = null;
  private listCount: Label | null = null;
  private listAuto: Label | null = null;
  private listToast: Label | null = null;
  private listTimer: ReturnType<typeof setInterval> | null = null;

  onEnter(): void {
    this.refreshList();
    this.listTimer = setInterval(() => this.refreshList(), 5000);
    director.once(Director.EVENT_AFTER_UPDATE, () => this.alignListCount());
  }
  onExit(): void {
    if (this.listTimer) { clearInterval(this.listTimer); this.listTimer = null; }
  }

  /** 右列列表面板（还原原型 .room-list）：head(标题+计数+5s 自动+手动钮) + body(≤4 行/空态) + foot */
  private buildRoomList(root: Node): void {
    const panel = uiPanel(480, 272, { variant: 'gold', radius: Theme.radius.lg });
    panel.name = 'RoomList';
    panel.setParent(root);
    panel.setPosition(158, -17, 0);
    // head 底纹 + head/foot 分隔线（还原原型 .room-list-head bg rgba(212,165,55,.06)+border-bottom、.room-list-foot border-top）
    const deco = new Node('Deco');
    deco.addComponent(UITransform);
    const dg = deco.addComponent(Graphics);
    dg.fillColor = new Color(212, 165, 55, 15);
    dg.rect(-240, 102, 480, 34);
    dg.fill();
    dg.strokeColor = new Color(212, 165, 55, 30);
    dg.lineWidth = 1;
    dg.moveTo(-240, 102);
    dg.lineTo(240, 102);
    dg.stroke();
    dg.strokeColor = new Color(255, 255, 255, 10);
    dg.moveTo(-240, -112);
    dg.lineTo(240, -112);
    dg.stroke();
    deco.setParent(panel);
    const title = uiLabel('📋 公开房间', { size: 13, color: Theme.color.gold, bold: true, align: 'left' });
    title.name = 'HeadTitle';
    title.setParent(panel);
    title.getComponent(UITransform)!.anchorX = 0; // 左对齐标签须显式设锚（中心锚会使标题溢出面板左缘，原型 padding 0 14px）
    title.setPosition(-226, 119, 0);
    const count = uiLabel('0 桌', { size: 10, color: Theme.color.textMuted, align: 'left' });
    count.name = 'HeadCount';
    count.setParent(panel);
    count.getComponent(UITransform)!.anchorX = 0; // 标题右缘+gap 8（进大厅后按标题实测宽度校准，见 alignListCount）
    count.setPosition(-141, 119, 0);
    this.listCount = count.getComponent(Label);
    const auto = uiLabel('5s 自动刷新', { size: 9, color: Theme.color.textMuted, align: 'right', width: 120 });
    auto.setParent(panel);
    auto.getComponent(UITransform)!.anchorX = 1; // 右缘与手动钮留 gap 6（原型 .room-list-refresh）
    auto.setPosition(200, 119, 0);
    this.listAuto = auto.getComponent(Label);
    const refresh = uiButton('🔄', () => this.refreshList(), { variant: 'secondary', width: 20, height: 20, fontSize: 10 });
    refresh.setParent(panel);
    refresh.setPosition(216, 119, 0);
    this.listBody = new Node('Body');
    this.listBody.addComponent(UITransform).setContentSize(452, 214);
    this.listBody.setParent(panel);
    this.listBody.setPosition(0, -5, 0);
    const foot = uiLabel('仅展示公开且未关闭房间 · 对局中/满员不可加入', { size: 9, color: Theme.color.textMuted });
    foot.setParent(panel);
    foot.setPosition(0, -124, 0);
    const toast = uiLabel('', { size: 10, color: Theme.color.danger });
    toast.setParent(panel);
    toast.setPosition(0, -140, 0);
    this.listToast = toast.getComponent(Label);
  }

  private refreshList(): void {
    NetService.instance.requestRoomList()
      .then((rows) => { this.stampListAuto(); this.renderList(rows); })
      .catch(() => { this.stampListAuto(); this.renderList([]); });
  }

  /** head「5s 自动刷新 · 更新于 hh:mm:ss」（原型 .room-list-refresh / PRD03 §3.3） */
  private stampListAuto(): void {
    if (!this.listAuto) return;
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    this.listAuto.string = `5s 自动刷新 · ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /** head 计数跟随标题实测宽度（原型 flex gap 8）：Cocos Label 宽度渲染后才可测，进大厅后校准一次 */
  private alignListCount(): void {
    const panel = this.node?.getChildByName('RoomList');
    const t = panel?.getChildByName('HeadTitle');
    const c = panel?.getChildByName('HeadCount');
    if (!t || !c) return;
    const w = t.getComponent(UITransform)!.contentSize.width;
    if (w > 0) c.setPosition(-226 + w + 8, 119, 0);
  }

  private renderList(rows: PublicRoomEntry[]): void {
    const body = this.listBody;
    if (!body) return;
    body.destroyAllChildren();
    if (this.listCount) this.listCount.string = `${rows.length} 桌`;
    if (this.listToast) this.listToast.string = '';
    if (!rows.length) {
      const empty = uiLabel('暂无公开房间 · 成为第一个开桌的人', { size: 12, color: Theme.color.textMuted });
      empty.setParent(body);
      empty.setPosition(0, 40, 0);
      const go = uiButton('创建房间', () => this.openCreate(), { variant: 'primary', width: 120, height: 32, fontSize: 12 });
      go.setParent(body);
      go.setPosition(0, 0, 0);
      return;
    }
    rows.slice(0, 4).forEach((r, i) => {
      const row = new Node(`Row_${r.room}`);
      row.addComponent(UITransform).setContentSize(452, 44);
      row.setParent(body);
      row.setPosition(0, 80 - i * 44, 0);
      // 行分隔线（还原原型 .room-row border-bottom）
      const sep = new Node('Sep');
      sep.addComponent(UITransform);
      const sg = sep.addComponent(Graphics);
      sg.strokeColor = new Color(255, 255, 255, 10);
      sg.lineWidth = 1;
      sg.moveTo(-240, -22);
      sg.lineTo(240, -22);
      sg.stroke();
      sep.setParent(row);
      const code = uiLabel(r.room, { size: 14, color: Theme.color.goldLight, bold: true, align: 'left' });
      code.setParent(row);
      code.getComponent(UITransform)!.anchorX = 0;
      code.setPosition(-226, 0, 0);
      const host = uiLabel(`房主 ${r.host}`, { size: 11, color: Theme.color.textPrimary, align: 'left', width: 150 });
      host.setParent(row);
      host.getComponent(UITransform)!.anchorX = 0;
      host.setPosition(-160, 0, 0);
      const seats = uiLabel(`${r.seats}/4`, { size: 11, color: Theme.color.textSecondary });
      seats.setParent(row);
      seats.setPosition(40, 0, 0);
      const rounds = uiLabel(r.maxRounds > 0 ? `${r.maxRounds} 局` : '不限', { size: 10, color: Theme.color.textMuted });
      rounds.setParent(row);
      rounds.setPosition(90, 0, 0);
      const playing = r.status === 'playing';
      const full = r.seats >= 4;
      // 记忆房间（本人曾入座，服务端保留座位）→ 对局中/满员也允许「重进」；mine 双源：服务端权威标记（跨设备）+ 本地记忆房（兼容旧服务端）
      const mine = r.mine || r.room === NetService.instance.storedLastRoom();
      // 状态徽标胶囊（还原原型 .rr-badge：pill 描边+淡底，等待=金绿/对局中=灰）
      const pill = new Node('BadgePill');
      pill.addComponent(UITransform).setContentSize(42, 16);
      const pg = pill.addComponent(Graphics);
      pg.fillColor = playing ? new Color(255, 255, 255, 10) : new Color(159, 233, 176, 20);
      pg.strokeColor = playing ? new Color(255, 255, 255, 38) : new Color(159, 233, 176, 102);
      pg.lineWidth = 1;
      pg.roundRect(-21, -8, 42, 16, 8);
      pg.fill();
      pg.stroke();
      pill.setParent(row);
      pill.setPosition(140, 0, 0);
      const badge = uiLabel(playing ? '对局中' : '等待', { size: 9, color: playing ? Theme.color.textMuted : new Color(159, 233, 176, 255) });
      badge.setParent(row);
      badge.setPosition(140, 0, 0);
      const off = (playing || full) && !mine;
      const btn = uiButton(mine && (playing || full) ? '重进' : off ? (playing ? '对局中' : '已满') : '加入', off ? () => { /* 对局中/满员不可加入（观战预留） */ } : () => void this.joinFromList(r.room), { variant: off ? 'secondary' : 'primary', width: 64, height: 26, fontSize: 11 });
      btn.setParent(row);
      btn.setPosition(192, 0, 0);
    });
  }

  private async joinFromList(room: string): Promise<void> {
    try {
      const rv = await NetService.instance.joinRoom(room);
      // 与 doJoin 同路由：对局中/仪式重进直切牌桌（服务端加入期间已下发 gameView）
      const inGame = rv.phase === 'playing' || rv.phase === 'seating' || !!NetService.instance.view;
      this.router.show(inGame ? 'table' : 'room');
    } catch (e) {
      if (this.listToast) this.listToast.string = `加入失败：${(e as Error).message}`;
    }
  }

  /** 建房弹层（还原 home.html 创建房间横屏双列弹层）：左=局数 2×2（主+副双行）；右=房间与玩法设置开关（BL-020 先看吃再碰默认开 + BL-017 两开关默认开）+ 创建并分享 + modal-hint */
  private openCreate(): void {
    const m = uiModal('创建房间', { width: 720, height: 380 }); // BL-032：左列增时间档两行，加高
    const tip = uiLabel('选择局数上限', { size: 11, color: Theme.color.textMuted });
    tip.setParent(m.panel);
    tip.setPosition(-205, 104, 0);

    // 局数单选（默认 8 局标准局）：2×2 gap8；选中=透金底+金边+金字（原型 .rounds-option.selected）
    let rounds = 8;
    const opts: { v: number; main: string; sub: string }[] = [
      { v: 4, main: '4 局', sub: '快餐局' },
      { v: 8, main: '8 局', sub: '标准局' },
      { v: 16, main: '16 局', sub: '酣战局' },
      { v: 0, main: '不限', sub: '尽兴' },
    ];
    const btns: { node: Node; g: Graphics; main: Label; sub: Label; v: number }[] = [];
    const grid: [number, number][] = [[-255, 66], [-155, 66], [-255, 14], [-155, 14]];
    const paint = (b: { g: Graphics; main: Label; sub: Label }, sel: boolean): void => {
      b.g.clear();
      b.g.lineWidth = 1;
      b.g.fillColor = sel ? new Color(212, 165, 55, 51) : new Color(0, 0, 0, 77);
      b.g.strokeColor = sel ? Theme.color.gold : new Color(212, 165, 55, 51);
      b.g.roundRect(-46, -22, 92, 44, 8);
      b.g.fill();
      b.g.stroke();
      b.main.color = sel ? Theme.color.goldLight : Theme.color.textPrimary;
      b.sub.color = sel ? Theme.color.gold : Theme.color.textMuted;
    };
    opts.forEach((o, i) => {
      const node = new Node(`Rounds_${o.v}`);
      node.addComponent(UITransform).setContentSize(92, 44);
      const g = node.addComponent(Graphics);
      const mk = (nm: string, text: string, size: number, y: number, bold: boolean): Label => {
        const ln = new Node(nm);
        ln.addComponent(UITransform);
        const lb = ln.addComponent(Label);
        lb.string = text;
        lb.fontSize = size;
        lb.lineHeight = size + 4;
        lb.isBold = bold;
        ln.setParent(node);
        ln.setPosition(0, y, 0);
        return lb;
      };
      const b = { node, g, main: mk('Main', o.main, 13, 8, true), sub: mk('Sub', o.sub, 9, -10, false), v: o.v };
      btns.push(b);
      paint(b, o.v === rounds);
      node.on(Node.EventType.TOUCH_END, () => {
        rounds = o.v;
        for (const x of btns) paint(x, x.v === rounds);
      });
      node.setParent(m.panel);
      node.setPosition(grid[i]![0], grid[i]![1], 0);
    });

    // 房间与玩法设置（右列）：BL-018 公开房间默认开 + BL-020 先看吃再碰默认开 + BL-017 两开关默认开；选位仪式恒开不可关
    const psTitle = uiLabel('房间与玩法设置', { size: 11, color: Theme.color.textMuted });
    psTitle.setParent(m.panel);
    psTitle.setPosition(180, 104, 0);
    let isPublic = true; // BL-018：公开房间（默认开，进大厅列表）
    let chiFirstView = true;
    let physical = true;
    let breakDice = true;
    // BL-032 时间档（左列局数下方）：思考 10/15/20/30 默认 15；响应 5/8/10/15 默认 8；服务端钳制到档位
    let turnSec = 15;
    let respSec = 8;
    const segTitle = uiLabel('时间档（超时服务端代打）', { size: 10, color: Theme.color.textMuted });
    segTitle.setParent(m.panel);
    segTitle.setPosition(-205, -22, 0);
    const rowT = this.makeSegRow('思考时间', '自己回合摸/打最长等待', [10, 15, 20, 30], turnSec, (v) => { turnSec = v; });
    rowT.setParent(m.panel);
    rowT.setPosition(-205, -46, 0);
    const rowR = this.makeSegRow('响应时间', '吃/碰/杠/胡/过最长等待', [5, 8, 10, 15], respSec, (v) => { respSec = v; });
    rowR.setParent(m.panel);
    rowR.setPosition(-205, -86, 0);
    const rowPub = this.makePlayRow('公开房间', '开=进大厅列表可被发现；关=仅房号可入', isPublic, (on) => { isPublic = on; }, 340, 44);
    rowPub.setParent(m.panel);
    rowPub.setPosition(180, 84, 0);
    const row0 = this.makePlayRow('先看吃再碰', '吃意图公开，碰家看见后再决', chiFirstView, (on) => { chiFirstView = on; }, 340, 44);
    row0.setParent(m.panel);
    row0.setPosition(180, 36, 0);
    const row1 = this.makePlayRow('物理牌墙展示', '牌桌四方可见；关=随机发牌', physical, (on) => { physical = on; }, 340, 44);
    row1.setParent(m.panel);
    row1.setPosition(180, -12, 0);
    const row2 = this.makePlayRow('摸牌位骰', '每局骰定摸牌位', breakDice, (on) => { breakDice = on; }, 340, 44);
    row2.setParent(m.panel);
    row2.setPosition(180, -60, 0);
    const fixed = uiLabel('固定：点炮胡 / 自摸加底 / 选位仪式恒开', { size: 9, color: Theme.color.textMuted });
    fixed.setParent(m.panel);
    fixed.setPosition(180, -92, 0);

    const status = uiLabel('', { size: 11, color: Theme.color.textSecondary });
    const statusLbl = status.getComponent(Label)!;
    status.setParent(m.panel);
    status.setPosition(-205, -120, 0);
    const submit = uiButton('创建并分享', () => void this.doCreate(rounds, { wallMode: physical ? 'physical' : 'random', breakDice, chiFirstView, isPublic, turnSec, respSec }, m, statusLbl), { variant: 'primary', width: 240, height: 38, fontSize: 15 });
    submit.setParent(m.panel);
    submit.setPosition(-205, -154, 0);
    const hint = uiLabel('创建后生成 6 位房间号，可分享微信好友', { size: 10, color: Theme.color.textMuted });
    hint.setParent(m.panel);
    hint.setPosition(-205, -182, 0);

    m.root.setParent(this.node!);
  }

  /** 玩法设置行（还原 .play-row）：暗底金细边 + 名称/副文案左对齐双行 + 右侧开关，整行可点切换 */
  private makePlayRow(name: string, sub: string, initial: boolean, onChange: (on: boolean) => void, w = 376, h = 52): Node {
    const row = uiPanel(w, h, { variant: 'panel', radius: Theme.radius.md });
    row.name = `PlayRow_${name}`;
    const nameL = uiLabel(name, { size: 12, color: Theme.color.textPrimary, bold: true, align: 'left' });
    nameL.setParent(row);
    nameL.getComponent(UITransform)!.anchorX = 0;
    nameL.setPosition(-w / 2 + 12, h / 2 - 14, 0);
    const subL = uiLabel(sub, { size: 8.5, color: Theme.color.textMuted, align: 'left', width: w - 70 });
    subL.setParent(row);
    subL.getComponent(UITransform)!.anchorX = 0;
    subL.setPosition(-w / 2 + 12, -h / 2 + 10, 0);
    const sw = uiSwitch(initial, onChange, { interactive: false });
    sw.node.setParent(row);
    sw.node.setPosition(w / 2 - 30, 0, 0);
    // 整行可点（开关不自身响应，避免双触发）
    let on = initial;
    row.on(Node.EventType.TOUCH_END, () => {
      on = !on;
      sw.set(on);
      onChange(on);
    });
    return row;
  }

  /** BL-032 时间档行（还原 home.html .play-row+.seg）：暗底金细边 + 名称/副文案左对齐双行 + 右侧分段 pill（组内互斥） */
  private makeSegRow(name: string, sub: string, values: number[], initial: number, onChange: (v: number) => void): Node {
    const w = 300;
    const h = 36;
    const row = uiPanel(w, h, { variant: 'panel', radius: Theme.radius.md });
    row.name = `SegRow_${name}`;
    const nameL = uiLabel(name, { size: 10.5, color: Theme.color.textPrimary, bold: true, align: 'left' });
    nameL.setParent(row);
    nameL.getComponent(UITransform)!.anchorX = 0;
    nameL.setPosition(-w / 2 + 10, 7, 0);
    const subL = uiLabel(sub, { size: 8, color: Theme.color.textMuted, align: 'left' });
    subL.setParent(row);
    subL.getComponent(UITransform)!.anchorX = 0;
    subL.setPosition(-w / 2 + 10, -8, 0);
    const pills: { node: Node; g: Graphics; lb: Label; v: number }[] = [];
    const paint = (p: { g: Graphics; lb: Label }, sel: boolean): void => {
      p.g.clear();
      p.g.lineWidth = 1;
      p.g.fillColor = sel ? new Color(212, 165, 55, 45) : new Color(0, 0, 0, 89);
      p.g.strokeColor = sel ? Theme.color.gold : new Color(212, 165, 55, 64);
      p.g.roundRect(-16, -11, 32, 22, 6);
      p.g.fill();
      p.g.stroke();
      p.lb.color = sel ? Theme.color.goldLight : Theme.color.textSecondary;
    };
    values.forEach((v, i) => {
      const node = new Node(`Seg_${v}`);
      node.addComponent(UITransform).setContentSize(32, 22);
      const g = node.addComponent(Graphics);
      const lbNode = uiLabel(`${v}秒`, { size: 9, color: Theme.color.textSecondary, bold: true });
      lbNode.setParent(node);
      const p = { node, g, lb: lbNode.getComponent(Label)!, v };
      paint(p, v === initial);
      node.on(Node.EventType.TOUCH_END, () => {
        onChange(v);
        for (const x of pills) paint(x, x.v === v);
      });
      pills.push(p);
      node.setParent(row);
      node.setPosition(25 + i * 36, 0, 0);
    });
    return row;
  }

  private async doCreate(maxRounds: number, settings: { wallMode: 'physical' | 'random'; breakDice: boolean; chiFirstView: boolean; isPublic: boolean; turnSec: number; respSec: number }, m: Modal, statusLbl: Label): Promise<void> {
    statusLbl.string = '创建中…';
    statusLbl.color = Theme.color.textSecondary;
    try {
      await NetService.instance.createRoom(maxRounds, settings);
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
      const t0 = Date.now();
      const rv = await NetService.instance.joinRoom(room);
      m.close();
      // BL-016：对局中重进时服务端直接下发 gameView（加入期间到达，RoomScreen 可能尚未构建错过广播）→ 直接切牌桌
      // BL-017：仪式阶段（seating）重进同样切牌桌展示仪式遮罩
      const inGame = Date.now() - t0 < 5000 && Date.now() - NetService.instance.lastGameViewAt < 5000;
      this.router.show(inGame || rv.phase === 'playing' || rv.phase === 'seating' ? 'table' : 'room');
    } catch (e) {
      statusLbl.string = e instanceof Error ? e.message : '加入失败';
      statusLbl.color = Theme.color.danger;
    }
  }

  private openRules(): void {
    openRulesModal(this.node!);
  }
}
