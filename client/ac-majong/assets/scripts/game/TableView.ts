import { _decorator, Component, Node, Label, UITransform, Color, Sprite, Graphics, view } from 'cc';
import type { ViewState, GameEvent, RoomView } from '../vendor/protocol/index';
import { NetService } from './NetService';
import { chiOptions } from '../vendor/engine/index';
import { createTileNode, expandSorted, TILE_W, TILE_H } from './TileNode';

const { ccclass, property } = _decorator;

/**
 * 牌桌主控（挂在 Canvas）。
 * 职责：连服务端 → 订阅 ViewState → 动态渲染南家手牌/中央牌河/四家状态/状态栏；
 * 处理出牌（两步确认）与响应（吃碰杠胡/过）。
 * 牌与弃牌等全部运行时动态创建（数量每局变化，不在编辑器手摆）。
 */
@ccclass('TableView')
export class TableView extends Component {
  @property({ tooltip: '服务端 WS 地址' })
  serverUrl = 'ws://127.0.0.1:8080';
  @property({ tooltip: '登录 token（本地 mock 鉴权即 userId）' })
  token = 'player0';
  @property({ tooltip: '自动建房并由服务端补3个Bot开局（本地联调用；正式流程关闭）' })
  autoHost = true;
  @property({ tooltip: '本场总局数上限（打满后进入“对局结束”，可再来一局）' })
  maxRounds = 8;

  // 容器节点（在编辑器里拖拽绑定，或运行时按名查找）
  @property(Node) statusBar: Node | null = null;
  @property(Node) northPlayer: Node | null = null;
  @property(Node) westPlayer: Node | null = null;
  @property(Node) eastPlayer: Node | null = null;
  @property(Node) centerRiver: Node | null = null;
  @property(Node) southPlayer: Node | null = null;
  @property(Node) overlayLayer: Node | null = null;

  private net = NetService.instance;
  private selectedTile: string | null = null; // 已选中待出的牌
  private mySeat = -1;

  async start() {
    this.bindByNameIfNeeded();
    this.net.onView((v) => this.render(v));
    this.net.onEvent((m) => this.onEvents(m.events));
    this.net.onRoom((r) => this.onRoom(r));
    try {
      await this.net.connect(this.serverUrl, this.token);
      console.log('[TableView] 已连接服务端');
      if (this.autoHost) {
        this.net.createRoom(this.maxRounds);
      }
    } catch (e) {
      console.error('[TableView] 连接失败:', e);
    }
  }

  /** 未在编辑器绑定时，按节点名兜底查找（便于纯脚本联调） */
  private bindByNameIfNeeded() {
    const canvas = this.node;
    const find = (n: string) => canvas.getChildByName(n);
    this.statusBar ??= find('StatusBar');
    this.northPlayer ??= find('NorthPlayer');
    this.westPlayer ??= find('WestPlayer');
    this.eastPlayer ??= find('EastPlayer');
    this.centerRiver ??= find('CenterRiver');
    this.southPlayer ??= find('SouthPlayer');
    this.overlayLayer ??= find('OverlayLayer');
  }

  // ============ 渲染 ============

  private render(v: ViewState) {
    this.mySeat = v.you.seat;
    this.renderStatus(v);
    this.renderHand(v);
    this.renderMelds(v);
    this.renderRiver(v);
    this.renderOthers(v);
    this.renderActions(v);
  }

  private renderStatus(v: ViewState) {
    const wallLow = v.wallRemaining <= 8;
    const text = `房间 ${v.room}  第${v.round}局  剩${v.wallRemaining}张  连庄${v.lianzhuangCount}`;
    this.setLabel(this.statusBar, 'StatusLabel', text, wallLow ? new Color(230, 80, 80) : Color.WHITE);
  }

