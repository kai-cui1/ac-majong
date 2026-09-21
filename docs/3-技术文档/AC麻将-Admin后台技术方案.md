# A&C 麻将 · Admin 后台技术方案（schema + API 契约）

> **模块**：Admin 后台（`apps/admin-server` + `apps/admin-web`）的落地技术设计——数据层（Drizzle P2-a）、表结构、REST API 契约、Session/RBAC、回放帧服务、审计切面。
> **关联**：架构蓝图与技术栈选型 [`AC麻将-目录结构重构与Admin系统架构.md`](./AC麻将-目录结构重构与Admin系统架构.md) §6｜产品需求 [`../1-prd/10-Admin后台.md`](../1-prd/10-Admin后台.md)｜数据源 [`AC麻将-数据持久化与事件溯源.md`](./AC麻将-数据持久化与事件溯源.md)｜引擎回放 [`AC麻将-对局流程引擎.md`](./AC麻将-对局流程引擎.md)（`replayRound`/`rehydrate`）｜排期 [`../5-backlog/README.md`](../5-backlog/README.md) BL-015。
> 遵循[《文档总纲》](../README.md)三原则。本文承载 Admin **一期（P2-a）**技术细节；架构层大方向以 §6 蓝图文档为准。

---

## 1. 目标与范围

- **落地** PRD [10-Admin后台](../1-prd/10-Admin后台.md) 一期：管理员鉴权角色 + 用户查询 + 房间/对局查询 + 回放仲裁 + 审计日志。
- **技术栈**（已选型，见架构 §6）：admin-server = Fastify 5 + zod + Session/Redis + RBAC；admin-web = Vite + React 18 + TS + AntD 5 + TanStack Query；数据层 = Drizzle ORM（P2-a：仅 admin 用，游戏表只读、写入仍由现有 persistence raw mysql2 负责）。
- **不在本文**：二期看板/运营配置/用户处置；admin-web 高保真原型（交互设计阶段另出）；P2-b（persistence 整体迁 Drizzle）。

## 2. 服务结构

### 2.1 `apps/admin-server`（Fastify）

```
apps/admin-server/
├─ .env.example / package.json / tsconfig.json / vitest.config.ts
└─ src/
   ├─ index.ts         启动：loadConfig → createAdminPersistence → bootstrap 超管 → buildApp → listen
   ├─ app.ts           buildApp(deps)：插件装配（cookie/session/csrf/rate-limit）+ 全局 CSRF 钩子 + 路由挂载 + 错误处理（依赖注入，便于 inject 测试）
   ├─ config.ts        env → AdminConfig（DATABASE_URL/REDIS_URL/SESSION_SECRET/PORT/CSRF_ENABLED/RATE_LIMIT_ENABLED/COOKIE_SECURE/ADMIN_BOOTSTRAP_*）
   ├─ logger.ts        轻量结构化日志（同 game-server）
   ├─ deps.ts          AppDeps（config/admin/game/replay）+ AdminSession 类型
   ├─ augments.ts      fastify 类型增强（Session.admin / FastifyRequest.admin / FastifyInstance.deps）
   ├─ lib/
   │  ├─ password.ts   scrypt 哈希/校验（复刻 accountAuth 参数，不跨 app import）
   │  ├─ rbac.ts        requireAuth / requireRole（角色层级 super>operator>viewer）
   │  ├─ sessionStore.ts Redis 会话存储（实现 @fastify/session 回调式 store）
   │  ├─ audit.ts       withAudit() 切面：写操作成败均落 admin_audit_logs
   │  ├─ errors.ts      HttpError + 统一错误信封 + ZodError/4xx 处理
   │  ├─ replay.ts      ReplayService：buildReplayBundle → 逐帧 reduce（全信息）+ 导出 bundle
   │  └─ query.ts        分页/时间范围 zod 公共片段
   └─ routes/
      ├─ auth.ts        登录/登出/me（FR-Admin-01）
      ├─ users.ts       用户查询（只读，FR-Admin-04）
      ├─ rooms.ts       房间查询（只读，FR-Admin-05）
      ├─ games.ts       对局查询 + 回放帧 + 导出回放包 + 仲裁录入/编辑（FR-Admin-05/06/08）
      ├─ admins.ts      管理员账号管理（super，FR-Admin-03）
      └─ audit.ts       审计日志查询（super，FR-Admin-07）
```

