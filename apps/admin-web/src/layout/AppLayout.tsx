import { useMemo } from 'react';
import { Avatar, Layout, Menu, Space, Spin, Tag } from 'antd';
import type { MenuProps } from 'antd';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { hasRole, useAuth } from '../store/auth';

const { Sider, Header, Content } = Layout;

const TITLES: Record<string, string> = {
  '/users': '用户管理',
  '/rooms': '房间 / 对局',
  '/replay': '回放仲裁',
  '/admins': '管理员管理',
  '/audit': '审计日志',
};
const GROUPS: Record<string, string> = {
  '/users': '查证',
  '/rooms': '查证',
  '/replay': '查证',
  '/admins': '系统',
  '/audit': '系统',
};

/** 主框架：固定深色侧栏 + 顶栏（面包屑 / 环境标 / 当前管理员 / 登出）+ 内容区。未登录跳登录页。 */
export function AppLayout(): JSX.Element {
  const admin = useAuth((s) => s.admin);
  const ready = useAuth((s) => s.ready);
  const logout = useAuth((s) => s.logout);
  const nav = useNavigate();
  const loc = useLocation();

  const items = useMemo<MenuProps['items']>(() => {
    const groups: MenuProps['items'] = [
      {
        type: 'group',
        label: '查证',
        children: [
          { key: '/users', label: <span>👥 用户管理</span> },
          { key: '/rooms', label: <span>🚪 房间 / 对局</span> },
          { key: '/replay', label: <span>▶️ 回放仲裁</span> },
        ],
      },
    ];
    if (hasRole(admin?.role, 'super')) {
      groups.push({
        type: 'group',
        label: '系统',
        children: [
          { key: '/admins', label: <span>🛡️ 管理员管理 🔒</span> },
          { key: '/audit', label: <span>📜 审计日志 🔒</span> },
        ],
      });
    }
    return groups;
  }, [admin?.role]);

  if (!ready) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" tip="加载中…" />
      </div>
    );
  }
  if (!admin) return <Navigate to="/login" replace />;

  const selectedKey = '/' + (loc.pathname.split('/')[1] || 'users');

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={208} theme="dark" style={{ position: 'fixed', left: 0, top: 0, bottom: 0, overflow: 'auto', zIndex: 20 }}>
        <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="brand-tile">🀄</div>
          <div style={{ color: '#fff', fontSize: 15, fontWeight: 600, letterSpacing: 0.5, whiteSpace: 'nowrap' }}>
            AC 麻将
            <small style={{ display: 'block', fontSize: 11, fontWeight: 400, color: 'rgba(255,255,255,0.65)', letterSpacing: 1 }}>管理后台</small>
          </div>
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[selectedKey]} items={items} onClick={(e) => nav(e.key)} style={{ borderInlineEnd: 'none' }} />
      </Sider>

      <Layout style={{ marginLeft: 208 }}>
        <Header style={{ position: 'sticky', top: 0, zIndex: 10, borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 14 }}>
            {GROUPS[selectedKey]} / <b style={{ color: 'rgba(0,0,0,0.88)', fontWeight: 600 }}>{TITLES[selectedKey]}</b>
          </div>
          <div style={{ flex: 1 }} />
          <Tag color="gold">内网 · 只读一期</Tag>
          <Space size={8}>
            <Avatar size={28} style={{ background: '#1677ff' }}>{admin.username.slice(0, 1).toUpperCase()}</Avatar>
            <span style={{ color: 'rgba(0,0,0,0.65)' }}>
              {admin.username} · <b style={{ color: 'rgba(0,0,0,0.88)' }}>{admin.role}</b>
            </span>
            <a
              onClick={async () => {
                await logout();
                nav('/login');
              }}
            >
              登出
            </a>
          </Space>
        </Header>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