  /** 南家手牌：清空后按 concealed 重建，摸牌态多出的 1 张右移留缝 */
  private renderHand(v: ViewState) {
    const parent = this.southPlayer;
    if (!parent) return;
    const holder = this.ensureChild(parent, 'Hand');
    holder.removeAllChildren();
    const tiles = expandSorted(v.you.concealed);
    const gap = 3;
    const totalW = tiles.length * (TILE_W + gap) - gap;
    let x = -totalW / 2 + TILE_W / 2;
    for (const id of tiles) {
      const t = createTileNode(id);
      t.setParent(holder);
      const selected = id === this.selectedTile;
      t.setPosition(x, selected ? 12 : 0, 0);
      this.bindTileClick(t, id, v);
      x += TILE_W + gap;
    }
  }

  /** 南家明牌（吃/碰/杠）：手牌上方一排，每组小牌+标签 */
  private renderMelds(v: ViewState) {
    const parent = this.southPlayer;
    if (!parent) return;
    const holder = this.ensureChild(parent, 'Melds');
    holder.removeAllChildren();
    let x = -340;
    for (const meld of v.you.melds) {
      const g = new Node('Meld');
      g.addComponent(UITransform);
      g.setParent(holder);
      let mx = 0;
      for (const t of meld.tiles) {
        const tn = createTileNode(t, 26, 35);
        tn.setParent(g);
        tn.setPosition(mx, 0, 0);
        mx += 28;
      }
      const lbl = new Node('Lbl');
      lbl.addComponent(UITransform);
      const lb = lbl.addComponent(Label);
      lb.string = meldLabel(meld.type);
      lb.fontSize = 11;
      lb.color = new Color(255, 220, 120, 255);
      lbl.setParent(g);
      lbl.setPosition(mx / 2 - 14, -26, 0);
      g.setPosition(x + mx / 2, 46, 0);
      x += mx + 24;
    }
  }

  /** 中央牌河：按座位分 4 行展示全部弃牌，最新一张高亮 */
  private renderRiver(v: ViewState) {
    const parent = this.centerRiver;
    if (!parent) return;
    const holder = this.ensureChild(parent, 'Discards');
    holder.removeAllChildren();
    const rowY: Record<number, number> = { 0: -66, 1: -22, 2: 22, 3: 66 };
    const rows: Record<number, Node> = {};
    const counts: Record<number, number> = {};
    for (const seat of [0, 1, 2, 3]) {
      const row = new Node(`Row${seat}`);
      row.addComponent(UITransform);
      row.setParent(holder);
      row.setPosition(0, rowY[seat] ?? 0, 0);
      rows[seat] = row;
      counts[seat] = 0;
      const tag = new Node('Tag');
      tag.addComponent(UITransform);
      const tl = tag.addComponent(Label);
      tl.string = seat === v.you.seat ? `座${seat}(你)` : `座${seat}`;
      tl.fontSize = 12;
      tl.color = new Color(170, 170, 170, 255);
      tag.setParent(row);
      tag.setPosition(-352, 0, 0);
    }
    const small = 0.6;
    const step = TILE_W * small + 2;
    let lastNode: Node | null = null;
    for (const d of v.discards) {
      const row = rows[d.seat];
      if (!row) continue;
      const i = counts[d.seat]!;
      counts[d.seat] = i + 1;
      const t = createTileNode(d.tile, TILE_W * small, TILE_H * small);
      t.setParent(row);
      t.setPosition(-320 + i * step, 0, 0);
      lastNode = t;
    }
    const sp = lastNode?.getComponent(Sprite);
    if (sp) sp.color = new Color(255, 235, 170, 255); // 最新弃牌高亮
  }

  /** 三家：只显示暗牌张数 + 积分 + 子（防透视，服务端已裁剪） */
  private renderOthers(v: ViewState) {
    const seatNode: Record<number, Node | null> = {};
    // 相对自己：下家=北、对家=? 这里简单按绝对方位：其余三家分给 北/西/东
    const others = v.others;
    const slots = [this.northPlayer, this.westPlayer, this.eastPlayer];
    others.forEach((o, i) => {
      const parent = slots[i];
      if (!parent) return;
      this.setLabel(parent, 'Info', `座${o.seat}  暗${o.concealedCount}  分${o.score}  子${o.zi}`, Color.WHITE);
    });
  }