> 实现约定：插件注册集中在 `app.ts`（未单列 `plugins/`）；仲裁路由并入 `games.ts`（按局录入 `POST /api/games/:id/arbitrations` + 按 id 编辑 `PATCH /api/arbitrations/:id`）；路由直接注册到根上下文（使根上 CSRF/限流 hook 一致生效）。

### 2.2 `apps/admin-web`（Vite + React）

```
apps/admin-web/
├─ index.html / package.json / tsconfig.json / vite.config.ts（dev proxy /api→8090）
└─ src/
   ├─ main.tsx           入口：ConfigProvider(theme) + RouterProvider
   ├─ App.tsx            QueryClientProvider + AntD App（message 上下文）+ 启动 restore()
   ├─ router.tsx         createBrowserRouter：/login + AppLayout 子路由（users / rooms / replay[/:gameId] / admins / audit）
   ├─ theme.ts           AntD ConfigProvider token（对齐原型：#1677ff / radius 6 / 深色侧栏 #001529 / header 56px）
   ├─ index.css          全局样式（page-title / page-desc / mono / muted / brand-tile 等原型类）
   ├─ api/
   │  ├─ types.ts        DTO（对齐后端 REST 响应）
   │  ├─ client.ts       fetch 封装（credentials:include + 写操作带 x-csrf-token + ApiError）
   │  └─ hooks.ts        TanStack Query hooks（按后端一一对应）+ downloadReplayBundle
   ├─ store/auth.ts      Zustand：admin / role / csrfToken / ready + login/logout/restore + hasRole
   ├─ layout/AppLayout.tsx 主框架：固定深色 Sider（分组菜单按角色渲染）+ Header（面包屑 / env / 管理员 / 登出）+ Outlet
   └─ pages/             Login / Users / Rooms / Replay / Admins / Audit（6 页；对局并入 Rooms，无独立 Games 页）
```

> 实现约定：**回放播放器内聚在 `pages/Replay.tsx`**（未单列 `components/replay/`）——逐帧游标 + 牌面渲染 + 动作序列 + 仲裁面板同页；牌面用 **Unicode 麻将牌区**（U+1F000..，与原型 `replay.html` 同款）而非 tiles 贴图，避免 admin-web 引客户端资源（架构 §4）。**「房间 / 对局」合并为 `Rooms.tsx` 一页**（局列表在房间详情抽屉内，点「回放」跳 `/replay/:gameId`），无独立 Games 页。admin-web 不 import `packages/*`，仅经 REST 消费后端。

## 3. 数据层（Drizzle，P2-a）

### 3.1 归属与单一入口

- **决策**：Admin 的所有 DB 访问经 `@ac-majong/persistence` 新增的 **admin 命名空间**（`persistence/src/admin/`），由其持有唯一的 Drizzle client 与 mysql2 连接池；`admin-server` **不自持** drizzle/mysql2 依赖，只消费 persistence 暴露的接口。
  - **理由**：① 符合架构 §4「admin 读游戏数据只经 persistence」；② Drizzle schema 与 drizzle-kit 迁移集中在 persistence 一处，避免双 client / 双迁移源；③ 与 P2-b「persistence 整体迁 Drizzle、成为唯一 Drizzle 共享层」前向一致。
  - **代价**：persistence 包增益 admin 领域知识——用 `src/admin/` 子命名空间与独立 `AdminStore` 接口隔离，游戏侧代码不感知。
- persistence 新增导出：`createAdminPersistence(env)` → `{ db, admin: AdminStore, game: AdminGameQueries, close() }`（唯一 mysql2 pool + Drizzle client；`admin` 为自有表读写、`game` 为游戏表只读检索面）。**admin 仅 MySQL、无 DATABASE_URL 直接报错（不回落内存）**。
- 已落地文件布局（`packages/persistence/src/admin/`）：`schema.ts`（admin 自有 3 表、唯一迁移源）、`gameSchema.ts`（游戏 6 表只读镜像）、`types.ts`（AdminStore/AdminGameQueries 契约 + 分页/筛选类型）、`adminStore.ts`（`DrizzleAdminStore`）、`gameQueries.ts`（`DrizzleAdminGameQueries` + `DrizzleReplaySource`）、`index.ts`（`createAdminPersistence`）。

