import { Node, UITransform, Graphics, Color, BlockInputEvents, Label, tween, Tween, Vec3, UIOpacity } from 'cc';
import { Screen } from '../app/SceneRouter';
import { Theme, rgba } from '../ui/Theme';
import { uiLabel, uiButton, uiPanel, setButtonEnabled, uiMuteToggle } from '../ui/UiKit';
import { openRulesModal } from '../ui/RulesModal';
import { openSettingsModal } from '../ui/SettingsModal';
import { AudioManager, SfxName } from '../ui/AudioManager';
import { NetService } from './NetService';
import { createTileNode, expandSorted } from './TileNode';
import { chiOptions, waitingTiles, previewTai, addedKongOptions, concealedKongOptions, HONOR_NAMES } from '../vendor/engine/index';
import type { ViewState, GameEvent, Meld, RoomView, SeatingView } from '../vendor/protocol/index';

/**
 * 牌桌页（P6，还原 game.html v2「方案A 中央公共牌河」，横屏 844×390）。
 * 布局（垂直预算）：状态栏左上~30 / 北家~47 / 中央牌河~232 / 南家~105。
 * 水平预算：西~78 / 中央牌河~688 / 东~78；南家手牌行 = 手牌 + 出牌圆钮（兄弟并排不重叠）。
 * 交互：两步出牌、响应浮层(吃碰杠胡过+倒计时)、吃牌多解、听牌提示、台数徽章+预览浮层、诈胡置灰。
 * 防透视：他家仅暗牌张数（服务端裁剪）；昵称经 ViewState.names 下发。
 */

// 设计坐标（中心原点）
const W = 844;
const H = 390;
const TOP = H / 2;
const LEFT = -W / 2;
const RIGHT = W / 2;
// 牌尺寸
const EDGE_H = { w: 19, h: 13 }; // 北家牌侧横
const EDGE_V = { w: 13, h: 15 }; // 西/东牌侧竖
const MELD_N = { w: 16, h: 22 };
const MELD_S = { w: 14, h: 19 };
const MELD_ME = { w: 20, h: 28 }; // 方案A重排：明牌行缩小贴手牌
const RIVER_T = { w: 18, h: 25 };
const HAND_T = { w: 38, h: 48 }; // 方案A重排：手牌略缩下移，抬升量减小

export class TableScreen extends Screen {
  readonly name = 'table';
  private net = NetService.instance;
  private mySeat = -1;
  private selectedIdx: number | null = null; // 选中手牌的位置索引（非牌 ID，避免一对牌同时抬起）
  private revealed: Record<number, Record<string, number>> | null = null; // 终局摊牌：各家暗牌（win/exhaustive 事件下发）
  private listening = false;

  private statusBar!: Node;
  private northArea!: Node;
  private westArea!: Node;
  private eastArea!: Node;
  private riverArea!: Node;
  private southTop!: Node;
  private southHand!: Node;
  private overlay!: Node;
  private discardBtn!: Node;
  private discardRing: Node | null = null;
  private statusCdLbl: Node | null = null;
  // BL-017：四边物理牌墙排（physical 模式）与开局仪式/摸牌位骰遮罩
  private wallRoot!: Node;
  private seatingRoot!: Node;
  // BL-017：开牌点图例瞬态提示（新局显示一次、5s 自隐；操作浮层出现立即隐藏）
  private wallLegend: Node | null = null;
  private wallLegendRound = -1;
  private wallLegendTween: Tween<Node> | null = null;
  private lastRoom: RoomView | null = null;

  // 响应倒计时（FR-对局-13）
  private cdTotal = 0;
  private cdRemain = 0;
  private cdRunning = false;
  private cdBar: Node | null = null;
  private cdOnTimeout: (() => void) | null = null;
  private cdTimer: ReturnType<typeof setInterval> | null = null;
  // 当前响应窗锚点（局序+弃牌序+弃牌）：窗内任何广播重建不得重置倒计时（2026-09-18 bugfix）
  private cdRespKey = '';
  // 自己回合展示倒计时（仅视觉：状态栏⏱ + 出牌钮环）
  private turnCd = 0;
  private turnTimer: ReturnType<typeof setInterval> | null = null;
  // BL-014：发牌音去重（每局仅在 round 变化时播一次）
  private lastSoundRound = -1;

  build(): Node {
    const root = new Node('TableScreen');
    root.addComponent(UITransform).setContentSize(W, H);
    this.drawTableBg(root);

    this.statusBar = this.mk(root, 'StatusBar', 0, 0);
    this.northArea = this.mk(root, 'North', 0, 150);
    this.westArea = this.mk(root, 'West', LEFT + 64, 0);
    this.eastArea = this.mk(root, 'East', RIGHT - 64, 0);
    this.riverArea = this.mk(root, 'River', 0, 25);
    this.southTop = this.mk(root, 'SouthTop', 0, -104);
    this.southHand = this.mk(root, 'SouthHand', 0, -156);
    // BL-017：牌墙排在牌桌层之上、遮罩之下（2D 渲染序=兄弟顺序，必须先于 overlay 创建）；仪式遮罩在 overlay 之上
    this.wallRoot = this.mk(root, 'WallBoard', 0, 0);
    this.overlay = this.mk(root, 'Overlay', 0, 0);
    this.seatingRoot = this.mk(root, 'SeatingLayer', 0, 0);

    // 出牌圆钮（手牌行右端兄弟节点，不重叠）
    this.discardBtn = this.makeDiscardBtn();
    this.discardBtn.setParent(this.southHand);

    // 静音开关（BL-014 最简本地开关，右上角）
    const mute = uiMuteToggle(30);
    mute.setParent(root);
    mute.setPosition(RIGHT - 24, TOP - 22, 0);

    this.net.onView((v) => this.render(v));
    this.net.onEvent((m) => this.onEvents(m.events));
    this.net.onRoomEnd(() => this.router.show('result'));
    this.net.onReconnect((s) => this.showReconnect(s));
    // BL-017：开局仪式（phase=seating）随 roomView 广播驱动遮罩
    this.net.onRoom((r) => {
      this.lastRoom = r;
      if (r.phase === 'seating') this.renderSeating(r.seating ?? null, r);
      else if (!this.net.view?.seating) this.hideSeating();
    });
    return root;
  }

  onEnter(): void {
    if (this.net.view) this.render(this.net.view);
    // BL-017：进页时若房间处于仪式阶段（start 后/重连），立即渲染遮罩
    const r = this.net.room;
    if (r) {
      this.lastRoom = r;
      if (r.phase === 'seating') this.renderSeating(r.seating ?? null, r);
    }
    if (this.net.view?.seating) this.renderSeating(this.net.view.seating, this.lastRoom);
  }
  onExit(): void {
    this.stopCountdown();
    this.stopTurnCd();
  }

  // ============ 渲染 ============

  private render(v: ViewState): void {
    this.selectedIdx = null; // 视图刷新（手牌可能变化）时清除选中
    if (v.phase !== 'settled' && v.phase !== 'exhaustive') this.revealed = null; // 新局开始收起摊牌
    this.mySeat = v.you.seat;
    // BL-014：进入新的一局（round 变化且非终局相位）播发牌音
    if (v.round !== this.lastSoundRound && v.phase !== 'settled' && v.phase !== 'exhaustive') {
      this.lastSoundRound = v.round;
      AudioManager.instance.play('deal');
    }
    this.renderStatus(v);
    this.renderNorth(v);
    this.renderSide(this.westArea, v, 3); // 上家=西
    this.renderSide(this.eastArea, v, 1); // 下家=东
    this.renderRiver(v);
    this.renderSouth(v);
    this.renderActions(v);
    this.renderWalls(v); // BL-017：physical 模式四边牌墙排
    this.renderSeating(v.seating ?? null, this.lastRoom); // BL-017：局间摸牌位骰遮罩（roundBreak）
    this.runAnims(v);
  }

  /** 顶部状态栏（左上角胶囊 + 分隔线 + 金色数值 + ⏱） */
  private renderStatus(v: ViewState): void {
    this.statusBar.destroyAllChildren();
    const low = v.wallRemaining <= 8;
    const cd = this.cdRunning ? this.cdRemain : this.turnCd;
    const segs: { pre: string; val: string; post?: string; valColor?: Color }[] = [
      { pre: '🀄 ', val: windName(v.round), valColor: Theme.color.textSecondary },
      { pre: '房 ', val: v.room },
      { pre: '第 ', val: `${v.round}/${v.maxRounds > 0 ? v.maxRounds : '∞'}`, post: ' 局' },
      { pre: '剩 ', val: `${v.wallRemaining}`, post: ' 张', valColor: low ? Theme.color.danger : undefined },
      { pre: '⏱ ', val: `${cd}`, post: 's' },
    ];
    // 单行不折行（原型 white-space:nowrap）：CJK 按字号估宽、ASCII 按 6px；标签不设 width（自然宽，避免 RESIZE_HEIGHT 折行）
    const SZ = 10;
    const tw = (s: string): number => {
      let w = 0;
      for (const ch of s) w += ch.charCodeAt(0) > 255 ? SZ : 6;
      return w;
    };
    const DIV = 7;
    const GAP = 5;
    let total = 20;
    segs.forEach((s, i) => {
      total += tw(s.pre) + tw(s.val) + tw(s.post ?? '') + GAP;
      if (i > 0) total += DIV;
    });
    const bar = uiPanel(total, 22, { variant: 'panel', radius: Theme.radius.full });
    bar.setParent(this.statusBar);
    bar.setPosition(LEFT + 10 + total / 2, TOP - 6 - 11, 0);
    let x = -total / 2 + 10;
    segs.forEach((s, i) => {
      if (i > 0) {
        const dv = new Node('Div');
        dv.addComponent(UITransform).setContentSize(1, 12);
        const dg = dv.addComponent(Graphics);
        dg.strokeColor = Theme.color.goldFaint;
        dg.lineWidth = 1;
        dg.moveTo(0, -6);
        dg.lineTo(0, 6);
        dg.stroke();
        dv.setParent(bar);
        dv.setPosition(x + DIV / 2, 0, 0);
        x += DIV;
      }
      const pre = uiLabel(s.pre, { size: SZ, color: Theme.color.textSecondary, align: 'left' });
      pre.setParent(bar);
      pre.setPosition(x + tw(s.pre) / 2, 0, 0);
      x += tw(s.pre);
      const val = uiLabel(s.val, { size: SZ, color: s.valColor ?? Theme.color.gold, bold: true, align: 'left' });
      val.setParent(bar);
      val.setPosition(x + tw(s.val) / 2, 0, 0);
      x += tw(s.val);
      if (s.post) {
        const post = uiLabel(s.post, { size: SZ, color: Theme.color.textSecondary, align: 'left' });
        post.setParent(bar);
        post.setPosition(x + tw(s.post) / 2, 0, 0);
        x += tw(s.post);
      }
      x += GAP;
      if (s.pre === '⏱ ') this.statusCdLbl = val;
    });
  }

  /** 北家：pinfo 居中 + [明牌横排 | 牌侧横条] */
  private renderNorth(v: ViewState): void {
    this.northArea.destroyAllChildren();
    const o = v.others.find((x) => relOf(x.seat, this.mySeat) === 2);
    if (!o) return;
    const name = this.nameOf(v, o.seat);
    const pinfo = this.drawPinfo({ name, score: o.score, zi: o.zi, isDealer: o.seat === v.dealerSeat, isActive: this.isActive(v, o.seat), lianzhuang: v.lianzhuangCount, ...this.seatFlags(o.seat) });
    pinfo.setParent(this.northArea);
    pinfo.setPosition(0, 26, 0);
    // body: 明牌(左) + 牌侧横条(右)
    const body = this.mk(this.northArea, 'Body', 0, 0);
    const meldW = this.drawMelds(body, o.melds ?? [], MELD_N, 'h', o.seat, this.pendChiFor(v, o.seat));
    const rev = this.revealed?.[o.seat];
    const revTiles = rev ? expandSorted(rev) : null;
    const RT = { w: 16, h: 22 }; // 摊牌牌面尺寸
    const edgeW = revTiles ? revTiles.length * (RT.w + 1) : o.concealedCount * (EDGE_H.w + 1);
    const totalW = meldW + (meldW ? 10 : 0) + edgeW;
    // 明牌在左
    if (meldW) body.getChildByName('Melds')?.setPosition(-totalW / 2 + meldW / 2, 6, 0);
    // 牌侧横条在右（终局摊牌时为面牌横排）
    const edge = this.mk(body, 'Edge', -totalW / 2 + meldW + (meldW ? 10 : 0) + edgeW / 2, 0);
    if (revTiles) {
      revTiles.forEach((t, i) => {
        const tn = createTileNode(t, RT.w, RT.h);
        tn.setParent(edge);
        tn.setPosition(-edgeW / 2 + i * (RT.w + 1) + RT.w / 2, 0, 0);
      });
    } else {
      for (let i = 0; i < o.concealedCount; i++) {
        const e = this.drawEdge(EDGE_H.w, EDGE_H.h, 'top');
        e.setParent(edge);
        e.setPosition(-edgeW / 2 + i * (EDGE_H.w + 1) + EDGE_H.w / 2, 0, 0);
      }
    }
  }

