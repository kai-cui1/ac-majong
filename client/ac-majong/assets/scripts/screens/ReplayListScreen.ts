import { Node, UITransform, Mask, ScrollView, Graphics, Color, Label } from 'cc';
import { Screen } from '../app/SceneRouter';
import { Theme } from '../ui/Theme';
import { uiBackground, uiLabel, uiButton, uiPanel } from '../ui/UiKit';
import { NetService } from '../game/NetService';
import type { ReplayRoomSummary, ReplayRoundSummary } from '../vendor/protocol/index';

/**
 * 战绩 / 回放列表（P9，BL-012；还原 replay-list.html，横向重排到 844×390）。
 * 房间→局两级：房间卡可折叠（首卡默认展开），局行显示结束方式/赢家/台数，点击进入回放播放器。
 * 数据源：网关 replayList（仅本人参赛房间，D-29）。
 */

/** 列表 → 播放器的跳转参数（SceneRouter.show 不带参，模块级传递） */
export const replayTarget: { gameId: string; roomLabel: string; roundNo: number } = { gameId: '', roomLabel: '', roundNo: 0 };

const SEAT_LABEL = ['南', '东', '北', '西'];

export class ReplayListScreen extends Screen {
  readonly name = 'replayList';
  private listRoot: Node | null = null;
  private rooms: ReplayRoomSummary[] = [];
  private openState: boolean[] = [];

  build(): Node {
    const W = Theme.size.designW;
    const H = Theme.size.designH;
    const root = new Node('ReplayListScreen');
    root.addComponent(UITransform).setContentSize(W, H);
    uiBackground('table').setParent(root);

    // 顶栏：返回 / 标题 / 注记
    const back = uiButton('‹', () => this.router.show('lobby'), { variant: 'secondary', width: 34, height: 34, fontSize: 16 });
    back.setParent(root);
    back.setPosition(-W / 2 + 30, H / 2 - 26, 0);
    const title = uiLabel('🎬 战绩 / 回放', { size: 17, color: Theme.color.gold, bold: true, align: 'left' });
    title.setParent(root);
    title.setPosition(-W / 2 + 150, H / 2 - 26, 0);
    const note = uiLabel('仅本人参赛的对局 · 参赛四方可看', { size: 10, color: Theme.color.textMuted, align: 'right', width: 240 });
    note.setParent(root);
    note.setPosition(W / 2 - 140, H / 2 - 26, 0);

    // 滚动列表容器（onEnter 填充）
    this.listRoot = new Node('ListRoot');
    this.listRoot.addComponent(UITransform).setContentSize(W - 48, H - 66);
    this.listRoot.setParent(root);
    this.listRoot.setPosition(0, -26, 0);
    return root;
  }

  onEnter(): void {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const box = this.listRoot;
    if (!box) return;
    box.destroyAllChildren();
    const loading = uiLabel('加载中…', { size: 12, color: Theme.color.textMuted });
    loading.setParent(box);
    try {
      this.rooms = await NetService.instance.replayList();
    } catch (e) {
      loading.destroy();
      if (!box.isValid) return;
      const err = uiLabel(e instanceof Error ? e.message : '战绩加载失败', { size: 12, color: Theme.color.danger });
      err.setParent(box);
      return;
    }
    loading.destroy();
    if (!box.isValid) return;
    this.openState = this.rooms.map((_, i) => i === 0); // 首卡默认展开（对齐原型）
    this.renderList();
  }

  /** 整表渲染（折叠切换即全量重建，简单可靠） */
  private renderList(): void {
    const box = this.listRoot!;
    box.destroyAllChildren();
    if (!this.rooms.length) {
      const empty = uiLabel('还没有对局记录', { size: 12, color: Theme.color.textMuted });
      empty.setParent(box);
      empty.setPosition(0, 60, 0);
      return;
    }
    const vw = box.getComponent(UITransform)!.width;
    const vh = box.getComponent(UITransform)!.height;

    const svNode = new Node('ReplayScroll');
    svNode.addComponent(UITransform).setContentSize(vw, vh);
    const sv = svNode.addComponent(ScrollView);
    sv.horizontal = false;
    sv.vertical = true;
    sv.inertia = true;
    svNode.setParent(box);

    const view = new Node('View');
    view.addComponent(UITransform).setContentSize(vw, vh);
    view.addComponent(Mask);
    view.setParent(svNode);

    const cardH = (i: number): number => 40 + (this.openState[i] ? this.rooms[i].rounds.length * 36 + 8 : 0);
    let totalH = 8;
    this.rooms.forEach((_, i) => { totalH += cardH(i) + 10; });

    const content = new Node('Content');
    const ct = content.addComponent(UITransform);
    ct.setContentSize(vw, Math.max(totalH, vh));
    ct.setAnchorPoint(0.5, 1);
    content.setParent(view);
    content.setPosition(0, vh / 2, 0);
    sv.content = content;

    let y = -4;
    this.rooms.forEach((room, i) => {
      const h = cardH(i);
      const card = this.makeRoomCard(room, i, vw - 8, this.openState[i], h);
      card.setParent(content);
      y -= h / 2;
      card.setPosition(0, y, 0);
      y -= h / 2 + 10;
    });
  }