### 3.2 游戏表只读镜像（`AdminGameQueries`）

- 游戏 6 表的 Drizzle **只读镜像**（`persistence/src/admin/gameSchema.ts`）手写对齐 `deploy/schema.sql`（等价 introspect 结果，但手写避免 introspect 漂移/误产迁移），**不改现有表结构、不产迁移**；写入仍由 `MysqlGameStore`(raw mysql2) 负责，对局落库链路零改动。
- 查询能力（分页 `{items,total,page,size}` + 多条件筛选 + 轻量聚合，已实现）：

| 方法 | 说明 |
|---|---|
| `queryUsers({q,from,to,page,size})` | q 匹配 openid/昵称（LIKE）；按注册时间筛选 |
| `getUserDetail(openid)` | 资料 + 房主/参赛房间 + 该等房间对局（后续可扩战绩统计） |
| `queryRooms({roomId,host,status,from,to,page,size})` | 房间检索；批量补房主昵称 + 局数（`RoomSummary`，免 N+1） |
| `getRoomDetail(roomId)` | 房间行 + 成员进出事件 + 局列表 |
| `queryGames({roomId,from,to,page,size})` | 对局检索；附动作数（`GameSummary`） |
| `getGameDetail(gameId)` | 对局行 + 动作数 |
| `replaySource()` | 返回 `DrizzleReplaySource`（实现 `ReplaySource` 6 读方法），供 `buildReplayBundle` 组装回放帧/导出包 |

### 3.3 admin 自有表（`AdminStore`，Drizzle 定义 + 迁移）

**`admins`**（管理员账号；一期角色用枚举列，不单设 roles 表）

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT AI PK | |
| username | VARCHAR(32) UNIQUE NOT NULL | 登录名 |
| pass_hash | VARCHAR(255) NOT NULL | scrypt `s$<saltHex>$<hashHex>`（同 accountAuth 参数 N=16384 r=8 p=1） |
| role | ENUM('super','operator','viewer') NOT NULL | RBAC 三档 |
| status | ENUM('active','disabled') NOT NULL DEFAULT 'active' | 停用即禁登录 |
| created_at | DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) | |
| last_login_at | DATETIME(3) NULL | |
| updated_at | DATETIME(3) ON UPDATE CURRENT_TIMESTAMP(3) | |

**`arbitrations`**（仲裁记录；纯留痕，不回写游戏数据）

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT AI PK | |
| game_id | VARCHAR(24) NOT NULL | 关联对局（`{roomId}:{roundNo}`） |
| admin_id | BIGINT NOT NULL | 录入管理员（FK admins.id，逻辑外键） |
| status | ENUM('pending','accepted','rejected','resolved') NOT NULL DEFAULT 'pending' | 受理状态 |
| verdict | VARCHAR(32) NULL | 结论分类（如 valid/invalid/adjust_offline） |
| note | TEXT NULL | 结论备注（自由文本，含线下处理说明） |
| created_at / updated_at | DATETIME(3) | |
| — | KEY idx_game(game_id)、idx_admin(admin_id) | |

**`admin_audit_logs`**（审计流水；记所有管理员写操作）

| 列 | 类型 | 说明 |
|---|---|---|
| id | BIGINT AI PK | |
| admin_id | BIGINT NULL | 登录失败时可空 |
| admin_username | VARCHAR(32) NULL | 冗余便于检索 |
| action | VARCHAR(48) NOT NULL | login / logout / arbitration.create / arbitration.update / admin.create / admin.update … |
| target_type | VARCHAR(32) NULL | user / room / game / arbitration / admin |
| target_id | VARCHAR(64) NULL | |
| before_json | JSON NULL | 变更前（更新类） |
| after_json | JSON NULL | 变更后 / 提交内容 |
| ip | VARCHAR(64) NULL | |
| result | ENUM('success','fail') NOT NULL DEFAULT 'success' | |
| at | DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) | |
| — | KEY idx_admin_time(admin_id,at)、idx_action(action)、idx_at(at) | |

### 3.4 迁移策略（P2-a）

