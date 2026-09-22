import type { ReactNode } from 'react';
import './TableBoard.css';
import { tileSrc, expandConcealed, MELD_LABEL } from './tiles';

/** 引擎 TableState 的 admin-web 本地投影（不引 packages/**，经 REST 消费；见架构 §4） */
export interface BoardMeld { type: string; tiles: string[]; called?: string }
export interface BoardPlayer { seat: number; concealed: Record<string, number>; melds: BoardMeld[]; flowers: string[]; zi: number; score: number }
export interface BoardDiscard { seat: number; tile: string }
export interface BoardState {
  wall: string[];
  players: BoardPlayer[];
  currentSeat: number;
  dealerSeat: number;
  phase: string;
  discards: BoardDiscard[];
  lastDiscard: BoardDiscard | null;
  lastDrawn?: { seat: number; tile: string } | null;
}
/** 座位运维元信息（监控用：Bot / 离线徽标；回放无则从昵称推导 Bot） */
export interface SeatMeta { userId?: string; isBot?: boolean; offline?: boolean }

/** 末尾死牌张数（复刻 engine `DEAD_WALL`；荒庄不摸，牌墙区末尾以牌背呈现） */
const DEAD_WALL = 4;

/** 上帝视角固定方位（与原型 monitor.html / replay.html 一致）：seat0=南(底)、seat1=西(左)、seat2=东(右)、seat3=北(顶) */
const POSITIONS = [
  { cls: 'seat-n', seat: 3, label: '北', side: false },
  { cls: 'seat-w', seat: 1, label: '西', side: true },
  { cls: 'seat-e', seat: 2, label: '东', side: true },
  { cls: 'seat-s', seat: 0, label: '南', side: false },
] as const;

const fmtScore = (n: number): string => (n >= 0 ? `+${n}` : `\u2212${Math.abs(n)}`);

function Tile({ id, size = 't-xs', hit, back }: { id?: string; size?: string; hit?: boolean; back?: boolean }): JSX.Element {
  if (back || !id) return <span className={`tile back ${size}`} />;
  return (
    <span className={`tile ${size}${hit ? ' hit' : ''}`}>
      <img src={tileSrc(id)} alt={id} />
    </span>
  );
}

function Tiles({ ids, size, hitTile }: { ids: string[]; size?: string; hitTile?: string }): JSX.Element {
  return <>{ids.map((id, i) => <Tile key={i} id={id} size={size} hit={!!hitTile && id === hitTile} />)}</>;
}

/** 分区牌河的一格：末尾且等于 lastDiscard 的那张高亮 */
function RiverTiles({ tiles, seat, lastDiscard }: { tiles: string[]; seat: number; lastDiscard: BoardDiscard | null }): JSX.Element {
  return (
    <>
      {tiles.map((t, i) => {
        const hit = !!lastDiscard && lastDiscard.seat === seat && i === tiles.length - 1 && lastDiscard.tile === t;
        return <Tile key={i} id={t} size="t-rv" hit={hit} />;
      })}
    </>
  );
}

interface SeatViewProps {
  cls: string; label: string; seat: number; side: boolean;
  player?: BoardPlayer; name: string; variant: 'monitor' | 'replay';
  isCur: boolean; isDealer: boolean; isWinner: boolean; isBot: boolean; offline: boolean;
  drawnTile?: string;
}

