import { useState } from 'react';
import { App as AntApp, Button, Card, Descriptions, Input, Space, Table, Tag } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useDiagIntake } from '../api/hooks';
import { hasRole, useAuth } from '../store/auth';
import type { DiagIntakeResult, NormDiagError } from '../api/types';

const clock = (ms: number): string => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
const datetime = (ms: number): string => new Date(ms).toLocaleString('zh-CN', { hour12: false });

/** 消息环 tag 配色：err→红、view→金、act→蓝、msg→默认（对齐 diag.html） */
const ringColor = (t: string): string => (t.startsWith('err:') ? 'red' : t.startsWith('view:') ? 'gold' : t.startsWith('act:') ? 'blue' : 'default');

/** 从报错消息切出类型标签（TypeError / unhandledrejection 等）+ 正文 */
function splitMsg(msg: string): { kind: string; rest: string } {
  const sp = msg.search(/[\s:]/);
  if (sp > 0 && sp <= 24) return { kind: msg.slice(0, sp), rest: msg.slice(sp).replace(/^[\s:]+/, '') };
  return { kind: 'error', rest: msg };
}

/** 「填入示例」样例包（对齐 diag.html 展示态：房 212817 第 2 局荒庄 + 2 条报错） */
const SAMPLE = {
  at: 1758460867000,
  ctx: { screen: 'table', room: '212817', round: 2, phase: 'exhaustive', cur: 3, mySeat: 0 },
  ring: ['view:table', 'msg:gameView', 'msg:you.drawn', 'act:discard W5', 'msg:responseNeeded', 'act:pass', 'msg:gameView', 'view:exhaustive', 'err:1'],
  errors: [
    {
      at: 1758460858000,
      msg: "TypeError: cannot read properties of undefined (reading 'settled')",
      stack: 'at TableScreen.render (TableScreen.ts:412:28)\nat NetService.emit (NetService.ts:88:5)\nat ws.onmessage (ws.ts:31:11)',
      ctx: { screen: 'table', room: '212817', round: 2, phase: 'exhaustive' },
      ring: ['msg:gameView', 'view:exhaustive', 'err:1'],
    },
    {
      at: 1758460752000,
      msg: 'unhandledrejection: timeout waiting roomView',
      stack: 'at NetService.awaitView (NetService.ts:120:9)\nat async Promise.all (index 0)',
      ctx: { screen: 'table', room: '212817' },
      ring: ['msg:gameView'],
    },
  ],
};

/**
 * 诊断包受理（★FR-Admin-09，operator+）：粘贴玩家「复制诊断包」的 ac-diag JSON → 后端 zod 规范化受理（记审计、不落本体）
 * → 结构化展示现场 ctx / 消息环 / 报错栈 → 凭 room+round 派生 gameId 一键跳「回放仲裁」。对照原型 diag.html。
 */