- 游戏表：手写只读镜像 `gameSchema.ts`（drizzle.config **不指向它**），**不产出对游戏表的迁移**，避免误改现网结构。
- admin 自有表：drizzle.config `schema` 只指 `src/admin/schema.ts`；`drizzle-kit generate` 已产出 **`persistence/drizzle/0000_admin_init.sql`**（admins/arbitrations/admin_audit_logs 三表 + 索引），`db:migrate` 应用到 `ac_majong`；与现有 `schema.sql` 并存（schema.sql 仍管游戏表，admin 表由 drizzle 管）。
- P2-b 再统一：schema.sql 退役、游戏表迁移源并入 drizzle-kit、生产库 baseline。

## 4. 鉴权与会话（Session + RBAC）

- **插件**：`@fastify/cookie` + `@fastify/session`（**store = Redis**，复用现有 ioredis；session TTL 建议 8h，空闲滑动）+ `@fastify/csrf-protection`（cookie 会话必备，写操作校验 CSRF token）。
- **session 数据**：`{ adminId, username, role }`；`request.admin` 由此 decorate。
- **密码**：`lib/password.ts` 复刻 `accountAuth` 的 scrypt 参数（跨 app 不 import game-server，见架构 §4 禁令）。
- **首个超管 bootstrap**：启动时若 `admins` 为空且配置了 `ADMIN_BOOTSTRAP_USERNAME/PASSWORD`，自动创建 super 账号（并记 audit `admin.bootstrap`）。
- **RBAC 中间件**：`requireAuth`（未登录 401）+ `requireRole(...roles)`（角色不足 403）作为路由 `preHandler`；角色层级 super > operator > viewer。
- **登录限流**：`@fastify/rate-limit` 对 `POST /api/auth/login`（如 5 次/分/IP），失败记 audit（result=fail）。

## 5. REST API 契约

**通用约定**
- 前缀 `/api`（nginx 同源反代：`/api` → admin-server）。
- 认证：会话 cookie（同源）；**写操作**（POST/PATCH/DELETE）需带 CSRF header（`@fastify/csrf-protection` 约定）。
- 分页响应：`{ items: T[], total: number, page: number, size: number }`。
- 错误信封：`{ error: { code: string, message: string } }`；HTTP 状态码 400/401/403/404/429/500。
- 权限列：**V**=viewer、**O**=operator、**S**=super（含关系：S⊇O⊇V）。

| Method | Path | 权限 | 请求 | 响应 |
|---|---|---|---|---|
| POST | `/api/auth/login` | 公开 | `{username,password}` | `{admin:{id,username,role}}` + set-cookie；CSRF token |
| POST | `/api/auth/logout` | V | — | `{ok:true}`（清会话） |
| GET | `/api/auth/me` | V | — | `{admin:{id,username,role}}` |
| GET | `/api/users` | V | query `q,from,to,page,size` | 分页 `UserSummary[]` |
| GET | `/api/users/:openid` | V | — | `{profile, rooms[], games[], stats}` |
| GET | `/api/rooms` | V | query `roomId,host,status,from,to,page,size` | 分页 `RoomSummary[]` |
| GET | `/api/rooms/:roomId` | V | — | `{room, memberEvents[], games[]}` |
| GET | `/api/games` | V | query `roomId,from,to,page,size` | 分页 `GameSummary[]` |
| GET | `/api/games/:gameId` | V | — | `{game, initialState(摘要), actionCount, result}` |
| GET | `/api/games/:gameId/replay` | V | — | `{meta, frames[]}`（ReplayBundle 逐帧，见 §6） |
| GET | `/api/games/:gameId/replay-bundle` | O | — | 下载 `ReplayBundle` JSON（申诉取证，BL-024，见 §6/§10.1） |
| GET | `/api/games/:gameId/arbitrations` | V | — | `Arbitration[]` |
| POST | `/api/games/:gameId/arbitrations` | O | `{status,verdict?,note?}` | `{arbitration}` + audit |
| PATCH | `/api/arbitrations/:id` | O | `{status?,verdict?,note?}` | `{arbitration}` + audit |
| GET | `/api/admins` | S | query `page,size` | 分页 `Admin[]`（不含 pass_hash） |
| POST | `/api/admins` | S | `{username,password,role}` | `{admin}` + audit |
| PATCH | `/api/admins/:id` | S | `{role?,status?,password?}` | `{admin}` + audit |
| GET | `/api/audit` | S | query `adminId,action,targetType,from,to,page,size` | 分页 `AuditLog[]` |
| GET | `/api/audit/:id` | S | — | `AuditLog`（含 before/after） |