  /** 操作栏：出牌按钮 + 响应按钮，按 you.legal 显示/置灰 */
  private renderActions(v: ViewState) {
    const legal = v.you.legal;
    const canDraw = legal.includes('draw');
    const canDiscard = legal.includes('discard');
    const inResponse = v.phase === 'response';

    // 自己回合需摸牌：自动摸（简化；正式可做"摸牌"按钮）
    if (canDraw && v.currentSeat === this.mySeat) {
      this.net.draw(this.mySeat);
    }

    const bar = this.ensureChild(this.overlayLayer!, 'ActionBar');
    bar.removeAllChildren();
    const actions: { label: string; fn: () => void }[] = [];
    if (legal.includes('win_draw')) actions.push({ label: '胡', fn: () => this.net.declareWin(this.mySeat) });
    // 响应阶段：仅当自己真有可选动作（胡/碰/杠/吃）时才弹按钮+过；被服务端自动过的人不显示
    const hasRealOption =
      inResponse &&
      (legal.includes('win_discard') || legal.includes('pong') || legal.includes('kong_exposed') || legal.includes('chi'));
    if (hasRealOption) {
      if (legal.includes('win_discard')) actions.push({ label: '胡', fn: () => this.net.respond(this.mySeat, 'win') });
      if (legal.includes('pong')) actions.push({ label: '碰', fn: () => this.net.respond(this.mySeat, 'pong') });
      if (legal.includes('kong_exposed')) actions.push({ label: '杠', fn: () => this.net.respond(this.mySeat, 'kong_exposed') });
      if (legal.includes('chi')) actions.push({ label: '吃', fn: () => this.doChi(v) });
      actions.push({ label: '过', fn: () => this.net.respond(this.mySeat, 'pass') });
    }
    if (canDiscard && this.selectedTile) actions.push({ label: '出牌', fn: () => this.doDiscard() });

    let bx = -((actions.length - 1) * 70) / 2;
    for (const a of actions) {
      const btn = this.makeButton(a.label, a.fn);
      btn.setParent(bar);
      btn.setPosition(bx, 0, 0);
      bx += 70;
    }
  }

  // ============ 交互 ============

  private bindTileClick(tileNode: Node, id: string, v: ViewState) {
    tileNode.on(Node.EventType.TOUCH_END, () => {
      if (v.currentSeat !== this.mySeat || v.phase !== 'discard') return;
      this.selectedTile = this.selectedTile === id ? null : id; // 再次点击取消
      this.render(this.net.view!);
    });
  }

  private doDiscard() {
    if (!this.selectedTile) return;
    const tile = this.selectedTile;
    this.selectedTile = null;
    this.net.discard(this.mySeat, tile);
  }

  /** 吃：取第一个可行顺子（多解时后续加选择器）；chiTiles=除弃牌外的两张手牌 */
  private doChi(v: ViewState) {
    const tile = v.lastDiscard?.tile;
    if (!tile) return;
    const me = { seat: this.mySeat, concealed: v.you.concealed, melds: [], flowers: [], zi: 0, score: 0 };
    const opts = chiOptions(me, tile);
    const combo = opts[0];
    if (!combo) return;
    const handTiles = combo.filter((x) => x !== tile);
    this.net.respond(this.mySeat, 'chi', handTiles);
  }

  // ============ 局末结算 ============

  private onEvents(events: GameEvent[]) {
    for (const ev of events) {
      if (ev.type === 'win' || ev.type === 'exhaustive' || ev.type === 'zhahu') {
        this.showSettlement(ev);
      }
    }
  }

