import { Node, Label, UITransform, Graphics } from 'cc';
import { Screen } from '../app/SceneRouter';
import { Theme, rgba } from '../ui/Theme';
import { uiBackground, uiLabel, uiButton, uiPanel } from '../ui/UiKit';
import { NetService } from '../game/NetService';
import type { FinalStanding, RoundReview, ServerMsg } from '../vendor/protocol/index';

type RoomEnd = Extract<ServerMsg, { t: 'roomEnd' }>;

/**
 * 散场战绩页（P8，还原 result.html，横向重排到 844×390）。M-G。
 * 左栏：冠军卡片（👑 + 头像 + 名 + 大字积分 + 房间/局数副标题）+ 返回大厅 / 再来一局；
 * 右栏：最终排名（4 家：奖牌 + 头像 + 名 + 胡 N 局 + 累计积分）+ 局数回顾（逐局：赢家/台数/荒庄，双列）。
 * 数据源：服务端 roomEnd（NetService.finalResult）。散场后房间已解散、积分清零（D-03），战绩仅本房间有效。
 */
export class ResultScreen extends Screen {
  readonly name = 'result';
  private net = NetService.instance;
  private championArea!: Node;
  private rankArea!: Node;
  private roundsArea!: Node;

  build(): Node {
    const W = Theme.size.designW;
    const H = Theme.size.designH;
    const root = new Node('ResultScreen');
    root.addComponent(UITransform).setContentSize(W, H);
    uiBackground('wood').setParent(root);

    // 顶部：返回 + 标题
    const back = this.makeBackButton();
    back.setParent(root);
    back.setPosition(-W / 2 + 30, H / 2 - 28, 0);
    const title = uiLabel('散场战绩', { size: 20, color: Theme.color.gold, bold: true });
    title.setParent(root);
    title.setPosition(0, H / 2 - 28, 0);

    // 左栏：冠军卡片（render 时填充）
    this.championArea = uiPanel(232, 226, { variant: 'gold', radius: Theme.radius.xl });
    this.championArea.setParent(root);
    this.championArea.setPosition(-298, 26, 0);

    // 左栏底部：返回大厅 + 再来一局
    const home = uiButton('返回大厅', () => this.onHome(), { variant: 'primary', width: 212, height: 44 });
    home.setParent(root);
    home.setPosition(-298, -124, 0);
    const again = uiButton('🔄 再来一局', () => this.onRestart(), { variant: 'action', width: 212, height: 40, fontSize: 14 });
    again.setParent(root);
    again.setPosition(-298, -170, 0);

    // 右栏容器：最终排名 + 局数回顾（render 时填充）
    const rankHeader = uiLabel('最终排名', { size: 15, color: Theme.color.textPrimary, bold: true, align: 'left', width: 200 });
    rankHeader.setParent(root);
    rankHeader.setPosition(-78, 148, 0);
    this.rankArea = this.mk(root, 'Rank', 0, 0);

    const roundsHeader = uiLabel('局数回顾', { size: 15, color: Theme.color.textPrimary, bold: true, align: 'left', width: 200 });
    roundsHeader.setParent(root);
    roundsHeader.setPosition(-78, -34, 0);
    this.roundsArea = this.mk(root, 'Rounds', 0, 0);

    const note = uiLabel('散场后房间解散、积分清零（D-03）· 战绩仅本房间有效，不做跨房间累计', { size: 10, color: Theme.color.textMuted, width: 460 });
    note.setParent(root);
    note.setPosition(120, -178, 0);

    return root;
  }

  onEnter(): void {
    const m = this.net.finalResult;
    if (m) this.render(m);
  }

  private render(m: RoomEnd): void {
    const ranked = [...m.standings].sort((a, b) => b.score - a.score);
    this.renderChampion(m, ranked[0]);
    this.renderRanking(ranked);
    this.renderRounds(m.rounds);
  }

  /** 冠军卡片：👑 + 头像 + 名 + 大字积分 + 房间/局数副标题 */
  private renderChampion(m: RoomEnd, top?: FinalStanding): void {
    this.championArea.destroyAllChildren();
    if (!top) return;
    const crown = uiLabel('👑', { size: 30 });
    crown.setParent(this.championArea);
    crown.setPosition(0, 86, 0);

    const av = this.makeAvatar(this.nameOf(top).slice(0, 1), top.isBot, 30);
    av.setParent(this.championArea);
    av.setPosition(0, 40, 0);

    const name = uiLabel(this.nameOf(top), { size: 17, color: Theme.color.gold, bold: true });
    name.setParent(this.championArea);
    name.setPosition(0, -2, 0);

    const score = uiLabel(`${top.score >= 0 ? '+' : ''}${top.score}`, { size: 34, color: Theme.color.gold, bold: true });
    score.setParent(this.championArea);
    score.setPosition(-14, -40, 0);
    const unit = uiLabel('积分', { size: 12, color: Theme.color.textSecondary });
    unit.setParent(this.championArea);
    unit.setPosition(48, -44, 0);

    const rounds = m.rounds.length;
    const sub = uiLabel(`房间 ${m.room} · ${rounds} 局战罢 · ${m.reason === 'dissolve' ? '房主解散' : '打满局数'}`, { size: 11, color: Theme.color.textMuted, width: 200 });
    sub.setParent(this.championArea);
    sub.setPosition(0, -84, 0);
  }