## 6. 回放帧服务（`lib/replay.ts`）

> **统一数据契约 = ReplayBundle（BL-024）**：Admin 回放与「导出回放包」共用 `@ac-majong/persistence` 的 `buildReplayBundle`（见 §10.1）。服务端先 `buildReplayBundle(gameId)` 得自包含 bundle（snapshot 自带墙 + actions + settings/seating/names），再逐帧 reduce 供播放器；「导出回放包」直接返回该 bundle JSON。

- **为何服务端逐帧**：`engine.replayRound(snap, actions)` 是**一次性**返回终态 + 全部事件；播放器需**逐帧**，且 admin-web 不得引 `packages/*`（架构 §4）。故 admin-server 逐动作 reduce，产出帧数组。
- **算法**：`buildReplayBundle(gameId)`（persistence，见 §10.1）→ `rehydrate(bundle.snapshot)` 得初始态 → 依次 `applyAction(state, bundle.actions[i])`，每步捕获一帧（snapshot 自带整副墙，确定性重演无需 seed）。
- **全信息**：admin 为特权方，**不做防透视裁剪**——每帧含各家 `concealed`（暗牌明细）、`melds`、`flowers`、`score`、`zi`、`wallRemaining`、`discards`、`currentSeat`、`phase`，便于仲裁看清全貌。
- **帧结构**（`GET /api/games/:gameId/replay`）：

```jsonc
{
  "meta": { "gameId": "R123:1", "roomId": "R123", "roundNo": 1, "dealerSeat": 0,
            "names": ["A","B","C","D"], "endType": "win", "result": {/* 结算明细 */} },
  "frames": [
    { "seq": 0, "action": null,               "events": [], "state": {/* 初始态，全信息 */} },
    { "seq": 1, "action": {"type":"discard","seat":0,"tile":"W5"}, "events": ["discarded","responseNeeded"], "state": {/* … */} }
    // …每个动作一帧
  ]
}
```

- **前端**：`pages/Replay.tsx` 用 **Unicode 麻将牌区**（U+1F000..，与原型 `replay.html` 同款，不引客户端 tiles 资源）渲染 `state`；播放器控制帧游标（前进 / 后退 / 跳转 / 播放 / 自动播）+ 动作序列点选跳帧 + 仲裁录入面板（operator+）+ 导出回放包按钮。数据量：一局约百~数百帧，单帧全信息，响应体约数百 KB，可接受；如需再做增量/压缩优化。

## 7. 审计切面（`lib/audit.ts`）

- `withAudit(req, {action,targetType,targetId,before?,after?}, fn)`：执行 `fn`，成功/失败均落 `admin_audit_logs`（含 admin、ip、result）。
- **覆盖**：login/logout、arbitration.create/update、admin.create/update、（bootstrap）。**只读查询不记审计**（一期）。
- 查询：`GET /api/audit`（super），按 admin/action/target/时间筛选。

## 8. 配置与部署

- **环境变量**（admin-server）：`PORT`、`DATABASE_URL`、`REDIS_URL`、`SESSION_SECRET`、`SESSION_TTL_SEC`、`ADMIN_BOOTSTRAP_USERNAME`、`ADMIN_BOOTSTRAP_PASSWORD`、`LOG_LEVEL`、`CSRF_ENABLED`、`RATE_LIMIT_ENABLED`、`COOKIE_SECURE`。
- **起服约定**：monorepo 内 `@ac-majong/persistence` 的 `exports` 指向 **TS 源码**（`./src/index.ts`），故 admin-server 与 game-server 一律经 **tsx** 起服（`node dist` 无法解析 TS 依赖）；`pnpm --filter @ac-majong/admin-server start` = `tsx --env-file-if-exists=.env src/index.ts`（自动载入 `.env`）。**本地冒烟流程**：`cd deploy && docker compose up -d`（首启自动执行 `schema.sql` 建游戏表）→ `pnpm --filter @ac-majong/persistence db:migrate`（建 admin 三表）→ `cp .env.example .env` → `pnpm --filter @ac-majong/admin-server start`（bootstrap 超管）→ `pnpm --filter @ac-majong/admin-web dev`（vite，dev proxy `/api`→8090）。P2-b 待 persistence 产 dist + 修 exports 后可统一回 `node dist`。
- **部署**：三容器（game-server / admin-server / admin-web 静态）；**nginx 同源反代**——同域下 `/` → admin-web 静态、`/api` → admin-server，使会话 cookie 同源（免跨域/SameSite 麻烦）。admin 不挂微信云托管公网默认域名，走内网 / IP 白名单 / 独立域名 + HTTPS（呼应 BL-009 合规）。
- **CSP/CORS**：同源无需宽松 CORS；`@fastify/cors` 仅放行同源；生产强制 HTTPS + `Secure`/`HttpOnly`/`SameSite=Lax` cookie。

