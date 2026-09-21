import { useState } from 'react';
import { Button, Form, Input } from 'antd';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import { ApiError } from '../api/client';

/** 登录页（还原原型 login.html）：管理员账号密码 · 与玩家账号完全隔离 */
export default function Login(): JSX.Element {
  const admin = useAuth((s) => s.admin);
  const ready = useAuth((s) => s.ready);
  const login = useAuth((s) => s.login);
  const nav = useNavigate();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (ready && admin) return <Navigate to="/users" replace />;

  const onFinish = async (v: { username: string; password: string }): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      await login(v.username, v.password);
      nav('/users');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '登录失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(1200px 600px at 50% -10%, #e6f4ff 0%, transparent 60%), linear-gradient(180deg, #f7f9fc 0%, #eef1f5 100%)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
        <div className="brand-tile" style={{ width: 44, height: 44, borderRadius: 10, fontSize: 24, boxShadow: '0 6px 18px rgba(212,165,55,0.35)' }}>🀄</div>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 1 }}>
          AC 麻将 · 管理后台
          <small style={{ display: 'block', fontSize: 12, fontWeight: 400, color: 'rgba(0,0,0,0.45)', letterSpacing: 2 }}>ADMIN CONSOLE</small>
        </div>
      </div>

      <div style={{ width: 380, background: '#fff', borderRadius: 12, boxShadow: '0 6px 16px rgba(0,0,0,0.08), 0 9px 28px 8px rgba(0,0,0,0.05)', padding: '32px 32px 24px' }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>管理员登录</h2>
        <div style={{ color: 'rgba(0,0,0,0.45)', fontSize: 13, marginBottom: 24 }}>运营 / 客服 / 超管专用入口 · 与玩家账号完全隔离</div>

        {err && (
          <div style={{ background: '#fff2f0', border: '1px solid #ffccc7', color: '#ff4d4f', fontSize: 13, padding: '7px 12px', borderRadius: 6, marginBottom: 16 }}>{err}</div>
        )}

        <Form layout="vertical" onFinish={onFinish} requiredMark={false} size="large">
          <Form.Item label="账号" name="username" rules={[{ required: true, message: '请输入管理员账号' }]}>
            <Input placeholder="管理员账号" autoComplete="username" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入登录密码' }]}>
            <Input.Password placeholder="登录密码" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading} style={{ height: 38, fontSize: 15, marginTop: 4 }}>
            登 录
          </Button>
        </Form>

        <div style={{ marginTop: 14, fontSize: 12, color: 'rgba(0,0,0,0.45)', textAlign: 'center' }}>受保护系统 · 所有登录与操作均记入审计日志</div>
      </div>

      <div style={{ textAlign: 'center', color: 'rgba(0,0,0,0.45)', fontSize: 12, marginTop: 20, lineHeight: 1.8 }}>
        会话存 Redis（8h 滑动）· 写操作需 CSRF 校验 · 生产走独立域名 + HTTPS + IP 白名单
        <br />
        AC Mahjong Admin v0.1.0 · 一期（BL-015）：用户查询 / 房间对局 / 回放仲裁 / 审计
      </div>
    </div>
  );
}
