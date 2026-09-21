import { useState } from 'react';
import { Button, Card, Descriptions, Drawer, Input, Space, Statistic, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useUserDetail, useUsers, type UserQuery } from '../api/hooks';
import type { GameDTO, RoomDTO, UserDTO } from '../api/types';

const fmt = (v?: string | null): string => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');

/** 用户管理（只读，FR-Admin-04）：检索 + 详情抽屉（资料 / 房间史 / 对局史） */
export default function Users(): JSX.Element {
  const [query, setQuery] = useState<UserQuery>({ page: 1, size: 20 });
  const [draft, setDraft] = useState({ q: '', from: '', to: '' });
  const [openId, setOpenId] = useState<string | null>(null);
  const { data, isFetching } = useUsers(query);
  const detail = useUserDetail(openId);

  const columns: ColumnsType<UserDTO> = [
    { title: '用户', dataIndex: 'nickname', render: (v: string, r) => <b>{v || r.openid}</b> },
    { title: 'openid', dataIndex: 'openid', render: (v: string) => <span className="mono">{v}</span> },
    { title: '注册时间', dataIndex: 'createdAt', render: (v: string) => fmt(v) },
    { title: '最后登录', dataIndex: 'lastLoginAt', render: (v: string) => (v ? fmt(v) : <span className="muted">—</span>) },
    {
      title: '操作',
      key: 'op',
      width: 90,
      render: (_: unknown, r) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => setOpenId(r.openid)}>
          详情
        </Button>
      ),
    },
  ];

  const roomCols: ColumnsType<RoomDTO> = [
    { title: '房间号', dataIndex: 'roomId', render: (v: string) => <span className="mono">{v}</span> },
    { title: '身份', key: 'role', render: (_: unknown, r) => (r.hostOpenid === openId ? <Tag color="gold">房主</Tag> : <Tag color="blue">成员</Tag>) },
    { title: '局数上限', dataIndex: 'maxRounds', render: (v: number) => (v > 0 ? v : '不限') },
    { title: '状态', dataIndex: 'status', render: (v: string) => <Tag color={v === 'playing' ? 'green' : 'default'}>{v}</Tag> },
  ];
  const gameCols: ColumnsType<GameDTO> = [
    { title: '对局', dataIndex: 'gameId', render: (v: string) => <span className="mono">{v}</span> },
    { title: '庄家位', dataIndex: 'dealerSeat' },
    { title: '结束', dataIndex: 'endType', render: (v: string | null) => (v ? <Tag color={v === 'win' ? 'green' : 'default'}>{v}</Tag> : <span className="muted">进行中</span>) },
    { title: '开始', dataIndex: 'startedAt', render: (v: string) => fmt(v) },
  ];

  const d = detail.data;

  return (
    <>
      <h1 className="page-title">用户管理</h1>
      <p className="page-desc">
        检索玩家、查看资料与战绩（一期<b>纯只读</b>，不含封禁 / 改资料等处置）。
      </p>

      <Card style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
        <Space wrap size={12}>
          <Space size={8}>
            <span className="muted">关键词</span>
            <Input
              style={{ width: 240 }}
              placeholder="openid / 昵称"
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
              onPressEnter={() => setQuery({ ...query, ...draft, page: 1 })}
              allowClear
            />
          </Space>
          <Space size={8}>
            <span className="muted">注册时间</span>
            <Input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            <span className="muted">~</span>
            <Input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          </Space>
          <Button type="primary" onClick={() => setQuery({ ...query, ...draft, page: 1 })}>
            查询
          </Button>
          <Button
            onClick={() => {
              setDraft({ q: '', from: '', to: '' });
              setQuery({ page: 1, size: query.size });
            }}
          >
            重置
          </Button>
          <span className="muted">共 {data?.total ?? 0} 位用户</span>
        </Space>
      </Card>

      <Card styles={{ body: { padding: 0 } }}>
        <Table<UserDTO>
          rowKey="openid"
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

      <Drawer
        open={!!openId}
        onClose={() => setOpenId(null)}
        width={560}
        title={`用户详情 · ${d?.profile.nickname ?? openId ?? ''}`}
        loading={detail.isFetching}
      >
        {d && (
          <>
            <Descriptions column={1} bordered size="small" style={{ marginBottom: 20 }}>
              <Descriptions.Item label="openid">
                <span className="mono">{d.profile.openid}</span>
              </Descriptions.Item>
              <Descriptions.Item label="昵称">{d.profile.nickname || '—'}</Descriptions.Item>
              <Descriptions.Item label="头像">
                <span className="muted">（未设置 · 头像功能延后）</span>
              </Descriptions.Item>
              <Descriptions.Item label="注册时间">{fmt(d.profile.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="最后登录">{d.profile.lastLoginAt ? fmt(d.profile.lastLoginAt) : '—'}</Descriptions.Item>
            </Descriptions>

            <Space size={16} style={{ marginBottom: 20 }}>
              <Card size="small" style={{ width: 150 }}>
                <Statistic title="参赛房间" value={d.rooms.length} />
              </Card>
              <Card size="small" style={{ width: 150 }}>
                <Statistic title="对局数" value={d.games.length} />
              </Card>
            </Space>

            <Card size="small" title="近期房间" style={{ marginBottom: 16 }}>
              <Table<RoomDTO> rowKey="roomId" size="small" columns={roomCols} dataSource={d.rooms} pagination={false} scroll={{ y: 200 }} />
            </Card>
            <Card size="small" title="近期对局">
              <Table<GameDTO> rowKey="gameId" size="small" columns={gameCols} dataSource={d.games} pagination={false} scroll={{ y: 200 }} />
            </Card>

            <p className="muted" style={{ marginTop: 16 }}>
              一期只读 · 处置动作（封禁 / 改资料）归二期
            </p>
          </>
        )}
      </Drawer>
    </>
  );
}
