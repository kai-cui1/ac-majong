import { Node, UITransform, Graphics, Color, Label } from 'cc';
import { Screen } from '../app/SceneRouter';
import { Theme } from '../ui/Theme';
import { uiBackground, uiLabel, uiButton } from '../ui/UiKit';
import { NetService } from '../game/NetService';
import { createTileNode, expandSorted } from '../game/TileNode';
import { rehydrate, applyAction } from '../vendor/engine/index';
import { tileName } from '../game/TableScreen';
import type { TableState, Action, GameEvent, RoundSnapshot } from '../vendor/engine/index';
import type { ReplayActionRow } from '../vendor/protocol/index';
import { replayTarget } from './ReplayListScreen';

/**
 * 回放播放器（P10，BL-012；还原 replay-player.html，横屏 844×390）。
 * 数据 = 起始快照 + 动作序列（replayData），客户端 rehydrate + applyAction 确定性重演（D-31 单局回放）。
 * 视角 = 本人座位（viewSeat，服务端按参赛身份下发）；默认牌背随推进，终局自动摊牌；「全亮」开关全知视角（D-29）。
 * 播放控制：播放/暂停 · 单步±1 · 关键帧跳转（开局/胡牌/荒庄）· 倍速 1x/2x/4x · 进度轨点击 seek。
 */

const SEAT_LABEL = ['南', '东', '北', '西'];
const BASE_MS = 800; // 1x 单步间隔
const SPEEDS = [1, 2, 4];

export class ReplayPlayerScreen extends Screen {
  readonly name = 'replay';

  // 回放数据
  private snapshot: RoundSnapshot | null = null;
  private actions: Action[] = [];
  private names: Record<number, string> = {};
  private viewSeat = 0;
  // 播放状态
  private idx = 0;
  private state: TableState | null = null;
  private lastEvents: GameEvent[] = [];
  private keyframes: number[] = [0];
  private playing = false;
  private speed = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private revealAll = false;
  // UI 引用
  private dyn: Node | null = null;
  private infoLbl: Label | null = null;
  private bannerLbl: Label | null = null;
  private posLbl: Label | null = null;
  private playLbl: Label | null = null;
  private speedLbl: Label | null = null;
  private revealLbl: Label | null = null;
  private track: Node | null = null;
  private trackFill: Node | null = null;

