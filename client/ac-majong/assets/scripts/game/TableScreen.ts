import { Node, UITransform, Graphics, Color, BlockInputEvents } from 'cc';
import { Screen } from '../app/SceneRouter';
import { Theme, rgba } from '../ui/Theme';
import { uiLabel, uiButton, uiPanel, setButtonEnabled } from '../ui/UiKit';
import { NetService } from './NetService';
import { createTileNode, expandSorted } from './TileNode';
import { chiOptions, waitingTiles, previewTai, addedKongOptions, concealedKongOptions, HONOR_NAMES } from '../vendor/engine/index';
import type { ViewState, GameEvent, Meld } from '../vendor/protocol/index';

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
const MELD_ME = { w: 24, h: 34 };
const RIVER_T = { w: 18, h: 25 };
const HAND_T = { w: 38, h: 54 };

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

  // 响应倒计时（FR-对局-13）
  private cdTotal = 0;
  private cdRemain = 0;
  private cdRunning = false;
  private cdBar: Node | null = null;
  private cdOnTimeout: (() => void) | null = null;
  private cdTimer: ReturnType<typeof setInterval> | null = null;
  // 自己回合展示倒计时（仅视觉：状态栏⏱ + 出牌钮环）
  private turnCd = 0;
  private turnTimer: ReturnType<typeof setInterval> | null = null;

  build(): Node {
    const root = new Node('TableScreen');
    root.addComponent(UITransform).setContentSize(W, H);
    this.drawTableBg(root);

    this.statusBar = this.mk(root, 'StatusBar', 0, 0);
    this.northArea = this.mk(root, 'North', 0, 150);
    this.westArea = this.mk(root, 'West', LEFT + 64, 0);
    this.eastArea = this.mk(root, 'East', RIGHT - 64, 0);
    this.riverArea = this.mk(root, 'River', 0, 25);
    this.southTop = this.mk(root, 'SouthTop', 0, -100);
    this.southHand = this.mk(root, 'SouthHand', 0, -150);
    this.overlay = this.mk(root, 'Overlay', 0, 0);

    // 出牌圆钮（手牌行右端兄弟节点，不重叠）
    this.discardBtn = this.makeDiscardBtn();
    this.discardBtn.setParent(this.southHand);

    this.net.onView((v) => this.render(v));
    this.net.onEvent((m) => this.onEvents(m.events));
    this.net.onRoomEnd(() => this.router.show('result'));
    return root;
  }

  onEnter(): void {
    if (this.net.view) this.render(this.net.view);
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
    this.renderStatus(v);
    this.renderNorth(v);
    this.renderSide(this.westArea, v, 3); // 上家=西
    this.renderSide(this.eastArea, v, 1); // 下家=东
    this.renderRiver(v);
    this.renderSouth(v);
    this.renderActions(v);
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
      { pre: '连庄 ', val: `${v.lianzhuangCount}` },
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
    const pinfo = this.drawPinfo({ name, score: o.score, zi: o.zi, isDealer: o.seat === v.dealerSeat, isActive: this.isActive(v, o.seat) });
    pinfo.setParent(this.northArea);
    pinfo.setPosition(0, 26, 0);
    // body: 明牌(左) + 牌侧横条(右)
    const body = this.mk(this.northArea, 'Body', 0, 0);
    const meldW = this.drawMelds(body, o.melds ?? [], MELD_N, 'h');
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
    const meldH = this.drawMelds(body, o.melds ?? [], MELD_S, 'v');
    // 牌背多时压缩间距，避免竖条底端压到南家信息行
    const pitch = o.concealedCount > 12 ? EDGE_V.h - 2 : EDGE_V.h + 1;
    const edgeH = o.concealedCount * pitch;
    const bodyH = Math.max(edgeH, meldH);
    const PH = 24;
    const GAPV = 4;
    const groupH = PH + GAPV + bodyH;
    const SIDE_Y = 12; // 整组略上移，给南家行让位
    const pinfo = this.drawPinfo({ name, score: o.score, zi: o.zi, isDealer: o.seat === v.dealerSeat, isActive: this.isActive(v, o.seat) });
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
    this.drawRiverBlock(this.riverArea, buckets[nSeat] ?? [], 23, 0, RH / 2 - 14, 'center', latestSeat === nSeat);
    // 南（自己）弃牌：底部居中换行
    this.drawRiverBlock(this.riverArea, buckets[this.mySeat] ?? [], 23, 0, -RH / 2 + 14, 'center', latestSeat === this.mySeat, true);
    // 西（上家）弃牌：中行靠左
    this.drawRiverBlock(this.riverArea, buckets[wSeat] ?? [], 12, -RW / 2 + 120, 0, 'center', latestSeat === wSeat);
    // 东（下家）弃牌：中行靠右
    this.drawRiverBlock(this.riverArea, buckets[eSeat] ?? [], 12, RW / 2 - 120, 0, 'center', latestSeat === eSeat);

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
      const px = (c - (count - 1) / 2) * step;
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
      t.setPosition(x, sel ? 18 : isDrawn ? 10 : 0, 0);
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
    let x = LEFT + 12;
    const me = v.you;
    const pinfo = this.drawPinfo({ name: '我', score: me.score, zi: me.zi, isDealer: me.seat === v.dealerSeat, isActive: this.isActive(v, me.seat), self: true });
    const pw = pinfo.getComponent(UITransform)!.contentSize.width;
    pinfo.setParent(this.southTop);
    pinfo.setPosition(x + pw / 2, 0, 0);
    x += pw + 8;
    if (me.flowers.length) {
      const fw = me.flowers.length * 25 + 10;
      const fa = uiPanel(fw, 35, { variant: 'panel', radius: 6 });
      fa.setParent(this.southTop);
      fa.setPosition(x + fw / 2, 0, 0);
      me.flowers.forEach((f, i) => {
        const t = createTileNode(f, 22, 31);
        t.setParent(fa);
        t.setPosition(-fw / 2 + 5 + i * 25 + 11, 0, 0);
      });
      x += fw + 8;
    }
    const meldsNode = this.mk(this.southTop, 'Melds', 0, 0);
    const meldW = this.drawMelds(meldsNode, me.melds ?? [], MELD_ME, 'h');
    meldsNode.setPosition(x + meldW / 2, 0, 0);
    const preview = previewTai(me.concealed, me.melds ?? [], me.flowers, {
      isDealer: me.seat === v.dealerSeat,
      wallRemaining: v.wallRemaining,
      lianzhuangCount: v.lianzhuangCount,
      drawn: me.drawn ?? undefined,
    });
    const badge = uiButton(`💡 ${preview.tai}台 ▴`, () => this.toggleScorePop(preview), { variant: 'action', width: 92, height: 26, fontSize: 12 });
    badge.setParent(this.southTop);
    badge.setPosition(RIGHT - 58, 0, 0);
    const listen = uiButton(this.listening ? '听牌✓' : '听牌', () => this.toggleListen(), { variant: 'secondary', width: 56, height: 26, fontSize: 12 });
    listen.setParent(this.southTop);
    listen.setPosition(RIGHT - 58 - 46 - 8 - 28, 0, 0);
  }

  // ============ 组件绘制 ============

  /** 玩家信息条：头像+昵称(暖白)+积分(金)+子(灰)+庄家角标；active 金边 */
  private drawPinfo(o: { name: string; score: number; zi: number; isDealer: boolean; isActive: boolean; self?: boolean }): Node {
    const nameW = o.name.length * 11;
    const scoreStr = `${o.score >= 0 ? '+' : ''}${o.score}`;
    const scoreW = scoreStr.length * 7;
    const ziStr = `子${o.zi}`;
    const ziW = ziStr.length * 6;
    const dealerW = o.isDealer ? 20 : 0;
    const pw = 22 + 4 + nameW + 4 + scoreW + 4 + ziW + (dealerW ? 4 : 0) + dealerW + 16;
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
    const zi = uiLabel(ziStr, { size: 9, color: Theme.color.textMuted, align: 'left', width: ziW + 2 });
    zi.setParent(node);
    zi.setPosition(x + ziW / 2, 0, 0);
    x += ziW;
    if (o.isDealer) {
      x += 4;
      const db = new Node('Dealer');
      db.addComponent(UITransform).setContentSize(18, 14);
      const dg = db.addComponent(Graphics);
      dg.fillColor = Theme.color.gold;
      dg.roundRect(-9, -7, 18, 14, 5);
      dg.fill();
      const dl = uiLabel('庄', { size: 9, color: Theme.color.bgWoodDark, bold: true });
      dl.setParent(db);
      db.setParent(node);
      db.setPosition(x + 9, 0, 0);
    }
    return node;
  }

  /** 明牌组（横/竖）+ 组下微型标签；返回占用宽/高 */
  private drawMelds(parent: Node, melds: Meld[], size: { w: number; h: number }, orient: 'h' | 'v'): number {
    if (!melds.length) return 0;
    const wrap = this.mk(parent, 'Melds', 0, 0);
    if (orient === 'h') {
      let x = 0;
      for (const m of melds) {
        const g = this.mk(wrap, 'M', 0, 0);
        let dx = 0;
        for (const t of m.tiles) {
          const tn = createTileNode(t, size.w, size.h);
          tn.setParent(g);
          tn.setPosition(dx, 4, 0);
          dx += size.w + 1;
        }
        const lb = uiLabel(meldLabel(m.type), { size: 9, color: Theme.color.textSecondary });
        lb.setParent(g);
        lb.setPosition(dx / 2 - 4, -size.h / 2 - 4, 0);
        g.setPosition(x + dx / 2, 0, 0);
        x += dx + 8;
      }
      return x;
    }
    let y = 0;
    for (const m of melds) {
      const g = this.mk(wrap, 'M', 0, 0);
      let dy = 0;
      for (const t of m.tiles) {
        const tn = createTileNode(t, size.w, size.h);
        tn.setParent(g);
        tn.setPosition(0, -dy, 0);
        dy += size.h + 1;
      }
      const lb = uiLabel(meldLabel(m.type), { size: 9, color: Theme.color.textSecondary });
      lb.setParent(g);
      lb.setPosition(0, -dy - 6, 0);
      g.setPosition(0, y - dy / 2, 0);
      y -= dy + 10;
    }
    return -y;
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
    const rows = preview.detail.length;
    const statusH = preview.tenpai ? 16 : 0;
    const h = 60 + statusH + rows * 16 + 26;
    const pop = uiPanel(w, h, { variant: 'panel', radius: Theme.radius.lg });
    pop.name = 'ScorePop';
    pop.setParent(this.overlay);
    pop.setPosition(RIGHT - 12 - w / 2, -40, 0);
    const title = uiLabel('💡 台数预览', { size: 11, color: Theme.color.gold, bold: true });
    title.setParent(pop);
    title.setPosition(0, h / 2 - 16, 0);
    if (!preview.tenpai) {
      const d = uiLabel('未听牌 · 暂无台数', { size: 11, color: Theme.color.textSecondary });
      d.setParent(pop);
      d.setPosition(0, 0, 0);
    } else {
      let y = h / 2 - 34;
      const status = preview.canWin
        ? `可自摸 · ${preview.tai}台`
        : preview.viaDiscard
          ? `打 ${tileName(preview.viaDiscard)} 听牌 · ${preview.tai}台`
          : `听牌 · ${preview.tai}台`;
      const st = uiLabel(status, { size: 11, color: Theme.color.goldLight, bold: true });
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
    this.cdBar = this.mk(this.actionBarNode(), 'CdBar', 0, 22);
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
    if (!acts.length) { this.stopCountdown(); return; }
    // 浮层面板
    const panel = uiPanel(360, 92, { variant: 'panel', radius: Theme.radius.lg });
    panel.setParent(bar);
    const hint = uiLabel(hasOpt && v.lastDiscard ? `${this.nameOf(v, v.lastDiscard.seat)} 打出「${tileName(v.lastDiscard.tile)}」，你可以：` : '你可以：', { size: 11, color: Theme.color.textSecondary });
    hint.setParent(panel);
    hint.setPosition(0, 26, 0);
    let bx = -((acts.length - 1) * 62) / 2;
    for (const a of acts) {
      const btn = uiButton(a.label, a.fn, { variant: a.danger ? 'primary' : 'action', width: 56, height: 42, fontSize: 16 });
      btn.setParent(panel);
      btn.setPosition(bx, -12, 0);
      bx += 62;
    }
    // 仅响应期才有「过」与响应倒计时；自己回合的杠/胡按钮不启动 pass 倒计时（避免非法 pass）
    if (hasOpt) this.startCountdown(8, () => this.net.respond(this.mySeat, 'pass'));
    else this.stopCountdown();
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
      if (ev.type === 'win' || ev.type === 'exhaustive') {
        this.revealed = ev.revealed ?? null; // 终局摊牌：先翻面再弹结算
        if (this.net.view) this.render(this.net.view);
      }
      if (ev.type === 'win' || ev.type === 'exhaustive' || ev.type === 'zhahu') this.showSettlement(ev);
    }
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
    const pw = isWin ? 560 : 380;
    const subLines = isWin ? (ev.winners[0]?.detail ?? []).filter((d) => d.tiles && d.tiles.length).length : 0;
    const ph = 300 + subLines * 12;
    const panel = uiPanel(pw, ph, { variant: 'gold', radius: Theme.radius.xl });
    panel.setParent(mask);
    const v = this.net.view;
    let title = '🀄 荒庄流局';
    if (ev.type === 'win') title = `🎉 ${ev.winners.map((w) => this.nameOf(v!, w.seat) + ` 胡 ${w.tai}台`).join(' / ')}`;
    else if (ev.type === 'zhahu') title = `⚠ ${this.nameOf(v!, ev.seat)} 诈胡罚分`;
    const tt = uiLabel(title, { size: 20, color: Theme.color.gold, bold: true });
    tt.setParent(panel);
    tt.setPosition(0, ph / 2 - 28, 0);
    const sub = uiLabel(`第 ${v?.round ?? 1}/${v && v.maxRounds > 0 ? v.maxRounds : '∞'} 局 · 1 台 = 20 积分`, { size: 11, color: Theme.color.textMuted });
    sub.setParent(panel);
    sub.setPosition(0, ph / 2 - 50, 0);
    if (ev.type === 'win') {
      const w0 = ev.winners[0]!;
      const lx = -pw / 4;
      const cl = uiLabel('台数明细', { size: 12, color: Theme.color.gold, bold: true });
      cl.setParent(panel);
      cl.setPosition(lx, ph / 2 - 74, 0);
      let ly = ph / 2 - 96;
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
      const tl = uiLabel(`合计 ${w0.tai} 台`, { size: 13, color: Theme.color.gold, bold: true });
      tl.setParent(panel);
      tl.setPosition(lx, Math.max(-ph / 2 + 58, ly - 6), 0);
      const rx = pw / 4;
      const cr = uiLabel('积分变动', { size: 12, color: Theme.color.gold, bold: true });
      cr.setParent(panel);
      cr.setPosition(rx, ph / 2 - 74, 0);
      let ry = ph / 2 - 96;
      for (const seat of [0, 1, 2, 3]) {
        const dv = ev.delta[seat] ?? 0;
        const nm = uiLabel(this.nameOf(v!, seat), { size: 11, color: Theme.color.textSecondary, align: 'left', width: 60 });
        nm.setParent(panel);
        nm.setPosition(rx - 34, ry, 0);
        const tv = uiLabel(`${dv >= 0 ? '+' : ''}${dv}`, { size: 13, color: dv >= 0 ? Theme.color.gold : Theme.color.danger, bold: true, align: 'right', width: 66 });
        tv.setParent(panel);
        tv.setPosition(rx + 40, ry, 0);
        ry -= 22;
      }
      const my = v?.you.score ?? 0;
      const mt = uiLabel(`我累计 ${my >= 0 ? '+' : ''}${my}`, { size: 12, color: my >= 0 ? Theme.color.gold : Theme.color.danger, bold: true });
      mt.setParent(panel);
      mt.setPosition(rx, Math.max(-ph / 2 + 58, ry - 4), 0);
    } else if (ev.type === 'exhaustive') {
      const desc = uiLabel('牌墙摸完，本局无人胡牌\n不计分 · 庄家连庄', { size: 13, color: Theme.color.textSecondary, width: 300 });
      desc.setParent(panel);
      desc.setPosition(0, 10, 0);
    }
    const isLast = (v?.maxRounds ?? 0) > 0 && (v?.round ?? 1) >= (v?.maxRounds ?? 8);
    const isHost = this.net.room?.hostUserId != null && this.net.room.hostUserId === this.net.userId;
    const showDissolve = !isLast && (v?.maxRounds ?? 0) === 0 && isHost;
    const cont = uiButton(isLast ? '查看最终结果' : '下一局 ▶', () => { mask.destroy(); this.net.nextRound(); }, { variant: 'primary', width: showDissolve ? 170 : 200, height: 46 });
    cont.setParent(panel);
    cont.setPosition(showDissolve ? -95 : 0, -ph / 2 + 34, 0);
    if (showDissolve) {
      const dis = uiButton('解散牌局', () => this.showDissolveConfirm(), { variant: 'action', width: 130, height: 44, fontSize: 14 });
      dis.setParent(panel);
      dis.setPosition(95, -ph / 2 + 34, 0);
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
    exit.setPosition(RIGHT - 10 - 14, TOP - 6 - 14, 0);
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
function tileName(id: string): string {
  const head = id.charAt(0);
  const num = Number(id.slice(1));
  if (head === 'W' || head === 'T' || head === 'B') return `${id.slice(1)}${TILE_NAMES[head]}`;
  if (head === 'Z') return HONOR_NAMES[num - 1] ?? id;
  if (head === 'H') return FLOWER_NAMES[num - 1] ?? id;
  return id;
}