## 9. 门禁与验收（P2-a）

- `pnpm -r typecheck && pnpm -r test && pnpm -r build` 全绿。
- admin-server 独立起服；drizzle migrate 建 admin 三表；bootstrap 超管可登录。
- 登录 → RBAC 拦截（viewer 访问 `/api/admins` 得 403）→ 一个只读查询（`/api/users`）打通 → 一局 `/api/games/:id/replay` 返回帧序列 → 一条仲裁录入 + 审计留痕。
- **不触碰对局链路**：game-server e2e（单人+Bot 完整一局）保持绿，验证 P2-a 未改游戏写路径。

## 10. 关联可维护性能力（BL-022 / BL-023 / BL-024）

> 与技术方案《[可维护性与诊断](./AC麻将-可维护性与诊断.md)》联动。这些能力原长在 game-server（`diag.ts` + dev HTTP），Admin 复用需处理「跨 app 不 import」与「admin 不介入实时链路」两条边界。

### 10.1 BL-024 回放包（**一期**，已纳入 BL-015）
- **`buildReplayBundle` 下沉 persistence**：从 `apps/game-server/src/diag.ts` 移到 `@ac-majong/persistence`（仅依赖 `GameStore` + engine 类型，下沉无副作用），game-server 与 admin-server 共用；消除 Admin 跨 app import 障碍（架构 §4）。入参已由整个 `GameStore` **收窄为 `ReplaySource`**（= `Pick<GameStore, 6 个读方法>`），使 admin 的 `DrizzleReplaySource`（只读）也能直接喂入；game-server 传 `MysqlGameStore` 结构上仍满足。
- **导出回放包**：`GET /api/games/:gameId/replay-bundle`（operator+）返回自包含、离线可确定性重演的 `ReplayBundle`（含 settings/seating/names/snapshot/actions），供申诉取证下载。
- **统一契约**：Admin 回放播放器与导出共用同一 bundle；玩家侧 BL-024 导出 UI 待补期间，Admin 导出即为运营即时取证通道。

### 10.2 BL-023 客户端诊断包受理（**二期**）
- Admin 新增「诊断包受理/解析」面：运营粘贴玩家复制的诊断包 JSON（`{errors:[{at,msg,stack,ctx,ring}]}`）→ 结构化展示（现场 ctx：screen/room/round/phase/cur/mySeat + 消息环 ring + 报错栈）→ 凭 `ctx.room`/`ctx.round` 一键跳「回放仲裁」定位对应局。
- **纯解析、无上报管线**（低成本）；「客户端自动上报→入库→Admin 列表」为更重的后续档，涉及隐私/存储，另议。

### 10.3 BL-022 实时房间监控（**二期**，需受控跨系统调用）
- **需求**：运营对 `status=playing` 的卡顿房，查看 `inspect()` 实时态（在等谁 / legalBySeat / stall.idleMs / seating 演示阶段）——这些是 game-server 内存态，MySQL 无。
- **通道（已定：内网鉴权端点）**：game-server 暴露一个**内网、鉴权、只读**的 inspect 端点（如 `GET /internal/rooms/:id/inspect`，共享密钥/mTLS + 仅内网可达），admin-server **服务端**调用后转呈前端；不复用 dev-only 无鉴权 `/dev/*`（生产不开）。
- **边界修订**：这是对「admin 不介入实时链路」的**受控例外**——仅只读、网络隔离、独立鉴权、调用记审计；admin 仍不持有 WS/RoomManager、不写实时态。见架构文档 §4 依赖规则修订。
- **降级**：game-server 不可达/房已回收时，回退展示 MySQL 已落库事实（rooms.status/member_scores）并标注「实时态不可用」。

---

## 维护记录