  build(): Node {
    const W = Theme.size.designW;
    const H = Theme.size.designH;
    const root = new Node('ReplayPlayerScreen');
    root.addComponent(UITransform).setContentSize(W, H);
    uiBackground('table').setParent(root);

    // 顶栏（暗色横条）：返回 / 局信息 / 全亮开关
    const topbar = new Node('TopBar');
    topbar.addComponent(UITransform).setContentSize(W, 36);
    const tg = topbar.addComponent(Graphics);
    tg.fillColor = new Color(0, 0, 0, 115);
    tg.rect(-W / 2, -18, W, 36);
    tg.fill();
    topbar.setParent(root);
    topbar.setPosition(0, H / 2 - 18, 0);

    const back = uiButton('‹', () => this.router.show('replayList'), { variant: 'secondary', width: 30, height: 28, fontSize: 14 });
    back.setParent(topbar);
    back.setPosition(-W / 2 + 26, 0, 0);
    const info = uiLabel('', { size: 12, color: Theme.color.gold, bold: true, align: 'left', width: 560 });
    info.setParent(topbar);
    info.setPosition(-W / 2 + 330, 0, 0);
    this.infoLbl = info.getComponent(Label)!;
    const reveal = uiButton('全亮：关', () => this.toggleReveal(), { variant: 'secondary', width: 84, height: 26, fontSize: 11 });
    reveal.setParent(topbar);
    reveal.setPosition(W / 2 - 60, 0, 0);
    this.revealLbl = this.findLabel(reveal);

    // 事件横幅
    const banner = uiLabel('', { size: 12, color: Theme.color.gold, bold: true, width: 640 });
    banner.setParent(root);
    banner.setPosition(0, H / 2 - 56, 0);
    this.bannerLbl = banner.getComponent(Label)!;

    // 牌桌动态层（每步重建）
    this.dyn = new Node('Dyn');
    this.dyn.addComponent(UITransform).setContentSize(W, H);
    this.dyn.setParent(root);

    // 底部播放控制条（暗色横条）
    const bar = new Node('ControlBar');
    bar.addComponent(UITransform).setContentSize(W, 52);
    const bg = bar.addComponent(Graphics);
    bg.fillColor = new Color(0, 0, 0, 140);
    bg.rect(-W / 2, -26, W, 52);
    bg.fill();
    bar.setParent(root);
    bar.setPosition(0, -H / 2 + 26, 0);

    const mk = (text: string, x: number, w: number, onClick: () => void, primary = false): Label => {
      const b = uiButton(text, onClick, { variant: primary ? 'primary' : 'secondary', width: w, height: 30, fontSize: 13 });
      b.setParent(bar);
      b.setPosition(x, 0, 0);
      return this.findLabel(b)!;
    };
    mk('⏮', -W / 2 + 34, 36, () => this.jumpKeyframe(-1));
    mk('−1', -W / 2 + 76, 36, () => this.stepBy(-1));
    this.playLbl = mk('▶', -W / 2 + 120, 44, () => this.togglePlay(), true);
    mk('+1', -W / 2 + 164, 36, () => this.stepBy(1));
    mk('⏭', -W / 2 + 206, 36, () => this.jumpKeyframe(1));
    this.speedLbl = mk('1x', -W / 2 + 250, 44, () => this.cycleSpeed());

    // 进度轨（点击 seek）+ 金色填充
    const trackW = W - 420;
    const track = new Node('Track');
    track.addComponent(UITransform).setContentSize(trackW, 16);
    const tkg = track.addComponent(Graphics);
    tkg.fillColor = new Color(255, 255, 255, 30);
    tkg.roundRect(-trackW / 2, -2, trackW, 4, 2);
    tkg.fill();
    track.setParent(bar);
    track.setPosition(60, 0, 0);
    this.track = track;
    const fill = new Node('TrackFill');
    fill.addComponent(UITransform).setContentSize(trackW, 16);
    fill.addComponent(Graphics);
    fill.setParent(bar);
    fill.setPosition(60, 0, 0);
    this.trackFill = fill;
    track.on(Node.EventType.TOUCH_END, (e: { getUILocation: () => { x: number } }) => {
      if (!this.snapshot) return;
      const wp = track.worldPosition;
      const ratio = Math.min(1, Math.max(0, (e.getUILocation().x - (wp.x - trackW / 2)) / trackW));
      this.seekTo(Math.round(ratio * this.actions.length));
    });

    const pos = uiLabel('0 / 0 步', { size: 10, color: Theme.color.textMuted, align: 'right', width: 90 });
    pos.setParent(bar);
    pos.setPosition(W / 2 - 60, 0, 0);
    this.posLbl = pos.getComponent(Label)!;

    return root;
  }

  onEnter(): void {
    void this.load();
  }

  onExit(): void {
    this.stopTimer();
    this.playing = false;
  }

  private async load(): Promise<void> {
    this.stopTimer();
    this.snapshot = null;
    if (this.bannerLbl) this.bannerLbl.string = '回放加载中…';
    try {
      const d = await NetService.instance.replayLoad(replayTarget.gameId);
      this.snapshot = d.snapshot as unknown as RoundSnapshot;
      this.actions = d.actions.map((a: ReplayActionRow) => a.action as Action);
      this.names = d.names;
      this.viewSeat = d.viewSeat;
    } catch (e) {
      if (this.bannerLbl) {
        this.bannerLbl.string = e instanceof Error ? e.message : '回放加载失败';
        this.bannerLbl.color = Theme.color.danger;
      }
      return;
    }
    if (!this.dyn || !this.dyn.isValid) return;
    if (this.bannerLbl) this.bannerLbl.color = Theme.color.gold;
    // 预演一遍：收集关键帧（开局 + 每步产生胡/诈胡/荒庄后的位置）
    const total = this.actions.length;
    // 关键帧用纯数组维护（Cocos web 构建下 Set 展开运算符不可靠，勿用 [...set]）
    const kf: number[] = [0];
    const addKf = (n: number): void => { if (!kf.includes(n)) kf.push(n); };
    addKf(total);
    if (total > 0) {
      let sim = rehydrate(this.snapshot);
      for (let k = 0; k < total; k++) {
        const r = applyAction(sim, this.actions[k]!);
        if (r.events.some((ev) => ev.type === 'win' || ev.type === 'zhahu' || ev.type === 'exhaustive')) addKf(k + 1);
        sim = r.state;
      }
    }
    this.keyframes = kf.sort((x, y) => x - y);
    this.revealAll = false;
    this.speed = 1;
    if (this.speedLbl) this.speedLbl.string = '1x';
    this.updateInfo();
    this.seekTo(0);
    this.playing = true;
    if (this.playLbl) this.playLbl.string = '⏸';
    this.startTimer();
  }

