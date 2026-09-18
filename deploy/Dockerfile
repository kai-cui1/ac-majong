# 微信云托管（cloudrun）镜像：WebSocket 网关服务
# 构建：docker build -f deploy/Dockerfile -t ac-majong-server .
# 云托管环境变量：DATABASE_URL / REDIS_URL / IDENTITY=wechat / PORT=8080 / AUTO_BOTS=0
FROM node:20-alpine
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY server ./server
RUN pnpm install --frozen-lockfile
EXPOSE 8080
CMD ["pnpm", "--filter", "server", "exec", "tsx", "src/index.ts"]