  /** 西/东家：整块垂直居中，pinfo 在上、body(牌背竖条|明牌竖排) 在下（还原 game.html .player-west/.player-east 列布局） */
  private renderSide(area: Node, v: ViewState, rel: 1 | 3): void {
    area.destroyAllChildren();
    const o = v.others.find((x) => relOf(x.seat, this.mySeat) === rel);
    if (!o) return;
    const isWest = rel === 3;
    const name = this.nameOf(v, o.seat);
    const body = this.mk(area, 'Body', 0, 0);
    const meldH = this.drawMelds(body, o.melds ?? [], MELD_S, 'v', o.seat, this.pendChiFor(v, o.seat));
    // 牌背多时压缩间距，避免竖条底端压到南家信息行
    const pitch = o.concealedCount > 12 ? EDGE_V.h - 2 : EDGE_V.h + 1;
    const edgeH = o.concealedCount * pitch;
    const bodyH = Math.max(edgeH, meldH);
    const PH = 24;
    const GAPV = 4;
    const groupH = PH + GAPV + bodyH;
    const SIDE_Y = 12; // 整组略上移，给南家行让位
    const pinfo = this.drawPinfo({ name, score: o.score, zi: o.zi, isDealer: o.seat === v.dealerSeat, isActive: this.isActive(v, o.seat), lianzhuang: v.lianzhuangCount, ...this.seatFlags(o.seat) });
    pinfo.setParent(area);
    pinfo.setPosition(0, SIDE_Y + groupH / 2 - PH / 2, 0);
    body.setPosition(0, SIDE_Y - groupH / 2 + bodyH / 2, 0);
    // body 内一行水平居中：牌背竖条靠外、明牌竖排靠中央
    const rev = this.revealed?.[o.seat];
    const revTiles = rev ? expandSorted(rev) : null;
    const RT = { w: 16, h: 22 }; // 摊牌牌面尺寸
    const edgeW = revTiles ? RT.w * 2 + 3 : EDGE_V.w;
    const meldColW = meldH ? MELD_S.w : 0;
    const rowW = edgeW + (meldColW ? 4 + meldColW : 0);
    const edgeX = isWest ? -rowW / 2 + edgeW / 2 : rowW / 2 - edgeW / 2;
    const meldX = isWest ? -rowW / 2 + edgeW + 4 + meldColW / 2 : rowW / 2 - edgeW - 4 - meldColW / 2;
    const edge = this.mk(body, 'Edge', edgeX, 0);
    if (revTiles) {
      // 终局摊牌：面牌双竖列（高度预算内可读）
      const per = Math.ceil(revTiles.length / 2);
      const pitchY = RT.h + 1;
      revTiles.forEach((t, i) => {
        const col = Math.floor(i / per);
        const row = i % per;
        const tn = createTileNode(t, RT.w, RT.h);
        tn.setParent(edge);
        tn.setPosition((col - 0.5) * (RT.w + 3), ((per - 1) * pitchY) / 2 - row * pitchY, 0);
      });
    } else {
      for (let i = 0; i < o.concealedCount; i++) {
        const e = this.drawEdge(EDGE_V.w, EDGE_V.h, isWest ? 'left' : 'right');
        e.setParent(edge);
        e.setPosition(0, edgeH / 2 - i * pitch - EDGE_V.h / 2, 0);
      }
    }
    if (meldH) body.getChildByName('Melds')?.setPosition(meldX, 0, 0);
  }

  /** 中央公共牌河：北顶/南底居中换行 + 西左/东右换行 + 风圈盘 */
  private renderRiver(v: ViewState): void {
    this.riverArea.destroyAllChildren();
    const RW = 668;
    const RH = 204;
    const buckets: Record<number, string[]> = { 0: [], 1: [], 2: [], 3: [] };
    v.discards.forEach((d) => buckets[d.seat]?.push(d.tile));
    const latestIdx = v.discards.length - 1;
    const latestTile = latestIdx >= 0 ? v.discards[latestIdx] : null;
    const latestSeat = latestTile ? latestTile.seat : -1;
    const nSeat = relSeat(v, this.mySeat, 2);
    const wSeat = relSeat(v, this.mySeat, 3);
    const eSeat = relSeat(v, this.mySeat, 1);
    // 北（对家）弃牌：顶部居中换行
    this.drawRiverBlock(this.riverArea, buckets[nSeat] ?? [], 23, 0, RH / 2 - 36, 'center', latestSeat === nSeat);
    // 南（自己）弃牌：底部居中换行
    this.drawRiverBlock(this.riverArea, buckets[this.mySeat] ?? [], 23, 0, -RH / 2 + 36, 'center', latestSeat === this.mySeat, true);
    // 西（上家）弃牌：6 列横排、置于墙列与风盘之间（墙列内侧，2026-09-18 用户确认）；行内自左→右（边缘→中心），行自 y+40 向下排
    this.drawRiverBlock(this.riverArea, buckets[wSeat] ?? [], 6, -150, 40, 'left', latestSeat === wSeat);
    // 东（下家）弃牌：6 列横排、墙列内侧；行内自右→左（边缘→中心）
    this.drawRiverBlock(this.riverArea, buckets[eSeat] ?? [], 6, 150, 40, 'right', latestSeat === eSeat);

    this.drawWindDisc(v);
  }

  private drawRiverBlock(parent: Node, tiles: string[], perRow: number, cx: number, cy: number, align: 'center' | 'left' | 'right', highlightLast: boolean, fromBottom = false): void {
    if (!tiles.length) return;
    const step = RIVER_T.w + 2;
    const rowH = RIVER_T.h + 2;
    const posOf = (i: number): { x: number; y: number } => {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      const count = Math.min(perRow, tiles.length - r * perRow);
      // align：left=列位固定自左→右填（西：边缘→中心）；right=列位镜像自右→左填（东：边缘→中心）；center=逐行居中（北/南）
      const px = align === 'left' ? (c - (perRow - 1) / 2) * step
        : align === 'right' ? ((perRow - 1) / 2 - c) * step
        : (c - (count - 1) / 2) * step;
      const py = fromBottom ? cy + r * rowH : cy - r * rowH;
      return { x: px, y: py };
    };
    tiles.forEach((t, i) => {
      const p = posOf(i);
      const node = createTileNode(t, RIVER_T.w, RIVER_T.h);
      node.setParent(parent);
      node.setPosition(cx + p.x, p.y, 0);
    });
    if (highlightLast) {
      const lastTile = parent.children[parent.children.length - 1];
      if (lastTile) lastTile.name = 'RTileLast'; // M-J：最新弃牌弹窗锚点
      const p = posOf(tiles.length - 1);
      const ring = new Node('Latest');
      ring.addComponent(UITransform);
      const g = ring.addComponent(Graphics);
      g.strokeColor = Theme.color.gold;
      g.lineWidth = 2;
      g.roundRect(-RIVER_T.w / 2 - 2, -RIVER_T.h / 2 - 2, RIVER_T.w + 4, RIVER_T.h + 4, 4);
      g.stroke();
      ring.setParent(parent);
      ring.setPosition(cx + p.x, p.y, 0);
    }
  }

  /** 风圈指示盘：圆盘 + 中心风 + 四方位标记（当前庄家方位高亮） */
  private drawWindDisc(v: ViewState): void {
    const disc = new Node('Wind');
    disc.addComponent(UITransform).setContentSize(58, 58);
    const g = disc.addComponent(Graphics);
    g.fillColor = rgba(13, 74, 42, 0.92);
    g.circle(0, 0, 29);
    g.fill();
    g.strokeColor = rgba(212, 165, 55, 0.35);
    g.lineWidth = 1.5;
    g.circle(0, 0, 29);
    g.stroke();
    disc.setParent(this.riverArea);
    const wc = uiLabel(windName(v.round).slice(0, 1), { size: 20, color: Theme.color.gold, bold: true });
    wc.setParent(disc);
    const dealerRel = relOf(v.dealerSeat, this.mySeat);
    const pos: { rel: number; label: string; x: number; y: number }[] = [
      { rel: 2, label: '北', x: 0, y: 33 },
      { rel: 1, label: '东', x: 33, y: 0 },
      { rel: 0, label: '南', x: 0, y: -33 },
      { rel: 3, label: '西', x: -33, y: 0 },
    ];
    for (const p of pos) {
      const on = p.rel === dealerRel;
      const n = new Node('Pos');
      n.addComponent(UITransform).setContentSize(14, 14);
      if (on) {
        const pg = n.addComponent(Graphics);
        pg.fillColor = Theme.color.gold;
        pg.circle(0, 0, 7);
        pg.fill();
      }
      const lb = uiLabel(p.label, { size: 8, color: on ? Theme.color.bgWoodDark : Theme.color.textMuted, bold: on });
      lb.setParent(n);
      n.setParent(disc);
      n.setPosition(p.x, p.y, 0);
    }
  }

  /** 南家下行：手牌（居中）+ 出牌圆钮（右端兄弟） */
  private renderSouthHand(v: ViewState): void {
    // 清手牌（保留 discardBtn）
    for (const c of [...this.southHand.children]) if (c !== this.discardBtn) c.destroy();
    const tiles = expandSorted(v.you.concealed);
    const gap = 3;
    const handW = tiles.length * (HAND_T.w + gap) - gap;
    const btnW = 50;
    const groupW = handW + 10 + btnW;
    const handCenterX = -groupW / 2 + handW / 2;
    const canDiscard = v.phase === 'discard' && v.currentSeat === this.mySeat;
    // 刚摸的牌：保持在排序原位但抬高（抽出状态），便于分辨是哪一张；取最右一张同牌
    const drawn = v.you.drawn;
    let drawnIdx = -1;
    if (drawn) for (let i = tiles.length - 1; i >= 0; i--) if (tiles[i] === drawn) { drawnIdx = i; break; }
    let x = handCenterX - handW / 2 + HAND_T.w / 2;
    if (this.selectedIdx != null && this.selectedIdx >= tiles.length) this.selectedIdx = null;
    for (let i = 0; i < tiles.length; i++) {
      const id = tiles[i]!;
      const t = createTileNode(id, HAND_T.w, HAND_T.h);
      t.setParent(this.southHand);
      const sel = i === this.selectedIdx; // 按位置选中：一对牌只抬被点的那张
      const isDrawn = i === drawnIdx;
      t.setPosition(x, sel ? 8 : isDrawn ? 6 : 0, 0);
      if (sel) {
        // 方案A：抬升量减小后以金边补偿选中态辨识
        const rg = t.addComponent(Graphics);
        rg.strokeColor = Theme.color.gold;
        rg.lineWidth = 2;
        rg.roundRect(-HAND_T.w / 2 - 1, -HAND_T.h / 2 - 1, HAND_T.w + 2, HAND_T.h + 2, 4);
        rg.stroke();
      }
      t.on(Node.EventType.TOUCH_END, () => {
        if (!canDiscard) return;
        this.selectedIdx = this.selectedIdx === i ? null : i;
        this.renderSouthHand(this.net.view!);
        this.renderActions(this.net.view!);
      });
      x += HAND_T.w + gap;
    }
    // 出牌钮位置 + 态 + my-turn 环
    this.discardBtn.setPosition(-groupW / 2 + handW + 10 + btnW / 2, 0, 0);
    setButtonEnabled(this.discardBtn, canDiscard && this.selectedIdx != null);
    this.discardBtn.active = canDiscard;
    this.drawTurnRing(canDiscard);
  }