  private updateInfo(): void {
    if (!this.infoLbl || !this.snapshot) return;
    const lian = this.snapshot.lianzhuangCount;
    this.infoLbl.string = `${replayTarget.roomLabel} · 第 ${replayTarget.roundNo || this.snapshot.round} 局 · 庄家：${this.who(this.snapshot.dealerSeat)}${lian > 0 ? ` · 连庄 ${lian}` : ''}`;
  }

  private who(seat: number): string {
    if (seat === this.viewSeat) return '我';
    return this.names[seat] ?? `AI·${SEAT_LABEL[this.rel(seat)] ?? seat}`;
  }
  /** 座位 → 显示方位（0=下/我，1=右，2=上，3=左） */
  private rel(seat: number): number {
    return (seat - this.viewSeat + 4) % 4;
  }

  // ===== 播放控制 =====

  private togglePlay(): void {
    if (!this.snapshot) return;
    if (this.idx >= this.actions.length && !this.playing) this.seekTo(0); // 播完再点=重播
    this.playing = !this.playing;
    if (this.playLbl) this.playLbl.string = this.playing ? '⏸' : '▶';
  }

  private cycleSpeed(): void {
    const i = SPEEDS.indexOf(this.speed);
    this.speed = SPEEDS[(i + 1) % SPEEDS.length]!;
    if (this.speedLbl) this.speedLbl.string = `${this.speed}x`;
    if (this.playing) this.startTimer(); // 变速即时生效
  }

  private toggleReveal(): void {
    this.revealAll = !this.revealAll;
    if (this.revealLbl) this.revealLbl.string = this.revealAll ? '全亮：开' : '全亮：关';
    this.render();
  }

  private stepBy(d: number): void {
    this.seekTo(Math.min(this.actions.length, Math.max(0, this.idx + d)));
  }

