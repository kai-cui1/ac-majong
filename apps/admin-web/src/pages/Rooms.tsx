import { useState } from 'react';
import { Button, Card, Descriptions, Drawer, Input, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import { useRoomDetail, useRooms, type RoomQuery } from '../api/hooks';
import type { GameDTO, MemberEventDTO, RoomSummary } from '../api/types';

const fmt = (v?: string | null): string => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');
const statusTag = (s: string): JSX.Element => <Tag color={s === 'playing' ? 'green' : s === 'closed' ? 'default' : 'blue'}>{s}</Tag>;

/** 房间 / 对局（只读，FR-Admin-05）：房间检索 + 详情（成员进出 / 局列表 / 进入回放） */
export default function Rooms(): JSX.Element {
  const [query, setQuery] = useState<RoomQuery>({ page: 1, size: 20 });
  const [draft, setDraft] = useState({ roomId: '', host: '', status: '' });
  const [openRoom, setOpenRoom] = useState<string | null>(null);
  const { data, isFetching } = useRooms(query);
  const detail = useRoomDetail(openRoom);
  const nav = useNavigate();

  const columns: ColumnsType<RoomSummary> = [
    { title: '房间号', key: 'roomId', render: (_, r) => <span className="mono">{r.room.roomId}</span> },
    { title: '房主', key: 'host', render: (_, r) => r.hostNickname || <span className="mono">{r.room.hostOpenid}</span> },
    { title: '局数上限', key: 'max', render: (_, r) => (r.room.maxRounds > 0 ? r.room.maxRounds : '不限') },
    { title: '已打局数', dataIndex: 'gameCount', align: 'right' },
    { title: '状态', key: 'status', render: (_, r) => statusTag(r.room.status) },
    { title: '创建时间', key: 'created', render: (_, r) => fmt(r.room.createdAt) },
    {
      title: '操作',
      key: 'op',
      width: 90,
      render: (_, r) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => setOpenRoom(r.room.roomId)}>
          详情
        </Button>
      ),
    },
  ];

  const memCols: ColumnsType<MemberEventDTO> = [
    { title: '时间', dataIndex: 'at', render: (v: string) => fmt(v) },
    { title: 'openid', dataIndex: 'openid', render: (v: string) => <span className="mono">{v}</span> },
    { title: '座位', dataIndex: 'seat', render: (v: number | null) => (v == null ? '—' : v) },
    { title: '事件', dataIndex: 'event', render: (v: string) => <Tag>{v}</Tag> },
  ];
  const gameCols: ColumnsType<GameDTO> = [
    { title: '局', dataIndex: 'roundNo' },
    { title: 'gameId', dataIndex: 'gameId', render: (v: string) => <span className="mono">{v}</span> },
    { title: '结束', dataIndex: 'endType', render: (v: string | null) => (v ? <Tag color={v === 'win' ? 'green' : 'default'}>{v}</Tag> : <span className="muted">进行中</span>) },
    { title: '开始', dataIndex: 'startedAt', render: (v: string) => fmt(v) },
    {
      title: '操作',
      key: 'op',
      render: (_, r) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => nav(`/replay/${encodeURIComponent(r.gameId)}`)}>
          回放
        </Button>
      ),
    },
  ];

  const d = detail.data;

  return (
    <>
      <h1 className="page-title">房间 / 对局</h1>
      <p className="page-desc">检索房间、查看成员进出与局列表（一期<b>纯只读</b>），可进入逐帧回放仲裁。</p>

      <Card style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
        <Space wrap size={12}>
          <Space size={8}>
            <span className="muted">房间号</span>
            <Input style={{ width: 160 }} placeholder="精确房号" value={draft.roomId} onChange={(e) => setDraft({ ...draft, roomId: e.target.value })} allowClear />
          </Space>
          <Space size={8}>
            <span className="muted">房主</span>
            <Input style={{ width: 200 }} placeholder="host openid" value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })} allowClear />
          </Space>
          <Space size={8}>
            <span className="muted">状态</span>
            <Select
              style={{ width: 120 }}
              placeholder="全部"
              allowClear
              value={draft.status || undefined}
              onChange={(v) => setDraft({ ...draft, status: v ?? '' })}
              options={[
                { value: 'idle', label: 'idle' },
                { value: 'playing', label: 'playing' },
                { value: 'closed', label: 'closed' },
              ]}
            />
          </Space>
          <Button type="primary" onClick={() => setQuery({ ...query, ...draft, page: 1 })}>
            查询
          </Button>
          <Button
            onClick={() => {
              setDraft({ roomId: '', host: '', status: '' });
              setQuery({ page: 1, size: query.size });
            }}
          >
            重置
          </Button>
          <span className="muted">共 {data?.total ?? 0} 间</span>
        </Space>
      </Card>

      <Card styles={{ body: { padding: 0 } }}>
        <Table<RoomSummary>
          rowKey={(r) => r.room.roomId}
          size="middle"
          loading={isFetching}
          columns={columns}
          dataSource={data?.items ?? []}
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

      <Drawer open={!!openRoom} onClose={() => setOpenRoom(null)} width={620} title={`房间详情 · ${openRoom ?? ''}`} loading={detail.isFetching}>
        {d && (
          <>
            <Descriptions column={2} bordered size="small" style={{ marginBottom: 20 }}>
              <Descriptions.Item label="房主">
                <span className="mono">{d.room.hostOpenid}</span>
              </Descriptions.Item>
              <Descriptions.Item label="状态">{statusTag(d.room.status)}</Descriptions.Item>
              <Descriptions.Item label="局数上限">{d.room.maxRounds > 0 ? d.room.maxRounds : '不限'}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{fmt(d.room.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="积分账本" span={2}>
                <span className="mono">{d.room.memberScores ? JSON.stringify(d.room.memberScores) : '—'}</span>
              </Descriptions.Item>
              <Descriptions.Item label="最终分" span={2}>
                <span className="mono">{d.room.finalScore ? JSON.stringify(d.room.finalScore) : '—'}</span>
              </Descriptions.Item>
            </Descriptions>
            <Card size="small" title="成员进出" style={{ marginBottom: 16 }}>
              <Table<MemberEventDTO> rowKey={(r) => `${r.at}-${r.openid}-${r.event}-${r.seat}`} size="small" columns={memCols} dataSource={d.memberEvents} pagination={false} scroll={{ y: 200 }} />
            </Card>
            <Card size="small" title={`局列表（${d.games.length}）`}>
              <Table<GameDTO> rowKey="gameId" size="small" columns={gameCols} dataSource={d.games} pagination={false} scroll={{ y: 260 }} />
            </Card>
          </>
        )}
      </Drawer>
    </>
  );
}