  /** 局末结算浮层：结果 + 分数变动 + 四家亮牌；点击关闭 */
  private showSettlement(ev: Extract<GameEvent, { type: 'win' | 'exhaustive' | 'zhahu' }>) {
    this.node.getChildByName('Settlement')?.destroy();
    const panel = new Node('Settlement');
    const ptf = panel.addComponent(UITransform);
    ptf.setContentSize(844, 390);
    const g = panel.addComponent(Graphics);
    g.fillColor = new Color(0, 0, 0, 190);
    g.rect(-422, -195, 844, 390);
    g.fill();
    panel.setParent(this.node);
    panel.setPosition(0, 0, 0);

    let title = '';
    let delta: Record<number, number> = {};
    let revealed: Record<number, Record<string, number>> = {};
    if (ev.type === 'win') {
      title = ev.winners.map((w) => `座${w.seat} 胡 ${w.tai}台`).join('  /  ');
      delta = ev.delta;
      revealed = ev.revealed;
    } else if (ev.type === 'exhaustive') {
      title = '流局（荒庄）· 庄家连庄';
      revealed = ev.revealed;
    } else {
      title = `座${ev.seat} 诈胡`;
    }

    const t = new Node('Title');
    t.addComponent(UITransform);
    const tl = t.addComponent(Label);
    tl.string = title;
    tl.fontSize = 28;
    tl.color = new Color(255, 215, 100, 255);
    t.setParent(panel);
    t.setPosition(0, 150, 0);

    if (Object.keys(delta).length) {
      const d = new Node('Delta');
      d.addComponent(UITransform);
      const dl = d.addComponent(Label);
      dl.string = [0, 1, 2, 3]
        .map((s) => `座${s} ${ (delta[s] ?? 0) >= 0 ? '+' : '' }${delta[s] ?? 0}`)
        .join('   ');
      dl.fontSize = 16;
      dl.color = Color.WHITE;
      d.setParent(panel);
      d.setPosition(0, 120, 0);
    }

    let y = 80;
    for (const seat of [0, 1, 2, 3]) {
      const hand = revealed[seat];
      if (!hand) continue;
      const row = new Node(`Rev${seat}`);
      row.addComponent(UITransform);
      row.setParent(panel);
      row.setPosition(0, y, 0);
      const tag = new Node('Tag');
      tag.addComponent(UITransform);
      const tagL = tag.addComponent(Label);
      tagL.string = seat === this.mySeat ? `座${seat}(你)` : `座${seat}`;
      tagL.fontSize = 13;
      tagL.color = new Color(200, 200, 200, 255);
      tag.setParent(row);
      tag.setPosition(-380, 0, 0);
      const tiles = expandSorted(hand);
      let x = -340;
      for (const id of tiles) {
        const tn = createTileNode(id, 22, 30);
        tn.setParent(row);
        tn.setPosition(x, 0, 0);
        x += 24;
      }
      y -= 42;
    }

    // 续局按钮：非末局→“下一局”，末局→“查看最终结果”（都发 nextRound，服务端据此推进或置 finished）
    const cur = this.net.view;
    const isLast = (cur?.round ?? 1) >= (cur?.maxRounds ?? this.maxRounds);
    const cont = this.makeWideButton(isLast ? '查看最终结果' : '下一局 ▶', () => {
      panel.destroy();
      this.net.nextRound();
    });
    cont.setParent(panel);
    cont.setPosition(0, -150, 0);
  }

  /** 房间视图：打满总局数 → 对局结束屏 */
  private onRoom(r: RoomView) {
    if (r.phase === 'finished') this.showGameOver();
  }