| 日期 | 概要 |
|---|---|
| 2026-09-19 | 首次产出（BL-015 Admin 一期技术方案细化）：依据 PRD 10 与架构 §6 选型，落定 admin-server/admin-web 服务结构；数据层 Drizzle P2-a（游戏表 introspect 只读镜像 + admin 自有表迁移，统一经 persistence admin 命名空间单一入口）；admins/arbitrations/admin_audit_logs 三表结构；Session(Redis)+RBAC+CSRF+登录限流+超管 bootstrap；REST API 契约（auth/users/rooms/games/replay/arbitrations/admins/audit，权限 V/O/S）；回放帧服务（服务端逐动作 reduce、全信息、帧结构）；审计切面；配置/三容器/nginx 同源部署；P2-a 门禁（不触碰对局链路）|
| 2026-09-21 | 关联可维护性能力（新增 §10）：**BL-024 回放包纳入一期**——`buildReplayBundle` 下沉 `@ac-majong/persistence` 供 game/admin 共用、新增 `GET /api/games/:id/replay-bundle`（operator+）导出取证、§6 回放统一到 ReplayBundle 契约；**BL-023 诊断包受理**列二期（粘贴解析→跳回放，无上报管线）；**BL-022 实时房间监控**列二期，通道定为 game-server 内网鉴权只读 inspect 端点（admin 服务端调用，受控例外，记审计，含降级）。同步修订架构 §4 依赖规则与《可维护性与诊断》 |
| 2026-09-21 | **P2-a 数据层落地**（编码）：`buildReplayBundle` 已下沉 `persistence/src/replayBundle.ts`（入参收窄 `ReplaySource`）、game-server `diag.ts`/`wsGateway.ts` 改引 persistence；新增 `persistence/src/admin/`（schema/gameSchema/types/adminStore/gameQueries/index）与 `createAdminPersistence`；`drizzle-kit generate` 产出 `drizzle/0000_admin_init.sql`（三表）；admin.integration.test（DB_IT 门控）。门禁：typecheck 全 Done / engine179 client-core100 game-server115 persistence8+7skip / persistence build 声明产出正常。§3.1-3.4 写实至实现 |
| 2026-09-21 | **P2-a admin-server 脚手架落地**（编码）：新建 `apps/admin-server`（Fastify 5 + @fastify/cookie/session(Redis store)/csrf-protection/rate-limit + zod）；`buildApp(deps)` 依赖注入；lib（password scrypt / rbac / sessionStore / audit / errors / replay / query）+ routes（auth/users/rooms/games[含回放帧·导出包·仲裁]/admins/audit）；index.ts bootstrap 超管 + 优雅退出；.env.example。inject 集成测 8 例全绿（健康/登录成败/401/RBAC 403·200/回放帧/导出包权限/仲裁+审计）。门禁：全量 typecheck 6 包 Done / test engine179 persistence8+7skip client-core100 admin-server8 game-server117 / build 4 包 Done。§2.1 写实至实现 |
| 2026-09-21 | **P2-a admin-web 脚手架落地**（编码）：新建 `apps/admin-web`（Vite 6 + React 18 + AntD 5 + TanStack Query v5 + Zustand + React Router 6）；`api/`（types / client[带 CSRF] / hooks）+ `store/auth` + `layout/AppLayout`（固定深色侧栏、分组菜单按角色渲染）+ `pages/`（Login/Users/Rooms/Replay/Admins/Audit 6 页，**对局并入 Rooms**、无独立 Games 页）+ `theme.ts`/`index.css` 对齐原型 token；**回放播放器内聚 `pages/Replay.tsx`**（逐帧游标 + 动作序列点选 + 仲裁录入 + 导出回放包），牌面用 **Unicode 麻将牌区**（非 tiles 贴图、不单列 `components/replay/`）。后端收尾：users 剥离 passHash、`/me` 补发 csrfToken（供刷新后写操作）。门禁：全量 typecheck **7 项目** Done / test engine179·persistence8+7skip·client-core100·admin-server8·game-server117 / build 全 Done（**admin-web vite build** 产出 dist）。§2.2/§6 写实至实现；**users.html / rooms.html 原型同批对齐**（用户表移除每行 房间数/对局数/累计台数 并入抽屉、房间详情改抽屉；累计台数/赢家台数/仲裁标记/玩法参数等富字段标注归 **P2-b** 聚合，P2-a 只读镜像不算聚合） |
