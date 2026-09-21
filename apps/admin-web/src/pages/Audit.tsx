import { useState } from 'react';
import { Button, Card, Input, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useAudit, type AuditQuery } from '../api/hooks';
import type { AuditDTO } from '../api/types';

const fmt = (v?: string | null): string => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');
const JsonBlock = ({ label, v }: { label: string; v: unknown }): JSX.Element => (
  <div style={{ marginBottom: 8 }}>
    <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>
      {label}
    </div>
    <pre className="mono" style={{ background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 6, padding: 8, margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
      {v == null ? '—' : JSON.stringify(v, null, 2)}
    </pre>
  </div>
);

/** 审计日志（super，FR-Admin-07）：全部写操作留痕 + before/after + 多条件检索 */
export default function Audit(): JSX.Element {
  const [query, setQuery] = useState<AuditQuery>({ page: 1, size: 20 });
  const [draft, setDraft] = useState({ action: '', targetType: '', from: '', to: '' });
  const { data, isFetching } = useAudit(query);

  const columns: ColumnsType<AuditDTO> = [
    { title: '时间', dataIndex: 'at', width: 180, render: (v: string) => fmt(v) },
    { title: '管理员', dataIndex: 'adminUsername', render: (v: string | null) => v ?? <span className="muted">—</span> },
    { title: '动作', dataIndex: 'action', render: (v: string) => <Tag color="blue">{v}</Tag> },
    { title: '目标', key: 'target', render: (_, r) => (r.targetType ? <span className="mono">{r.targetType}:{r.targetId ?? ''}</span> : <span className="muted">—</span>) },
    { title: '结果', dataIndex: 'result', width: 90, render: (v: string) => <Tag color={v === 'success' ? 'green' : 'red'}>{v}</Tag> },
    { title: 'IP', dataIndex: 'ip', render: (v: string | null) => <span className="mono">{v ?? '—'}</span> },
  ];

  return (
    <>
      <h1 className="page-title">审计日志</h1>
      <p className="page-desc">全部管理员<b>写操作</b>留痕（who / when / what / target / 前后值 / ip / result），仅 <b>super</b> 可查。</p>

      <Card style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
        <Space wrap size={12}>
          <Space size={8}>
            <span className="muted">动作</span>
            <Input style={{ width: 180 }} placeholder="如 arbitration.update" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} allowClear />
          </Space>
          <Space size={8}>
            <span className="muted">目标类型</span>
            <Input style={{ width: 140 }} placeholder="game / admin …" value={draft.targetType} onChange={(e) => setDraft({ ...draft, targetType: e.target.value })} allowClear />
          </Space>
          <Space size={8}>
            <span className="muted">时间</span>
            <Input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            <span className="muted">~</span>
            <Input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </Space>
          <Button type="primary" onClick={() => setQuery({ ...query, ...draft, page: 1 })}>
            查询
          </Button>
          <Button
            onClick={() => {
              setDraft({ action: '', targetType: '', from: '', to: '' });
              setQuery({ page: 1, size: query.size });
            }}
          >
            重置
          </Button>
        </Space>
      </Card>

      <Card styles={{ body: { padding: 0 } }}>
        <Table<AuditDTO>
          rowKey="id"
          size="middle"
          loading={isFetching}
          columns={columns}
          dataSource={data?.items ?? []}
          expandable={{
            expandedRowRender: (r) => (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <JsonBlock label="变更前 before" v={r.beforeJson} />
                <JsonBlock label="变更后 after" v={r.afterJson} />
              </div>
            ),
            rowExpandable: (r) => r.beforeJson != null || r.afterJson != null,
          }}
          pagination={{
            current: query.page,
            pageSize: query.size,
            total: data?.total ?? 0,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (page, size) => setQuery((q) => ({ ...q, page, size })),
          }}
        />
      </Card>
    </>
  );
}