  /** 对局结束屏：四家最终积分/子排名 + 再来一局 */
  private showGameOver() {
    this.node.getChildByName('GameOver')?.destroy();
    this.node.getChildByName('Settlement')?.destroy();
    const v = this.net.view;
    const panel = new Node('GameOver');
    const ptf = panel.addComponent(UITransform);
    ptf.setContentSize(844, 390);
    const g = panel.addComponent(Graphics);
    g.fillColor = new Color(10, 22, 16, 238);
    g.rect(-422, -195, 844, 390);
    g.fill();
    panel.setParent(this.node);
    panel.setPosition(0, 0, 0);

    const t = new Node('Title');
    t.addComponent(UITransform);
    const tl = t.addComponent(Label);
    tl.string = '对局结束';
    tl.fontSize = 30;
    tl.color = new Color(255, 215, 100, 255);
    t.setParent(panel);
    t.setPosition(0, 150, 0);

    const rows: { seat: number; score: number; zi: number; me: boolean }[] = [];
    if (v) {
      rows.push({ seat: v.you.seat, score: v.you.score, zi: v.you.zi, me: true });
      for (const o of v.others) rows.push({ seat: o.seat, score: o.score, zi: o.zi, me: false });
    }
    rows.sort((a, b) => b.score - a.score);
    let y = 88;
    rows.forEach((r, i) => {
      const row = new Node(`Rank${i}`);
      row.addComponent(UITransform);
      const lb = row.addComponent(Label);
      lb.string = `${i + 1}.  座${r.seat}${r.me ? '(你)' : ''}    积分 ${r.score}    子 ${r.zi}`;
      lb.fontSize = 20;
      lb.color = i === 0 ? new Color(255, 225, 130, 255) : Color.WHITE;
      row.setParent(panel);
      row.setPosition(0, y, 0);
      y -= 40;
    });

    const btn = this.makeWideButton('再来一局', () => {
      panel.destroy();
      this.net.restart(this.maxRounds);
    });
    btn.setParent(panel);
    btn.setPosition(0, -140, 0);
  }

  // ============ 小工具 ============

  private ensureChild(parent: Node, name: string): Node {
    let n = parent.getChildByName(name);
    if (!n) {
      n = new Node(name);
      n.addComponent(UITransform);
      n.setParent(parent);
    }
    return n;
  }

  private setLabel(parent: Node | null, name: string, text: string, color: Color) {
    if (!parent) return;
    const n = this.ensureChild(parent, name);
    let lb = n.getComponent(Label);
    if (!lb) {
      lb = n.addComponent(Label);
      lb.fontSize = 16;
      lb.lineHeight = 18;
    }
    lb.string = text;
    lb.color = color;
  }

  private makeButton(text: string, onClick: () => void): Node {
    const n = new Node(`Btn_${text}`);
    const tf = n.addComponent(UITransform);
    tf.setContentSize(64, 42);
    const g = n.addComponent(Graphics);
    g.fillColor = new Color(214, 178, 60, 255); // 金色实底，高对比
    g.roundRect(-32, -21, 64, 42, 8);
    g.fill();
    const lbNode = new Node('Label');
    lbNode.addComponent(UITransform);
    const lb = lbNode.addComponent(Label);
    lb.string = text;
    lb.fontSize = 20;
    lb.color = new Color(35, 26, 8, 255);
    lbNode.setParent(n);
    n.on(Node.EventType.TOUCH_END, onClick);
    return n;
  }

  /** 宽按钮（用于结算/结束屏的长文案，如“下一局”“再来一局”） */
  private makeWideButton(text: string, onClick: () => void): Node {
    const n = new Node(`Btn_${text}`);
    const tf = n.addComponent(UITransform);
    tf.setContentSize(220, 50);
    const g = n.addComponent(Graphics);
    g.fillColor = new Color(214, 178, 60, 255);
    g.roundRect(-110, -25, 220, 50, 12);
    g.fill();
    const lbNode = new Node('Label');
    lbNode.addComponent(UITransform);
    const lb = lbNode.addComponent(Label);
    lb.string = text;
    lb.fontSize = 24;
    lb.color = new Color(35, 26, 8, 255);
    lbNode.setParent(n);
    n.on(Node.EventType.TOUCH_END, onClick);
    return n;
  }
}

function meldLabel(t: string): string {
  switch (t) {
    case 'chi': return '吃';
    case 'pong': return '碰';
    case 'kong_exposed': return '明杠';
    case 'kong_concealed': return '暗杠';
    case 'kong_added': return '加杠';
    default: return t;
  }
}