  private renderSouth(v: ViewState): void {
    this.renderSouthTop(v);
    this.renderSouthHand(v);
  }
  private renderSouthTop(v: ViewState): void {
    this.southTop.destroyAllChildren();
    const x0 = LEFT + 12;
    const me = v.you;
    const pinfo = this.drawPinfo({ name: '我', score: me.score, zi: me.zi, isDealer: me.seat === v.dealerSeat, isActive: this.isActive(v, me.seat), self: true, lianzhuang: v.lianzhuangCount, ...this.seatFlags(me.seat) });
    const pw = pinfo.getComponent(UITransform)!.contentSize.width;
    pinfo.setParent(this.southTop);
    pinfo.setPosition(x0 + pw / 2, 0, 0);
    // 花牌固定槽位 x -250~-166（避开西墙列带 ±256~272，方案A重排）
    if (me.flowers.length) {
      const fw = me.flowers.length * 17 + 8;
      const fa = uiPanel(fw, 26, { variant: 'panel', radius: 6 });
      fa.setParent(this.southTop);
      fa.setPosition(-208, 0, 0);
      me.flowers.forEach((f, i) => {
        const t = createTileNode(f, 16, 22);
        t.setParent(fa);
        t.setPosition(-fw / 2 + 4 + i * 17 + 8, 0, 0);
      });
    }
    // 明牌行自 x=-160 右排；超宽（徽章左缘 115）时降为侧家规格防遮
    const meldsNode = this.mk(this.southTop, 'Melds', 0, 0);
    let meldW = this.drawMelds(meldsNode, me.melds ?? [], MELD_ME, 'h', me.seat, this.pendChiFor(v, me.seat));
    if (meldW > 271) {
      meldsNode.destroyAllChildren();
      meldW = this.drawMelds(meldsNode, me.melds ?? [], { w: 14, h: 19 }, 'h', me.seat, this.pendChiFor(v, me.seat));
    }
    meldsNode.setPosition(-160 + meldW / 2, 0, 0);
    const preview = previewTai(me.concealed, me.melds ?? [], me.flowers, {
      isDealer: me.seat === v.dealerSeat,
      wallRemaining: v.wallRemaining,
      lianzhuangCount: v.lianzhuangCount,
      drawn: me.drawn ?? undefined,
      myZi: me.zi,
    });
    // BL-021：未听牌时徽章改显保底台数（不再显 0）；听牌后仍显预览台数（天然含保底，不双计）
    const badge = uiButton(preview.tenpai ? `💡 ${preview.tai}台 ▴` : `💡 保底 ${preview.secured}台 ▴`, () => this.toggleScorePop(preview), { variant: 'action', width: 96, height: 26, fontSize: 12 });
    badge.setParent(this.southTop);
    badge.setPosition(216, 0, 0);
    const listen = uiButton(this.listening ? '听牌✓' : '听牌', () => this.toggleListen(), { variant: 'secondary', width: 50, height: 26, fontSize: 12 });
    listen.setParent(this.southTop);
    listen.setPosition(140, 0, 0);
  }

  // ============ 组件绘制 ============

  /** 玩家信息条：头像+昵称(暖白)+积分(金)+子(灰)+庄家角标；active 金边 */
  private drawPinfo(o: { name: string; score: number; zi: number; isDealer: boolean; isActive: boolean; self?: boolean; lianzhuang?: number; offline?: boolean; trusteed?: boolean }): Node {
    const nameW = o.name.length * 11;
    const scoreStr = `${o.score >= 0 ? '+' : ''}${o.score}`;
    const scoreW = scoreStr.length * 7;
    const ziStr = `子${o.zi}`;
    const ziW = 9 + String(o.zi).length * 6; // CJK 字宽≈字号(9)、数字≈6：估窄会导致 Label 换行
    const lz = o.lianzhuang ?? 0;
    const lzStr = o.isDealer && lz > 0 ? `连${lz}` : ''; // 连庄数移入庄家信息框
    const lzW = lzStr ? 18 + String(lz).length * 6 : 0;
    const tagStr = o.trusteed ? '托管' : o.offline ? '离线' : ''; // M-I 离线/托管标识
    const tagW = tagStr ? 22 : 0;
    const dealerW = o.isDealer ? 22 + (lzW ? lzW + 4 : 0) : 0;
    const pw = 22 + 4 + nameW + 4 + scoreW + 4 + ziW + (dealerW ? 4 : 0) + dealerW + (tagW ? 4 + tagW : 0) + 16;
    const ph = o.self ? 26 : 24;
    const node = uiPanel(pw, ph, { variant: 'panel', radius: Theme.radius.full });
    if (o.isActive) {
      const hl = new Node('Active');
      hl.addComponent(UITransform);
      const hg = hl.addComponent(Graphics);
      hg.strokeColor = Theme.color.gold;
      hg.lineWidth = 1.5;
      hg.roundRect(-pw / 2, -ph / 2, pw, ph, ph / 2);
      hg.stroke();
      hl.setParent(node);
    }
    let x = -pw / 2 + 8;
    const av = new Node('Av');
    av.addComponent(UITransform).setContentSize(20, 20);
    const ag = av.addComponent(Graphics);
    ag.fillColor = Theme.color.gold;
    ag.circle(0, 0, 10);
    ag.fill();
    ag.strokeColor = Theme.color.goldLight;
    ag.lineWidth = 1.5;
    ag.circle(0, 0, 10);
    ag.stroke();
    const gl = uiLabel(o.name.slice(0, 1), { size: 11, color: Theme.color.bgWoodDark, bold: true });
    gl.setParent(av);
    av.setParent(node);
    av.setPosition(x + 10, 0, 0);
    x += 22 + 4;
    const nm = uiLabel(o.name, { size: 11, color: Theme.color.textPrimary, bold: true, align: 'left', width: nameW + 2 });
    nm.setParent(node);
    nm.setPosition(x + nameW / 2, 0, 0);
    x += nameW + 4;
    const sc = uiLabel(scoreStr, { size: 10, color: Theme.color.gold, bold: true, align: 'left', width: scoreW + 2 });
    sc.setParent(node);
    sc.setPosition(x + scoreW / 2, 0, 0);
    x += scoreW + 4;
    const zi = uiLabel(ziStr, { size: 9, color: Theme.color.textMuted, align: 'left', width: ziW + 4 });
    zi.setParent(node);
    zi.setPosition(x + ziW / 2, 0, 0);
    x += ziW;
    if (o.isDealer) {
      x += 4;
      const db = new Node('Dealer');
      db.addComponent(UITransform).setContentSize(22, 16);
      const dg = db.addComponent(Graphics);
      dg.fillColor = Theme.color.danger; // 红底白字+金环：庄家一眼可辨
      dg.roundRect(-11, -8, 22, 16, 6);
      dg.fill();
      dg.strokeColor = Theme.color.goldLight;
      dg.lineWidth = 1.5;
      dg.roundRect(-11, -8, 22, 16, 6);
      dg.stroke();
      const dl = uiLabel('庄', { size: 10, color: Color.WHITE, bold: true });
      dl.setParent(db);
      db.setParent(node);
      db.setPosition(x + 11, 0, 0);
      x += 22;
      if (lzStr) {
        x += 4;
        const lzL = uiLabel(lzStr, { size: 9, color: Theme.color.goldLight, bold: true, align: 'left', width: lzW + 4 });
        lzL.setParent(node);
        lzL.setPosition(x + lzW / 2, 0, 0);
        x += lzW;
      }
    }
    if (tagStr) {
      x += 4;
      const tg = uiLabel(tagStr, { size: 9, color: o.trusteed ? Theme.color.wxGreen : Theme.color.textMuted, bold: true, align: 'left', width: tagW + 4 });
      tg.setParent(node);
      tg.setPosition(x + tagW / 2, 0, 0);
    }
    return node;
  }

  /** M-I：座位离线/托管标识（取自最新 roomView） */
  private seatFlags(seat: number): { offline?: boolean; trusteed?: boolean } {
    const s = this.net.room?.seats[seat];
    return { offline: s?.offline, trusteed: s?.trusteed };
  }

