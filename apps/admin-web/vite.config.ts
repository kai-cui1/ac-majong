import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev 同源代理：/api → admin-server(8090)，使会话 cookie 同源（免跨域/SameSite 麻烦）。
// 生产由 nginx 同源反代（静态 + /api），见 Admin 技术方案 §8。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8090', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