  /** 最终排名：4 家（奖牌 + 头像 + 名 + 胡 N 局 + 累计积分），冠军行金色高亮 */
  private renderRanking(ranked: FinalStanding[]): void {
    this.rankArea.destroyAllChildren();
    const medals = ['🥇', '🥈', '🥉', '4'];
    ranked.slice(0, 4).forEach((s, i) => {
      const y = 116 - i * 40;
      const row = uiPanel(430, 36, { variant: i === 0 ? 'gold' : 'panel', radius: Theme.radius.lg });
      row.setParent(this.rankArea);
      row.setPosition(118, y, 0);

      const medal = uiLabel(medals[i] ?? '4', { size: 17, color: Theme.color.textMuted });
      medal.setParent(row);
      medal.setPosition(-192, 0, 0);

      const av = this.makeAvatar(this.nameOf(s).slice(0, 1), s.isBot, 15);
      av.setParent(row);
      av.setPosition(-156, 0, 0);

      const name = uiLabel(this.nameOf(s), { size: 14, color: Theme.color.textPrimary, bold: i === 0, align: 'left', width: 120 });
      name.setParent(row);
      name.setPosition(-70, 7, 0);
      const detail = uiLabel(`胡 ${s.wins} 局`, { size: 10, color: Theme.color.textMuted, align: 'left', width: 120 });
      detail.setParent(row);
      detail.setPosition(-70, -9, 0);

      const sc = uiLabel(`${s.score >= 0 ? '+' : ''}${s.score}`, { size: 19, color: s.score >= 0 ? Theme.color.gold : Theme.color.danger, bold: true, align: 'right', width: 100 });
      sc.setParent(row);
      sc.setPosition(150, 0, 0);
    });
  }

  /** 局数回顾：逐局（第 N 局 + 赢家/台数 或 荒庄），双列排布，最多 8 局。自然宽度单行标签，避免换行与两列重叠 */
  private renderRounds(rounds: RoundReview[]): void {
    this.roundsArea.destroyAllChildren();
    const shown = rounds.slice(0, 8);
    shown.forEach((r, i) => {
      const col = i < 4 ? 0 : 1;
      const row = i % 4;
      const cx = col === 0 ? -20 : 240;
      const y = -58 - row * 24;

      const no = uiLabel(`第${r.round}局`, { size: 11, color: Theme.color.textMuted });
      no.setParent(this.roundsArea);
      no.setPosition(cx - 96, y, 0);

      const d = uiLabel(this.roundDesc(r), { size: 11, color: Theme.color.textSecondary });
      d.setParent(this.roundsArea);
      d.setPosition(cx + 8, y, 0);

      const score = r.endType === 'win' ? `+${r.tai}台` : '流';
      const s = uiLabel(score, { size: 12, color: r.endType === 'win' ? Theme.color.goldLight : Theme.color.textMuted, bold: true });
      s.setParent(this.roundsArea);
      s.setPosition(cx + 100, y, 0);
    });
    if (rounds.length > 8) {
      const more = uiLabel(`… 共 ${rounds.length} 局`, { size: 11, color: Theme.color.textMuted });
      more.setParent(this.roundsArea);
      more.setPosition(240, -130, 0);
    }
  }

  private roundDesc(r: RoundReview): string {
    if (r.endType !== 'win' || r.winnerSeat == null) return '荒庄流局 · 连庄';
    const winner = this.nameOfSeat(r.winnerSeat);
    const how = r.zimo ? '自摸' : '胡';
    return `${winner} ${how}${r.topFan ? ` · ${r.topFan}` : ''}`;
  }

  // ============ 小工具 ============

  private nameOf(s: FinalStanding): string {
    return this.nameOfUserId(s.userId, s.isBot, s.seat);
  }
  private nameOfSeat(seat: number): string {
    const m = this.net.finalResult;
    const s = m?.standings.find((x) => x.seat === seat);
    return s ? this.nameOf(s) : `座${seat}`;
  }
  private nameOfUserId(userId: string, isBot: boolean, seat: number): string {
    if (userId === this.net.userId) return '我';
    if (isBot) return '机器人';
    return `座${seat}`;
  }

  /** 圆形头像：真人金底 + 首字，Bot 灰底 + 🤖（复用房间等待页视觉语言） */
  private makeAvatar(glyph: string, isBot: boolean, r: number): Node {
    const av = new Node('Avatar');
    av.addComponent(UITransform).setContentSize(r * 2, r * 2);
    const g = av.addComponent(Graphics);
    g.fillColor = isBot ? Theme.color.textMuted : Theme.color.gold;
    g.circle(0, 0, r);
    g.fill();
    g.strokeColor = isBot ? Theme.color.textSecondary : Theme.color.goldLight;
    g.lineWidth = 2;
    g.circle(0, 0, r);
    g.stroke();
    const ln = new Node('Glyph');
    ln.addComponent(UITransform);
    const lb = ln.addComponent(Label);
    lb.string = isBot ? '🤖' : glyph;
    lb.fontSize = Math.round(r * 0.78);
    lb.lineHeight = lb.fontSize + 4;
    lb.color = isBot ? Theme.color.white : Theme.color.bgWoodDark;
    lb.isBold = true;
    lb.horizontalAlign = Label.HorizontalAlign.CENTER;
    lb.verticalAlign = Label.VerticalAlign.CENTER;
    ln.setParent(av);
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
    n.on(Node.EventType.TOUCH_END, () => this.onHome());
    return n;
  }

  private mk(parent: Node, name: string, x: number, y: number): Node {
    const n = new Node(name);
    n.addComponent(UITransform);
    n.setParent(parent);
    n.setPosition(x, y, 0);
    return n;
  }

  /** 返回大厅：离开（已散场，房间服务端已回收）+ 切大厅 */
  private onHome(): void {
    this.net.leave();
    this.router.show('lobby');
  }

  /** 再来一局：离开旧房 + 重新建房（服务端补 Bot 并开局，NetService.restart） */
  private onRestart(): void {
    this.net.restart(8);
    this.router.show('room');
  }
}
