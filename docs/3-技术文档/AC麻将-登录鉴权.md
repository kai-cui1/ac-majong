# A&C 麻将 · 登录鉴权（技术方案）

> **模块**：登录与身份鉴权（对应 M-B）。产品需求见 [`../1-prd/01-登录与身份.md`](../1-prd/01-登录与身份.md)。
> **关联**：总体架构 [`AC麻将-联机架构方案.md`](./AC麻将-联机架构方案.md)｜持久化 [`AC麻将-数据持久化与事件溯源.md`](./AC麻将-数据持久化与事件溯源.md)｜客户端网络层 [`AC麻将-客户端网络层.md`](./AC麻将-客户端网络层.md)｜前端基座 [`AC麻将-前端基座与设计系统.md`](./AC麻将-前端基座与设计系统.md)
> 遵循[《文档总纲》](../README.md)三原则：本文件为登录鉴权模块的全量技术说明。

---

## 1. 目标与范围

- **平台无关的可插拔鉴权**：本地 mock / 微信 / Web token 三种 identity，按部署环境选择。
- **登录即落库 + 建会话**：`users` upsert 到 MySQL、会话写 Redis，`authOk` 回传展示资料。
- **本期（M-B）范围**：本地 mock 打通全链路并端到端验证；真实微信 `code2Session` 留 M-K；重连恢复留 M-I。

## 2. 身份模型（身份 vs 资料分离）

| 维度 | 含义 | 来源 | 可信度 |
|---|---|---|---|
| 身份（谁） | `userId`（微信下 = openid） | 服务端 `IdentityProvider` 校验 | 权威、不可伪造 |
| 资料（展示） | 昵称 / 头像（`UserProfile`） | 客户端上报 | 仅展示，不参与鉴权 |

服务端**只信任自己校验出的身份**，仅接受客户端提供的展示资料。

## 3. 协议（`packages/protocol`）

```ts
interface UserProfile { nickname: string; avatarUrl: string }
// 客户端 → 服务端
{ t: 'auth'; seq: number; token: string; profile?: UserProfile }
// 服务端 → 客户端
{ t: 'authOk'; userId: string; profile: UserProfile }
```

## 4. 服务端

### 4.1 IdentityProvider（`server/src/identity.ts`）

```ts
interface Identity { userId: string; nickname?: string; avatarUrl?: string } // 身份源可自带资料
interface IdentityProvider { authenticate(ctx: { token?; headers? }): Promise<Identity | null> }
```

| 实现 | 身份来源 | 用途 |
|---|---|---|
| `MockIdentity` | `token` 即 `userId` | 本地开发/测试（M-B 默认，`IDENTITY=mock`）|
| `WeChatIdentity` | 握手头 `x-wx-openid` | 微信云托管（`IDENTITY=wechat`，M-K）|
| `TokenIdentity` | `token` → `web:<token>` | Web/HTML5（占位；上线前校验 JWT/会话签名）|

选择：`server/src/index.ts` 的 `pickIdentity(process.env.IDENTITY)`。

### 4.2 登录处理（`server/src/wsGateway.ts` · `case 'auth'`）

```
idn = identity.authenticate({ token, headers })
若 idn 为空 → ack{ ok:false, reason:'鉴权失败' }
否则：
  session.userId = idn.userId
  profile = {
    nickname:  msg.profile?.nickname  ?? idn.nickname  ?? '牌友',
    avatarUrl: msg.profile?.avatarUrl ?? idn.avatarUrl ?? '',
  }
  try:
    store.upsertUser({ openid:idn.userId, nickname, avatarUrl, lastLoginAt: now })  // users 落库
    realtime.saveSession(token, { openid:idn.userId, createdAt:now }, TTL=7天)       // Redis 会话
  catch: 记录日志，不阻断登录（MVP 容错）
  send authOk{ userId:idn.userId, profile }
  send ack{ ok:true }
```

