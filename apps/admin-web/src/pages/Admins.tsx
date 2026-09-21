import { useState } from 'react';
import { App as AntApp, Button, Card, Form, Input, Modal, Select, Space, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useAdmins, useCreateAdmin, useUpdateAdmin } from '../api/hooks';
import type { AdminDTO } from '../api/types';

const fmt = (v?: string | null): string => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');
const roleTag = (r: string): JSX.Element => <Tag color={r === 'super' ? 'purple' : r === 'operator' ? 'blue' : 'default'}>{r}</Tag>;

/** 管理员账号管理（super，FR-Admin-03）：创建 / 停用 / 改角色 / 重置密码 */
export default function Admins(): JSX.Element {
  const { message } = AntApp.useApp();
  const [page, setPage] = useState({ page: 1, size: 20 });
  const { data, isFetching } = useAdmins(page);
  const createAdmin = useCreateAdmin();
  const updateAdmin = useUpdateAdmin();

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<{ username: string; password: string; role: string }>();
  const [pwdTarget, setPwdTarget] = useState<AdminDTO | null>(null);
  const [pwdForm] = Form.useForm<{ password: string }>();

  const onCreate = async (): Promise<void> => {
    const v = await createForm.validateFields();
    try {
      await createAdmin.mutateAsync(v);
      message.success('管理员已创建');
      setCreateOpen(false);
      createForm.resetFields();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '创建失败');
    }
  };

  const toggleStatus = async (a: AdminDTO): Promise<void> => {
    const status = a.status === 'active' ? 'disabled' : 'active';
    try {
      await updateAdmin.mutateAsync({ id: a.id, patch: { status } });
      message.success(status === 'active' ? '已启用' : '已停用');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败');
    }
  };

  const onResetPwd = async (): Promise<void> => {
    if (!pwdTarget) return;
    const v = await pwdForm.validateFields();
    try {
      await updateAdmin.mutateAsync({ id: pwdTarget.id, patch: { password: v.password } });
      message.success('密码已重置');
      setPwdTarget(null);
      pwdForm.resetFields();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '重置失败');
    }
  };

  const columns: ColumnsType<AdminDTO> = [
    { title: 'ID', dataIndex: 'id', width: 70 },
    { title: '用户名', dataIndex: 'username', render: (v: string) => <b>{v}</b> },
    { title: '角色', dataIndex: 'role', render: (v: string) => roleTag(v) },
    { title: '状态', dataIndex: 'status', render: (v: string) => <Tag color={v === 'active' ? 'green' : 'red'}>{v}</Tag> },
    { title: '创建时间', dataIndex: 'createdAt', render: (v: string) => fmt(v) },
    { title: '最后登录', dataIndex: 'lastLoginAt', render: (v: string) => (v ? fmt(v) : <span className="muted">—</span>) },
    {
      title: '操作',
      key: 'op',
      width: 200,
      render: (_, a) => (
        <Space size={4}>
          <Button type="link" style={{ padding: 0 }} onClick={() => toggleStatus(a)}>
            {a.status === 'active' ? '停用' : '启用'}
          </Button>
          <Button type="link" style={{ padding: 0 }} onClick={() => setPwdTarget(a)}>
            重置密码
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <>
      <h1 className="page-title">管理员管理</h1>
      <p className="page-desc">创建 / 停用管理员、分配角色、重置密码（仅 <b>super</b>；所有操作记入审计）。</p>

      <Card
        styles={{ body: { padding: 0 } }}
        title={<span>管理员账号</span>}
        extra={
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            + 新建管理员
          </Button>
        }
      >
        <Table<AdminDTO>
          rowKey="id"
          size="middle"
          loading={isFetching}
          columns={columns}
          dataSource={data?.items ?? []}
          pagination={{
            current: page.page,
            pageSize: page.size,
            total: data?.total ?? 0,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p, s) => setPage({ page: p, size: s }),
          }}
        />
      </Card>

      <Modal title="新建管理员" open={createOpen} onOk={onCreate} onCancel={() => setCreateOpen(false)} confirmLoading={createAdmin.isPending} okText="创建" cancelText="取消">
        <Form form={createForm} layout="vertical" initialValues={{ role: 'viewer' }} style={{ marginTop: 12 }}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }, { pattern: /^[a-zA-Z0-9_]{3,32}$/, message: '3-32 位字母/数字/下划线' }]}>
            <Input placeholder="登录名" autoComplete="off" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }, { min: 8, max: 64, message: '8-64 位' }]}>
            <Input.Password placeholder="初始密码" autoComplete="new-password" />
          </Form.Item>
          <Form.Item label="角色" name="role" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'viewer', label: 'viewer（只读）' },
                { value: 'operator', label: 'operator（查询 + 仲裁）' },
                { value: 'super', label: 'super（全部）' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title={`重置密码 · ${pwdTarget?.username ?? ''}`} open={!!pwdTarget} onOk={onResetPwd} onCancel={() => setPwdTarget(null)} confirmLoading={updateAdmin.isPending} okText="确定" cancelText="取消">
        <Form form={pwdForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item label="新密码" name="password" rules={[{ required: true, message: '请输入新密码' }, { min: 8, max: 64, message: '8-64 位' }]}>
            <Input.Password placeholder="新密码" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
