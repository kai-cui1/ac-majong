import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Checkbox, Descriptions, Input, Space, Tag } from 'antd';
import { useNavigate, useParams } from 'react-router-dom';
import { useMonitorRoom } from '../api/hooks';
import { hasRole, useAuth } from '../store/auth';
import TableBoard, { WallStrip, type BoardState, type SeatMeta } from '../components/TableBoard';
import type { MonitorInspect } from '../api/types';

const clock = (ms: number): string => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });

function scoreText(ms: Record<number, number> | null | undefined): string {
  if (!ms) return '—';
  const keys = Object.keys(ms).sort((a, b) => Number(a) - Number(b));
  if (!keys.length) return '—';
  return keys.map((k) => `seat${k} ${ms[Number(k)]! >= 0 ? '+' : ''}${ms[Number(k)]}`).join(' · ');
}

/** legalBySeat[seat] → 可读动作串（元素可能是字符串或 {type} 对象） */
function legalText(legal: unknown): string {
  if (!Array.isArray(legal) || !legal.length) return '—';
  return legal
    .map((a) => (typeof a === 'string' ? a : a && typeof a === 'object' && 'type' in a ? String((a as { type: unknown }).type) : JSON.stringify(a)))
    .join(' / ');
}

/**
 * 实时房间监控（★FR-Admin-10，operator+）：上帝全知视角——经 game-server 内网只读 inspect 端点抓进程内存全量台态，
 * 复用回放牌桌 <TableBoard> 呈现「一帧活的回放」；快照轮询 ~2s 跟随牌局推进；不可达时降级展示 MySQL 已落库事实。
 */