  private jumpKeyframe(dir: 1 | -1): void {
    const ks = this.keyframes;
    let target = dir === 1 ? ks[ks.length - 1] : ks[0];
    for (const k of ks) {
      if (dir === 1 && k > this.idx) { target = k; break; }
      if (dir === -1 && k < this.idx) target = k;
    }
    this.seekTo(target ?? this.idx);
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (!this.node || !this.node.isValid || !this.dyn || !this.dyn.isValid) { this.stopTimer(); return; }
      if (!this.playing) return;
      if (this.idx >= this.actions.length) {
        this.playing = false;
        if (this.playLbl) this.playLbl.string = '▶';
        return;
      }
      this.seekTo(this.idx + 1);
    }, BASE_MS / this.speed);
  }

  private stopTimer(): void {
    if (this.timer != null) { clearInterval(this.timer); this.timer = null; }
  }

  /** 跳到第 k 步（0=起始快照）：前进增量 apply，回退全量重演（≤200 步，代价可忽略） */
  private seekTo(k: number): void {
    if (!this.snapshot) return;
    k = Math.min(this.actions.length, Math.max(0, k));
    if (k >= this.idx && this.state) {
      while (this.idx < k) {
        const r = applyAction(this.state, this.actions[this.idx]!);
        this.state = r.state;
        this.lastEvents = r.events;
        this.idx++;
      }
    } else {
      let st = rehydrate(this.snapshot);
      let evs: GameEvent[] = [];
      for (let i = 0; i < k; i++) {
        const r = applyAction(st, this.actions[i]!);
        st = r.state;
        evs = r.events;
      }
      this.state = st;
      this.lastEvents = evs;
      this.idx = k;
    }
    this.render();
  }

  // ===== 渲染 =====

  private render(): void {
    const dyn = this.dyn;
    if (!dyn || !this.state) return;
    dyn.destroyAllChildren();
    const s = this.state;
    const ended = s.phase === 'settled' || s.phase === 'exhaustive';
    const showAll = this.revealAll || ended; // D-29：终局自动摊牌；全亮=全知视角

    // 四家：手牌区 + 名牌 + 副露 + 花/子
    s.players.forEach((p) => {
      const rel = this.rel(p.seat);
      const count = Object.values(p.concealed).reduce((a, b) => a + b, 0);
      const isMe = rel === 0;
      if (isMe) {
        // 下家（我）：明牌横排 + 副露
        const tiles = expandSorted(p.concealed);
        const gap = 2;
        const tw = 28;
        const total = tiles.length * (tw + gap) - gap;
        tiles.forEach((t, i) => {
          const n = createTileNode(t, tw, 38);
          n.setParent(dyn);
          n.setPosition(-total / 2 + i * (tw + gap) + tw / 2 - 60, -Theme.size.designH / 2 + 88, 0);
        });
        this.drawMelds(dyn, p.melds, -Theme.size.designW / 2 + 120, -Theme.size.designH / 2 + 128);
        this.drawSeatTag(dyn, p.seat, p, -Theme.size.designW / 2 + 300, -Theme.size.designH / 2 + 128);
      } else if (rel === 2) {
        // 上家（北）：横条
        this.drawSeatTag(dyn, p.seat, p, 0, Theme.size.designH / 2 - 92);
        if (!showAll) {
          for (let i = 0; i < count; i++) {
            const n = this.backTile(16, 22);
            n.setParent(dyn);
            n.setPosition(-((count - 1) * 18) / 2 + i * 18, Theme.size.designH / 2 - 116, 0);
          }
        } else {
          this.revealRow(dyn, p, 0, Theme.size.designH / 2 - 116, 18);
        }
        this.drawMelds(dyn, p.melds, Theme.size.designW / 2 - 200, Theme.size.designH / 2 - 116);
      } else {
        // 左/右家（西/东）：竖条（限高不压控制条）
        const x = rel === 1 ? Theme.size.designW / 2 - 52 : -Theme.size.designW / 2 + 52;
        this.drawSeatTag(dyn, p.seat, p, x, 100);
        if (!showAll) {
          for (let i = 0; i < count; i++) {
            const n = this.backTile(16, 22);
            n.setParent(dyn);
            n.setPosition(x, 72 - i * 13, 0);
          }
        } else {
          this.revealColumn(dyn, p, x, 72, 13);
        }
        this.drawMelds(dyn, p.melds, x, -110);
      }
    });

    // 中央牌河：四格文字（对齐原型 rp-river）
    const river = new Node('River');
    river.addComponent(UITransform).setContentSize(320, 150);
    const rg = river.addComponent(Graphics);
    rg.strokeColor = new Color(212, 165, 55, 50);
    rg.lineWidth = 1;
    rg.roundRect(-160, -75, 320, 150, 10);
    rg.stroke();
    river.setParent(dyn);
    river.setPosition(0, -6, 0);
    ([2, 1, 0, 3] as const).forEach((rel, i) => {
      const seat = (this.viewSeat + rel) % 4;
      const tiles = s.discards.filter((d) => d.seat === seat).map((d) => tileName(d.tile));
      const cx = i % 2 === 0 ? -78 : 78;
      const cy = i < 2 ? 42 : -42;
      const cell = uiLabel(`${this.who(seat)}：${tiles.length ? tiles.join(' ') : '—'}`, {
        size: 9, color: Theme.color.textMuted, align: 'left', width: 150,
      });
      cell.setParent(river);
      cell.setPosition(cx, cy, 0);
    });

    // 事件横幅 + 进度
    if (this.bannerLbl) this.bannerLbl.string = this.summarize(this.lastEvents);
    if (this.posLbl) this.posLbl.string = `${this.idx} / ${this.actions.length} 步`;
    this.drawTrackFill();
    this.drawKeyframeMarks();
  }

  /** 进度轨金色填充 */
  private drawTrackFill(): void {
    const fill = this.trackFill;
    const track = this.track;
    if (!fill || !track) return;
    const g = fill.getComponent(Graphics)!;
    g.clear();
    const w = track.getComponent(UITransform)!.width;
    const ratio = this.actions.length ? this.idx / this.actions.length : 0;
    g.fillColor = Theme.color.gold;
    g.roundRect(-w / 2, -2, Math.max(2, w * ratio), 4, 2);
    g.fill();
  }

  /** 关键帧绿色刻度 */
  private drawKeyframeMarks(): void {
    const track = this.track;
    if (!track || !this.actions.length) return;
    const w = track.getComponent(UITransform)!.width;
    const old = track.getChildByName('KfMarks');
    if (old) old.destroy();
    const marks = new Node('KfMarks');
    marks.addComponent(UITransform).setContentSize(w, 16);
    const g = marks.addComponent(Graphics);
    g.fillColor = Theme.color.wxGreen;
    for (const k of this.keyframes) {
      const x = -w / 2 + w * (k / this.actions.length);
      g.rect(x - 1, -5, 2, 10);
    }
    g.fill();
    marks.setParent(track);
  }

  /** 名牌：昵称（我）+ 庄徽章 + 子数 + 花数 */
  private drawSeatTag(dyn: Node, seat: number, p: { zi: number; flowers: string[]; score: number }, x: number, y: number): void {
    const isDealer = this.state?.dealerSeat === seat;
    const text = `${this.who(seat)}${isDealer ? ' [庄]' : ''} · 子${p.zi} · 花${p.flowers.length} · ${p.score}分`;
    const tag = uiLabel(text, { size: 10, color: isDealer ? Theme.color.gold : Theme.color.textSecondary, bold: isDealer, width: 220 });
    tag.setParent(dyn);
    tag.setPosition(x, y, 0);
  }

  /** 副露（吃/碰/杠）：小牌面横排；吃副被吃牌横置+金描边（FR-对局-17） */
  private drawMelds(dyn: Node, melds: { type: string; tiles: string[]; called?: string }[], x: number, y: number): void {
    let cx = x;
    for (const m of melds) {
      for (const t of m.tiles) {
        const isCalled = m.type === 'chi' && m.called === t;
        const n = isCalled ? createTileNode(t, 22, 16) : createTileNode(t, 16, 22);
        if (isCalled) {
          n.angle = 90;
          const g = n.addComponent(Graphics);
          g.strokeColor = Theme.color.gold;
          g.lineWidth = 1;
          g.roundRect(-11, -8, 22, 16, 2);
          g.stroke();
        }
        n.setParent(dyn);
        n.setPosition(cx + (isCalled ? 11 : 8), y, 0);
        cx += (isCalled ? 22 : 16) + 2;
      }
      cx += 6;
    }
  }

  /** 牌背：圆角小矩形（牌背蓝 #0D2857，对齐 TableScreen） */
  private backTile(w: number, h: number, color = new Color(13, 40, 87)): Node {
    const n = new Node('Back');
    n.addComponent(UITransform).setContentSize(w, h);
    const g = n.addComponent(Graphics);
    g.fillColor = color;
    g.strokeColor = new Color(255, 255, 255, 46);
    g.lineWidth = 1;
    g.roundRect(-w / 2, -h / 2, w, h, 3);
    g.fill();
    g.stroke();
    return n;
  }

  /** 全亮时北家横排真实牌面 */
  private revealRow(dyn: Node, p: { concealed: Record<string, number> }, cx: number, y: number, step: number): void {
    const list = expandSorted(p.concealed);
    const total = list.length * step;
    list.forEach((t, i) => {
      const n = createTileNode(t, 15, 21);
      n.setParent(dyn);
      n.setPosition(cx - total / 2 + i * step + step / 2, y, 0);
    });
  }

  /** 全亮时左右家竖排真实牌面（步长 13 限高） */
  private revealColumn(dyn: Node, p: { concealed: Record<string, number> }, x: number, yTop: number, step: number): void {
    const list = expandSorted(p.concealed);
    list.forEach((t, i) => {
      const n = createTileNode(t, 15, 21);
      n.setParent(dyn);
      n.setPosition(x, yTop - i * step, 0);
    });
  }

  /** 最近事件摘要（横幅文案） */
  private summarize(events: GameEvent[]): string {
    if (!events.length) return this.idx === 0 ? '开局 · 庄家起手' : '';
    const parts: string[] = [];
    for (const ev of events) {
      switch (ev.type) {
        case 'discarded': parts.push(`${this.who(ev.seat)} 打出「${tileName(ev.tile)}」`); break;
        case 'melded': parts.push(`${this.who(ev.seat)} ${ev.move === 'chi' ? '吃' : ev.move === 'pong' ? '碰' : ev.move}「${ev.tiles.map(tileName).join('')}」`); break;
        case 'kong': parts.push(`${this.who(ev.seat)} ${ev.kind === 'concealed' ? '暗杠' : ev.kind === 'added' ? '补杠' : '明杠'}「${tileName(ev.tile)}」`); break;
        case 'flower': parts.push(`${this.who(ev.seat)} 补花`); break;
        case 'win': parts.push(`🎉 ${ev.winners.map((w) => `${this.who(w.seat)} 胡 ${w.tai}台`).join('、')}`); break;
        case 'zhahu': parts.push(`⚠ ${this.who(ev.seat)} 诈胡拦截`); break;
        case 'exhaustive': parts.push('荒庄流局 · 庄家连庄'); break;
        default: break; // drawn/responseNeeded/advance/roundEnd 不上横幅
      }
    }
    return parts.slice(-2).join(' · ');
  }

  private findLabel(btn: Node): Label | null {
    for (const c of btn.children) {
      const l = c.getComponent(Label);
      if (l) return l;
    }
    return btn.getComponent(Label);
  }
}