export default function Diag(): JSX.Element {
  const { message } = AntApp.useApp();
  const nav = useNavigate();
  const admin = useAuth((s) => s.admin);
  const canIntake = hasRole(admin?.role, 'operator');
  const intake = useDiagIntake();

  const [text, setText] = useState('');
  const [result, setResult] = useState<DiagIntakeResult | null>(null);

  const onIntake = async (): Promise<void> => {
    const raw = text.trim();
    if (!raw) { message.warning('请先粘贴诊断包 JSON'); return; }
    let pkg: unknown;
    try {
      pkg = JSON.parse(raw);
    } catch {
      message.error('JSON 解析失败：请确认粘贴的是完整的 ac-diag JSON');
      return;
    }
    try {
      const r = await intake.mutateAsync(pkg);
      setResult(r);
      message.success('受理成功（已记审计，未落库诊断包本体）');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '受理失败');
    }
  };

  if (!canIntake) {
    return (
      <>
        <h1 className="page-title">诊断包受理</h1>
        <Card className="muted">诊断包受理需 operator+ 权限。</Card>
      </>
    );
  }

  const ctx = result?.ctx;

  return (
    <>
      <h1 className="page-title">诊断包受理</h1>
      <p className="page-desc">
        粘贴玩家从<b>设置页「复制诊断包」</b>得到的 <span className="mono">ac-diag</span> JSON；后端<b>校验 / 规范化受理</b>（记审计、不落库本体），结构化展示现场上下文 / 消息环 / 报错栈，并可凭 room+round 一键跳「回放仲裁」。<b>operator+</b>
      </p>

      {/* 1 · 粘贴受理 */}
      <Card title="1 · 粘贴诊断包" style={{ marginBottom: 16 }}>
        <Input.TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ height: 132, fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6 }}
          placeholder='{"at":1758460867000,"ctx":{"screen":"table","room":"212817","round":2,"phase":"exhaustive","cur":3,"mySeat":0},"ring":["view:table","msg:you.drawn"],"errors":[{"at":0,"msg":"...","stack":"..."}]}'
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <Button type="primary" loading={intake.isPending} onClick={onIntake}>受理并解析</Button>
          <Button onClick={() => setText(JSON.stringify(SAMPLE, null, 2))}>填入示例</Button>
          <Button onClick={() => { setText(''); setResult(null); }}>清空</Button>
          <div style={{ flex: 1 }} />
          <span className="muted" style={{ fontSize: 12 }}>受理记入审计（room / round / errors 数 / 受理人）· 不回传玩家 · 不落库诊断包本体</span>
        </div>
      </Card>

      {/* 2 · 解析结果 */}
      {result && ctx && (
        <Card
          title={
            <Space size={8} wrap>
              <span>2 · 解析结果</span>
              <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                受理成功 · 已规范化{result.truncated ? '（ring 截断至 60 / errors 至 5 / stack 折叠）' : ''}
              </span>
            </Space>
          }
        >
          {/* 现场上下文 */}
          <Descriptions
            size="small" column={2} bordered style={{ marginBottom: 14 }}
            items={[
              { key: 'screen', label: 'screen', children: <Tag color="blue">{ctx.screen ?? '—'}</Tag> },
              { key: 'room', label: 'room', children: <span className="mono">{ctx.room ?? '—'}</span> },
              { key: 'round', label: 'round', children: ctx.round ?? '—' },
              { key: 'phase', label: 'phase', children: <Tag color="gold">{ctx.phase ?? '—'}</Tag> },
              { key: 'cur', label: 'cur / mySeat', children: `seat${ctx.cur ?? '?'} / seat${ctx.mySeat ?? '?'}` },
              { key: 'at', label: '诊断包时刻', children: result.at ? datetime(result.at) : '—' },
            ]}
          />

          {/* 联动跳转 */}
          <div style={{ marginBottom: 20 }}>
            {result.gameId ? (
              <Button type="primary" onClick={() => nav(`/replay/${result.gameId}`)}>
                ▶ 跳回放仲裁 · <span className="mono">{result.gameId}</span>
              </Button>
            ) : result.room ? (
              <Button onClick={() => nav('/rooms')}>跳房间详情 · <span className="mono">{result.room}</span></Button>
            ) : (
              <span className="muted">无 room / round，无法联动回放</span>
            )}
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>凭 ctx.room + ctx.round 拼 gameId；room 有而 round 缺时跳房间详情</span>
          </div>

          {/* 消息环 */}
          <Card
            size="small" style={{ marginBottom: 16 }}
            title={<Space size={8}>消息环 ring<span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>最近 ≤60 · 时间正序{result.ringTruncated ? '（已截断）' : ''}</span></Space>}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {result.ring.length ? result.ring.map((t, i) => <Tag key={i} color={ringColor(t)} className="mono">{t}</Tag>) : <span className="muted">（空）</span>}
            </div>
          </Card>

          {/* 报错列表（展开看栈） */}
          <Card
            size="small"
            title={<Space size={8}>报错 errors<span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>≤5 · 展开看栈{result.errorsTruncated ? '（已截断）' : ''}</span></Space>}
          >
            <Table<NormDiagError>
              size="small"
              rowKey={(_r, i) => `err-${i}`}
              dataSource={result.errors}
              pagination={false}
              locale={{ emptyText: '无报错记录' }}
              expandable={{
                rowExpandable: (e) => !!e.stack,
                expandedRowRender: (e) => (
                  <pre className="mono" style={{ margin: 0, fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: 'rgba(0,0,0,0.65)' }}>
                    {e.stack}
                    {e.stackTruncated ? '\n…（栈已截断）' : ''}
                  </pre>
                ),
              }}
              columns={[
                { title: '时刻', dataIndex: 'at', width: 110, render: (at: number | null) => <span className="mono" style={{ whiteSpace: 'nowrap' }}>{at ? clock(at) : '—'}</span> },
                {
                  title: '消息', dataIndex: 'msg',
                  render: (msg: string | null) => {
                    if (!msg) return <span className="muted">—</span>;
                    const { kind, rest } = splitMsg(msg);
                    return <span><Tag color="red">{kind}</Tag>{rest}</span>;
                  },
                },
              ]}
            />
          </Card>
        </Card>
      )}
    </>
  );
}
