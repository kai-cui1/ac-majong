import { Node, UITransform, Graphics, Color, BlockInputEvents, Label, tween, Tween, Vec3, UIOpacity, game, Game } from 'cc';
import { Screen } from '../app/SceneRouter';
import { Theme, rgba } from '../ui/Theme';
import { uiLabel, uiButton, uiPanel, setButtonEnabled, uiMuteToggle } from '../ui/UiKit';
import { openRulesModal } from '../ui/RulesModal';
import { openSettingsModal } from '../ui/SettingsModal';
import { AudioManager, SfxName } from '../ui/AudioManager';
import { NetService } from './NetService';
import { Diag } from '../app/Diag';
import { createTileNode, expandSorted } from './TileNode';
import { chiOptions, waitingTiles, previewTai, addedKongOptions, concealedKongOptions, HONOR_NAMES } from '../vendor/engine/index';
import type { ViewState, GameEvent, Meld, RoomView, SeatingView, CeremonyDice, CeremonyPresentation, CeremonyToken } from '../vendor/protocol/index';

/** 牌桌右上按钮簇样式（对齐原型 game.html .btn-exit：28×28 圆钮、黑.5 填、淡金.2 描边、字号13） */
const TOP_BTN = { variant: 'dark' as const, fill: rgba(0, 0, 0, 0.5), stroke: rgba(212, 165, 55, 0.2), radius: 14, width: 28, height: 28, fontSize: 13 };

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
  private settleRound = -1; // BL-026：已建结算浮层的 round（防重复补发请求）
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
  private ceremonyPanel: CeremonyPanel | null = null;
  private readonly resumeCeremony = (): void => { if (this.ceremonyPanel) this.net.refreshRoom(); };
  // BL-017：开牌点图例瞬态提示（新局显示一次、5s 自隐；操作浮层出现立即隐藏）
  private wallLegend: Node | null = null;
  private wallLegendRound = -1;
  private wallLegendTween: Tween<Node> | null = null;
  private lastRoom: RoomView | null = null;

  // BL-032 deadline 同步显示：服务端权威截止驱动响应条/出牌环/状态栏⏱（客户端不再自动 pass，超时动作由服务端产出）
  private cdSec = 0; // 当前相关截止整秒（状态栏⏱）
  private cdBar: Node | null = null;
  private uiTimer: ReturnType<typeof setInterval> | null = null;
  private turnRingRatio = 0; // 出牌钮金环剩余比（自己回合窗）
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
    const mute = uiMuteToggle(28, TOP_BTN);
    mute.setParent(root);
    mute.setPosition(RIGHT - 126, TOP - 20, 0);

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
    game.off(Game.EVENT_SHOW, this.resumeCeremony);
    game.on(Game.EVENT_SHOW, this.resumeCeremony);
    if (this.net.view && this.net.room?.phase !== 'seating') this.render(this.net.view);
    // BL-017：进页时若房间处于仪式阶段（start 后/重连），立即渲染遮罩
    const r = this.net.room;
    if (r) {
      this.lastRoom = r;
      if (r.phase === 'seating') this.renderSeating(r.seating ?? null, r);
    }
    if (this.net.room?.phase !== 'seating' && this.net.view?.seating) this.renderSeating(this.net.view.seating, this.lastRoom);
    // 还原度截图自检演示态：?settleDemo=win 直开结算浮层（mock 数据对齐 result.html 原型演示态）
    if (typeof location !== 'undefined' && location.search.includes('settleDemo=win')) this.demoSettlement();
    // BL-034 自检演示态：?tableDemo=1 mock 视图直渲牌桌（南家徽章/明牌行/右下簇位置核对）
    if (typeof location !== 'undefined' && location.search.includes('tableDemo=1')) this.demoTable();
    this.startUiTick(); // BL-032：deadline 同步显示 tick
  }
  onExit(): void {
    this.stopUiTick();
    if (this.cdBar && this.cdBar.isValid) this.cdBar.destroy();
    this.cdBar = null;
    game.off(Game.EVENT_SHOW, this.resumeCeremony);
    this.hideSeating();
  }

  // ============ 渲染 ============

  private render(v: ViewState): void {
    // BL-023：诊断包上下文（报错时随包带出，免截图猜现场）
    Diag.setCtx({ screen: 'table', room: this.net.room?.room ?? null, round: v.round, phase: v.phase, cur: v.currentSeat, mySeat: v.you?.seat });
    Diag.note('view:' + v.phase);
    this.net.sampleViewClock(v.serverNow); // BL-032：deadline 同步显示钟采样
    this.selectedIdx = null; // 视图刷新（手牌可能变化）时清除选中
    if (v.phase !== 'settled' && v.phase !== 'exhaustive') { this.revealed = null; this.settleRound = -1; } // 新局开始收起摊牌
    // BL-026：结算相位但浮层缺失（晚进入/晚挂载/重连漏事件）→ 请求服务端补发终局事件重建浮层
    if ((v.phase === 'settled' || v.phase === 'exhaustive') && !v.seating && this.settleRound !== v.round && !this.overlay.getChildByName('Settlement')) {
      this.settleRound = v.round; // 先占位防重复请求；事件到达 showSettlement 才真正建层
      this.net.resendSettlement();
    }
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
    const cd = this.cdSec; // BL-032：deadline 同步整秒（自己响应窗优先，否则当前行动家回合窗）
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
    // 明牌在左（BL-035：wrap 名=Melds${seat}；BL-038：drawMelds 横排为左缘原点，旧 +meldW/2 补偿致右移半块压牌背行）
    if (meldW) body.getChildByName(`Melds${o.seat}`)?.setPosition(-totalW / 2, 6, 0);
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
    if (meldH) body.getChildByName(`Melds${o.seat}`)?.setPosition(meldX, meldH / 2, 0); // BL-038：竖排为顶缘原点，+meldH/2 使列垂直居中（旧 y=0 致下垂）
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
    // 明牌行自 x=-160 右排；超宽（听牌钮左缘 115）时降为侧家规格防遮
    const meldsNode = this.mk(this.southTop, 'Melds', 0, 0);
    let meldW = this.drawMelds(meldsNode, me.melds ?? [], MELD_ME, 'h', me.seat, this.pendChiFor(v, me.seat));
    if (meldW > 271) {
      meldsNode.destroyAllChildren();
      meldW = this.drawMelds(meldsNode, me.melds ?? [], { w: 14, h: 19 }, 'h', me.seat, this.pendChiFor(v, me.seat));
    }
    meldsNode.setPosition(-160, 0, 0); // BL-038：横排左缘原点，自 -160 起右排（旧 +meldW/2 致整行右移半块）
    const preview = previewTai(me.concealed, me.melds ?? [], me.flowers, {
      isDealer: me.seat === v.dealerSeat,
      wallRemaining: v.wallRemaining,
      lianzhuangCount: v.lianzhuangCount,
      drawn: me.drawn ?? undefined,
      myZi: me.zi,
    });
    // BL-021：未听牌时徽章改显保底台数（不再显 0）；听牌后仍显预览台数（天然含保底，不双计）
    // BL-034（2026-09-22 用户报障重叠）：徽章自明牌行右端移至右下角（出牌钮右侧、手牌行上沿带，绝对 y-140），
    // 避让自己明牌区右延与下家牌背列；原型 game.html .score-badge 同批
    const badge = uiButton(preview.tenpai ? `💡 ${preview.tai}台 ▴` : `💡 保底 ${preview.secured}台 ▴`, () => this.toggleScorePop(preview), { variant: 'action', width: 88, height: 26, fontSize: 12 });
    badge.setParent(this.southTop);
    badge.setPosition(370, -36, 0);
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
    const ratio = this.turnRingRatio; // BL-032：剩余比由 tickDeadline 按服务端 deadline 计算
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
    pop.setPosition(RIGHT - 8 - w / 2, -121 + h / 2, 0); // BL-034：锚定右下角徽章正上方（底边 -121 起向上展开）
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

  // ============ BL-032 deadline 同步显示 ============

  /** 250ms UI tick：按 view.deadline（服务端权威）刷新响应条/出牌环/⏱；超时动作由服务端产出，客户端只读显示 */
  private startUiTick(): void {
    if (this.uiTimer) return;
    this.uiTimer = setInterval(() => this.tickDeadline(), 250);
  }
  private stopUiTick(): void {
    if (this.uiTimer) { clearInterval(this.uiTimer); this.uiTimer = null; }
  }
  private tickDeadline(): void {
    const v = this.net.view;
    if (!v || !this.node?.isValid) return;
    const d = v.deadline ?? null;
    const remain = d ? Math.max(0, d.at - this.net.viewNow()) : 0;
    // 状态栏⏱：自己的响应窗优先；否则当前行动家回合窗（无窗=0）
    const relevant = !!d && (d.kind === 'resp' ? d.seats.includes(this.mySeat) : true);
    const sec = relevant ? Math.ceil(remain / 1000) : 0;
    if (sec !== this.cdSec) {
      this.cdSec = sec;
      this.renderStatus(v);
      if (sec >= 1 && sec <= 5) AudioManager.instance.play('countdown'); // BL-014：最后 5 秒逐秒警告
    }
    // 响应条（仅自己的响应窗）
    if (d && d.kind === 'resp' && d.seats.includes(this.mySeat)) {
      if (!this.cdBar || !this.cdBar.isValid) {
        // CdBar 挂在 overlay 而非 ActionBar：renderActions 每帧 destroyAllChildren(ActionBar) 会误销毁倒计时条
        this.cdBar = this.mk(this.overlay, 'CdBar', 0, -6);
        this.cdBar.addComponent(Graphics);
      }
      this.drawCdBar(remain / Math.max(1, d.totalMs));
    } else if (this.cdBar) {
      if (this.cdBar.isValid) this.cdBar.destroy();
      this.cdBar = null;
    }
    // 出牌钮金环（自己回合窗）
    this.turnRingRatio = d && d.kind === 'turn' && d.seats.includes(this.mySeat) ? remain / Math.max(1, d.totalMs) : 0;
    this.drawTurnRing(v.phase === 'discard' && v.currentSeat === this.mySeat);
  }
  private drawCdBar(ratio: number): void {
    if (!this.cdBar || !this.cdBar.isValid) { this.cdBar = null; return; }
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
      this.net.draw(this.mySeat);
      return;
    }

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
    if (!acts.length) return;
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
    // BL-032：响应条/⏱ 由 tickDeadline 按服务端 deadline 同步刷新（窗锚点在服务端，客户端无本地倒计时状态）
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

  private showSettlement(ev: Extract<GameEvent, { type: 'win' | 'exhaustive' | 'zhahu' }>, demo = false, demoView?: ViewState): void {
    this.overlay.getChildByName('Settlement')?.destroy();
    this.settleRound = (demoView ?? this.net.view)?.round ?? -1; // BL-026：标记本局浮层已建
    const isWin = ev.type === 'win';
    const mask = new Node('Settlement');
    mask.addComponent(UITransform).setContentSize(W, H);
    const mg = mask.addComponent(Graphics);
    mg.fillColor = rgba(0, 0, 0, 0.55); // 对齐 result.html .rs-dim
    mg.rect(LEFT, -TOP, W, H);
    mg.fill();
    mask.setParent(this.overlay);
    const hands = this.revealed;
    // 面板尺寸对齐 result.html v3：.rs-panel 620×370 固定（有手牌/胡牌时，屏上下各留 10px 边距）；否则小面板
    const pw = isWin || hands ? 620 : 380;
    const ph = isWin || hands ? 370 : 220;
    const panel = uiPanel(pw, ph, { variant: 'gold', radius: Theme.radius.xl });
    // M-J 结算演出（FR-表现-03）：面板 pop 入场
    panel.setScale(0.92, 0.92, 1);
    tween(panel).to(0.22, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    panel.setParent(mask);
    const v = demoView ?? this.net.view;
    const meSeat = v?.you.seat ?? -1;
    const myDelta = ev.type === 'win' ? (ev.delta[meSeat] ?? 0) : 0;
    let title = '🀄 荒庄流局';
    if (ev.type === 'win') {
      const ws = ev.winners[0]!;
      title = ev.winners.length === 1 && ws.seat === meSeat ? `🎉 你胡 ${ws.tai}台！` : `🎉 ${ev.winners.map((w) => `${this.nameOf(v!, w.seat)} 胡 ${w.tai}台`).join(' / ')}`;
    } else if (ev.type === 'zhahu') title = `⚠ ${this.nameOf(v!, ev.seat)} 诈胡罚分`;
    // .rs-title 19px/900/gold-light
    const tt = uiLabel(title, { size: 19, color: Theme.color.goldLight, bold: true });
    tt.setParent(panel);
    tt.setPosition(0, ph / 2 - 20, 0);
    // .rs-sub 9.5px muted
    const sub = uiLabel(`第 ${v?.round ?? 1}/${v && v.maxRounds > 0 ? v.maxRounds : '∞'} 局 · 1 台 = 1 积分`, { size: 9.5, color: Theme.color.textMuted });
    sub.setParent(panel);
    sub.setPosition(0, ph / 2 - 39, 0);
    // 角色个性化横幅（.rs-banner 420×22 胶囊三态：胡方金/付方红/无关灰）
    let banner = '';
    let bannerState: 'win' | 'pay' | 'none' = 'none';
    if (ev.type === 'win') {
      if (meSeat === ev.winners[0]!.seat) {
        banner = `🎉 本局你为胡方 · 共收 ${myDelta >= 0 ? '+' : ''}${myDelta} 分`;
        bannerState = 'win';
      } else if (myDelta < 0) {
        banner = payerCount(ev) === 1 ? `💸 本局你点炮 · 付 ${-myDelta} 分（构成见子注）` : `💸 本局对方自摸 · 你付 ${-myDelta} 分`;
        bannerState = 'pay';
      } else banner = '本局与你无关 · 积分不变';
    }
    if (banner) {
      const bn = new Node('Banner');
      bn.setParent(panel);
      bn.setPosition(0, ph / 2 - 61, 0);
      const bg = bn.addComponent(Graphics);
      if (bannerState === 'win') {
        bg.fillColor = rgba(212, 165, 55, 0.2);
        bg.roundRect(-210, -11, 420, 22, 11);
        bg.fill();
        bg.strokeColor = Theme.color.gold;
      } else if (bannerState === 'pay') {
        bg.fillColor = rgba(220, 80, 80, 0.16);
        bg.roundRect(-210, -11, 420, 22, 11);
        bg.fill();
        bg.strokeColor = rgba(220, 80, 80, 0.55);
      } else {
        bg.fillColor = rgba(255, 255, 255, 0.06);
        bg.roundRect(-210, -11, 420, 22, 11);
        bg.fill();
        bg.strokeColor = rgba(255, 255, 255, 0.15);
      }
      bg.lineWidth = 1;
      bg.roundRect(-210, -11, 420, 22, 11);
      bg.stroke();
      const btxt = uiLabel(banner, { size: 10.5, color: bannerState === 'win' ? Theme.color.goldLight : bannerState === 'pay' ? new Color(243, 177, 177, 255) : Theme.color.textMuted, bold: bannerState !== 'none' });
      btxt.setParent(bn);
    }
    // 双列区域（.rs-cols）：左列 [-292,-9]、右列 [9,292]；列题 11px 金居中
    const colTop = ph / 2 - 88;
    const LC = { l: -pw / 2 + 18, r: -9 }; // 左列边界
    const RC = { l: 9, r: pw / 2 - 18 }; // 右列边界
    if (ev.type === 'win') {
      const w0 = ev.winners[0]!;
      const T0 = w0.tai;
      const ziOf = (s: number): number => (s === v!.you.seat ? v!.you.zi : (v!.others.find((o) => o.seat === s)?.zi ?? 0));
      const dealerSeat = v!.dealerSeat;
      const lz = v!.lianzhuangCount;
      const payerSeats = [0, 1, 2, 3].filter((s) => (ev.delta[s] ?? 0) < 0);
      const cl = uiLabel('台数明细', { size: 11, color: Theme.color.gold, bold: true });
      cl.setParent(panel);
      cl.setPosition((LC.l + LC.r) / 2, colTop, 0);
      // 行区预算：colTop-18 至 手牌区分隔线(-ph/2+84)；行多时压缩行距
      const subN = w0.detail.filter((d) => d.tiles && d.tiles.length).length;
      const rowTop = colTop - 18;
      const rowBottom = -ph / 2 + 96;
      const pitch = Math.min(16, (rowTop - rowBottom - subN * 11 - 34) / Math.max(1, w0.detail.length));
      let ly = rowTop;
      for (const d of w0.detail) {
        // BL-036：子/连庄加成行显性化（金色＋口径后缀），与原型 .rs-row.addrow 同批
        const isAdd = d.name === '子' || d.name === '连庄';
        const addSuffix = d.name === '子' ? '（每家付方各加）' : d.name === '连庄' ? '（涉庄付方加）' : '';
        const nm = uiLabel(`${d.name}${d.count != null && d.count > 1 ? ` ×${d.count}` : ''}${addSuffix}`, { size: 10.5, color: isAdd ? Theme.color.gold : Theme.color.textSecondary, align: 'left', anchorX: 0, width: 200 });
        nm.setParent(panel);
        nm.setPosition(LC.l, ly, 0);
        const tv = uiLabel(`+${d.tai}`, { size: 10.5, color: isAdd ? Theme.color.gold : Theme.color.goldLight, bold: true, align: 'right', anchorX: 1, width: 60 });
        tv.setParent(panel);
        tv.setPosition(LC.r, ly, 0);
        ly -= pitch;
        if (d.tiles && d.tiles.length) {
          const tl2 = uiLabel(d.tiles.map(tileName).join('、'), { size: 8.5, color: Theme.color.textMuted, align: 'left', anchorX: 0, width: 240 });
          tl2.setParent(panel);
          tl2.setPosition(LC.l, ly, 0);
          ly -= 11;
        }
      }
      // .rs-row.total：上分隔线 + 合计行
      const totalY = Math.max(rowBottom + 26, ly - 4);
      const tg = panel.addComponent(Graphics);
      tg.strokeColor = rgba(212, 165, 55, 0.2);
      tg.lineWidth = 1;
      tg.moveTo(LC.l, totalY + 9);
      tg.lineTo(LC.r, totalY + 9);
      tg.stroke();
      const tn = uiLabel('合计', { size: 11.5, color: Theme.color.textPrimary, align: 'left', anchorX: 0, width: 60 });
      tn.setParent(panel);
      tn.setPosition(LC.l, totalY, 0);
      const tvv = uiLabel(`${T0} 台`, { size: 11.5, color: Theme.color.goldLight, bold: true, align: 'right', anchorX: 1, width: 60 });
      tvv.setParent(panel);
      tvv.setPosition(LC.r, totalY, 0);
      const ziNote = uiLabel('付方台 = 底番 + 3×(胡方子+付方子) + 庄连庄 2N−1（仅涉庄付方）', { size: 8.5, color: Theme.color.textMuted });
      ziNote.setParent(panel);
      ziNote.setPosition((LC.l + LC.r) / 2, totalY - 13, 0);
      // 右列：积分变动（.rs-seat 三色：正绿/负浅红/零灰；子注右对齐含零项）
      const cr = uiLabel('积分变动', { size: 11, color: Theme.color.gold, bold: true });
      cr.setParent(panel);
      cr.setPosition((RC.l + RC.r) / 2, colTop, 0);
      let ry = rowTop;
      // BL-036：底番反算（修正旧子注把含加成合计误标为「底」）：B = T0 − 胡方子×3 − 胡方涉庄连庄加成
      const wz = ziOf(w0.seat);
      const winnerInvolved = w0.seat === dealerSeat || (payerSeats.length === 1 && payerSeats[0] === dealerSeat);
      const winBonus = winnerInvolved && lz >= 1 ? 2 * lz - 1 : 0;
      const baseTai = T0 - 3 * wz - winBonus;
      for (const seat of [0, 1, 2, 3]) {
        const dv = ev.delta[seat] ?? 0;
        const nm = uiLabel(`${this.nameOf(v!, seat)}${seat === meSeat ? '（我）' : ''}`, { size: 10.5, color: Theme.color.textSecondary, align: 'left', anchorX: 0, width: 150 });
        nm.setParent(panel);
        nm.setPosition(RC.l, ry, 0);
        // BL-036：庄/子状态徽 chip 接名字后（红 庄·连N / 金 子N / 灰 子0），与原型 .rs-dchip/.rs-zchip 同批
        let chipX = RC.l + (this.nameOf(v!, seat).length + (seat === meSeat ? 3 : 0)) * 10.5 + 6;
        if (seat === dealerSeat) chipX = this.settleChip(panel, chipX, ry, lz >= 1 ? `庄·连${lz}` : '庄', 'dlr');
        this.settleChip(panel, chipX, ry, `子${ziOf(seat)}`, ziOf(seat) > 0 ? 'zi' : 'zi0');
        const dColor = dv > 0 ? new Color(159, 233, 176, 255) : dv < 0 ? new Color(243, 177, 177, 255) : Theme.color.textMuted;
        const tv = uiLabel(`${dv >= 0 ? '+' : ''}${dv}`, { size: 10.5, color: dColor, bold: true, align: 'right', anchorX: 1, width: 60 });
        tv.setParent(panel);
        tv.setPosition(RC.r, ry, 0);
        // BL-036：子注升级算番公式（加项金色分段）：胡方=合计拆解；付方=底+胡方子+自身子+连庄=付台
        const segs: { t: string; gold?: boolean }[] = [];
        if (seat === w0.seat) {
          segs.push({ t: `胡 ${T0} 台 = 底 ${baseTai}` });
          if (wz > 0) segs.push({ t: ` + 自身子 ${wz}×3`, gold: true });
          if (winBonus > 0) segs.push({ t: ` + 连庄 ${lz}(+${winBonus})`, gold: true });
          segs.push({ t: payerSeats.length === 1 ? ' · 收点炮方 1 家' : ' · 按付方子逐家收' });
        } else if (dv < 0) {
          const zi = ziOf(seat);
          const payBonus = (seat === dealerSeat || w0.seat === dealerSeat) && lz >= 1 ? 2 * lz - 1 : 0;
          segs.push({ t: `底 ${baseTai}` });
          if (wz > 0) segs.push({ t: ` + 胡方子 ${wz}×3`, gold: true });
          if (zi > 0) segs.push({ t: ` + 自身子 ${zi}×3`, gold: true });
          if (payBonus > 0) segs.push({ t: ` + 连庄 ${lz}(+${payBonus})`, gold: true });
          segs.push({ t: ` = ${-dv} 台` });
        }
        if (segs.length) {
          this.drawFormula(panel, segs, RC.r, ry - 11);
          ry -= 28;
        } else ry -= 17;
      }
      // .rs-cum：右列底右对齐
      const cum = (v?.you.score ?? 0) + myDelta;
      const mt = uiLabel(`我累计 ${cum >= 0 ? '+' : ''}${cum}`, { size: 11, color: cum >= 0 ? Theme.color.goldLight : new Color(243, 177, 177, 255), bold: true, align: 'right', anchorX: 1, width: 200 });
      mt.setParent(panel);
      mt.setPosition(RC.r, -ph / 2 + 109, 0);
    } else if (ev.type === 'exhaustive') {
      const desc = uiLabel('牌墙摸完，本局无人胡牌\n不计分 · 庄家连庄', { size: 13, color: Theme.color.textSecondary, width: 300 });
      desc.setParent(panel);
      desc.setPosition(0, hands ? 60 : 10, 0);
    }
    // 各家手牌区（终局摊牌）：标题与牌行拉开 + 上分隔线；2×2 牌面行（对齐 result.html BL-033：名称移至牌行上方、牌行享整列宽）
    if (hands) {
      const ht = uiLabel('各家手牌', { size: 11, color: Theme.color.gold, bold: true });
      ht.setParent(panel);
      ht.setPosition(0, -ph / 2 + 108, 0);
      const hg = panel.addComponent(Graphics);
      hg.strokeColor = rgba(212, 165, 55, 0.15);
      hg.lineWidth = 1;
      hg.moveTo(-pw / 2 + 18, -ph / 2 + 99);
      hg.lineTo(pw / 2 - 18, -ph / 2 + 99);
      hg.stroke();
      const RT = { w: 13, h: 18 }; // 对齐原型 .rs-tiles img 13×18
      const PITCH = 15; // 牌宽 13 + 间隙 2；17 张=253 ≤ 列宽 283 不溢面板
      const colW = pw / 2 - 27; // 单列牌行可用宽（左列 -pw/2+18..-9 / 右列 9..pw/2-18）
      const winSeat = ev.type === 'win' ? ev.winners[0]!.seat : -1;
      const payerSeat = ev.type === 'win' ? ([0, 1, 2, 3].find((s) => (ev.delta[s] ?? 0) < 0) ?? -1) : -1;
      for (let i = 0; i < 4; i++) {
        const seat = i;
        const cellLeft = i % 2 === 0 ? -pw / 2 + 18 : 9;
        const cy = -ph / 2 + (i < 2 ? 80 : 47); // 牌行中心；名称行在其上 cy+16（原型：名称在牌行上方）
        const role = seat === winSeat ? '（胡）' : seat === payerSeat ? '（炮）' : '';
        const nm = uiLabel(`${this.nameOf(v!, seat)}${role}`, { size: 8.5, color: Theme.color.textMuted, align: 'left', anchorX: 0, width: colW });
        nm.setParent(panel);
        nm.setPosition(cellLeft, cy + 16, 0);
        // 整手全景（2026-09-22 用户确认）：暗牌(revealed) + 已副露展开（杠计 4 张）= 17 张基准
        const melds = seat === v!.you.seat ? (v!.you.melds ?? []) : (v!.others.find((o) => o.seat === seat)?.melds ?? []);
        const tiles = [...expandSorted(hands[seat] ?? {}), ...melds.flatMap((m) => [...m.tiles].sort())];
        const pitch = tiles.length > 1 ? Math.min(PITCH, (colW - RT.w) / (tiles.length - 1)) : PITCH; // 超 17 张极端例自动压缩牌距，绝不溢面板
        tiles.forEach((t, j) => {
          const tn = createTileNode(t, RT.w, RT.h);
          tn.setParent(panel);
          tn.setPosition(cellLeft + j * pitch + RT.w / 2, cy, 0);
        });
      }
    }
    // .rs-next：200×34 胶囊金钮，底边距 12（-ph/2+12+17）
    const btnY = -ph / 2 + 29;
    const isLast = (v?.maxRounds ?? 0) > 0 && (v?.round ?? 1) >= (v?.maxRounds ?? 8);
    const isHost = this.net.room?.hostUserId != null && this.net.room.hostUserId === this.net.userId;
    const showDissolve = !isLast && (v?.maxRounds ?? 0) === 0 && isHost;
    const cont = uiButton(isLast ? '查看最终结果' : '下一局 ▶', () => { mask.destroy(); if (!demo) this.net.nextRound(); }, { variant: 'primary', width: 200, height: 34, fontSize: 14 });
    cont.setParent(panel);
    cont.setPosition(showDissolve ? -73 : 0, btnY, 0);
    if (showDissolve) {
      const dis = uiButton('解散牌局', () => this.showDissolveConfirm(), { variant: 'action', width: 130, height: 34, fontSize: 12 });
      dis.setParent(panel);
      dis.setPosition(108, btnY, 0);
    }
  }

  /** BL-036 结算庄/子状态徽 chip（对齐原型 .rs-dchip/.rs-zchip）：pill 底+小字；x 为左缘入参，返回下一 chip 左缘 */
  private settleChip(parent: Node, x: number, y: number, text: string, kind: 'dlr' | 'zi' | 'zi0'): number {
    const w = text.length * 8.5 + 10;
    const n = new Node(`Chip${text}`);
    const g = n.addComponent(Graphics);
    if (kind === 'dlr') { g.fillColor = new Color(176, 48, 48, 255); g.strokeColor = Theme.color.goldLight; }
    else if (kind === 'zi') { g.fillColor = rgba(212, 165, 55, 0.14); g.strokeColor = rgba(212, 165, 55, 0.45); }
    else { g.fillColor = rgba(255, 255, 255, 0.05); g.strokeColor = rgba(255, 255, 255, 0.14); }
    g.lineWidth = 1;
    g.roundRect(-w / 2, -6.5, w, 13, 6);
    g.fill();
    g.stroke();
    const lb = uiLabel(text, { size: 8.5, color: kind === 'dlr' ? new Color(255, 255, 255, 255) : kind === 'zi' ? Theme.color.goldLight : Theme.color.textMuted, bold: true });
    lb.setParent(n);
    n.setParent(parent);
    n.setPosition(x + w / 2, y, 0);
    return x + w + 4;
  }

  /** BL-036 算番公式子注：分段着色（加项金/其余灰）右对齐；估宽会致分段重叠/溢右缘，改渲染后按 Label 实宽校准一次 */
  private drawFormula(parent: Node, segs: { t: string; gold?: boolean }[], xRight: number, y: number): void {
    const labels = segs.map((s) => {
      const n = uiLabel(s.t, { size: 8.5, color: s.gold ? Theme.color.gold : Theme.color.textMuted, align: 'left', anchorX: 0 });
      n.setParent(parent);
      n.setPosition(xRight, y, 0);
      return n;
    });
    // Label 实宽在首帧渲染后才可用：双 rAF 待首帧渲染完成后按实宽右对齐重排（估宽会致分段重叠/溢右缘）
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!parent.isValid) return;
      const widths = labels.map((n) => (n.isValid ? n.getComponent(UITransform)!.contentSize.width : 0));
      let x = xRight - widths.reduce((a, b) => a + b, 0);
      labels.forEach((n, i) => {
        if (n.isValid) n.setPosition(x, y, 0);
        x += widths[i]!;
      });
    }));
  }

  /** ?settleDemo=win 演示态：mock 视图+摊牌+win 事件（对齐 result.html 原型 BL-036 演示：你胡 15台=底11+子3+连庄1、付方子2 付 21；含 17 张整手全景行） */
  private demoSettlement(): void {
    const kong = (t: string) => ({ type: 'kong_exposed', tiles: [t, t, t, t] });
    const mockView = {
      room: '688144', round: 1, maxRounds: 8,
      names: ['凯叔', '机器人1', '机器人2', '机器人3'],
      phase: 'settled', dealerSeat: 0, currentSeat: 0, wallRemaining: 20, lianzhuangCount: 1,
      you: { seat: 0, zi: 1, score: 0, concealed: {}, melds: [] },
      others: [
        { seat: 1, zi: 0, concealedCount: 1, melds: [kong('W6'), kong('T2'), kong('B9'), kong('Z1')] }, // 四杠极端例：1+16=17 张
        { seat: 2, zi: 0, concealedCount: 13, melds: [] },
        { seat: 3, zi: 2, concealedCount: 13, melds: [] },
      ],
      discards: [],
    } as unknown as ViewState;
    this.revealed = [
      { W6: 3, B9: 3, T4: 3, B8: 3, T1: 2 },
      { Z2: 1 },
      { W7: 3, T3: 1, T4: 1, T5: 1, T6: 1, B3: 1, B5: 1, Z2: 2, Z7: 1 },
      { W6: 1, W8: 1, W9: 1, T2: 1, T4: 1, T5: 1, B1: 1, B7: 1, Z4: 1, Z5: 1, Z6: 3 },
    ];
    const ev = {
      type: 'win',
      winners: [{
        seat: 0, tai: 15, detail: [
          { name: '见花', count: 2, tai: 2 },
          { name: '无字', tai: 1 },
          { name: '门清自摸', tai: 3 },
          { name: '胡九筒', tai: 5 },
          { name: '子', count: 1, tai: 3 },
          { name: '连庄', count: 1, tai: 1 },
        ],
      }],
      delta: [21, 0, 0, -21],
    } as unknown as Extract<GameEvent, { type: 'win' }>;
    this.showSettlement(ev, true, mockView);
  }

  /** ?tableDemo=1 演示态：mock 视图直渲牌桌（BL-034 徽章右下角位置自检；含明牌两组吃+花牌） */
  private demoTable(): void {
    const mockView = {
      room: '843952', round: 4, maxRounds: 8,
      names: ['凯叔', '机器人1', '机器人2', '机器人3'],
      phase: 'discard', dealerSeat: 3, currentSeat: 0, wallRemaining: 21, lianzhuangCount: 1,
      you: {
        seat: 0, zi: 0, score: 74,
        concealed: { W1: 1, W2: 1, W3: 1, W4: 1, W5: 1, T2: 2, T3: 2, B5: 2, Z1: 1, Z2: 1 },
        melds: [{ type: 'chi', tiles: ['B1', 'B2', 'B3'], called: 'B3' }, { type: 'chi', tiles: ['T4', 'T5', 'T6'], called: 'T4' }],
        flowers: ['H1', 'H3'], drawn: 'Z1', legal: ['discard'],
      },
      others: [
        { seat: 1, zi: 1, score: -22, concealedCount: 13, melds: [{ type: 'chi', tiles: ['T4', 'T5', 'T6'], called: 'T5' }], flowersCount: 0 },
        { seat: 2, zi: 0, score: -30, concealedCount: 13, melds: [{ type: 'pon', tiles: ['Z5', 'Z5', 'Z5'] }], flowersCount: 1 },
        { seat: 3, zi: 1, score: -22, concealedCount: 13, melds: [{ type: 'chi', tiles: ['B1', 'B2', 'B3'], called: 'B2' }], flowersCount: 0 },
      ],
      discards: [{ seat: 3, tile: 'Z5' }, { seat: 0, tile: 'W9' }, { seat: 1, tile: 'B9' }],
      lastDiscard: { seat: 3, tile: 'Z5' },
    } as unknown as ViewState;
    this.render(mockView);
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

  // ============ BL-017 开局仪式遮罩 v2（2026-09-19 重设计：经典骰面+罗盘布局+昵称主显+动效） ============

  private hideSeating(): void {
    this.ceremonyPanel?.dispose();
    this.ceremonyPanel = null;
    this.seatingRoot.destroyAllChildren();
  }

  /** 仪式遮罩 v2：三阶段（①掷骰选位 → ②选座 → ③定庄摸牌位）+ 局间摸牌位 */
  private renderSeating(sv: SeatingView | null, room: RoomView | null): void {
    if (this.router.currentName !== 'table') return;
    if (sv?.presentation) {
      if (this.ceremonyPanel?.id !== sv.presentation.ceremonyId) {
        this.hideSeating();
        this.ceremonyPanel = new CeremonyPanel(this.seatingRoot, this.net, sv.presentation.ceremonyId);
      }
      this.ceremonyPanel!.update(sv, room, this.net.view);
      return;
    }
    this.hideSeating();
    if (!sv) return;
    const v = this.net.view;
    const me = v ? v.you.seat : (room?.seats.findIndex((s) => s?.userId === this.net.userId) ?? -1);
    const nameOf = (seat: number): string => {
      const nick = v?.names?.[seat] || room?.seats[seat]?.nickname;
      if (nick) return seat === me ? `${nick}（我）` : nick;
      const u = room?.seats[seat]?.userId;
      if (!u) return `座${seat}`;
      if (u.startsWith('bot-')) return '机器人';
      return seat === me ? `${u}（我）` : u;
    };
    const isCompass = sv.stage === 'dealerBreak' || sv.stage === 'roundBreak';
    const isRoundBreak = sv.stage === 'roundBreak';
    const title = isRoundBreak ? '🎲 局间定摸牌位' : '🎲 开局仪式';
    const stageText = isCompass
      ? (isRoundBreak ? '局间 · 庄家掷摸牌位骰' : '阶段 ③/3 · 定庄摸牌位')
      : (sv.stage === 'roll' ? '阶段 ①/3 · 掷骰选位' : '阶段 ②/3 · 选座');

    // 遮罩层
    const mask = new Node('SeatingOverlay');
    mask.addComponent(UITransform).setContentSize(W, H);
    const mg = mask.addComponent(Graphics);
    mg.fillColor = rgba(0, 0, 0, 0.6);
    mg.rect(LEFT, -TOP, W, H);
    mg.fill();
    mask.addComponent(BlockInputEvents);
    mask.setParent(this.seatingRoot);

    // 主面板
    const PW = 640;
    const PH = 330;
    const panel = uiPanel(PW, PH, { variant: 'gold', radius: Theme.radius.xl });
    panel.setScale(0.94, 0.94, 1);
    tween(panel).to(0.2, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
    panel.setParent(mask);

    // 标题 + 阶段指示
    const tt = uiLabel(title, { size: 17, color: Theme.color.gold, bold: true });
    tt.setParent(panel);
    tt.setPosition(0, PH / 2 - 24, 0);
    const stg = uiLabel(stageText, { size: 10, color: Theme.color.textMuted });
    stg.setParent(panel);
    stg.setPosition(0, PH / 2 - 42, 0);

    if (isCompass) {
      this.renderCompass(panel, sv, me, nameOf, room, PW, PH);
    } else {
      this.renderRollPick(panel, sv, me, nameOf, PW, PH);
    }
  }

  /** ①② 阶段：四家卡横排 + 经典骰面 + 选座按钮 */
  private renderRollPick(panel: Node, sv: SeatingView, me: number, nameOf: (s: number) => string, PW: number, PH: number): void {
    const cardW = 140;
    const cardH = 96;
    const gap = 12;
    const startX = -(cardW * 4 + gap * 3) / 2 + cardW / 2;
    const cardY = PH / 2 - 110;
    const maxRoll = Math.max(...sv.rolls.map((x) => x ?? -1));

    for (let seat = 0; seat < 4; seat++) {
      const isMe = seat === me;
      const cx = startX + seat * (cardW + gap);
      const card = new Node(`PCard${seat}`);
      card.setParent(panel);
      card.setPosition(cx, cardY, 0);

      // 卡片背景
      const cg = card.addComponent(Graphics);
      const bgAlpha = isMe ? 0.16 : 0.3;
      cg.fillColor = isMe ? rgba(212, 165, 55, bgAlpha) : rgba(0, 0, 0, bgAlpha);
      cg.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 12);
      cg.fill();
      cg.strokeColor = isMe ? Theme.color.gold : rgba(212, 165, 55, 0.2);
      cg.lineWidth = isMe ? 2 : 1;
      cg.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 12);
      cg.stroke();

      // 「我」角标
      if (isMe) {
        const badge = uiLabel('我', { size: 9, color: Theme.color.gold, bold: true });
        badge.setParent(card);
        badge.setPosition(-cardW / 2 + 14, cardH / 2 - 10, 0);
      }

      // 昵称
      const nick = uiLabel(nameOf(seat), { size: 13, color: Theme.color.textPrimary, bold: true, width: cardW - 16 });
      nick.setParent(card);
      nick.setPosition(0, cardH / 2 - 22, 0);

      // 骰子区
      const roll = sv.rolls[seat];
      const diceY = -2;
      if (roll == null) {
        const pending = uiLabel(sv.reroll[seat] ? '待重掷' : '待掷', { size: 10, color: Theme.color.textMuted });
        pending.setParent(card);
        pending.setPosition(0, diceY, 0);
      } else {
        // 旧协议只有总点数：静态呈现，不把拆分值冒充真实双骰。
        const legacy = uiLabel('旧版仅提供总点数', { size: 9, color: Theme.color.textMuted });
        legacy.setParent(card);
        legacy.setPosition(0, diceY, 0);
        // 点数和
        const sumLbl = uiLabel(`${roll}`, { size: 14, color: Theme.color.goldLight, bold: true });
        sumLbl.setParent(card);
        sumLbl.setPosition(0, diceY - 22, 0);
        // 最大者金框高亮
        if (roll === maxRoll && maxRoll > 0 && sv.order.length === 4) {
          const hl = card.addComponent(Graphics);
          hl.strokeColor = Theme.color.gold;
          hl.lineWidth = 1.6;
          hl.roundRect(-cardW / 2 - 2, -cardH / 2 - 2, cardW + 4, cardH + 4, 14);
          hl.stroke();
        }
      }

      // 同点重掷徽章
      if (sv.reroll[seat]) {
        const rb = uiLabel('同点重掷', { size: 8, color: Theme.color.danger, bold: true });
        rb.setParent(card);
        rb.setPosition(cardW / 2 - 28, cardH / 2 - 10, 0);
      }
    }

    // 选位顺序榜
    let y = cardY - cardH / 2 - 20;
    if (sv.order.length === 4) {
      const rank = uiLabel(`选位顺序：${sv.order.map((s) => nameOf(s)).join(' → ')}`, { size: 10, color: Theme.color.textMuted, width: PW - 40 });
      rank.setParent(panel);
      rank.setPosition(0, y, 0);
      y -= 22;
    }

    // ② 选座行
    if (sv.stage === 'pick') {
      const isMePicker = me === sv.picker;
      const hint = uiLabel(isMePicker ? '轮到你了！请选择座位' : `等待 ${nameOf(sv.picker!)} 选座（10s 超时保留原位）`, { size: 12, color: isMePicker ? Theme.color.goldLight : Theme.color.textSecondary, bold: isMePicker });
      hint.setParent(panel);
      hint.setPosition(0, y - 4, 0);
      y -= 28;
      const windNames = ['东', '南', '西', '北'];
      for (let seat = 0; seat < 4; seat++) {
        const btn = uiButton(windNames[seat]!, () => {
          if (isMePicker) this.net.pickSeat(seat);
        }, { variant: sv.picked === seat ? 'primary' : 'action', width: 52, height: 34, fontSize: 14, enabled: isMePicker });
        btn.setParent(panel);
        btn.setPosition(-90 + seat * 60, y - 10, 0);
      }
      y -= 44;
    }

    // 掷骰按钮（roll 阶段轮到自己）
    const myTurnRoll = sv.stage === 'roll' && me >= 0 && (sv.rolls[me] == null || sv.reroll[me]);
    if (myTurnRoll) {
      const rollBtn = uiButton('🎲 掷骰', () => this.net.roll(), { variant: 'primary', width: 180, height: 40 });
      rollBtn.setParent(panel);
      rollBtn.setPosition(0, -PH / 2 + 38, 0);
    }

    // 底部状态
    const foot = uiButton(sv.stage === 'roll' ? '各家掷骰比大小…' : '选座进行中…', () => {}, { variant: 'primary', width: 240, height: 36, fontSize: 12, enabled: false });
    foot.setParent(panel);
    foot.setPosition(0, -PH / 2 + 38, 0);
    if (myTurnRoll) foot.active = false;
  }

  /** ③ 定庄摸牌位 / 局间摸牌位：罗盘式落座布局 */
  private renderCompass(panel: Node, sv: SeatingView, me: number, nameOf: (s: number) => string, room: RoomView | null, PW: number, PH: number): void {
    const isRoundBreak = sv.stage === 'roundBreak';
    const scardW = 118;
    const scardH = 56;
    // 罗盘中心偶移（相对 panel 中心）
    const cY = 10;
    const spreadY = 72; // N/S 距离中心
    const spreadX = 160; // W/E 距离中心

    // 四个座位卡（上北下南左西右东）
    const positions: { seat: number; wind: string; x: number; y: number }[] = [
      { seat: 0, wind: '东', x: spreadX, y: cY },
      { seat: 1, wind: '南', x: 0, y: cY - spreadY },
      { seat: 2, wind: '西', x: -spreadX, y: cY },
      { seat: 3, wind: '北', x: 0, y: cY + spreadY },
    ];

    for (const pos of positions) {
      const { seat, wind, x, y } = pos;
      const isMe = seat === me;
      const isDealer = sv.dealerSeat === seat && sv.dealerDice != null;
      const card = new Node(`SCard${seat}`);
      card.setParent(panel);
      card.setPosition(x, y, 0);

      const cg = card.addComponent(Graphics);
      cg.fillColor = isMe ? rgba(212, 165, 55, 0.16) : rgba(0, 0, 0, 0.3);
      cg.roundRect(-scardW / 2, -scardH / 2, scardW, scardH, 10);
      cg.fill();
      cg.strokeColor = isDealer ? rgba(200, 50, 50, 0.8) : isMe ? Theme.color.gold : rgba(212, 165, 55, 0.2);
      cg.lineWidth = isDealer ? 2 : isMe ? 2 : 1;
      cg.roundRect(-scardW / 2, -scardH / 2, scardW, scardH, 10);
      cg.stroke();

      // 风位角标
      const windLbl = uiLabel(wind, { size: 9, color: Theme.color.textMuted });
      windLbl.setParent(card);
      windLbl.setPosition(-scardW / 2 + 14, scardH / 2 - 10, 0);

      // 「我」角标
      if (isMe) {
        const meBadge = uiLabel('我', { size: 9, color: Theme.color.gold, bold: true });
        meBadge.setParent(card);
        meBadge.setPosition(-scardW / 2 + 14, scardH / 2 - 22, 0);
      }

      // 昵称
      const nick = uiLabel(nameOf(seat), { size: 12, color: Theme.color.textPrimary, bold: true, width: scardW - 12 });
      nick.setParent(card);
      nick.setPosition(0, -2, 0);

      // 子数（局间显示各家实际存子）
      if (isRoundBreak && sv.ziCounts) {
        const zi = sv.ziCounts[seat] ?? 0;
        const isDlr = sv.dealerSeat === seat;
        const ziText = isDlr ? `庄 1 · 子 ${zi}` : `子 ${zi}`;
        const ziLbl = uiLabel(ziText, { size: 9, color: Theme.color.textMuted });
        ziLbl.setParent(card);
        ziLbl.setPosition(0, -scardH / 2 + 12, 0);
      }

      // 庄家徽章（定格后显示）
      if (isDealer) {
        const db = uiLabel('庄家', { size: 9, color: new Color(255, 255, 255, 255), bold: true });
        db.setParent(card);
        db.setPosition(scardW / 2 - 22, scardH / 2 - 10, 0);
        // 红底背景
        const dbg = card.addComponent(Graphics);
        dbg.fillColor = rgba(200, 50, 50, 0.9);
        dbg.roundRect(scardW / 2 - 38, scardH / 2 - 18, 32, 14, 4);
        dbg.fill();
      }

      // A 上 1 子金标（仅开局仪式 dealerBreak 且是 picker）
      if (!isRoundBreak && sv.picker === seat && sv.dealerDice != null) {
        const chip = uiLabel('1 子', { size: 9, color: new Color(60, 40, 10, 255), bold: true });
        chip.setParent(card);
        chip.setPosition(0, -scardH / 2 - 6, 0);
        const chipG = card.addComponent(Graphics);
        chipG.fillColor = Theme.color.gold;
        chipG.roundRect(-18, -scardH / 2 - 13, 36, 14, 7);
        chipG.fill();
      }
    }

    // 中央骰子区
    const diceResult = isRoundBreak ? sv.breakN : sv.dealerDice;
    const myTurn = (sv.stage === 'dealerBreak' && me === sv.picker) || (sv.stage === 'roundBreak' && me === sv.roller);
    if (diceResult != null) {
      // 静态兼容旧服务端，未下发两枚骰面时只展示总和。
      const sumLbl = uiLabel(`总点数 ${diceResult} 点`, { size: 18, color: Theme.color.goldLight, bold: true });
      sumLbl.setParent(panel);
      sumLbl.setPosition(0, cY, 0);
    } else if (myTurn) {
      // 轮到我掷：显示按钮
      const rollBtn = uiButton('🎲 掷骰', () => this.net.roll(), { variant: 'primary', width: 120, height: 38 });
      rollBtn.setParent(panel);
      rollBtn.setPosition(0, cY, 0);
    } else {
      // 等待他人掷骰
      const waitLbl = uiLabel('等待掷骰…', { size: 11, color: Theme.color.textMuted });
      waitLbl.setParent(panel);
      waitLbl.setPosition(0, cY, 0);
    }

    // 牌墙条示意（定庄后显示开牌点）
    let hintY = cY - spreadY - scardH / 2 - 20;
    if (diceResult != null && sv.dealerSeat != null) {
      // 18 组牌墙条
      const stripW = 18 * 14;
      const stripX = -stripW / 2;
      for (let i = 0; i < 18; i++) {
        const gx = stripX + i * 14 + 5;
        const ws = new Node(`WS${i}`);
        ws.setParent(panel);
        ws.setPosition(gx, hintY, 0);
        const wg = ws.addComponent(Graphics);
        const isSkip = i < diceResult; // 右端起跳 N 组（右侧=索引大）
        const isPt = i === diceResult; // 第 N+1 组=开牌点
        if (isSkip) {
          wg.fillColor = rgba(20, 40, 77, 0.3);
        } else if (isPt) {
          wg.fillColor = rgba(212, 165, 55, 0.6);
        } else {
          wg.fillColor = rgba(29, 58, 107, 0.8);
        }
        wg.roundRect(-5, -8, 10, 16, 2);
        wg.fill();
        if (isPt) {
          wg.strokeColor = Theme.color.gold;
          wg.lineWidth = 1.5;
          wg.roundRect(-5, -8, 10, 16, 2);
          wg.stroke();
        }
      }
      const wallLbl = uiLabel(`右端起跳 ${diceResult} 组 · 自第 ${diceResult + 1} 组开摸`, { size: 9, color: Theme.color.textMuted });
      wallLbl.setParent(panel);
      wallLbl.setPosition(0, hintY - 18, 0);
      hintY -= 34;
    }

    // 提示行（去算法化，只报结果）
    if (diceResult != null && sv.dealerSeat != null) {
      const pickerName = nameOf(sv.picker ?? 0);
      const dealerName = nameOf(sv.dealerSeat);
      const hintText = isRoundBreak
        ? `庄家（${dealerName}）掷出 ${diceResult} → 开牌点 = 右端起跳 ${diceResult} 组`
        : `${pickerName} 掷出 ${diceResult} → 首庄 = ${dealerName} · ${pickerName} 上 1 子 + ${dealerName} 上庄`;
      const hint = uiLabel(hintText, { size: 11, color: Theme.color.textSecondary, width: PW - 60 });
      hint.setParent(panel);
      hint.setPosition(0, hintY - 6, 0);
    } else if (myTurn) {
      const hint = uiLabel('轮到你了！', { size: 13, color: Theme.color.goldLight, bold: true });
      hint.setParent(panel);
      hint.setPosition(0, hintY - 6, 0);
    }

    // 底部状态按钮
    const foot = uiButton(
      isRoundBreak ? '掷骰后自动开下一局' : diceResult != null ? '开始发牌 ▶' : '仪式进行中…',
      () => {},
      { variant: 'primary', width: 240, height: 36, fontSize: 12, enabled: false },
    );
    foot.setParent(panel);
    foot.setPosition(0, -PH / 2 + 30, 0);
  }

  /** 经典骰面：象牙白圆角底 + 红/黑点（1/4 红点，其余黑） */
  private drawClassicDie(parent: Node, size: number, value: number, offsetX: number, offsetY: number, big = false): void {
    const die = new Node(`Die${value}`);
    die.setParent(parent);
    die.setPosition(offsetX, offsetY, 0);
    const g = die.addComponent(Graphics);
    const hs = size / 2;
    const r = size * 0.18;
    // 象牙白底 + 边框
    g.fillColor = new Color(255, 254, 245, 255);
    g.roundRect(-hs, -hs, size, size, r);
    g.fill();
    g.strokeColor = new Color(201, 189, 151, 255);
    g.lineWidth = 1;
    g.roundRect(-hs, -hs, size, size, r);
    g.stroke();
    // 点位布局（百分比坐标）
    const PIPS: Record<number, [number, number, number? ][]> = {
      1: [[50, 50, 1]],
      2: [[28, 28], [72, 72]],
      3: [[25, 25], [50, 50], [75, 75]],
      4: [[28, 28, 1], [72, 28, 1], [28, 72, 1], [72, 72, 1]],
      5: [[26, 26], [74, 26], [50, 50], [26, 74], [74, 74]],
      6: [[28, 24], [72, 24], [28, 50], [72, 50], [28, 76], [72, 76]],
    };
    const pipR = size * 0.1;
    for (const [px, py, isRed] of PIPS[value] ?? []) {
      const x = -hs + (px / 100) * size;
      const y = hs - (py / 100) * size; // 翻转 Y
      g.fillColor = isRed ? new Color(176, 42, 42, 255) : new Color(38, 38, 38, 255);
      g.circle(x, y, pipR);
      g.fill();
    }
  }

  /** 本房间是否启用摸牌位骰（建房参数，随 roomView.settings 下发） */
  private needsBreak(sv: SeatingView): boolean {
    return this.lastRoom?.settings?.breakDice === true || sv.stage === 'roundBreak';
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
    const exit = uiButton('✕', () => this.onExitRoom(), TOP_BTN);
    exit.setParent(root);
    exit.setPosition(RIGHT - 92, TOP - 20, 0);
    // M-H：右上簇对齐原型 game.html .top-cluster（左→右 🔊/✕/📋/⚙，28 圆钮 gap6；静音钮在 build 中）
    const rulesBtn = uiButton('📋', () => openRulesModal(root), TOP_BTN);
    rulesBtn.setParent(root);
    rulesBtn.setPosition(RIGHT - 58, TOP - 20, 0);
    const gearBtn = uiButton('⚙', () => openSettingsModal(root, {
      onLeaveRoom: () => this.onExitRoom(),
      onRelogin: () => {
        this.net.disconnect();
        this.router.show('login');
      },
    }), TOP_BTN);
    gearBtn.setParent(root);
    gearBtn.setPosition(RIGHT - 24, TOP - 20, 0);
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

// ============ 持续仪式面板：对齐 game.html 的640×330布局预算 ============

type CeremonyCard = {
  node: Node; bg: Graphics; ring: Graphics; glow: Graphics; nick: Label; identity: Label; mine: Node;
  status: Label; sum: Label; old: Label; dice: Node[]; previous: Node[]; badge: Node;
};

/** 仅在仪式首次进入时构建，消息更新文字/状态；33ms时钟只驱动骰面和倒计时。 */
class CeremonyPanel {
  readonly root: Node;
  private panel: Node;
  private title: Label;
  private stage: Label;
  private rows: CeremonyCard[] = [];
  private compass: CeremonyCard[] = [];
  private center: Node[];
  private centerSum: Label;
  private info: Label[];
  private hint: Label;
  private clock: Label;
  private bar: Graphics;
  private wall: Graphics;
  private rollButton: Node;
  private picks: Node[] = [];
  private timer: ReturnType<typeof setInterval>;
  private sv: SeatingView | null = null;
  private room: RoomView | null = null;
  private view: ViewState | null = null;
  private step = -1;
  private submitted = -1;
  private pipFrame = -1;
  private hintText = '';
  private entranceAt: number | null = null;
  private gestureSteps = new Map<Node, number>();
  private fullNamePanel: Node;
  private fullNameLabel: Label;
  private fullNameUntil = 0;
  private disposed = false;

  constructor(parent: Node, private net: NetService, readonly id: string) {
    this.root = this.node(parent, 'SeatingOverlay', 0, 0);
    this.root.getComponent(UITransform)!.setContentSize(W, H);
    this.root.addComponent(BlockInputEvents);
    this.root.addComponent(UIOpacity);
    const mask = this.root.addComponent(Graphics);
    mask.fillColor = rgba(0, 0, 0, 0.6); mask.rect(-W / 2, -H / 2, W, H); mask.fill();
    this.panel = uiPanel(640, 330, { variant: 'gold', radius: 16 });
    this.panel.name = 'CeremonyPanel'; this.panel.setParent(this.root);
    const panelBg = this.panel.getComponent(Graphics)!;
    panelBg.clear();
    this.gradient(panelBg, 640, 330, 16, new Color(61, 31, 13, 247), new Color(42, 20, 8, 247));
    panelBg.strokeColor = Theme.color.goldDark; panelBg.lineWidth = 1; panelBg.roundRect(-320, -165, 640, 330, 16); panelBg.stroke();
    this.title = this.label(this.panel, 'CeremonyTitle', '', 17, 0, 141, 600, Theme.color.gold, true);
    this.stage = this.label(this.panel, 'CeremonyStage', '', 10, 0, 121, 600);
    for (let seat = 0; seat < 4; seat++) {
      this.rows.push(this.card(seat, false));
      this.compass.push(this.card(seat, true));
    }
    this.center = this.pair(this.panel, 'CenterDice', 40, 0, 33);
    this.centerSum = this.label(this.panel, 'CenterSum', '', 11, 0, 4, 122, Theme.color.goldLight, true);
    this.info = [this.label(this.panel, 'CeremonyInfo', '', 11, 0, -64, 600), this.label(this.panel, 'CeremonyDetail', '', 10, 0, -83, 600)];
    this.wall = this.node(this.panel, 'WallStrip', 0, -63).addComponent(Graphics);
    this.hint = this.label(this.panel, 'CeremonyHint', '', 11, 0, -105, 600, Theme.color.textSecondary);
    this.hint.node.addComponent(UIOpacity);
    this.bar = this.node(this.panel, 'CeremonyProgress', 0, -118.5).addComponent(Graphics);
    this.clock = this.label(this.panel, 'CeremonyClock', '', 10, 0, -139.5, 74, Theme.color.textSecondary);
    this.rollButton = uiButton('掷骰', () => {}, { width: 160, height: 27, fontSize: 12 });
    this.rollButton.name = 'CeremonyRoll'; this.rollButton.setParent(this.panel); this.rollButton.setPosition(-40, -139.5);
    for (let i = 0; i < 4; i++) {
      const b = uiButton(['东', '南', '西', '北'][i]!, () => {}, { variant: 'action', width: 54, height: 27, fontSize: 12 });
      b.name = `CeremonyPick${i}`; b.setParent(this.panel); b.setPosition(-115 + i * 62, -139.5);
      this.picks.push(b);
    }
    this.fullNamePanel = uiPanel(560, 34, { variant: 'gold', radius: 8 });
    this.fullNamePanel.name = 'NameTooltip'; this.fullNamePanel.setParent(this.panel); this.fullNamePanel.setPosition(0, 119);
    this.fullNameLabel = this.label(this.fullNamePanel, 'FullName', '', 12, 0, 0, 540, Theme.color.textPrimary);
    this.fullNamePanel.on(Node.EventType.TOUCH_END, () => { this.fullNamePanel.active = false; });
    this.fullNamePanel.active = false;
    this.timer = setInterval(() => this.tick(), 33);
  }

  private bindButton(button: Node, p: CeremonyPresentation, seat?: number): void {
    const token = { ceremonyId: p.ceremonyId, stepId: p.stepId };
    for (const type of [Node.EventType.TOUCH_START, Node.EventType.TOUCH_END, Node.EventType.TOUCH_CANCEL]) button.off(type);
    button.on(Node.EventType.TOUCH_START, () => this.gestureSteps.set(button, token.stepId));
    button.on(Node.EventType.TOUCH_CANCEL, () => this.gestureSteps.delete(button));
    button.on(Node.EventType.TOUCH_END, (event?: unknown) => {
      const beganAt = this.gestureSteps.get(button); this.gestureSteps.delete(button);
      if (event != null && beganAt !== token.stepId) return;
      this.submit(token, seat);
    });
  }
  private showFullName(seat: number): void {
    const p = this.sv?.presentation; if (!p || this.disposed) return;
    this.fullNameLabel.string = `${['东', '南', '西', '北'][seat]}座 · ${this.rawName(seat)}`;
    this.fullNamePanel.active = true;
    this.fullNameUntil = this.net.ceremonyNow(p) + 2000;
  }
  private paintGlow(c: CeremonyCard, blur: number): void {
    const g = c.glow, tf = c.node.getComponent(UITransform)!; g.clear();
    if (blur <= 0) return;
    for (let i = 12; i > 0; i--) {
      const d = blur * i / 24;
      g.strokeColor = rgba(212, 165, 55, (1 - i / 13) * 0.09); g.lineWidth = blur / 12 + 1;
      g.roundRect(-tf.width / 2 - d, -tf.height / 2 - d, tf.width + 2 * d, tf.height + 2 * d, (tf.height < 50 ? 10 : 12) + d); g.stroke();
    }
  }

  private node(parent: Node, name: string, x: number, y: number): Node {
    const n = new Node(name); n.addComponent(UITransform); n.setParent(parent); n.setPosition(x, y); return n;
  }
  private label(parent: Node, name: string, text: string, size: number, x: number, y: number, width: number, color = Theme.color.textMuted, bold = false): Label {
    const n = uiLabel(text, { size, color, bold, width }); n.name = name; n.setParent(parent); n.setPosition(x, y);
    const l = n.getComponent(Label)!; l.enableWrapText = false; l.overflow = Label.Overflow.SHRINK;
    n.getComponent(UITransform)!.setContentSize(width, size + 5); return l;
  }
  private gradient(g: Graphics, w: number, h: number, radius: number, top: Color, bottom: Color): void {
    for (let i = 0; i < h; i++) {
      const edge = Math.max(0, radius - Math.min(i + 0.5, h - i - 0.5));
      const inset = edge > 0 ? radius - Math.sqrt(radius * radius - edge * edge) : 0;
      const t = i / h;
      g.fillColor = new Color(top.r + (bottom.r - top.r) * t, top.g + (bottom.g - top.g) * t, top.b + (bottom.b - top.b) * t, top.a + (bottom.a - top.a) * t);
      g.rect(-w / 2 + inset, h / 2 - i - 1, w - inset * 2, 1); g.fill();
    }
  }
  private pair(parent: Node, name: string, size: number, x: number, y: number): Node[] {
    return [-1, 1].map((side, i) => {
      const d = this.node(parent, `${name}${i}`, x + side * (size + (size === 16 ? 3 : size === 40 ? 8 : 6)) / 2, y);
      d.getComponent(UITransform)!.setContentSize(size, size); d.addComponent(Graphics); this.paintDie(d, 0); return d;
    });
  }
  private paintDie(die: Node, value: number): void {
    const g = die.getComponent(Graphics)!; const size = die.getComponent(UITransform)!.width;
    g.clear();
    g.fillColor = rgba(0, 0, 0, 0.25); g.roundRect(-size / 2, -size / 2 - 2, size, size, size * 0.21); g.fill();
    // 象牙骰面渐变：逐条裁切圆角，颜色来自原型 .die。
    const radius = size * 0.21;
    for (let i = 0; i < size; i++) {
      const edge = Math.max(0, radius - Math.min(i + 0.5, size - i - 0.5));
      const inset = edge > 0 ? radius - Math.sqrt(radius * radius - edge * edge) : 0;
      const t = i / size; g.fillColor = new Color(255 - 21 * t, 254 - 28 * t, 245 - 47 * t);
      g.rect(-size / 2 + inset, size / 2 - i - 1, size - 2 * inset, 1); g.fill();
    }
    g.strokeColor = new Color(201, 189, 151); g.lineWidth = 1; g.roundRect(-size / 2, -size / 2, size, size, radius); g.stroke();
    const dots: number[][][] = [[], [[50, 50]], [[28, 28], [72, 72]], [[25, 25], [50, 50], [75, 75]], [[28, 28], [72, 28], [28, 72], [72, 72]], [[26, 26], [74, 26], [50, 50], [26, 74], [74, 74]], [[28, 24], [72, 24], [28, 50], [72, 50], [28, 76], [72, 76]]];
    g.fillColor = value === 1 || value === 4 ? new Color(176, 42, 42) : new Color(38, 38, 38);
    for (const [x, y] of dots[value] ?? []) { g.circle((x! / 100 - 0.5) * size, (0.5 - y! / 100) * size, size * 0.105); g.fill(); }
  }
  private card(seat: number, compass: boolean): CeremonyCard {
    // CSS: body top58,height158；横卡宽141；罗盘北/南46高、东西偏移176.5。
    const positions = [[176.5, 28], [0, -28], [-176.5, 28], [0, 84]];
    const [x, y] = compass ? positions[seat]! : [-229.5 + seat * 153, 28];
    const node = this.node(this.panel, `${compass ? 'Compass' : 'Roll'}Card${seat}`, x!, y!);
    node.getComponent(UITransform)!.setContentSize(compass ? 118 : 141, compass ? 46 : 158);
    const bg = node.addComponent(Graphics);
    const glow = this.node(node, 'Glow', 0, 0).addComponent(Graphics);
    const ring = this.node(node, 'Highlight', 0, 0).addComponent(Graphics);
    ring.node.addComponent(UIOpacity);
    const nick = this.label(node, 'Nickname', '', compass ? 11 : 13, 0, compass ? 13 : 59, compass ? 104 : 125, Theme.color.textPrimary, true);
    nick.node.on(Node.EventType.TOUCH_END, () => this.showFullName(seat));
    nick.node.on(Node.EventType.MOUSE_ENTER, () => this.showFullName(seat));
    nick.node.on(Node.EventType.MOUSE_LEAVE, () => { this.fullNamePanel.active = false; });
    if (compass) {
      const wind = this.node(node, 'WindBadge', 55, 21), wg = wind.addComponent(Graphics);
      wg.fillColor = rgba(0, 0, 0, 0.7); wg.strokeColor = rgba(212, 165, 55, 0.5); wg.lineWidth = 1;
      wg.circle(0, 0, 10); wg.fill(); wg.stroke();
      this.label(wind, 'Wind', ['东', '南', '西', '北'][seat]!, 10, 0, 0, 18, Theme.color.goldLight, true);
    }
    const identity = this.label(node, 'Identity', '', compass ? 8 : 9, 0, compass ? -1 : 42, compass ? 106 : 125);
    const mine = uiPanel(27, 14, { variant: 'gold', radius: 7 }); mine.name = 'MineBadge'; mine.setParent(node); mine.setPosition(compass ? -36 : -48, compass ? 23 : 79);
    const mineBg = mine.getComponent(Graphics)!; mineBg.clear();
    this.gradient(mineBg, 27, 14, 7, Theme.color.gold, Theme.color.goldDark);
    this.label(mine, 'MineText', '我', 9, 0, 0, 24, Theme.color.bgWoodDark, true);
    const dice = compass ? [] : this.pair(node, 'Dice', 32, 0, 9);
    const sum = this.label(node, 'Sum', '', 13, 0, -20, 128, Theme.color.goldLight, true);
    const status = this.label(node, 'CardStatus', '', compass ? 8 : 10, 0, compass ? -14 : -39, compass ? 110 : 130, Theme.color.goldLight);
    const old = this.label(node, 'PreviousResult', '', 9, 0, -62, 126, Theme.color.textSecondary);
    const previous = compass ? [] : this.pair(node, 'OldDice', 16, 5, -61);
    const badge = this.node(node, compass ? 'DealerBadge' : 'RerollBadge', compass ? 76 : 45, compass ? -16 : 78);
    badge.addComponent(UIOpacity); const g = badge.addComponent(Graphics); const bw = compass ? 34 : 56;
    g.fillColor = compass ? new Color(176, 48, 48) : rgba(0, 0, 0, 0.75); g.strokeColor = compass ? Theme.color.goldLight : rgba(220, 80, 80, 0.6);
    g.lineWidth = 1; g.roundRect(-bw / 2, -7, bw, 14, 4); g.fill(); g.stroke();
    this.label(badge, 'BadgeText', compass ? '庄家' : '同点重掷', compass ? 9 : 8, 0, 0, bw - 2, compass ? Theme.color.white : new Color(255, 138, 138), true);
    return { node, bg, ring, glow, nick, identity, mine, status, sum, old, dice, previous, badge };
  }
  private userAt(seat: number): string {
    return this.room?.seats[seat]?.userId ?? (this.sv?.presentation?.actor?.seat === seat ? this.sv.presentation.actor.userId : `seat-${seat}`);
  }
  private rawName(seat: number): string {
    return (this.sv?.stage === 'roundBreak' ? this.view?.names[seat] || this.room?.seats[seat]?.nickname : this.room?.seats[seat]?.nickname) || `座位${seat + 1}`;
  }
  private nameAt(seat: number, short = false): string {
    const roundBreak = this.sv?.stage === 'roundBreak';
    const raw = (i: number): string => this.rawName(i);
    const n = raw(seat);
    const me = roundBreak ? this.view?.you.seat === seat : this.userAt(seat) === this.net.userId;
    const suffix = !short ? '' : me ? '（我）' : [0, 1, 2, 3].some(i => i !== seat && raw(i) === n) ? `（${['东', '南', '西', '北'][seat]}）` : '';
    const limit = short ? 9 - suffix.length : 11;
    return (n.length > limit ? n.slice(0, limit - 1) + '…' : n) + suffix;
  }
  /** CSS ease = cubic-bezier(.25,.1,.25,1)，以时间求曲线进度。 */
  private ease(t: number, inOut = false): number {
    if (t <= 0 || t >= 1) return Math.max(0, Math.min(1, t));
    let low = 0, high = 1;
    for (let i = 0; i < 16; i++) {
      const u = (low + high) / 2;
      const x = 3 * (1 - u) * (1 - u) * u * (inOut ? 0.42 : 0.25) + 3 * (1 - u) * u * u * (inOut ? 0.58 : 0.25) + u * u * u;
      if (x < t) low = u; else high = u;
    }
    const u = (low + high) / 2;
    return (inOut ? 0 : 0.3) * (1 - u) * (1 - u) * u + 3 * (1 - u) * u * u + u * u * u;
  }
  private equation(d: CeremonyDice): string { return `${d.d1}＋${d.d2}＝${d.sum}点`; }

  update(sv: SeatingView, room: RoomView | null, view: ViewState | null): void {
    const p = sv.presentation!;
    if (this.disposed || p.stepId < this.step) return;
    if (this.step < 0 && p.stepId === 1 && p.phase === 'input' && p.serverNow - p.startedAt < 250) this.entranceAt = p.startedAt;
    const newStep = p.stepId !== this.step;
    this.step = p.stepId; this.sv = sv; this.room = room; this.view = view;
    if (newStep) {
      this.pipFrame = -1; this.fullNamePanel.active = false;
      this.bindButton(this.rollButton, p);
      this.picks.forEach((button, seat) => this.bindButton(button, p, seat));
    }
    const compass = sv.stage === 'dealerBreak' || sv.stage === 'roundBreak';
    const me = sv.stage === 'roundBreak' ? view?.you.seat : room?.seats.findIndex(s => s?.userId === this.net.userId);
    this.title.string = sv.stage === 'roundBreak' ? '局间定摸牌位' : '开局仪式';
    const titles = { roll: '阶段 ①/3 · 逐家掷骰选位', pick: '阶段 ②/3 · 最大者选座', dealerBreak: '阶段 ③/3 · 一次掷骰定庄与开牌点', roundBreak: '当前庄家掷骰 · 不重新选座或定庄' };
    this.stage.string = titles[sv.stage] + (sv.stage === 'roll' && p.rerollRound ? ` · 重掷第${p.rerollRound}轮` : '');
    for (let i = 0; i < 4; i++) {
      this.rows[i]!.node.active = !compass; this.compass[i]!.node.active = compass;
      const c = compass ? this.compass[i]! : this.rows[i]!;
      const uid = this.userAt(i), r = p.resultsByUserId[uid], actor = p.actor?.seat === i;
      const stale = !compass && sv.reroll[i], dealer = compass && sv.dealerSeat === i;
      const ranked = sv.order.length === 4 && !sv.reroll.some(Boolean);
      c.nick.string = this.nameAt(i); c.mine.active = i === me;
      const member = room?.seats[i];
      c.identity.string = `${['东', '南', '西', '北'][i]}座 · ${member?.isBot ? '机器人' : member ? '真人' : '已落座'}${member?.offline ? ' · 离线' : member?.trusteed ? ' · 托管' : ''}`;
      c.bg.clear(); const w = compass ? 118 : 141, h = compass ? 46 : 158, radius = compass ? 10 : 12;
      if (i === me) this.gradient(c.bg, w, h, radius, rgba(212, 165, 55, 0.16), rgba(212, 165, 55, 0.06));
      else { c.bg.fillColor = rgba(0, 0, 0, 0.3); c.bg.roundRect(-w / 2, -h / 2, w, h, radius); c.bg.fill(); }
      c.bg.strokeColor = stale ? new Color(220, 80, 80) : i === me || dealer || ranked && sv.order[0] === i ? Theme.color.gold : Theme.color.goldFaint;
      c.bg.lineWidth = i === me || dealer ? 2 : 1; c.bg.roundRect(-w / 2, -h / 2, w, h, radius); c.bg.stroke();
      c.ring.clear(); if (actor || dealer && p.phase === 'result') { c.ring.strokeColor = Theme.color.goldLight; c.ring.lineWidth = 2; c.ring.roundRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6, radius + 2); c.ring.stroke(); }
      this.paintGlow(c, i === me ? 10 : ranked && sv.order[0] === i ? 12 : !compass && actor && p.phase === 'result' ? 14 : 0);
      c.badge.active = compass ? dealer : !!stale; c.sum.node.active = !compass; c.old.node.active = !compass && !!stale && !!r;
      c.previous.forEach(d => { d.active = c.old.node.active; });
      if (compass) {
        c.status.string = `${dealer ? '庄家 · ' : ''}子 ${sv.ziCounts?.[i] ?? 0}${actor ? ' · 当前操作' : ''}`;
      } else {
        const pending = !r || actor && p.phase === 'rolling';
        c.sum.fontSize = pending ? 10 : 13; c.sum.isBold = !pending; c.sum.color = pending ? Theme.color.textMuted : Theme.color.goldLight; c.sum.lineHeight = 20;
        c.sum.string = actor && p.phase === 'rolling' ? '掷骰中…' : r ? this.equation(r) : '待掷';
        c.status.string = (actor ? '当前操作 · ' : '') + (stale ? '同点待重掷' : ranked ? `第${sv.order.indexOf(i) + 1}名${sv.order[0] === i ? ' · 最大者' : ''}` : r ? '已落定' : '等待轮转');
        c.status.color = stale ? new Color(255, 138, 138) : Theme.color.goldLight;
        c.old.string = r ? `上次                  ${r.sum}点` : '';
        if (!(actor && p.phase === 'rolling')) c.dice.forEach((d, j) => this.paintDie(d, r ? j ? r.d2 : r.d1 : 0));
        if (stale && r) c.previous.forEach((d, j) => this.paintDie(d, j ? r.d2 : r.d1));
      }
    }
    this.center.forEach((d, j) => { d.active = compass; if (compass && p.phase !== 'rolling') this.paintDie(d, p.ceremonyDice ? j ? p.ceremonyDice.d2 : p.ceremonyDice.d1 : 0); });
    this.centerSum.node.active = compass;
    this.centerSum.string = p.ceremonyDice ? this.equation(p.ceremonyDice) : p.phase === 'rolling' ? '掷骰中…' : '等待掷骰';
    this.wall.clear(); this.info[0]!.node.active = true;
    if (compass) {
      const dice = p.ceremonyDice;
      const physical = room?.settings?.wallMode === 'physical' || (!room?.settings && !!view?.wallInfo);
      if (dice && physical) {
        this.info[0]!.node.active = false;
        for (let i = 0; i < 18; i++) {
          const pt = 18 - i === dice.sum + 1;
          this.wall.fillColor = new Color(25, 49, 90); this.wall.strokeColor = pt ? Theme.color.gold : rgba(120, 160, 220, 0.35); this.wall.lineWidth = pt ? 2 : 1;
          this.wall.roundRect(-133.5 + i * 15, -8, 12, 16, 2); this.wall.fill(); this.wall.stroke();
        }
        this.info[1]!.string = `${this.nameAt(sv.dealerSeat!, true)}门前 · 右端跳${dice.sum}组（${dice.sum * 2}张）· 第${dice.sum + 1}组开摸 ← 从右向左`;
      } else {
        this.info[0]!.string = physical ? '落定后展示庄家门前牌墙开摸位置' : '随机牌墙 · 不展示物理开牌位置';
        this.info[1]!.string = '';
      }
    } else {
      const tiedSummary = p.phase === 'summary' && p.summaryKind === 'reroll';
      // 同点未决仅展示待决组（sv.reroll）本轮顺序；已定序者不参与本轮比较
      const order = sv.order.length ? sv.order : tiedSummary ? [0, 1, 2, 3].filter(i => sv.reroll[i]).sort((a, b) => (sv.rolls[b] ?? 0) - (sv.rolls[a] ?? 0)) : [];
      const rerollPending = sv.stage === 'roll' && p.rerollRound > 0 && !sv.order.length;
      this.info[0]!.string = order.length ? `${tiedSummary ? '同点未决 · 待决组本轮顺序' : '选位顺序'}：${order.map(i => this.nameAt(i, true)).join(' → ')}` : rerollPending ? '重掷进行中 · 仅待决组点数待比较' : '房主开始 · 按仪式开始时的下手座序逐家轮转';
      this.info[1]!.string = tiedSummary ? '仅待决组内判重比大小 · 已定序者不再参与' : p.summaryKind === 'seated' ? sv.order.map(i => `${this.nameAt(i, true)}坐${['东', '南', '西', '北'][i]}`).join(' · ') : sv.order.length ? '按点数降序落座 · 最大者任选一座，其余依次坐下手' : rerollPending ? '本轮结果展示结束后仅待决组重新比较 · 已定序者保留' : '每家滚动1.2秒 + 结果2秒 · 已揭晓结果全桌保留';
    }
    const actorName = p.actor ? this.nameAt(p.actor.seat, true) : '';
    if (compass && p.ceremonyDice) {
      const dealer = this.nameAt(sv.dealerSeat!, true), a = this.nameAt(sv.picker ?? 0, true);
      this.hintText = sv.stage === 'roundBreak' ? `${dealer}坐庄 · 本次仅定摸牌位，不额外加子` : `${dealer}坐庄 · ${a}上1子 + ${dealer}上庄1子${sv.picker === sv.dealerSeat ? '（共2子）' : ''}`;
    } else {
      const result = p.actor ? p.resultsByUserId[p.actor.userId] : undefined;
      const tiedNames = [0, 1, 2, 3].filter(i => sv.reroll[i]).map(i => this.nameAt(i, true)).join('、');
      this.hintText = p.phase === 'input' ? `${p.actor?.userId === this.net.userId ? '轮到你了' : `等待 ${actorName}`} · ${sv.stage === 'pick' ? '任选一座，超时保留当前座位' : p.deadline - p.startedAt <= 600 ? '准备600毫秒后自动掷骰' : '请掷骰，10秒超时自动代掷'}`
        : p.phase === 'rolling' ? `${actorName}正在掷骰 · 结果尚未揭晓`
        : p.phase === 'result' ? `${actorName} · ${result ? this.equation(result) : '结果等待同步'} · 结果停留2秒`
        : p.summaryKind === 'reroll' ? `同点重掷：${tiedNames} · 汇总2秒`
        : p.summaryKind === 'seated' ? '落座完成 · 汇总1.5秒后由最大者掷一次骰定庄' : `${this.nameAt(sv.picker ?? 0, true)}为最大者 · 排名汇总2秒后开放选座`;
    }
    this.hint.string = this.hintText;
    const mineInput = p.phase === 'input' && p.actor?.userId === this.net.userId;
    this.hint.color = mineInput ? Theme.color.goldLight : Theme.color.textSecondary; this.hint.isBold = mineInput;
    this.picks.forEach((button, seat) => {
      const selected = sv.picked === seat, g = button.getComponent(Graphics)!; g.clear();
      g.fillColor = selected ? rgba(212, 165, 55, 0.18) : rgba(0, 0, 0, 0.3); g.strokeColor = selected ? Theme.color.gold : rgba(212, 165, 55, 0.3);
      g.lineWidth = 1; g.roundRect(-27, -13.5, 54, 27, 8); g.fill(); g.stroke();
      button.getChildByName('Label')!.getComponent(Label)!.color = selected ? Theme.color.goldLight : Theme.color.textSecondary;
    });
    this.tick();
  }

  private tick(): void {
    const sv = this.sv; if (this.disposed || !sv?.presentation || !this.root.isValid || !this.root.activeInHierarchy) return;
    const p = sv.presentation, now = this.net.ceremonyNow(p), elapsed = Math.max(0, now - p.startedAt), remaining = Math.max(0, p.deadline - now);
    this.root.getComponent(UIOpacity)!.opacity = this.entranceAt == null ? 255 : Math.round(255 * this.ease((now - this.entranceAt) / 250));
    const compass = sv.stage === 'dealerBreak' || sv.stage === 'roundBreak';
    const rolling = p.phase === 'rolling', activeDice = compass ? this.center : p.actor ? this.rows[p.actor.seat]!.dice : [];
    const frame = Math.floor(elapsed / 90);
    for (const c of this.rows) { c.node.setScale(1, 1, 1); for (const d of c.dice) { d.angle = 0; d.setScale(1, 1, 1); } }
    for (const d of this.center) { d.angle = 0; d.setScale(1, 1, 1); }
    if (rolling) {
      const angles = [-24, 10, 26, -8, -24], scales = [1, 1.08, 1, 0.94, 1];
      const segment = (elapsed % 500) / 125, index = Math.floor(segment), fraction = segment - index;
      activeDice.forEach(d => {
        if (frame !== this.pipFrame) this.paintDie(d, 1 + Math.floor(Math.random() * 6));
        // CSS正角顺时针，Cocos正角逆时针；两骰共用原型关键帧节奏。
        d.angle = -(angles[index]! + (angles[index + 1]! - angles[index]!) * fraction);
        const scale = scales[index]! + (scales[index + 1]! - scales[index]!) * fraction; d.setScale(scale, scale, 1);
      }); this.pipFrame = frame;
    } else if (!compass && p.phase === 'result' && p.actor && elapsed < 200) {
      const progress = elapsed < 90 ? this.ease(elapsed / 90) : 1 - this.ease((elapsed - 90) / 110);
      const scale = 1 + 0.03 * progress; this.rows[p.actor.seat]!.node.setScale(scale, scale, 1);
    }
    for (const c of this.rows) if (c.badge.active) c.badge.getComponent(UIOpacity)!.opacity = elapsed % 600 < 300 ? 255 : 64;
    for (const c of this.compass) c.ring.node.getComponent(UIOpacity)!.opacity = 255;
    if (compass && sv.dealerSeat != null && p.phase === 'result') {
      const pulse = elapsed >= 1000 ? 0 : elapsed < 500 ? this.ease(elapsed / 500) : 1 - this.ease((elapsed - 500) / 500);
      this.paintGlow(this.compass[sv.dealerSeat]!, 14 + 10 * pulse);
    }
    const mine = p.phase === 'input' && p.actor?.userId === this.net.userId;
    const enabled = mine && this.submitted !== p.stepId && remaining > 0;
    const hintTime = elapsed % 1000, hintPulse = hintTime < 500 ? this.ease(hintTime / 500, true) : 1 - this.ease((hintTime - 500) / 500, true);
    this.hint.node.getComponent(UIOpacity)!.opacity = mine ? Math.round(255 * (1 - 0.45 * hintPulse)) : 255;
    if (this.fullNamePanel.active && now >= this.fullNameUntil) this.fullNamePanel.active = false;
    this.rollButton.active = sv.stage !== 'pick'; setButtonEnabled(this.rollButton, enabled);
    this.rollButton.getChildByName('Label')!.getComponent(Label)!.string = p.phase === 'input' ? mine ? '掷骰' : '等待当前玩家' : rolling ? '掷骰中…' : p.phase === 'result' ? compass ? '即将自动发牌' : '查看结果' : '仪式进行中…';
    this.picks.forEach(b => { b.active = sv.stage === 'pick'; setButtonEnabled(b, enabled); b.getComponent(UIOpacity)!.opacity = enabled ? 255 : 115; });
    this.clock.node.setPosition(this.rollButton.active ? 89 : this.picks[0]!.active ? 150 : 0, -139.5);
    this.clock.string = remaining > 0 ? `${p.phase === 'input' ? '剩余' : p.phase === 'rolling' ? '滚动' : p.phase === 'summary' ? '汇总' : '展示'} ${(remaining / 1000).toFixed(1)}s` : '等待同步…';
    this.bar.clear(); this.bar.fillColor = rgba(255, 255, 255, 0.08); this.bar.roundRect(-260, -1.5, 520, 3, 1.5); this.bar.fill();
    const ratio = Math.min(1, remaining / Math.max(1, p.deadline - p.startedAt));
    if (ratio > 0) { this.bar.fillColor = Theme.color.gold; this.bar.rect(-260, -1.5, 520 * ratio, 3); this.bar.fill(); }
  }
  private submit(token: CeremonyToken, seat?: number): void {
    const p = this.sv?.presentation;
    if (this.disposed || !this.root.activeInHierarchy || !p || token.ceremonyId !== p.ceremonyId || token.stepId !== p.stepId || p.phase !== 'input' || p.actor?.userId !== this.net.userId || this.net.ceremonyNow(p) >= p.deadline || this.submitted === p.stepId) return;
    this.submitted = p.stepId;
    AudioManager.instance.play('click');
    if (seat == null) this.net.roll(token); else this.net.pickSeat(seat, token);
    this.tick();
  }
  dispose(): void { this.disposed = true; this.gestureSteps.clear(); clearInterval(this.timer); Tween.stopAllByTarget(this.panel); this.root.destroy(); }
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
/** BL-017 v2：骰点和(2..12) → [d1, d2] 拆分（用于经典骰面绘制） */
function dicePair(sum: number): [number, number] {
  const d1 = Math.max(1, Math.min(6, Math.ceil(sum / 2)));
  const d2 = Math.max(1, Math.min(6, sum - d1));
  return [d1, d2];
}
/** 胡牌事件付方数（delta<0 的座位数） */
function payerCount(ev: { type: string; delta?: Record<number, number> }): number {
  return ev.type === 'win' ? [0, 1, 2, 3].filter((s) => (ev.delta?.[s] ?? 0) < 0).length : 0;
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
