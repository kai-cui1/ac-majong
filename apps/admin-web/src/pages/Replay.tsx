import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Card, Form, Input, Select, Slider, Space, Spin, Tag } from 'antd';
import { useParams } from 'react-router-dom';
import { downloadReplayBundle, useArbitrationsByGame, useCreateArbitration, useReplay } from '../api/hooks';
import { hasRole, useAuth } from '../store/auth';
import TableBoard, { type BoardState } from '../components/TableBoard';

// ---- 牌面 Unicode 映射（引擎 TileId：W/T/B 数牌、Z1-7 字、H1-8 花）----
const cp = (n: number): string => String.fromCodePoint(n);
function tileGlyph(id: string): string {
  const suit = id.charAt(0);
  const r = Number(id.slice(1));
  if (!suit || Number.isNaN(r)) return '🀫';
  switch (suit) {
    case 'W': return cp(0x1f006 + r);
    case 'T': return cp(0x1f00f + r);
    case 'B': return cp(0x1f018 + r);
    case 'Z': return cp(0x1f000 + r - 1);
    case 'H': return cp(0x1f022 + r - 1);
    default: return '🀫';
  }
}
/** 回放仲裁（★核心，FR-Admin-06/08）：逐帧全信息回放 + 动作序列 + 仲裁录入（operator+）+ 导出回放包 */
export default function Replay(): JSX.Element {
  const params = useParams<{ gameId?: string }>();
  const { message } = AntApp.useApp();
  const role = useAuth((s) => s.admin?.role);
  const canWrite = hasRole(role, 'operator');

  const [inputId, setInputId] = useState(params.gameId ?? '');
  const gameId = params.gameId ?? (inputId.trim() || null);
  const { data, isFetching, error } = useReplay(gameId);
  const arbQuery = useArbitrationsByGame(gameId);
  const createArb = useCreateArbitration(gameId ?? '');
  const [arbForm] = Form.useForm<{ status: string; verdict?: string; note?: string }>();

  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => { setIdx(0); setPlaying(false); }, [gameId]);
  useEffect(() => {
    if (!playing || !data) return;
    timer.current = window.setInterval(() => {
      setIdx((i) => {
        if (i >= data.frames.length - 1) { setPlaying(false); return i; }
        return i + 1;
      });
    }, 700);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [playing, data]);

  const frame = data?.frames[idx];
  const state = frame?.state as BoardState | undefined;

  const names = data?.meta.names ?? {};
  const seatName = (s: number): string => names[s] ?? `座位${s}`;
  const winnerSeat = useMemo(() => {
    const r = data?.meta.result as { winners?: { seat: number }[] } | null;
    return r?.winners?.[0]?.seat ?? null;
  }, [data]);

  const onSubmitArb = async (): Promise<void> => {
    if (!gameId) return;
    const v = await arbForm.validateFields();
    try {
      await createArb.mutateAsync({ status: v.status, verdict: v.verdict ?? null, note: v.note ?? null });
      message.success('仲裁结论已录入（留痕）');
      arbForm.resetFields();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '录入失败');
    }
  };

  const actions = useMemo(
    () => (data?.frames ?? []).map((f) => f.action).filter(Boolean) as { type?: string; seat?: number; tile?: string; move?: string }[],
    [data],
  );

  if (!gameId) {
    return (
      <>
        <h1 className="page-title">回放仲裁</h1>
        <p className="page-desc">输入 gameId（形如 <span className="mono">R84213:2</span>）或从「房间 / 对局」进入，逐帧全信息回放并录入仲裁结论。</p>
        <Card style={{ maxWidth: 520 }}>
          <Space.Compact style={{ width: '100%' }}>
            <Input placeholder="gameId，如 R84213:2" value={inputId} onChange={(e) => setInputId(e.target.value)} />
            <Button type="primary" onClick={() => setInputId(inputId.trim())}>载入</Button>
          </Space.Compact>
        </Card>
      </>
    );
  }

  if (isFetching && !data) return <Spin style={{ display: 'block', margin: '80px auto' }} size="large" tip="加载回放…" />;
  if (error) return <Card><span style={{ color: '#ff4d4f' }}>回放加载失败：{(error as Error).message}</span></Card>;
  if (!data || !state || !frame) return <Card className="muted">无回放数据</Card>;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <h1 className="page-title" style={{ margin: 0 }}>回放仲裁</h1>
        <Tag className="mono">{data.meta.gameId}</Tag>
        <span className="muted">房 {data.meta.roomId} · 第 {data.meta.roundNo} 局 · 庄位 {data.meta.dealerSeat} · {data.meta.endType ?? '进行中'}</span>
        <div style={{ flex: 1 }} />
        {canWrite && <Button onClick={() => downloadReplayBundle(data.meta.gameId)}>⬇ 导出回放包</Button>}
      </div>
      <p className="page-desc">服务端逐帧全信息还原（含各家暗牌，无防透视）· 仲裁结论<b>纯记录留痕</b>，不回写游戏数据。</p>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* 牌桌（共享 <TableBoard>：与实时监控同款——贴图 + 四家横排 + 弃牌按家分区 + 花牌独立区） */}
          <Card style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
            <TableBoard
              state={state}
              names={names}
              variant="replay"
              winnerSeat={winnerSeat}
              centerExtra={<>结束 <b>{data.meta.endType ?? '进行中'}</b>{winnerSeat != null ? <><br />赢家 <b>seat{winnerSeat}</b></> : null}</>}
            />
          </Card>

          {/* 控制条 */}
          <Card style={{ marginBottom: 16 }} styles={{ body: { padding: '12px 16px' } }}>
            <Space style={{ width: '100%' }} align="center">
              <Button onClick={() => { setPlaying(false); setIdx(0); }}>⏮</Button>
              <Button onClick={() => { setPlaying(false); setIdx((i) => Math.max(0, i - 1)); }}>◀</Button>
              <Button type="primary" onClick={() => setPlaying((p) => !p)}>{playing ? '⏸ 暂停' : '▶ 播放'}</Button>
              <Button onClick={() => { setPlaying(false); setIdx((i) => Math.min(data.frames.length - 1, i + 1)); }}>▶</Button>
              <Button onClick={() => { setPlaying(false); setIdx(data.frames.length - 1); }}>⏭</Button>
              <span className="muted mono" style={{ minWidth: 90 }}>帧 {idx} / {data.frames.length - 1}</span>
              <Slider style={{ flex: 1, minWidth: 200 }} min={0} max={Math.max(0, data.frames.length - 1)} value={idx} onChange={(v) => { setPlaying(false); setIdx(v as number); }} tooltip={{ formatter: (v) => `帧 ${v}` }} />
            </Space>
            <div style={{ marginTop: 8 }} className="muted">
              当前帧动作：{frame.action ? <span className="mono">{JSON.stringify(frame.action)}</span> : '（初始态）'} · 事件：{frame.events.length ? frame.events.join(', ') : '—'}
            </div>
          </Card>

          {/* 动作序列 */}
          <Card title={`动作序列（${actions.length}）`} size="small">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {actions.map((a, i) => (
                <Tag
                  key={i}
                  color={i + 1 === idx ? 'blue' : 'default'}
                  style={{ cursor: 'pointer' }}
                  onClick={() => { setPlaying(false); setIdx(i + 1); }}
                >
                  {i + 1}. {a.type}
                  {a.seat != null ? `·${seatName(a.seat)}` : ''}
                  {a.tile ? ` ${tileGlyph(a.tile)}` : ''}
                  {a.move ? ` ${a.move}` : ''}
                </Tag>
              ))}
            </div>
          </Card>
        </div>

        {/* 仲裁面板 */}
        <div style={{ width: 340, flexShrink: 0 }}>
          <Card title="仲裁记录" size="small" style={{ marginBottom: 16 }} loading={arbQuery.isFetching}>
            {(arbQuery.data ?? []).length === 0 && <div className="muted">暂无仲裁记录</div>}
            {(arbQuery.data ?? []).map((a) => (
              <div key={a.id} style={{ borderBottom: '1px solid #f0f0f0', padding: '8px 0' }}>
                <Space size={6}>
                  <Tag color={a.status === 'resolved' ? 'green' : a.status === 'rejected' ? 'red' : 'gold'}>{a.status}</Tag>
                  {a.verdict && <Tag>{a.verdict}</Tag>}
                  <span className="muted" style={{ fontSize: 12 }}>#{a.id}</span>
                </Space>
                {a.note && <div style={{ fontSize: 13, marginTop: 4 }}>{a.note}</div>}
              </div>
            ))}
          </Card>

          {canWrite ? (
            <Card title="录入仲裁结论" size="small">
              <Form form={arbForm} layout="vertical" initialValues={{ status: 'pending' }}>
                <Form.Item label="受理状态" name="status" rules={[{ required: true }]}>
                  <Select
                    options={[
                      { value: 'pending', label: 'pending（待处理）' },
                      { value: 'accepted', label: 'accepted（已受理）' },
                      { value: 'rejected', label: 'rejected（驳回）' },
                      { value: 'resolved', label: 'resolved（已裁定）' },
                    ]}
                  />
                </Form.Item>
                <Form.Item label="结论分类" name="verdict">
                  <Input placeholder="如 valid / invalid / adjust_offline" />
                </Form.Item>
                <Form.Item label="备注" name="note">
                  <Input.TextArea rows={3} placeholder="结论说明 / 线下处理记录" />
                </Form.Item>
                <Button type="primary" block loading={createArb.isPending} onClick={onSubmitArb}>
                  提交（留痕）
                </Button>
              </Form>
            </Card>
          ) : (
            <Card size="small" className="muted">仲裁录入需 operator+ 权限</Card>
          )}
        </div>
      </div>
    </>
  );
}