export default function Monitor(): JSX.Element {
  const params = useParams<{ roomId?: string }>();
  const nav = useNavigate();
  const admin = useAuth((s) => s.admin);
  const canMonitor = hasRole(admin?.role, 'operator');

  const [input, setInput] = useState(params.roomId ?? '');
  const [activeRoom, setActiveRoom] = useState<string | null>(params.roomId ?? null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const { data, isFetching, error, refreshWithAudit } = useMonitorRoom(activeRoom, autoRefresh && canMonitor);
  useEffect(() => { if (data) setFetchedAt(new Date()); }, [data]);

  const inspect: MonitorInspect | null = data?.available ? data.inspect : null;
  const state = (inspect?.state ?? null) as BoardState | null;
  const seatMeta = useMemo<Record<number, SeatMeta>>(() => {
    if (!inspect) return {};
    const offline = new Set(inspect.timers.offlineSince.map((e) => e[0]));
    const m: Record<number, SeatMeta> = {};
    inspect.seats.forEach((s, seat) => { if (s) m[seat] = { userId: s.userId, isBot: s.isBot, offline: offline.has(s.userId) }; });
    return m;
  }, [inspect]);

  const onQuery = (): void => {
    const id = input.trim();
    if (!id) return;
    if (id === activeRoom) refreshWithAudit();
    else { setActiveRoom(id); nav(`/monitor/${id}`, { replace: true }); }
  };

  if (!canMonitor) {
    return (
      <>
        <h1 className="page-title">实时房间监控</h1>
        <Card className="muted">实时房间监控需 operator+ 权限。</Card>
      </>
    );
  }

  // 扩展态字段（响应意图 / 连庄）取自完整 TableState，TableBoard 契约外的运维摘要按需读取
  const ext = state as (BoardState & { pending?: Record<number, { move: string } | null>; lianzhuangCount?: number }) | null;
  const pendingText = ext?.pending
    ? Object.entries(ext.pending).filter(([, v]) => v).map(([s, v]) => `seat${s} 待响应 ${v!.move}`).join(' · ') || '无（各家均已响应/非响应阶段）'
    : '—';
  const game = inspect?.game ?? null;

  return (
    <>
      <h1 className="page-title">实时房间监控</h1>
      <p className="page-desc">
        对 <span className="mono">status=playing</span> 房，经 game-server <b>内网预共享密钥只读 inspect 端点</b>抓进程内存<b>实时全量台态</b>——<b>上帝全知视角</b>（游戏同款贴图 + 对齐游戏牌桌布局：四家横排手牌、弃牌按家分区、花牌独立区、牌墙实牌序），等同「一帧活的回放」，与回放页共享 <span className="mono">&lt;TableBoard&gt;</span>。<b>快照轮询 ~2s</b>；operator+、只读、开启/手动刷新记审计；不可达时<b>降级</b>展示已落库事实。
      </p>

      {/* 查询条 */}
      <Card style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
        <Space wrap size={12}>
          <span className="muted">房号</span>
          <Input placeholder="212817" value={input} onChange={(e) => setInput(e.target.value)} onPressEnter={onQuery} style={{ width: 160 }} />
          <Button type="primary" onClick={onQuery} loading={isFetching}>查实时态</Button>
          <Checkbox checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)}>自动刷新 2s</Checkbox>
          <div style={{ width: 24 }} />
          {data?.available && <Tag color="green">实时态可用</Tag>}
          {data && !data.available && <Tag>实时态不可用</Tag>}
          {fetchedAt && <span className="muted mono">抓取于 {fetchedAt.toLocaleTimeString('zh-CN', { hour12: false })}</span>}
        </Space>
      </Card>

      {error && <Alert type="error" showIcon message={`监控查询失败：${(error as Error).message}`} style={{ marginBottom: 16 }} />}

      {!activeRoom && !error && <Card className="muted">输入房号并点「查实时态」开始监控（仅 operator+）。</Card>}

      {/* 降级态：game-server 不可达 / 房已回收 / 非 playing */}
      {data && !data.available && (
        <Card style={{ marginBottom: 16 }}>
          <Alert
            type="warning" showIcon style={{ marginBottom: 12 }}
            message="实时台态不可用"
            description={`game-server 不可达 / 房已回收 / 非 playing（原因：${data.reason}）。回退展示 MySQL 已落库事实，牌桌区无法呈现牌墙/手牌/牌河。`}
          />
          <Descriptions size="small" column={1} bordered
            items={[
              { key: 'st', label: 'rooms.status', children: <Tag>{data.fallback?.status ?? '—'}</Tag> },
              { key: 'sc', label: 'member_scores', children: <span className="mono">{scoreText(data.fallback?.memberScores)}</span> },
              { key: 'au', label: '调用审计', children: <span className="muted">who={admin?.username} · room={activeRoom} · result=fail → 已降级</span> },
            ]}
          />
        </Card>
      )}

      {/* 可用：左牌桌+牌墙 / 右运维摘要 */}
      {inspect && (
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Card
              style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}
              title={
                <Space size={8} wrap>
                  <span>实时牌桌</span>
                  <span className="mono muted" style={{ fontSize: 12, fontWeight: 400 }}>inspect().state</span>
                  <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>房间 {inspect.room} · 第 {game?.round ?? '—'} 局 · 只读无操作按钮</span>
                  {inspect.gameId && <a onClick={() => nav(`/replay/${inspect.gameId}`)}>看本局回放 →</a>}
                </Space>
              }
            >
              {state ? (
                <>
                  <TableBoard
                    state={state} names={inspect.names} seatMeta={seatMeta} variant="monitor"
                    centerExtra={<>当前 <b>seat{state.currentSeat}</b><br />phase <b>{state.phase}</b></>}
                  />
                  <div style={{ marginTop: 12 }}>
                    <WallStrip wall={state.wall} currentSeat={state.currentSeat} />
                  </div>
                </>
              ) : (
                <div className="muted">当前无进行中的牌局（房间相位 <Tag>{inspect.phase}</Tag>）；等待开局后再监控牌桌。</div>
              )}
            </Card>
          </div>

          <div style={{ width: 360, flexShrink: 0 }}>
            <Card size="small" title="在等谁 · 停滞" style={{ marginBottom: 16 }}>
              {inspect.stall.idleMs > 20000 && (
                <Alert type="warning" showIcon style={{ marginBottom: 10 }}
                  message={<span>当前行动 <b>seat{game?.currentSeat ?? state?.currentSeat}</b> 已 <b>{(inspect.stall.idleMs / 1000).toFixed(1)}s</b> 未动作</span>} />
              )}
              <Descriptions size="small" column={1}
                items={[
                  { key: 'idle', label: 'stall.idleMs', children: <Tag color={inspect.stall.idleMs > 20000 ? 'red' : 'default'}>{inspect.stall.idleMs.toLocaleString()} ms</Tag> },
                  { key: 'last', label: 'lastActionAt', children: <span className="mono">{clock(inspect.stall.lastActionAt)}</span> },
                  { key: 'legal', label: `legalBySeat[${game?.currentSeat ?? state?.currentSeat ?? '?'}]`, children: <span className="mono">{legalText(game?.legalBySeat?.[game?.currentSeat ?? state?.currentSeat ?? -1])}</span> },
                  { key: 'wall', label: '牌墙剩余', children: <span className="mono">{game?.wallLen ?? state?.wall.length ?? '—'}（可摸 {Math.max(0, (game?.wallLen ?? state?.wall.length ?? 0) - 4)}）</span> },
                ]}
              />
            </Card>

            <Card size="small" title="响应意图 · timers" style={{ marginBottom: 16 }}>
              <Descriptions size="small" column={1}
                items={[
                  { key: 'pend', label: 'pending 响应', children: <span className="muted">{pendingText}</span> },
                  { key: 'trus', label: 'trusteePending', children: <span className="mono">[{inspect.timers.trusteePending.join(', ')}]</span> },
                  { key: 'off', label: 'offlineSince', children: <span className="mono">{inspect.timers.offlineSince.length ? inspect.timers.offlineSince.map(([u, t]) => `${u.slice(0, 8)} @ ${clock(t)}`).join(' · ') : '无'}</span> },
                  { key: 'seat', label: 'seatingInputActive', children: inspect.timers.seatingInputActive ? '是' : '否' },
                ]}
              />
            </Card>

            <Card size="small" title="房间 / 仪式" style={{ marginBottom: 16 }}>
              <Descriptions size="small" column={1}
                items={[
                  { key: 'ph', label: '房间相位', children: <Tag color={inspect.phase === 'playing' ? 'green' : 'default'}>{inspect.phase}</Tag> },
                  { key: 'mr', label: '局数上限', children: <span className="mono">{inspect.maxRounds || '不限'}</span> },
                  { key: 'set', label: '玩法', children: <span className="muted">{inspect.settings ? JSON.stringify(inspect.settings) : '—'}</span> },
                  { key: 'dl', label: '庄家 / 连庄', children: <span>seat{state?.dealerSeat ?? '—'} · 连庄 {ext?.lianzhuangCount ?? 0}</span> },
                  { key: 'sg', label: 'seating 仪式', children: <span className="muted">{inspect.seating ? '进行中' : 'null（非仪式阶段）'}</span> },
                ]}
              />
            </Card>

            <Card size="small" title="调用审计">
              <Descriptions size="small" column={1}
                items={[
                  { key: 'who', label: 'who', children: <span className="mono">{admin?.username}（{admin?.role}）</span> },
                  { key: 'rm', label: 'room', children: <span className="mono">{activeRoom}</span> },
                  { key: 'rs', label: 'result', children: <Tag color={data?.available ? 'green' : 'red'}>{data?.available ? 'success' : 'fail'}</Tag> },
                  { key: 'note', label: '节流', children: <span className="muted">开启监控 / 手动刷新记一次，自动轮询不逐条记</span> },
                ]}
              />
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
