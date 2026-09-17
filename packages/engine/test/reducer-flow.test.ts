import { describe, it, expect } from 'vitest';
import { applyAction } from '../src/reducer';
import type { TableState, PlayerState } from '../src/table';
import { meld } from './helpers';

function pl(seat: number, concealed: Record<string, number> = {}, melds: PlayerState['melds'] = []): PlayerState {
  return { seat, concealed, melds, flowers: [], zi: 0, score: 0 };
}
function tbl(o: Partial<TableState>): TableState {
  return {
    wall: Array(60).fill('T1'),
    players: [pl(0), pl(1), pl(2), pl(3)],
    dealerSeat: 0,
    currentSeat: 0,
    phase: 'draw',
    lastDiscard: null,
    discards: [],
    lastDrawn: null,
    pending: {},
    robKong: null,
    lianzhuangCount: 0,
    round: 1,
    ...o,
  };
}
const FIVE_PONGS = [
  meld('pong', 'W111'),
  meld('pong', 'T222'),
  meld('pong', 'B333'),
  meld('pong', 'W444'),
  meld('pong', 'T555'),
];

describe('3c · 补牌胡 flow 标记', () => {
  it('摸最后一张可摸牌 → wasLastDrawable', () => {
    const s = tbl({ phase: 'draw', currentSeat: 0, wall: ['B5', 'd', 'd', 'd', 'd'] });
    s.players[0] = pl(0, { B5: 1 }, FIVE_PONGS);
    const r = applyAction(s, { type: 'draw', seat: 0 });
    expect(r.state.lastDrawn?.tile).toBe('B5');
    expect(r.state.lastDrawn?.wasLastDrawable).toBe(true);
  });

  it('摸到花后补摸 → viaFlower，花入花区', () => {
    const s = tbl({ phase: 'draw', currentSeat: 0, wall: ['H1', 'B5', 'd', 'd', 'd', 'd'] });
    s.players[0] = pl(0, { B5: 1 }, FIVE_PONGS);
    const r = applyAction(s, { type: 'draw', seat: 0 });
    expect(r.state.players[0]!.flowers).toContain('H1');
    expect(r.state.lastDrawn?.tile).toBe('B5');
    expect(r.state.lastDrawn?.viaFlower).toBe(true);
  });

  it('暗杠后补摸 → viaKong', () => {
    const s = tbl({ phase: 'discard', currentSeat: 0, wall: Array(20).fill('T9') });
    s.players[0] = pl(0, { W5: 4, B5: 2 }, [
      meld('pong', 'W111'),
      meld('pong', 'T222'),
      meld('pong', 'B333'),
      meld('pong', 'W444'),
    ]);
    const r = applyAction(s, { type: 'kongConcealed', seat: 0, tile: 'W5' });
    expect(r.state.players[0]!.melds.some((m) => m.type === 'kong_concealed')).toBe(true);
    expect(r.state.lastDrawn?.viaKong).toBe(true);
  });

  it('海底捞：摸最后一张自摸 → 台数含海底捞(8)', () => {
    const s = tbl({ phase: 'draw', currentSeat: 0, dealerSeat: 0, wall: ['B5', 'd', 'd', 'd', 'd'] });
    s.players[0] = pl(0, { B5: 1 }, FIVE_PONGS);
    const r1 = applyAction(s, { type: 'draw', seat: 0 });
    const r2 = applyAction(r1.state, { type: 'declareWin', seat: 0 });
    const winEv = r2.events.find((e) => e.type === 'win') as Extract<ReturnType<typeof applyAction>['events'][number], { type: 'win' }> | undefined;
    expect(winEv).toBeTruthy();
    // 碰碰胡15 + 全求人8 + 无花无字3 + 自摸1 + 海底捞8 = 35
    expect(winEv!.winners[0]!.tai).toBe(35);
    // M-F：win 事件透传台数明细（供局末结算浮层展示番种构成 + 散场回顾最高番种）
    const detail = winEv!.winners[0]!.detail;
    expect(detail.map((d) => d.name)).toEqual(expect.arrayContaining(['碰碰胡', '全求人', '无花无字', '自摸', '海底捞']));
    expect(detail.reduce((a, d) => a + d.tai, 0)).toBe(35); // 明细台数合计 = 总台数
  });
});

describe('3c · 抢杠胡', () => {
  it('加杠被他家抢杠胡 → 抢杠方得分、加杠方付', () => {
    const s = tbl({ phase: 'discard', currentSeat: 0, dealerSeat: 0 });
    s.players[0] = pl(0, { T2: 1, W9: 1 }, [meld('pong', 'T222')]);
    s.players[1] = pl(1, { T2: 1 }, FIVE_PONGS); // 单钓 T2，可抢杠胡
    const r1 = applyAction(s, { type: 'kongAdded', seat: 0, tile: 'T2' });
    expect(r1.state.robKong).toEqual({ seat: 0, tile: 'T2' });
    expect(r1.state.phase).toBe('response');
    const r2 = applyAction(r1.state, { type: 'respond', seat: 1, move: 'win' });
    expect(r2.events.some((e) => e.type === 'win')).toBe(true);
    expect(r2.state.players[1]!.score).toBeGreaterThan(0);
    expect(r2.state.players[0]!.score).toBeLessThan(0);
    expect(r2.state.robKong).toBeNull();
  });

  it('加杠无人抢杠 → 完成加杠并补摸', () => {
    const s = tbl({ phase: 'discard', currentSeat: 0, wall: Array(20).fill('T9') });
    s.players[0] = pl(0, { T2: 1, W9: 1 }, [meld('pong', 'T222')]);
    const r = applyAction(s, { type: 'kongAdded', seat: 0, tile: 'T2' });
    expect(r.state.robKong).toBeNull();
    expect(r.state.players[0]!.melds.some((m) => m.type === 'kong_added')).toBe(true);
    expect(r.state.lastDrawn?.viaKong).toBe(true);
  });
});