  /** M-J 基础动画（FR-表现-01）：发牌逐张 / 摸牌·弃牌·副露弹窗，均以 ViewState 差值校准 */
  private runAnims(v: ViewState): void {
    // 发牌：局数变化时手牌逐张 stagger 入场（首帧不播）
    if (v.round !== this.animRound) {
      const first = this.animRound < 0;
      this.animRound = v.round;
      this.animDrawn = v.you.drawn;
      this.animDiscards = v.discards.length;
      this.animMelds = {};
      if (!first) {
        this.southHand.children.forEach((c, i) => {
          c.setScale(0.2, 0.2, 1);
          tween(c).delay(0.05 * i).to(0.14, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
        });
      }
      return;
    }
    // 摸牌：抬高那张原位弹窗
    if (v.you.drawn && v.you.drawn !== this.animDrawn) {
      const c = this.southHand.children.find((n) => Math.abs(n.position.y - 10) < 0.5);
      if (c) this.pop(c);
    }
    this.animDrawn = v.you.drawn;
    // 打牌：牌河最新张弹窗
    if (v.discards.length !== this.animDiscards) {
      this.animDiscards = v.discards.length;
      const t = this.findByName(this.riverArea, 'RTileLast');
      if (t) this.pop(t);
    }
    // 吃碰杠：新增副露组弹窗
    for (const seat of [0, 1, 2, 3]) {
      const n = seat === this.mySeat ? v.you.melds.length : (v.others.find((o) => o.seat === seat)?.melds.length ?? 0);
      if (n > (this.animMelds[seat] ?? 0)) {
        const wrap = this.findByName(this.node, `Melds${seat}`);
        const kids = wrap?.children ?? [];
        if (kids.length) this.pop(kids[kids.length - 1]!);
      }
      this.animMelds[seat] = n;
    }
  }

  private pop(n: Node): void {
    n.setScale(0.4, 0.4, 1);
    tween(n).to(0.18, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
  }

  private findByName(root: Node, name: string): Node | null {
    for (const c of root.children) {
      if (c.name === name) return c;
      const r = this.findByName(c, name);
      if (r) return r;
    }
    return null;
  }

  /** M-I 断线重连遮罩（FR-断线-02 客户端表现） */
  private reconnectMask: Node | null = null;
  /** M-J 动画差值基线（事件驱动演出、ViewState 校准） */
  private animRound = -1;
  private animDrawn: string | null = null;
  private animDiscards = -1;
  private animMelds: Record<number, number> = {};
  private showReconnect(s: 'reconnecting' | 'restored' | 'failed'): void {
    if (s === 'restored') {
      if (this.reconnectMask) { this.reconnectMask.destroy(); this.reconnectMask = null; }
      this.toast('已重连，对局已恢复');
      return;
    }
    if (!this.reconnectMask) {
      const W = Theme.size.designW;
      const H = Theme.size.designH;
      const mask = new Node('ReconnectMask');
      mask.addComponent(UITransform).setContentSize(W, H);
      const g = mask.addComponent(Graphics);
      g.fillColor = Theme.color.mask;
      g.rect(-W / 2, -H / 2, W, H);
      g.fill();
      mask.setParent(this.node);
      const lb = uiLabel('断线重连中…', { size: 15, color: Theme.color.gold, bold: true });
      lb.name = 'Msg';
      lb.setParent(mask);
      this.reconnectMask = mask;
    }
    const lb = this.reconnectMask.getChildByName('Msg');
    if (lb) lb.getComponent(Label)!.string = s === 'failed' ? '重连失败：请返回登录重试' : '断线重连中…';
  }

  /** 明牌组（横/竖）+ 组下微型标签；返回占用宽/高 */
  private drawMelds(parent: Node, melds: Meld[], size: { w: number; h: number }, orient: 'h' | 'v', seat = -1, pending: { tiles: string[] } | null = null): number {
    if (!melds.length && !pending) return 0;
    const wrap = this.mk(parent, seat >= 0 ? `Melds${seat}` : 'Melds', 0, 0);
    // 吃副展示序（2026-09-18 用户定案）：被吃牌居中竖放、其余两张按序两侧（如手 7/8 万吃 9 万 → 7-9-8）；替代旧横置方案
    const orderOf = (m: Meld): string[] => {
      if (m.type !== 'chi' || !m.called) return m.tiles;
      const others = m.tiles.filter((t) => t !== m.called);
      return [others[0] ?? m.called, m.called, others[1] ?? m.called];
    };
    const tileOf = (m: Meld, t: string): Node => {
      const tn = createTileNode(t, size.w, size.h);
      if (m.type === 'chi' && t === m.called) this.mkCalledBadge(tn, size);
      return tn;
    };
    if (orient === 'h') {
      let x = 0;
      for (const m of melds) {
        const g = this.mk(wrap, 'M', 0, 0);
        let pen = 0;
        for (const t of orderOf(m)) {
          const tn = tileOf(m, t);
          tn.setParent(g);
          tn.setPosition(pen + size.w / 2, 4, 0);
          pen += size.w + 1;
        }
        const lb = uiLabel(meldLabel(m.type), { size: 9, color: Theme.color.textSecondary });
        lb.setParent(g);
        lb.setPosition(pen / 2 - 4, -size.h / 2 - 4, 0);
        g.setPosition(x + pen / 2, 0, 0);
        x += pen + 8;
      }
      if (pending) x = this.drawPendingChiH(wrap, pending, size, x);
      return x;
    }
    let y = 0;
    for (const m of melds) {
      const g = this.mk(wrap, 'M', 0, 0);
      let pen = 0;
      for (const t of orderOf(m)) {
        const tn = tileOf(m, t);
        tn.setParent(g);
        tn.setPosition(0, -(pen + size.h / 2), 0);
        pen += size.h + 1;
      }
      const lb = uiLabel(meldLabel(m.type), { size: 9, color: Theme.color.textSecondary });
      lb.setParent(g);
      lb.setPosition(0, -pen - 6, 0);
      g.setPosition(0, y - pen / 2, 0);
      y -= pen + 10;
    }
    if (pending) y = this.drawPendingChiV(wrap, pending, size, y);
    return -y;
  }

  /** BL-020 先看吃再碰：吃家副露区「准备吃」预览——两张手牌夹一个虚线空位（被吃牌将居中），吃失败/窗结束随视图消失 */
  private pendChiFor(v: ViewState, seat: number): { tiles: string[] } | null {
    const p = v.pendingChi;
    return p && p.seat === seat ? { tiles: p.tiles } : null;
  }
  private mkGapSlot(parent: Node, size: { w: number; h: number }, x: number, y: number): void {
    const slot = this.mk(parent, 'Gap', x, y);
    slot.addComponent(UITransform).setContentSize(size.w, size.h);
    const gg = slot.addComponent(Graphics);
    gg.strokeColor = rgba(212, 165, 55, 0.45);
    gg.lineWidth = 1;
    // Cocos Graphics 无 setLineDash：手绘 3/3 虚线矩形框
    const hw = size.w / 2;
    const hh = size.h / 2;
    const dashLine = (x1: number, y1: number, x2: number, y2: number): void => {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const n = Math.max(1, Math.floor(len / 6));
      for (let i = 0; i < n; i++) {
        const t1 = (i * 6) / len;
        const t2 = Math.min(len, i * 6 + 3) / len;
        gg.moveTo(x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1);
        gg.lineTo(x1 + (x2 - x1) * t2, y1 + (y2 - y1) * t2);
        gg.stroke();
      }
    };
    dashLine(-hw, hh, hw, hh);
    dashLine(hw, hh, hw, -hh);
    dashLine(hw, -hh, -hw, -hh);
    dashLine(-hw, -hh, -hw, hh);
  }
  private drawPendingChiH(wrap: Node, pending: { tiles: string[] }, size: { w: number; h: number }, x: number): number {
    const g = this.mk(wrap, 'MPending', 0, 0);
    let pen = 0;
    const put = (t: string | null) => {
      if (t) {
        const tn = createTileNode(t, size.w, size.h);
        tn.setParent(g);
        tn.setPosition(pen + size.w / 2, 4, 0);
      } else {
        this.mkGapSlot(g, size, pen + size.w / 2, 4);
      }
      pen += size.w + 1;
    };
    put(pending.tiles[0] ?? null);
    put(null);
    put(pending.tiles[1] ?? null);
    const lb = uiLabel('准备吃', { size: 9, color: Theme.color.gold });
    lb.setParent(g);
    lb.setPosition(pen / 2 - 4, -size.h / 2 - 4, 0);
    g.setPosition(x + pen / 2, 0, 0);
    return x + pen + 8;
  }
  private drawPendingChiV(wrap: Node, pending: { tiles: string[] }, size: { w: number; h: number }, y: number): number {
    const g = this.mk(wrap, 'MPending', 0, 0);
    let pen = 0;
    const put = (t: string | null) => {
      if (t) {
        const tn = createTileNode(t, size.w, size.h);
        tn.setParent(g);
        tn.setPosition(0, -(pen + size.h / 2), 0);
      } else {
        this.mkGapSlot(g, size, 0, -(pen + size.h / 2));
      }
      pen += size.h + 1;
    };
    put(pending.tiles[0] ?? null);
    put(null);
    put(pending.tiles[1] ?? null);
    const lb = uiLabel('准备吃', { size: 9, color: Theme.color.gold });
    lb.setParent(g);
    lb.setPosition(0, -pen - 6, 0);
    g.setPosition(0, y - pen / 2, 0);
    return y - pen - 10;
  }

  /** FR-对局-17（2026-09-18 v2）：吃副被吃牌标记 = 右上角小圆形角标（金底+暗「吃」字），牌身保持竖放 */
  private mkCalledBadge(tn: Node, size: { w: number; h: number }): void {
    const r = Math.max(4, Math.round(size.w * 0.22));
    const badge = new Node('CalledBadge');
    badge.addComponent(UITransform).setContentSize(r * 2, r * 2);
    const g = badge.addComponent(Graphics);
    g.fillColor = Theme.color.gold;
    g.circle(0, 0, r);
    g.fill();
    g.strokeColor = rgba(46, 32, 8, 0.6);
    g.lineWidth = 1;
    g.circle(0, 0, r);
    g.stroke();
    const lb = uiLabel('吃', { size: Math.max(6, Math.round(r * 1.3)), color: new Color(46, 32, 8, 255) });
    lb.setParent(badge);
    badge.setParent(tn);
    badge.setPosition(size.w / 2 - 1, size.h / 2 - 1, 0);
  }

  /** 牌侧俯视图：ivory 受光条 + 蓝背（side=ivory 所在边） */
  private drawEdge(w: number, h: number, side: 'top' | 'left' | 'right'): Node {
    const n = new Node('Edge');
    n.addComponent(UITransform).setContentSize(w, h);
    const g = n.addComponent(Graphics);
    g.fillColor = new Color(13, 40, 87, 255); // 牌背蓝
    g.roundRect(-w / 2, -h / 2, w, h, 2);
    g.fill();
    g.fillColor = new Color(247, 240, 220, 255); // 象牙顶面
    const band = 0.28;
    if (side === 'top') g.rect(-w / 2, h / 2 - h * band, w, h * band);
    else if (side === 'left') g.rect(-w / 2, -h / 2, w * band, h);
    else g.rect(w / 2 - w * band, -h / 2, w * band, h);
    g.fill();
    g.strokeColor = rgba(0, 0, 0, 0.35);
    g.lineWidth = 1;
    g.roundRect(-w / 2, -h / 2, w, h, 2);
    g.stroke();
    return n;
  }

  private makeDiscardBtn(): Node {
    const n = uiButton('出牌', () => this.doDiscard(), { variant: 'primary', width: 50, height: 50, fontSize: 13, enabled: false });
    this.discardRing = new Node('Ring');
    this.discardRing.addComponent(UITransform);
    this.discardRing.addComponent(Graphics);
    this.discardRing.setParent(n);
    return n;
  }

  private drawTurnRing(on: boolean): void {
    if (!this.discardRing) return;
    const g = this.discardRing.getComponent(Graphics);
    if (!g) return;
    g.clear();
    if (!on) return;
    const ratio = this.turnCd > 0 ? this.turnCd / 15 : 0;
    g.strokeColor = Theme.color.gold;
    g.lineWidth = 4;
    g.circle(0, 0, 32);
    // 用弧近似环形倒计时
    g.moveTo(0, 32);
    g.arc(0, 0, 32, Math.PI / 2, Math.PI / 2 - ratio * Math.PI * 2, true);
    g.stroke();
  }

  // ============ 交互 ============

  private doDiscard(): void {
    if (this.selectedIdx == null) return;
    const v = this.net.view;
    const tile = v ? expandSorted(v.you.concealed)[this.selectedIdx] : undefined;
    this.selectedIdx = null;
    if (!tile) return;
    this.stopCountdown();
    this.net.discard(this.mySeat, tile);
  }

  private doChi(v: ViewState): void {
    const tile = v.lastDiscard?.tile;
    if (!tile) return;
    const me = { seat: this.mySeat, concealed: v.you.concealed, melds: [], flowers: [], zi: 0, score: 0 };
    const opts = chiOptions(me, tile);
    if (!opts.length) return;
    if (opts.length === 1) {
      this.net.respond(this.mySeat, 'chi', opts[0]!.filter((x) => x !== tile));
      return;
    }
    this.showChiChooser(opts, tile);
  }

  private showChiChooser(opts: string[][], tile: string): void {
    this.showTileChooser(
      '选择吃的组合',
      opts.map((combo) => ({
        tiles: combo,
        onPick: () => this.net.respond(this.mySeat, 'chi', combo.filter((x) => x !== tile)),
      })),
    );
  }

  /** 通用牌面选择器：面板高度按选项数自适应（不再溢出下沿）；每个选项渲染为真实牌面组合（比纯文字更直观） */
  private showTileChooser(title: string, rows: { tiles: string[]; onPick: () => void }[]): void {
    this.overlay.getChildByName('TileChooser')?.destroy();
    const n = Math.max(1, rows.length);
    const rowH = 40;
    const titleH = 26;
    const pad = 12;
    const panelH = titleH + n * rowH + pad;
    const panelW = 150;
    const panel = uiPanel(panelW, panelH, { variant: 'gold', radius: Theme.radius.lg });
    panel.name = 'TileChooser';
    panel.setParent(this.overlay);
    panel.setPosition(0, 20, 0);
    const t = uiLabel(title, { size: 14, color: Theme.color.gold, bold: true });
    t.setParent(panel);
    t.setPosition(0, panelH / 2 - 15, 0);
    rows.forEach((r, i) => {
      const cy = panelH / 2 - titleH - rowH / 2 - i * rowH;
      const row = uiButton('', () => {
        panel.destroy();
        this.stopCountdown();
        r.onPick();
      }, { variant: 'action', width: panelW - 24, height: rowH - 6 });
      row.setParent(panel);
      row.setPosition(0, cy, 0);
      const tw = 24;
      const gap = 4;
      const totalW = r.tiles.length * tw + (r.tiles.length - 1) * gap;
      r.tiles.forEach((tile, j) => {
        const tn = createTileNode(tile, tw, 34);
        tn.setParent(row);
        tn.setPosition(-totalW / 2 + j * (tw + gap) + tw / 2, 0, 0);
      });
    });
  }

  private toggleListen(): void {
    this.listening = !this.listening;
    const v = this.net.view;
    if (v) this.renderSouthTop(v);
    if (this.listening) this.toast(v ? this.computeListenHint(v) : '听牌提示已开');
  }

  private computeListenHint(v: ViewState): string {
    const concealed = v.you.concealed;
    const meldCount = v.you.melds.length;
    const n = Object.values(concealed).reduce((a, b) => a + b, 0);
    const name = (arr: string[]) => arr.map(tileName).join('、');
    if (n % 3 === 1) {
      try {
        const waits = waitingTiles(concealed, meldCount);
        if (waits.length) return `听牌：${name(waits)}（${waits.length} 张）`;
      } catch { /* 非听牌态 */ }
      return '当前未听牌';
    }
    let best: { tile: string; waits: string[] } | null = null;
    for (const id of new Set(expandSorted(concealed))) {
      const after: Record<string, number> = { ...concealed };
      after[id] = (after[id] ?? 0) - 1;
      if (after[id] <= 0) delete after[id];
      try {
        const waits = waitingTiles(after, meldCount);
        if (waits.length && (!best || waits.length > best.waits.length)) best = { tile: id, waits };
      } catch { /* 忽略 */ }
    }
    return best ? `打「${tileName(best.tile)}」听：${name(best.waits)}` : '当前无听牌打法';
  }

  private toggleScorePop(preview: ReturnType<typeof previewTai>): void {
    const existing = this.overlay.getChildByName('ScorePop');
    if (existing) { existing.destroy(); return; }
    const w = 210;
    const rows = preview.tenpai ? preview.detail.length : 0;
    const secRows = preview.securedDetail.length;
    // 高 = 标题区44 + 保底块(块题+明细+小计) + 间距6 + 状态行16 + 听牌明细 + 合计24 + 底补8
    const h = 44 + (secRows + 2) * 16 + 6 + 16 + rows * 16 + (preview.tenpai ? 24 : 0) + 8;
    const pop = uiPanel(w, h, { variant: 'panel', radius: Theme.radius.lg });
    pop.name = 'ScorePop';
    pop.setParent(this.overlay);
    pop.setPosition(RIGHT - 12 - w / 2, -40, 0);
    const title = uiLabel('💡 台数预览', { size: 11, color: Theme.color.gold, bold: true });
    title.setParent(pop);
    title.setPosition(0, h / 2 - 16, 0);
    let y = h / 2 - 32;
    // BL-021 保底区块（常显）：锁定番种明细 + 小计
    const secT = uiLabel('已锁定（保底）', { size: 10, color: Theme.color.textMuted, align: 'left', width: w - 24 });
    secT.setParent(pop);
    secT.setPosition(0, y, 0);
    y -= 16;
    if (!secRows) {
      const none = uiLabel('暂无锁定番种', { size: 11, color: Theme.color.textSecondary, align: 'left', width: w - 24 });
      none.setParent(pop);
      none.setPosition(0, y, 0);
      y -= 16;
    }
    for (const d of preview.securedDetail) {
      const nm = uiLabel(`${d.name}${d.count != null && d.count > 1 ? ` ×${d.count}` : ''}`, { size: 11, color: Theme.color.textSecondary, align: 'left', width: 120 });
      nm.setParent(pop);
      nm.setPosition(-w / 2 + 12 + 55, y, 0);
      const tv = uiLabel(`+${d.tai}`, { size: 11, color: Theme.color.goldLight, bold: true, align: 'right', width: 40 });
      tv.setParent(pop);
      tv.setPosition(w / 2 - 12 - 20, y, 0);
      y -= 16;
    }
    const secSum = uiLabel(`保底小计 ${preview.secured} 台`, { size: 11, color: Theme.color.gold, bold: true, align: 'left', width: w - 24 });
    secSum.setParent(pop);
    secSum.setPosition(0, y, 0);
    y -= 6 + 16;
    // 状态行 + 听牌明细（原有三态逻辑）
    const status = preview.canWin
      ? `可自摸 · ${preview.tai}台`
      : preview.viaDiscard
        ? `打 ${tileName(preview.viaDiscard)} 听牌 · ${preview.tai}台`
        : preview.tenpai
          ? `听牌 · ${preview.tai}台`
          : '未听牌 · 听牌后预览台数实时更新';
    const st = uiLabel(status, { size: 11, color: preview.tenpai ? Theme.color.goldLight : Theme.color.textSecondary, bold: preview.tenpai });
    st.setParent(pop);
    st.setPosition(0, y, 0);
    y -= 16;
    for (const d of preview.detail) {
      const nm = uiLabel(`${d.name}${d.count != null && d.count > 1 ? ` ×${d.count}` : ''}`, { size: 11, color: Theme.color.textSecondary, align: 'left', width: 120 });
      nm.setParent(pop);
      nm.setPosition(-w / 2 + 12 + 55, y, 0);
      const tv = uiLabel(`+${d.tai}`, { size: 11, color: Theme.color.goldLight, bold: true, align: 'right', width: 40 });
      tv.setParent(pop);
      tv.setPosition(w / 2 - 12 - 20, y, 0);
      y -= 16;
    }
    if (preview.tenpai) {
      const tot = uiLabel(`合计 ${preview.tai} 台`, { size: 13, color: Theme.color.gold, bold: true });
      tot.setParent(pop);
      tot.setPosition(0, y - 8, 0);
    }
  }

  // ============ 倒计时 ============

  private startCountdown(sec: number, onTimeout: () => void): void {
    this.stopCountdown();
    this.cdTotal = sec;
    this.cdRemain = sec;
    this.cdOnTimeout = onTimeout;
    this.cdRunning = true;
    this.cdBar = this.mk(this.actionBarNode(), 'CdBar', 0, 24);
    this.cdBar.addComponent(Graphics);
    this.drawCdBar(1);
    this.cdTimer = setInterval(() => this.tickCountdown(), 1000);
  }
  private tickCountdown(): void {
    if (!this.cdRunning) return;
    this.cdRemain -= 1;
    this.refreshStatusCd();
    if (this.cdRemain <= 0) {
      this.stopCountdown();
      this.cdOnTimeout?.();
      return;
    }
    if (this.cdRemain <= 5) AudioManager.instance.play('countdown'); // BL-014：最后 5 秒逐秒警告
    this.drawCdBar(this.cdRemain / this.cdTotal);
  }
  private drawCdBar(ratio: number): void {
    if (!this.cdBar) return;
    const g = this.cdBar.getComponent(Graphics);
    if (!g) return;
    g.clear();
    g.fillColor = rgba(255, 255, 255, 0.12);
    g.roundRect(-90, -2, 180, 4, 2);
    g.fill();
    g.fillColor = Theme.color.gold;
    g.roundRect(-90, -2, 180 * Math.max(0, ratio), 4, 2);
    g.fill();
  }
  private stopCountdown(): void {
    this.cdRunning = false;
    this.cdOnTimeout = null;
    if (this.cdTimer) { clearInterval(this.cdTimer); this.cdTimer = null; }
    if (this.cdBar) { this.cdBar.destroy(); this.cdBar = null; }
  }
  private startTurnCd(): void {
    this.stopTurnCd();
    this.turnCd = 15;
    this.turnTimer = setInterval(() => {
      this.turnCd = Math.max(0, this.turnCd - 1);
      this.refreshStatusCd();
      this.drawTurnRing(true);
    }, 1000);
  }
  private stopTurnCd(): void {
    this.turnCd = 0;
    if (this.turnTimer) { clearInterval(this.turnTimer); this.turnTimer = null; }
  }
  private refreshStatusCd(): void {
    const v = this.net.view;
    if (v) this.renderStatus(v);
  }

  private actionBarNode(): Node {
    let n = this.overlay.getChildByName('ActionBar');
    if (!n) {
      n = this.mk(this.overlay, 'ActionBar', 0, -30);
      n.active = false;
    }
    return n;
  }

  // ============ 操作浮层 ============

  private renderActions(v: ViewState): void {
    const legal = v.you.legal;
    const myTurn = v.currentSeat === this.mySeat;
    if (v.phase === 'draw' && myTurn && legal.includes('draw')) {
      this.stopTurnCd();
      this.net.draw(this.mySeat);
      return;
    }
    // my-turn 展示倒计时（仅视觉）
    if (v.phase === 'discard' && myTurn) this.startTurnCd();
    else this.stopTurnCd();

    const bar = this.actionBarNode();
    bar.destroyAllChildren();
    const acts: { label: string; fn: () => void; danger?: boolean }[] = [];
    const inResp = v.phase === 'response';
    const canWinD = inResp && legal.includes('win_discard');
    const hasOpt = inResp && (canWinD || legal.includes('pong') || legal.includes('kong_exposed') || legal.includes('chi'));
    if (v.phase === 'discard' && myTurn && legal.includes('win_draw')) acts.push({ label: '胡', fn: () => this.net.declareWin(this.mySeat), danger: true });
    // 自己回合的杠：补杠（已有碰+手牌/摸到同张）、暗杠（手牌4张）；多解弹选择器
    if (v.phase === 'discard' && myTurn) {
      const me = { concealed: v.you.concealed, melds: v.you.melds } as Parameters<typeof addedKongOptions>[0];
      if (legal.includes('kong_added')) {
        const opts = addedKongOptions(me);
        if (opts.length) acts.push({ label: '补杠', fn: () => this.doKong('added', opts) });
      }
      if (legal.includes('kong_concealed')) {
        const opts = concealedKongOptions(me);
        if (opts.length) acts.push({ label: '暗杠', fn: () => this.doKong('concealed', opts) });
      }
    }
    if (hasOpt) {
      if (canWinD) acts.push({ label: '胡', fn: () => this.net.respond(this.mySeat, 'win'), danger: true });
      if (legal.includes('pong')) acts.push({ label: '碰', fn: () => this.net.respond(this.mySeat, 'pong') });
      if (legal.includes('kong_exposed')) acts.push({ label: '杠', fn: () => this.net.respond(this.mySeat, 'kong_exposed') });
      if (legal.includes('chi')) acts.push({ label: '吃', fn: () => this.doChi(v) });
      acts.push({ label: '过', fn: () => this.net.respond(this.mySeat, 'pass') });
    }
    bar.active = acts.length > 0;
    if (acts.length > 0) this.hideWallLegend(); // 操作浮层出现即隐藏开牌点图例，避免重叠
    if (!acts.length) { this.stopCountdown(); return; }
    // 浮层面板（加高：文案/倒计时条/按钮三层互不遮挡）
    const panel = uiPanel(360, 112, { variant: 'panel', radius: Theme.radius.lg });
    panel.setParent(bar);
    const hint = uiLabel(hasOpt && v.lastDiscard ? `${this.nameOf(v, v.lastDiscard.seat)} 打出「${tileName(v.lastDiscard.tile)}」，你可以：` : '你可以：', { size: 11, color: Theme.color.textSecondary });
    hint.setParent(panel);
    hint.setPosition(0, 38, 0);
    let bx = -((acts.length - 1) * 62) / 2;
    for (const a of acts) {
      const btn = uiButton(a.label, a.fn, { variant: a.danger ? 'primary' : 'action', width: 56, height: 42, fontSize: 16 });
      btn.setParent(panel);
      btn.setPosition(bx, -16, 0);
      bx += 62;
    }
    // 仅响应期才有「过」与响应倒计时；自己回合的杠/胡按钮不启动 pass 倒计时（避免非法 pass）
    // 倒计时锚定当前响应窗：窗内视图广播/浮层重建均不重置（防重复点吃/碰刷倒计时 bug）
    if (hasOpt && v.lastDiscard) {
      const key = `${v.round}:${v.discards.length}:${v.lastDiscard.seat}:${v.lastDiscard.tile}`;
      if (!this.cdRunning || this.cdRespKey !== key) {
        this.startCountdown(8, () => this.net.respond(this.mySeat, 'pass'));
        this.cdRespKey = key;
      }
    } else {
      this.cdRespKey = '';
      this.stopCountdown();
    }
  }

  /** 自己回合杠：单解直发，多解弹选择器 */
  private doKong(kind: 'added' | 'concealed', opts: string[]): void {
    if (opts.length === 1) {
      this.sendKong(kind, opts[0]!);
      return;
    }
    this.showTileChooser(
      kind === 'added' ? '选择补杠的牌' : '选择暗杠的牌',
      opts.map((tile) => ({ tiles: [tile], onPick: () => this.sendKong(kind, tile) })),
    );
  }

  private sendKong(kind: 'added' | 'concealed', tile: string): void {
    this.stopCountdown();
    if (kind === 'added') this.net.kongAdded(this.mySeat, tile);
    else this.net.kongConcealed(this.mySeat, tile);
  }

  // ============ 局末结算 ============

  private onEvents(events: GameEvent[]): void {
    for (const ev of events) {
      this.playEventSound(ev); // BL-014：事件驱动音效（与未来 M-J 动画复用同一事件入口）
      if (ev.type === 'win' || ev.type === 'exhaustive' || ev.type === 'zhahu') {
        // 只存 revealed：此时 net.view 仍是旧相位（discard），立即 render 会被 render 的清除逻辑抹掉；
        // 翻面渲染交由紧随其后的 settled 视图触发
        this.revealed = ev.revealed ?? null;
      }
      if (ev.type === 'win' || ev.type === 'exhaustive' || ev.type === 'zhahu') this.showSettlement(ev);
    }
  }

  /**
   * 事件 → 音效映射（PRD 07 §3.2.1）。
   * 杠三种区分（明/暗/补，依据 kong.kind）；胡统一「胡了」（win 不区分自摸/点炮）。
   * 可响应提示仅在本家被点名时播（避免为他家响应打扰）。
   */
  private playEventSound(ev: GameEvent): void {
    const a = AudioManager.instance;
    switch (ev.type) {
      case 'discarded': a.play('discard'); break;
      case 'drawn': a.play('draw'); break;
      case 'flower': a.play('flower'); break;
      case 'melded': a.play(ev.move === 'chi' ? 'chi' : ev.move === 'pong' ? 'pong' : 'click'); break;
      case 'kong': a.play(this.kongSfx(ev.kind)); break;
      case 'win': a.play('win'); break;
      case 'zhahu': a.play('zhahu'); break;
      case 'exhaustive': a.play('exhaustive'); break;
      case 'roundEnd': a.play('settle'); break;
      case 'responseNeeded': if (ev.seats.includes(this.mySeat)) a.play('alert'); break;
      default: break; // advance 等无音
    }
  }

  /** kong.kind → 语音资源：exposed=「杠」/ kong_concealed=「暗杠」/ kong_added=「补杠」 */
  private kongSfx(kind: string): SfxName {
    if (kind === 'kong_concealed') return 'kong_concealed';
    if (kind === 'kong_added') return 'kong_added';
    return 'kong_exposed';
  }

  private showSettlement(ev: Extract<GameEvent, { type: 'win' | 'exhaustive' | 'zhahu' }>): void {
    this.overlay.getChildByName('Settlement')?.destroy();
    const isWin = ev.type === 'win';
    const mask = new Node('Settlement');
    mask.addComponent(UITransform).setContentSize(W, H);
    const mg = mask.addComponent(Graphics);
    mg.fillColor = rgba(0, 0, 0, 0.6);
    mg.rect(LEFT, -TOP, W, H);
    mg.fill();
    mask.setParent(this.overlay);
    const pw = isWin || this.revealed ? 560 : 380;
    const subLines = isWin ? (ev.winners[0]?.detail ?? []).filter((d) => d.tiles && d.tiles.length).length : 0;
    const hands = this.revealed;
    const bandH = hands ? 56 : 0; // 各家手牌区高度
    // 子/庄明细子注行数（胡方 1 + 付方各 1）+ 角色横幅 → 面板加高
    const payerN = ev.type === 'win' ? [0, 1, 2, 3].filter((s) => (ev.delta[s] ?? 0) < 0).length : 0;
    const ph = 300 + subLines * 12 + bandH + (ev.type === 'win' ? 16 + (1 + payerN) * 10 : 0);
    const panel = uiPanel(pw, ph, { variant: 'gold', radius: Theme.radius.xl });
    // M-J 结算演出（FR-表现-03）：面板 pop 入场
    panel.setScale(0.92, 0.92, 1);
    tween(panel).to(0.22, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    panel.setParent(mask);
    const v = this.net.view;
    const meSeat = v?.you.seat ?? -1;
    const myDelta = ev.type === 'win' ? (ev.delta[meSeat] ?? 0) : 0;
    let title = '🀄 荒庄流局';
    if (ev.type === 'win') {
      const ws = ev.winners[0]!;
      title = ev.winners.length === 1 && ws.seat === meSeat ? `🎉 你胡 ${ws.tai}台！` : `🎉 ${ev.winners.map((w) => `${this.nameOf(v!, w.seat)} 胡 ${w.tai}台`).join(' / ')}`;
    } else if (ev.type === 'zhahu') title = `⚠ ${this.nameOf(v!, ev.seat)} 诈胡罚分`;
    const tt = uiLabel(title, { size: 20, color: Theme.color.gold, bold: true });
    tt.setParent(panel);
    tt.setPosition(0, ph / 2 - 28, 0);
    const sub = uiLabel(`第 ${v?.round ?? 1}/${v && v.maxRounds > 0 ? v.maxRounds : '∞'} 局 · 1 台 = 1 积分`, { size: 11, color: Theme.color.textMuted });
    sub.setParent(panel);
    sub.setPosition(0, ph / 2 - 50, 0);
    // 角色个性化横幅（2026-09-18）：胡方 / 被胡付方（点炮·自摸）/ 无关方
    let banner = '';
    let bannerColor = Theme.color.textMuted;
    if (ev.type === 'win') {
      if (meSeat === ev.winners[0]!.seat) {
        banner = `🎉 本局你为胡方 · 共收 ${myDelta >= 0 ? '+' : ''}${myDelta} 分`;
        bannerColor = Theme.color.gold;
      } else if (myDelta < 0) {
        banner = payerN === 1 ? `💸 本局你点炮 · 付 ${-myDelta} 分（构成见子注）` : `💸 本局对方自摸 · 你付 ${-myDelta} 分`;
        bannerColor = Theme.color.danger;
      } else banner = '本局与你无关 · 积分不变';
    }
    if (banner) {
      const bn = uiLabel(banner, { size: 12, color: bannerColor, bold: true });
      bn.setParent(panel);
      bn.setPosition(0, ph / 2 - 68, 0);
    }
    const colTop = ph / 2 - (banner ? 90 : 74);
    if (ev.type === 'win') {
      const w0 = ev.winners[0]!;
      const T0 = w0.tai;
      const ziOf = (s: number): number => (s === v!.you.seat ? v!.you.zi : (v!.others.find((o) => o.seat === s)?.zi ?? 0));
      const dealerSeat = v!.dealerSeat;
      const lz = v!.lianzhuangCount;
      const payerSeats = [0, 1, 2, 3].filter((s) => (ev.delta[s] ?? 0) < 0);
      const lx = -pw / 4;
      const cl = uiLabel('台数明细', { size: 12, color: Theme.color.gold, bold: true });
      cl.setParent(panel);
      cl.setPosition(lx, colTop, 0);
      let ly = colTop - 22;
      for (const d of w0.detail) {
        const nm = uiLabel(`${d.name}${d.count != null && d.count > 1 ? ` ×${d.count}` : ''}`, { size: 11, color: Theme.color.textSecondary, align: 'left', width: 120 });
        nm.setParent(panel);
        nm.setPosition(lx - 20, ly, 0);
        const tv = uiLabel(`+${d.tai}`, { size: 11, color: Theme.color.goldLight, bold: true, align: 'right', width: 44 });
        tv.setParent(panel);
        tv.setPosition(lx + 62, ly, 0);
        ly -= 18;
        if (d.tiles && d.tiles.length) {
          const tl2 = uiLabel(d.tiles.map(tileName).join('、'), { size: 9, color: Theme.color.textMuted, align: 'left', width: 120 });
          tl2.setParent(panel);
          tl2.setPosition(lx - 20, ly, 0);
          ly -= 12;
        }
      }
      const totalY = Math.max(-ph / 2 + 72 + bandH, ly - 6);
      const tl = uiLabel(`合计 ${T0} 台`, { size: 13, color: Theme.color.gold, bold: true });
      tl.setParent(panel);
      tl.setPosition(lx, totalY, 0);
      const ziNote = uiLabel('子/连庄加成按付方逐家计入（右列子注）', { size: 9, color: Theme.color.textMuted });
      ziNote.setParent(panel);
      ziNote.setPosition(lx, totalY - 14, 0);
      const rx = pw / 4;
      const cr = uiLabel('积分变动', { size: 12, color: Theme.color.gold, bold: true });
      cr.setParent(panel);
      cr.setPosition(rx, colTop, 0);
      let ry = colTop - 20;
      for (const seat of [0, 1, 2, 3]) {
        const dv = ev.delta[seat] ?? 0;
        const nm = uiLabel(`${this.nameOf(v!, seat)}${seat === meSeat ? '（我）' : ''}`, { size: 10, color: seat === meSeat ? Theme.color.goldLight : Theme.color.textSecondary, align: 'left', width: 92 });
        nm.setParent(panel);
        nm.setPosition(rx - 30, ry, 0);
        const tv = uiLabel(`${dv >= 0 ? '+' : ''}${dv}`, { size: 13, color: dv >= 0 ? Theme.color.gold : Theme.color.danger, bold: true, align: 'right', width: 56 });
        tv.setParent(panel);
        tv.setPosition(rx + 62, ry, 0);
        // 子/庄明细子注：胡方=收付构成；付方=底台+胡方子+自身子+连庄（庄家几庄几子、各加多少一目瞭然）
        let subTxt = '';
        if (seat === w0.seat) {
          subTxt = payerSeats.length === 1 ? `胡 ${T0} 台 · 收 ${this.nameOf(v!, payerSeats[0]!)}` : `胡 ${T0} 台 · 自摸收 ${payerSeats.length} 家`;
        } else if (dv < 0) {
          const zi = ziOf(seat);
          const parts = [seat === dealerSeat ? `庄家·底 ${T0}` : `底 ${T0}`];
          const wz = ziOf(w0.seat);
          if (wz > 0) parts.push(`胡方子 ${wz}(+${3 * wz})`);
          if (zi > 0) parts.push(`自身子 ${zi}(+${3 * zi})`);
          if ((seat === dealerSeat || w0.seat === dealerSeat) && lz >= 1) parts.push(`连庄 ${lz}(+${2 * lz - 1})`);
          subTxt = parts.join('·');
        }
        if (subTxt) {
          const nt = uiLabel(subTxt, { size: 9, color: Theme.color.textMuted, align: 'right', width: 246 });
          nt.setParent(panel);
          nt.setPosition(rx + 16, ry - 11, 0);
          ry -= 32;
        } else ry -= 20;
      }
      const cum = (v?.you.score ?? 0) + myDelta;
      const mt = uiLabel(`我累计 ${cum >= 0 ? '+' : ''}${cum}`, { size: 12, color: cum >= 0 ? Theme.color.gold : Theme.color.danger, bold: true });
      mt.setParent(panel);
      mt.setPosition(rx, Math.max(-ph / 2 + 58 + bandH, ry - 4), 0);
    } else if (ev.type === 'exhaustive') {
      const desc = uiLabel('牌墙摸完，本局无人胡牌\n不计分 · 庄家连庄', { size: 13, color: Theme.color.textSecondary, width: 300 });
      desc.setParent(panel);
      desc.setPosition(0, bandH ? 40 : 10, 0);
    }
    // 各家手牌区（终局摊牌）：2×2 牌面行，结果页内直接看清四家手牌
    if (hands) {
      const ht = uiLabel('各家手牌', { size: 12, color: Theme.color.gold, bold: true });
      ht.setParent(panel);
      ht.setPosition(0, -ph / 2 + 102, 0);
      const RT = { w: 13, h: 18 };
      const pitchX = 13;
      for (let i = 0; i < 4; i++) {
        const seat = i;
        const cellLeft = i % 2 === 0 ? -pw / 2 + 12 : 8;
        const cy = -ph / 2 + (i < 2 ? 86 : 64);
        const nm = uiLabel(this.nameOf(v!, seat), { size: 10, color: Theme.color.textSecondary, align: 'left', width: 52 });
        nm.setParent(panel);
        nm.setPosition(cellLeft + 26, cy, 0);
        expandSorted(hands[seat] ?? {}).forEach((t, j) => {
          const tn = createTileNode(t, RT.w, RT.h);
          tn.setParent(panel);
          tn.setPosition(cellLeft + 56 + j * pitchX + RT.w / 2, cy, 0);
        });
      }
    }
    const btnY = -ph / 2 + (hands ? 26 : 34);
    const isLast = (v?.maxRounds ?? 0) > 0 && (v?.round ?? 1) >= (v?.maxRounds ?? 8);
    const isHost = this.net.room?.hostUserId != null && this.net.room.hostUserId === this.net.userId;
    const showDissolve = !isLast && (v?.maxRounds ?? 0) === 0 && isHost;
    const cont = uiButton(isLast ? '查看最终结果' : '下一局 ▶', () => { mask.destroy(); this.net.nextRound(); }, { variant: 'primary', width: showDissolve ? 170 : 200, height: 46 });
    cont.setParent(panel);
    cont.setPosition(showDissolve ? -95 : 0, btnY, 0);
    if (showDissolve) {
      const dis = uiButton('解散牌局', () => this.showDissolveConfirm(), { variant: 'action', width: 130, height: 44, fontSize: 14 });
      dis.setParent(panel);
      dis.setPosition(95, btnY, 0);
    }
  }

  /** 解散牌局二次确认：结果页「解散牌局」易误点，先弹确认框，确认后才真正解散 */
  private showDissolveConfirm(): void {
    this.overlay.getChildByName('DissolveConfirm')?.destroy();
    const mask = new Node('DissolveConfirm');
    mask.setParent(this.overlay);
    mask.addComponent(UITransform).setContentSize(W, H);
    mask.addComponent(BlockInputEvents); // 阻隔下层结算页，防再次误点
    const w = 300;
    const h = 132;
    const panel = uiPanel(w, h, { variant: 'panel', radius: Theme.radius.lg });
    panel.setParent(mask);
    const tt = uiLabel('解散牌局？', { size: 15, color: Theme.color.gold, bold: true });
    tt.setParent(panel);
    tt.setPosition(0, h / 2 - 26, 0);
    const desc = uiLabel('解散后本房间对局立即结束\n当前积分仍保留至战绩', { size: 11, color: Theme.color.textSecondary, width: 260 });
    desc.setParent(panel);
    desc.setPosition(0, 14, 0);
    const ok = uiButton('确认解散', () => {
      mask.destroy();
      this.overlay.getChildByName('Settlement')?.destroy();
      this.net.dissolve();
    }, { variant: 'action', width: 120, height: 38, fontSize: 13 });
    ok.setParent(panel);
    ok.setPosition(-70, -h / 2 + 30, 0);
    const cancel = uiButton('取消', () => mask.destroy(), { variant: 'primary', width: 120, height: 38 });
    cancel.setParent(panel);
    cancel.setPosition(70, -h / 2 + 30, 0);
  }

  // ============ BL-017 开局仪式遮罩（还原 game.html seatingOverlay） ============

  private hideSeating(): void {
    this.seatingRoot.destroyAllChildren();
  }

  /** 仪式/摸牌位骰遮罩：四骰槽 + 点数榜 + 选座行 + 定庄/摸牌位横幅 + 掷骰按钮；每次 seating 视图变化全量重建 */
  private renderSeating(sv: SeatingView | null, room: RoomView | null): void {
    this.hideSeating();
    if (!sv) return;
    const v = this.net.view;
    const me = v ? v.you.seat : (room?.seats.findIndex((s) => s?.userId === this.net.userId) ?? -1);
    const nameOf = (seat: number): string => {
      if (v?.names?.[seat]) return seat === me ? '我' : v.names[seat]!;
      const u = room?.seats[seat]?.userId;
      if (!u) return `座${seat}`;
      return seat === me ? '我' : u.startsWith('bot-') ? '机器人' : u;
    };
    const isRoundBreak = sv.stage === 'roundBreak';
    const title = isRoundBreak ? `🎲 第 ${v?.round ?? 1} 局已结 · 庄家掷摸牌位骰` : '🎲 开局仪式 · 掷骰选位';

    const mask = new Node('SeatingOverlay');
    mask.addComponent(UITransform).setContentSize(W, H);
    const mg = mask.addComponent(Graphics);
    mg.fillColor = rgba(0, 0, 0, 0.6);
    mg.rect(LEFT, -TOP, W, H);
    mg.fill();
    mask.addComponent(BlockInputEvents); // 阻隔下层牌桌交互
    mask.setParent(this.seatingRoot);

    const PW = 560;
    const PH = 330;
    const panel = uiPanel(PW, PH, { variant: 'gold', radius: Theme.radius.xl });
    panel.setScale(0.94, 0.94, 1);
    tween(panel).to(0.2, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    panel.setParent(mask);
    const tt = uiLabel(title, { size: 17, color: Theme.color.gold, bold: true });
    tt.setParent(panel);
    tt.setPosition(0, PH / 2 - 26, 0);

    let y = PH / 2 - 52;
    // 四骰槽（roll 结果/重掷徽章/最大者金框）
    const hasDice = !isRoundBreak;
    if (hasDice) {
      const maxRoll = Math.max(...sv.rolls.map((x) => x ?? -1));
      for (let seat = 0; seat < 4; seat++) {
        const slotW = 124;
        const slot = uiPanel(slotW, 72, { variant: 'panel', radius: Theme.radius.md });
        slot.setParent(panel);
        slot.setPosition(-PW / 2 + 24 + slotW / 2 + seat * (slotW + 8), y - 36, 0);
        if (sv.rolls[seat] === maxRoll && maxRoll > 0 && (sv.stage === 'roll' || sv.stage === 'pick')) {
          const hl = slot.addComponent(Graphics);
          hl.strokeColor = Theme.color.gold;
          hl.lineWidth = 1.6;
          hl.roundRect(-slotW / 2, -36, slotW, 72, Theme.radius.md);
          hl.stroke();
        }
        const nm = uiLabel(nameOf(seat), { size: 11, color: Theme.color.textSecondary });
        nm.setParent(slot);
        nm.setPosition(0, 24, 0);
        const roll = sv.rolls[seat];
        const faces = uiLabel(roll == null ? '—' : diceFaces(roll), { size: 20, color: Theme.color.textPrimary });
        faces.setParent(slot);
        faces.setPosition(0, 2, 0);
        const sum = uiLabel(roll == null ? '待掷' : `${roll}`, { size: roll == null ? 11 : 14, color: roll == null ? Theme.color.textMuted : Theme.color.goldLight, bold: roll != null });
        sum.setParent(slot);
        sum.setPosition(0, -22, 0);
        if (sv.reroll[seat]) {
          const badge = uiLabel('同点重掷', { size: 8, color: Theme.color.danger });
          badge.setParent(slot);
          badge.setPosition(slotW / 2 - 26, 34, 0);
        }
      }
      y -= 84;
    }

    // 选位顺序榜（roll 完成后）
    if (sv.order.length === 4) {
      const rank = uiLabel(`选位顺序：${sv.order.map((s) => nameOf(s)).join(' → ')}（依次坐下手位）`, { size: 10, color: Theme.color.textMuted, width: PW - 40 });
      rank.setParent(panel);
      rank.setPosition(0, y - 8, 0);
      y -= 26;
    }

    // 选座行（仅 pick 阶段；A 可点，其余置灰）
    if (sv.stage === 'pick') {
      const label = uiLabel(`最大者（${nameOf(sv.picker!)}）选座`, { size: 12, color: Theme.color.textSecondary });
      label.setParent(panel);
      label.setPosition(-150, y - 14, 0);
      const windNames = ['东', '南', '西', '北'];
      const isMePicker = me === sv.picker;
      for (let seat = 0; seat < 4; seat++) {
        const btn = uiButton(windNames[seat]!, () => {
          if (isMePicker) this.net.pickSeat(seat);
        }, { variant: sv.picked === seat ? 'primary' : 'action', width: 52, height: 34, fontSize: 14, enabled: isMePicker });
        btn.setParent(panel);
        btn.setPosition(6 + seat * 60, y - 14, 0);
      }
      if (!isMePicker) {
        const wait = uiLabel(`等待 ${nameOf(sv.picker!)} 选座（10s 超时自动保留原位）`, { size: 10, color: Theme.color.textMuted });
        wait.setParent(panel);
        wait.setPosition(0, y - 42, 0);
      }
      y -= 62;
    }

    // 阶段提示/掷骰按钮
    const myTurn =
      (sv.stage === 'roll' && me >= 0 && (sv.rolls[me] == null || sv.reroll[me])) ||
      (sv.stage === 'dealerDice' && me === sv.picker) ||
      (sv.stage === 'breakDice' && me === sv.dealerSeat) ||
      (sv.stage === 'roundBreak' && me === sv.roller);
    const stageHint = (): string => {
      switch (sv.stage) {
        case 'roll': return '各家掷骰比大小：最大者先选座，其余按点数序依次坐下手；同点重掷';
        case 'pick': return '选位最大者任选一座，其余按点数序依次坐下手位';
        case 'dealerDice': return `最大者（${nameOf(sv.picker!)}）掷定庄骰：点数相对本人定位（7=对面、9=自己）`;
        case 'breakDice': return `庄家（${nameOf(sv.dealerSeat!)}）掷摸牌位骰：定开牌点（右端起跳 N 组）`;
        case 'roundBreak': return `庄家（${nameOf(sv.roller!)}）掷摸牌位骰：定下一局开牌点（相对庄家）`;
      }
    };
    const hint = uiLabel(myTurn ? '轮到你了！' : stageHint(), { size: 12, color: myTurn ? Theme.color.goldLight : Theme.color.textSecondary, bold: myTurn });
    hint.setParent(panel);
    hint.setPosition(0, y - 10, 0);
    y -= 32;
    if (myTurn) {
      const rollBtn = uiButton(isRoundBreak || sv.stage === 'breakDice' ? '🎲 掷摸牌位骰' : sv.stage === 'dealerDice' ? '🎲 掷定庄骰' : '🎲 掷骰', () => this.net.roll(), { variant: 'primary', width: 200, height: 42 });
      rollBtn.setParent(panel);
      rollBtn.setPosition(0, y - 18, 0);
      y -= 52;
    }

    // 定庄横幅
    if (sv.dealerDice != null && sv.dealerSeat != null) {
      const selfNote = sv.dealerSeat === sv.picker ? '（= 选位最大者本人）' : '';
      const b = this.makeBanner(`定庄骰 ${sv.dealerDice} → (${sv.dealerDice}-1) mod 4 = ${(sv.dealerDice - 1) % 4} → 首庄 = ${nameOf(sv.dealerSeat)}${selfNote} · 最大者上 1 子 + 庄子 1`, false);
      b.setParent(panel);
      b.setPosition(0, y - 14, 0);
      y -= 36;
    }
    // 摸牌位横幅（本局已定/局间待掷）
    if (sv.breakN != null) {
      const b = this.makeBanner(`摸牌位骰 ${sv.breakN} → 庄家排右端起跳 ${sv.breakN} 组 · 自第 ${sv.breakN + 1} 组开摸`, true);
      b.setParent(panel);
      b.setPosition(0, y - 14, 0);
      y -= 36;
    }

    // 底部状态按钮（仪式完成后服务端自动发牌，按钮为状态展示）
    const done = !isRoundBreak && sv.stage !== 'roll' && sv.stage !== 'pick' && sv.dealerDice != null && (sv.breakN != null || !this.needsBreak(sv));
    const foot = uiButton(isRoundBreak ? '掷骰后自动开下一局' : done ? `开始第 ${v?.round ?? 1} 局发牌 ▶` : '仪式进行中…', () => { /* 服务端自动推进 */ }, { variant: 'primary', width: 260, height: 40, fontSize: 14, enabled: false });
    foot.setParent(panel);
    foot.setPosition(0, -PH / 2 + 30, 0);
  }

  /** 本房间是否启用摸牌位骰（建房参数，随 roomView.settings 下发） */
  private needsBreak(sv: SeatingView): boolean {
    return this.lastRoom?.settings?.breakDice === true || sv.stage === 'breakDice' || sv.stage === 'roundBreak';
  }

  /** 仪式横幅（还原 .seating-banner / .seating-banner.gold） */
  private makeBanner(text: string, gold: boolean): Node {
    const bw = 500;
    const b = uiPanel(bw, 26, { variant: 'panel', radius: Theme.radius.md });
    const g = b.getComponent(Graphics)!;
    g.strokeColor = gold ? rgba(212, 165, 55, 0.5) : Theme.color.goldFaint;
    g.lineWidth = 1;
    g.roundRect(-bw / 2, -13, bw, 26, Theme.radius.md);
    g.stroke();
    const l = uiLabel(text, { size: 11, color: gold ? Theme.color.goldLight : Theme.color.textPrimary, width: bw - 16 });
    l.setParent(b);
    return b;
  }

  // ============ BL-017 四边物理牌墙排（还原 game.html wall-board，physical 模式） ============

  private renderWalls(v: ViewState): void {
    // 只销毁牌墙栈；开牌点图例（WallLegend）为瞬态提示，独立管理不随重渲染销毁
    for (const c of [...this.wallRoot.children]) if (c.name === 'WStack') c.destroy();
    const info = v.wallInfo;
    if (!info) return;
    const me = v.you.seat;
    const HS = { w: 10, h: 16, gap: 2 }; // 横排组（南/北）
    const VS = { w: 16, h: 10, gap: 2 }; // 竖列组（西/东）
    // 牌墙栈仅两态：满栈(height 2)实心 / 半栈(height 1)半透；已摸(height 0)留缺口不画
    const drawStack = (parent: Node, x: number, y: number, horiz: boolean, height: number, breakpt: boolean): void => {
      const n = new Node('WStack');
      n.addComponent(UITransform).setContentSize(horiz ? HS.w : VS.w, horiz ? HS.h : VS.h);
      n.setParent(parent);
      n.setPosition(x, y, 0);
      const g = n.addComponent(Graphics);
      const w = horiz ? HS.w : VS.w;
      const h = horiz ? HS.h : VS.h;
      g.lineWidth = 1;
      // 牌背：米白顶面 + 深蓝牌身（近似原型 linear-gradient）
      g.fillColor = height >= 2 ? rgba(29, 58, 107, 1) : rgba(29, 58, 107, 0.55);
      g.rect(-w / 2, -h / 2, w, h);
      g.fill();
      g.fillColor = height >= 2 ? rgba(247, 243, 232, 1) : rgba(247, 243, 232, 0.6);
      if (horiz) g.rect(-w / 2, h / 2 - 3, w, 3);
      else g.rect(-w / 2, -h / 2, 3, h);
      g.fill();
      g.strokeColor = rgba(0, 0, 0, 0.4);
      g.rect(-w / 2, -h / 2, w, h);
      g.stroke();
      if (breakpt) {
        // 开牌点：金框 + 光晕（双描边近似 box-shadow）
        g.strokeColor = rgba(212, 165, 55, 0.35);
        g.lineWidth = 4;
        g.rect(-w / 2 - 1, -h / 2 - 1, w + 2, h + 2);
        g.stroke();
        g.strokeColor = Theme.color.gold;
        g.lineWidth = 1.4;
        g.rect(-w / 2, -h / 2, w, h);
        g.stroke();
      }
    };
    // 四边：自己=南（下）、下家=东（右）、对家=北（上）、上手=西（左）；g1 在排右端（屏幕下方/右侧）
    for (const row of info.rows) {
      const rel = relOf(row.seat, me);
      const stacks = row.stacks;
      const isBreakRow = row.seat === info.breakSeat;
      const n = stacks.length;
      for (let i = 0; i < n; i++) {
        const gIdx = i + 1; // 组号：i=0 → g1（排右端）
        const height = stacks[i] ?? 0;
        if (height === 0) continue; // 已摸：留缺口，不再画残影
        const breakpt = isBreakRow && gIdx === info.breakGroups + 1;
        if (rel === 0) {
          // 南：横排，g1 在最右
          drawStack(this.wallRoot, (n - 1 - i) * (HS.w + HS.gap) - ((n - 1) * (HS.w + HS.gap)) / 2, -62, true, height, breakpt);
        } else if (rel === 2) {
          // 北：横排（从上方看右端=屏幕左，为与南排对称仍 g1 右）
          drawStack(this.wallRoot, (n - 1 - i) * (HS.w + HS.gap) - ((n - 1) * (HS.w + HS.gap)) / 2, 116, true, height, breakpt);
        } else if (rel === 1) {
          // 东：竖列，g1 在最下（原型 .wall-col.east right:150 → x=+264）
          drawStack(this.wallRoot, 264, (n - 1 - i) * (VS.h + VS.gap) - ((n - 1) * (VS.h + VS.gap)) / 2, false, height, breakpt);
        } else {
          // 西：竖列，g1 在最下（原型 .wall-col.west left:150 → x=-264）
          drawStack(this.wallRoot, -264, (n - 1 - i) * (VS.h + VS.gap) - ((n - 1) * (VS.h + VS.gap)) / 2, false, height, breakpt);
        }
      }
    }
    // 开牌点图例：瞬态提示——新局开局显示一次，5s 后自动淡出；操作浮层出现时立即隐藏
    if (v.round !== this.wallLegendRound) {
      this.wallLegendRound = v.round;
      this.showWallLegend(info);
    }
  }
  
  /** 开牌点图例（还原 .wall-legend）：新局显示一次，tween delay 5s 后淡出自动隐藏 */
  private showWallLegend(info: NonNullable<ViewState['wallInfo']>): void {
    this.hideWallLegend();
    const legendText = info.breakGroups > 0
      ? `开牌点：庄家排右端起跳 ${info.breakGroups} 组 · 自第 ${info.breakGroups + 1} 组开摸 · 排尽续上手家排`
      : '开牌点：庄家排右端第 1 组开摸 · 排尽续上手家排';
    const lw = legendText.length * 9 + 24;
    const legend = uiPanel(lw, 20, { variant: 'panel', radius: Theme.radius.full });
    const lg = legend.getComponent(Graphics)!;
    lg.strokeColor = rgba(212, 165, 55, 0.35);
    lg.lineWidth = 1;
    lg.roundRect(-lw / 2, -10, lw, 20, 10);
    lg.stroke();
    const ll = uiLabel(legendText, { size: 9, color: Theme.color.gold });
    ll.setParent(legend);
    legend.name = 'WallLegend';
    legend.setParent(this.wallRoot);
    legend.setPosition(0, -16, 0);
    this.wallLegend = legend;
    // Screen 为非 Component 基类（无调度器）：5s 自隐用 tween delay 计时，hideWallLegend 可 stop 取消
    this.wallLegendTween = tween(legend).delay(5).call(() => {
      this.wallLegendTween = null;
      const n = this.wallLegend;
      if (!n) return;
      this.wallLegend = null;
      const op = n.addComponent(UIOpacity);
      tween(op).to(0.3, { opacity: 0 }).call(() => n.destroy()).start();
    }).start();
  }
  
  /** 立即隐藏开牌点图例（5s 到时自隐 / 操作浮层出现时调用，避免与浮层重叠） */
  private hideWallLegend(): void {
    if (this.wallLegendTween) { this.wallLegendTween.stop(); this.wallLegendTween = null; }
    if (this.wallLegend) { this.wallLegend.destroy(); this.wallLegend = null; }
  }

  // ============ 小工具 ============

  private nameOf(v: ViewState, seat: number): string {
    const n = v.names?.[seat];
    if (n) return n;
    return seat === this.mySeat ? '我' : `座${seat}`;
  }
  private isActive(v: ViewState, seat: number): boolean {
    return v.currentSeat === seat && (v.phase === 'draw' || v.phase === 'discard' || v.phase === 'response');
  }

  private mk(parent: Node, name: string, x: number, y: number): Node {
    const n = new Node(name);
    n.addComponent(UITransform);
    n.setParent(parent);
    n.setPosition(x, y, 0);
    return n;
  }

  /** 桌面背景：中心提亮 + 45° 斜纹 + 南家底部渐变带 */
  private drawTableBg(root: Node): void {
    const bg = new Node('Bg');
    bg.addComponent(UITransform).setContentSize(W, H);
    const g = bg.addComponent(Graphics);
    g.fillColor = Theme.color.bgTable;
    g.rect(LEFT, -TOP, W, H);
    g.fill();
    // 45° 斜纹（近似 repeating-linear-gradient）
    g.strokeColor = rgba(9, 61, 34, 0.5);
    g.lineWidth = 2;
    for (let i = -H; i < W + H; i += 4) {
      g.moveTo(LEFT + i, -TOP);
      g.lineTo(LEFT + i + H, TOP);
      g.stroke();
    }
    // 中心提亮
    g.fillColor = rgba(30, 100, 60, 0.2);
    g.circle(0, 0, 220);
    g.fill();
    // 南家底部渐变带
    g.fillColor = rgba(9, 61, 34, 0.4);
    g.rect(LEFT, -TOP, W, 105);
    g.fill();
    bg.setParent(root);
    const exit = uiButton('✕', () => this.onExitRoom(), { variant: 'secondary', width: 28, height: 28, fontSize: 13 });
    exit.setParent(root);
    exit.setPosition(RIGHT - 58, TOP - 6 - 14, 0);
    // M-H：规则/设置入口（牌桌内弹层、不中断对局）；右上簇右→左：静音/退出/规则/设置
    const rulesBtn = uiButton('规则', () => openRulesModal(root), { variant: 'secondary', width: 40, height: 28, fontSize: 12 });
    rulesBtn.setParent(root);
    rulesBtn.setPosition(RIGHT - 96, TOP - 6 - 14, 0);
    const gearBtn = uiButton('⚙', () => openSettingsModal(root, {
      onLeaveRoom: () => this.onExitRoom(),
      onRelogin: () => {
        this.net.disconnect();
        this.router.show('login');
      },
    }), { variant: 'secondary', width: 28, height: 28, fontSize: 13 });
    gearBtn.setParent(root);
    gearBtn.setPosition(RIGHT - 134, TOP - 6 - 14, 0);
  }

  private toast(msg: string): void {
    this.overlay.getChildByName('ToastWrap')?.destroy();
    const p = uiPanel(420, 30, { variant: 'panel', radius: Theme.radius.full });
    p.name = 'ToastWrap';
    p.setParent(this.overlay);
    p.setPosition(0, 150, 0);
    const t = uiLabel(msg, { size: 12, color: Theme.color.textPrimary, width: 400 });
    t.setParent(p);
    setTimeout(() => p.destroy(), 2200);
  }

  private onExitRoom(): void {
    this.net.leave();
    this.router.show('lobby');
  }
}

// ============ 模块级工具 ============

function relOf(seat: number, mySeat: number): number {
  return (seat - mySeat + 4) % 4;
}
const DICE_GLYPHS = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
/** BL-017：骰点和(2..12) → 两骰面展示（客户端仅收到点数和，固定拆分 d1=max(1,min(6,v-6))） */
function diceFaces(v: number): string {
  const d1 = Math.max(1, Math.min(6, v - 6));
  return `${DICE_GLYPHS[d1 - 1]} ${DICE_GLYPHS[v - d1 - 1]}`;
}
/** 取相对方位 rel 对应的绝对座位 */
function relSeat(v: ViewState, mySeat: number, rel: number): number {
  return (mySeat + rel) % 4;
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
function windName(round: number): string {
  const winds = ['东风圈', '南风圈', '西风圈', '北风圈'];
  return winds[Math.floor((round - 1) / 4) % 4]!;
}
const TILE_NAMES: Record<string, string> = { W: '萬', T: '条', B: '筒' };
const FLOWER_NAMES = ['春', '夏', '秋', '冬', '梅', '兰', '竹', '菊'];
/** 牌 ID → 中文牌名（萬/条/筒/字/花）；回放屏复用 */
export function tileName(id: string): string {
  const head = id.charAt(0);
  const num = Number(id.slice(1));
  if (head === 'W' || head === 'T' || head === 'B') return `${id.slice(1)}${TILE_NAMES[head]}`;
  if (head === 'Z') return HONOR_NAMES[num - 1] ?? id;
  if (head === 'H') return FLOWER_NAMES[num - 1] ?? id;
  return id;
}