  private makeRoomCard(room: ReplayRoomSummary, idx: number, w: number, open: boolean, h: number): Node {
    const card = uiPanel(w, h, { variant: 'panel', radius: Theme.radius.lg });
    card.name = `Room_${idx}`;

    // 卡头：房号 / 时间·局数·状态 / 折叠箭头（整头可点）
    const head = new Node('Head');
    head.addComponent(UITransform).setContentSize(w, 40);
    head.setParent(card);
    head.setPosition(0, h / 2 - 20, 0);
    const roomLbl = uiLabel(`房 ${room.roomId}`, { size: 14, color: Theme.color.gold, bold: true, align: 'left' });
    roomLbl.setParent(head);
    roomLbl.setPosition(-w / 2 + 80, 0, 0);
    const created = room.createdAt ? new Date(room.createdAt) : null;
    const timeStr = created ? `${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')} ${String(created.getHours()).padStart(2, '0')}:${String(created.getMinutes()).padStart(2, '0')}` : '';
    const statusStr = room.status === 'closed' ? '已散场' : room.status === 'playing' ? '进行中' : '等待中';
    const meta = uiLabel(`${timeStr} · ${room.rounds.length} 局 · ${statusStr}`, { size: 10, color: Theme.color.textMuted, align: 'left' });
    meta.setParent(head);
    meta.setPosition(-w / 2 + 240, 0, 0);
    const arrow = uiLabel(open ? '▾' : '›', { size: 13, color: Theme.color.textMuted });
    arrow.setParent(head);
    arrow.setPosition(w / 2 - 20, 0, 0);
    head.on(Node.EventType.TOUCH_END, () => {
      this.openState[idx] = !this.openState[idx];
      this.renderList();
    });

    // 局行
    if (open) {
      room.rounds.forEach((round, ri) => {
        const row = this.makeRoundRow(room, round, ri, w - 16);
        row.setParent(card);
        row.setPosition(0, h / 2 - 40 - 8 - ri * 36 - 14, 0);
      });
    }
    return card;
  }

  private makeRoundRow(room: ReplayRoomSummary, round: ReplayRoundSummary, ri: number, w: number): Node {
    const row = new Node(`Round_${ri}`);
    row.addComponent(UITransform).setContentSize(w, 34);
    const g = row.addComponent(Graphics);
    g.strokeColor = new Color(212, 165, 55, 26);
    g.lineWidth = 1;
    g.moveTo(-w / 2, -17);
    g.lineTo(w / 2, -17);
    g.stroke();

    const no = uiLabel(`第 ${round.roundNo} 局`, { size: 12, color: Theme.color.textPrimary, bold: true, align: 'left' });
    no.setParent(row);
    no.setPosition(-w / 2 + 46, 0, 0);

    // 结束方式徽章：胡牌/多响（金）· 荒庄（灰）
    const isEx = round.endType === 'exhaustive';
    const kindText = isEx ? '荒庄' : round.winnerSeats.length > 1 ? '多响' : '胡牌';
    const badge = this.makeEndBadge(kindText, isEx);
    badge.setParent(row);
    badge.setPosition(-w / 2 + 116, 0, 0);

    const nameOf = (seat: number): string => room.seatNames[seat] ?? `AI·${SEAT_LABEL[seat] ?? seat}`;
    const desc = isEx
      ? '无人胡牌 · 庄家连庄'
      : round.winnerSeats.map((s) => `${nameOf(s)} ${round.taiBySeat[s] ?? '—'}台`).join('　');
    const win = uiLabel(desc, { size: 11, color: Theme.color.textSecondary, align: 'left', width: w - 360 });
    win.setParent(row);
    win.setPosition(-w / 2 + 152 + (w - 360) / 2, 0, 0);

    const play = uiLabel('回放 ▶', { size: 11, color: Theme.color.wxGreen, bold: true, align: 'right' });
    play.setParent(row);
    play.setPosition(w / 2 - 44, 0, 0);

    row.on(Node.EventType.TOUCH_END, () => {
      replayTarget.gameId = round.gameId;
      replayTarget.roomLabel = `房 ${room.roomId}`;
      replayTarget.roundNo = round.roundNo;
      this.router.show('replay');
    });
    return row;
  }

  /** 结束方式小徽章（金/灰圆角） */
  private makeEndBadge(text: string, gray: boolean): Node {
    const n = new Node('EndBadge');
    n.addComponent(UITransform).setContentSize(48, 20);
    const g = n.addComponent(Graphics);
    g.fillColor = gray ? new Color(255, 255, 255, 20) : new Color(212, 165, 55, 36);
    g.roundRect(-24, -10, 48, 20, 10);
    g.fill();
    const l = new Node('T');
    l.addComponent(UITransform);
    const lb = l.addComponent(Label);
    lb.string = text;
    lb.fontSize = 10;
    lb.lineHeight = 14;
    lb.color = gray ? Theme.color.textMuted : Theme.color.gold;
    lb.horizontalAlign = Label.HorizontalAlign.CENTER;
    lb.verticalAlign = Label.VerticalAlign.CENTER;
    l.setParent(n);
    return n;
  }
}