function SeatView(p: SeatViewProps): JSX.Element {
  const { cls, label, seat, side, player, name, variant, isCur, isDealer, isWinner, isBot, offline, drawnTile } = p;
  const hand = expandConcealed(player?.concealed);
  const flowers = player?.flowers ?? [];
  const melds = player?.melds ?? [];
  const handSize = side ? 't-side' : 't-sm';
  return (
    <div className={`seat ${cls}${offline ? ' off' : ''}`}>
      {variant === 'monitor' ? (
        <div className={`pinfo${isCur ? ' active' : ''}`}>
          <span className="av">{name.slice(0, 1)}</span>
          <span className="nm">{name}</span>
          {isBot && <span className="bdg bot">Bot</span>}
          {isDealer && <span className="bdg dealer">庄</span>}
          {offline && <span className="bdg off">离线</span>}
          <span className="sc">{fmtScore(player?.score ?? 0)}</span>
          <span className="zi">子{player?.zi ?? 0}</span>
        </div>
      ) : (
        <div className="name">
          {label} · seat{seat}
          {isBot && <span className="badge">Bot</span>}
          {isDealer && <span className="badge">庄</span>}
          {isWinner && <span className="badge win">赢家</span>}
        </div>
      )}
      <div className="hand">
        <Tiles ids={hand} size={handSize} hitTile={drawnTile} />
      </div>
      {(flowers.length > 0 || melds.length > 0) && (
        <div className="exposed">
          {flowers.length > 0 && (
            <div className="flower-area">
              <span className="flower-lbl">花</span>
              <span className="hand"><Tiles ids={flowers} size="t-rv" /></span>
            </div>
          )}
          {melds.length > 0 && (
            <div className="melds">
              {melds.map((m, i) => (
                <div className="meld-item" key={i}>
                  <span className="hand"><Tiles ids={m.tiles} size="t-xs" /></span>
                  <span className="meld-lbl">{MELD_LABEL[m.type] ?? m.type}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface TableBoardProps {
  state: BoardState;
  names: Record<number, string>;
  /** 监控：每座 Bot/离线徽标；回放可省略（Bot 从昵称推导） */
  seatMeta?: Record<number, SeatMeta> | null;
  /** monitor=富玩家条(pinfo)；replay=简标签(name)，各自忠实还原对应原型 */
  variant?: 'monitor' | 'replay';
  winnerSeat?: number | null;
  /** 中央信息块补充行（牌墙剩余之后）：监控=当前座/phase，回放=结束/赢家 */
  centerExtra?: ReactNode;
}

/**
 * 共享牌桌俯视图（回放 / 实时监控复用，Admin 技术方案 §10.3）：游戏同款贴图 + CSS 网格 3×3（结构性防重叠）+
 * 四家横排手牌 + 花牌独立区 + 弃牌按家分区。全信息特权视角（含各家暗牌，无防透视裁剪）。
 */
export default function TableBoard({ state, names, seatMeta, variant = 'monitor', winnerSeat = null, centerExtra }: TableBoardProps): JSX.Element {
  const discardsBySeat: Record<number, string[]> = { 0: [], 1: [], 2: [], 3: [] };
  for (const d of state.discards ?? []) (discardsBySeat[d.seat] ?? (discardsBySeat[d.seat] = [])).push(d.tile);

  const seatLabel = (s: number): string => `seat${s}`;
  const nameOf = (s: number): string => names[s] ?? `座位${s}`;

  const renderSeat = (pos: (typeof POSITIONS)[number]): JSX.Element => {
    const player = state.players.find((x) => x.seat === pos.seat);
    const meta = seatMeta?.[pos.seat];
    const nm = nameOf(pos.seat);
    const isBot = meta?.isBot ?? /bot|机器人/i.test(nm);
    const offline = meta?.offline ?? false;
    const drawnTile = state.lastDrawn && state.lastDrawn.seat === pos.seat ? state.lastDrawn.tile : undefined;
    return (
      <SeatView
        key={pos.seat}
        cls={pos.cls} label={pos.label} seat={pos.seat} side={pos.side}
        player={player} name={nm} variant={variant}
        isCur={state.currentSeat === pos.seat} isDealer={state.dealerSeat === pos.seat}
        isWinner={winnerSeat === pos.seat} isBot={isBot} offline={offline} drawnTile={drawnTile}
      />
    );
  };

  const riverCol = (pos: (typeof POSITIONS)[number], extraCls: string): JSX.Element => (
    <div>
      <div className="river-tag" style={{ textAlign: 'center' }}>{pos.label} · {seatLabel(pos.seat)} 弃</div>
      <div className={`river-side ${extraCls}`}><RiverTiles tiles={discardsBySeat[pos.seat] ?? []} seat={pos.seat} lastDiscard={state.lastDiscard} /></div>
    </div>
  );

  return (
    <div className="table-board">
      <div className={`board${variant === 'replay' ? ' replay' : ''}`}>
        {renderSeat(POSITIONS[0]!)}
        {renderSeat(POSITIONS[1]!)}
        <div className="river">
          <div className="river-tag">北 · {seatLabel(POSITIONS[0]!.seat)} 弃</div>
          <div className="river-row"><RiverTiles tiles={discardsBySeat[POSITIONS[0]!.seat] ?? []} seat={POSITIONS[0]!.seat} lastDiscard={state.lastDiscard} /></div>
          <div className="river-mid">
            {riverCol(POSITIONS[1]!, 'river-w')}
            <div className="river-center">
              牌墙剩余 <b>{state.wall.length}</b>
              {centerExtra ? <><br />{centerExtra}</> : null}
            </div>
            {riverCol(POSITIONS[2]!, 'river-e')}
          </div>
          <div className="river-tag">南 · {seatLabel(POSITIONS[3]!.seat)} 弃</div>
          <div className="river-row"><RiverTiles tiles={discardsBySeat[POSITIONS[3]!.seat] ?? []} seat={POSITIONS[3]!.seat} lastDiscard={state.lastDiscard} /></div>
        </div>
        {renderSeat(POSITIONS[2]!)}
        {renderSeat(POSITIONS[3]!)}
      </div>
    </div>
  );
}

/** 上帝视角牌墙实牌序（监控专用）：可摸段全露未来摸牌顺序，末尾死牌以牌背呈现（荒庄不摸） */
export function WallStrip({ wall, currentSeat }: { wall: string[]; currentSeat: number }): JSX.Element {
  const drawable = Math.max(0, wall.length - DEAD_WALL);
  const dead = wall.length - drawable;
  return (
    <div className="table-board">
      <div className="wall-strip">
        <div className="cap">剩余 <b>{wall.length}</b> 张（可摸 {drawable} + 死牌 {dead}）· 下一张由 <b>seat{currentSeat}</b> 摸</div>
        <div className="tiles">
          {wall.slice(0, drawable).map((id, i) => <Tile key={i} id={id} size="t-xs" />)}
          {wall.slice(drawable).map((_, i) => <Tile key={`dead-${i}`} size="t-xs" back />)}
        </div>
      </div>
    </div>
  );
}
