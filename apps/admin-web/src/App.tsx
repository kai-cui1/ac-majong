import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { RouterProvider } from 'react-router-dom';
import { theme } from './theme';
import { router } from './router';
import { useAuth } from './store/auth';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } },
});

export function App(): JSX.Element {
  const restore = useAuth((s) => s.restore);
  // 首屏尝试用会话 cookie 恢复登录态（免每次刷新重登）
  useEffect(() => {
    void restore();
  }, [restore]);

  return (
    <ConfigProvider theme={theme} locale={zhCN}>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  );
}