- **持久化可插拔**：`GatewayOptions.persistence?: { store: GameStore; realtime: RealtimeStore }`，缺省用内存实现；`server/src/index.ts` 以 `createPersistence(env)` 注入（设 `DATABASE_URL` + `REDIS_URL` → MySQL + Redis，否则内存）。
- 落库失败不阻断登录，保证弱依赖下仍可进游戏。

### 4.3 会话（Redis）

- key `sess:<token>`，value `{ openid, createdAt }`，TTL 7 天（`SESSION_TTL_SEC`）。
- 用途：鉴权上下文；后续断线重连（M-I 将以「会话 + 房间快照」恢复对局）。
- **MVP 取舍**：直接以客户端 `token` 为会话键。微信 `code` 单次有效，故 M-K/M-I 将改为**服务端签发 session token** 并回传客户端用于重连。

## 5. 客户端（Cocos）

### 5.1 配置与 mock 身份（`client/ac-majong/assets/scripts/app/Config.ts`）

- `SERVER_URL`：本地 `ws://127.0.0.1:8080`（上线改云托管 WSS）。
- `mockIdentity()`：首次生成 `{ token, nickname, avatarUrl }` 并持久化到 `sys.localStorage`，之后复用同一用户 → `users` 表恒一行、每次登录刷新 `lastLoginAt`。真实微信登录将替换此步（M-K）。

### 5.2 网络服务（`.../game/NetService.ts`，单例）

- **幂等** `connect(url, token, profile?)`：已连接则复用同一连接（登录先连，房间/牌桌沿用）；`auth(token, profile)` 后 `waitFor('authOk')`；`onAuth` 回调缓存 `profile`。
- 暴露 `profile` / `userId` / `connected`；`disconnect()` 断连并清会话（返回登录时调用）。

### 5.3 登录页（`.../screens/LoginScreen.ts`）

- 勾选协议联动按钮可用态（`setButtonEnabled`）。
- 点击 → 异步登录：置「登录中…」、防重入（`loggingIn`）；成功 `router.show('lobby')`，失败提示「连接失败，请确认服务端已启动」并恢复按钮。
- `onEnter()` 复位交互态（从大厅返回登录时）。

### 5.4 大厅用户条（`.../screens/LobbyScreen.ts`）

- 读 `NetService.instance.profile / userId`，显示真实昵称、`ID: <userId>`、头像首字。「返回登录」调用 `disconnect()` 后回登录页。

## 6. 数据落库

- `users` 表：`openid`(PK) / `nickname` / `avatar_url` / `created_at` / `last_login_at`。DDL 见 [`../../deploy/schema.sql`](../../deploy/schema.sql)。
- 会话仅在 Redis（不落 MySQL）。存储层契约与实现见[持久化技术方案](./AC麻将-数据持久化与事件溯源.md)。

## 7. 测试与验证

- **网关测试**（`server/test/wsGateway.test.ts`）：`auth` 带 profile → `authOk` 回传资料 + `users` 落库 + 会话建立；不带 profile → 兜底昵称「牌友」仍落库。
- **端到端**（真实 MySQL/Redis）：WS `auth` → `authOk{profile}` → MySQL `users` 落库（昵称 UTF-8 存储校验正确）→ Redis `sess:<token>` 会话。

## 8. 待办与边界

- 真实微信 `wx.login → code2Session`、服务端签发 session token → **M-K**。
- 断线重连恢复登录态与对局 → **M-I**（BL-007 断线重连与托管 UI）。
- `TokenIdentity` 的签名/会话校验 → 上线前。

---

## 维护记录

| 日期 | 概要 |
|---|---|
| 2026-09-16 | 首次产出（补记 M-B 已实现方案）：可插拔 `IdentityProvider`、`auth`/`authOk` + `UserProfile` 协议、登录落库 `users` + Redis 会话、客户端 mock 身份 / NetService 幂等连接 / LoginScreen / LobbyScreen；标注真实 `code2Session` → M-K、重连 → M-I |
| 2026-09-16 | 回填交叉引用：持久化 / 客户端网络层 / 前端基座三份技术方案产出后，将文中「待补」占位链接改为真实相对路径 |
