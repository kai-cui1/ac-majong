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
apps/admin-server/src/
├─ index.ts            启动：读 env → createAdminPersistence → build app → listen
├─ app.ts              Fastify 实例装配（插件注册 + 路由挂载 + 错误处理）
├─ config.ts           env 解析（DATABASE_URL/REDIS_URL/SESSION_SECRET/ADMIN_BOOTSTRAP_*/PORT）
├─ plugins/
│  ├─ session.ts       @fastify/cookie + @fastify/session（Redis store）+ @fastify/csrf-protection
│  ├─ auth.ts          decorateRequest：从 session 解析 admin；requireAuth / requireRole preHandler
│  └─ rateLimit.ts     @fastify/rate-limit（登录接口限流）
├─ routes/
│  ├─ auth.ts          登录/登出/me
│  ├─ users.ts         用户查询（只读）
│  ├─ rooms.ts         房间查询（只读）
│  ├─ games.ts         对局查询 + 回放帧（只读）
│  ├─ arbitrations.ts  仲裁录入/编辑（operator+）
│  ├─ admins.ts        管理员账号管理（super）
│  └─ audit.ts         审计日志查询（super）
└─ lib/
   ├─ password.ts      scrypt 哈希/校验（复刻 accountAuth 参数，不跨 app import game-server）
   ├─ audit.ts         withAudit() 切面：写操作成功后落 admin_audit_logs
   └─ replay.ts        逐帧回放：snap+actions → frames[]（服务端 reduce，全信息）
```

### 2.2 `apps/admin-web`（Vite + React）

```
apps/admin-web/src/
├─ main.tsx / App.tsx        入口 + 路由（React Router 6）
├─ api/                      TanStack Query hooks（按后端 REST 一一对应）+ fetch 封装（带 CSRF）
├─ store/                    Zustand：当前管理员 / 角色 / 会话态
├─ layout/                   主框架（侧导航按角色渲染 + 顶栏）
├─ pages/                    login / users / rooms / games / replay / admins / audit
└─ components/replay/        回放播放器（逐帧 + 牌面贴图渲染，贴图复用 tiles 资源）
```

## 3. 数据层（Drizzle，P2-a）

### 3.1 归属与单一入口

- **决策**：Admin 的所有 DB 访问经 `@ac-majong/persistence` 新增的 **admin 命名空间**（`persistence/src/admin/`），由其持有唯一的 Drizzle client 与 mysql2 连接池；`admin-server` **不自持** drizzle/mysql2 依赖，只消费 persistence 暴露的接口。
  - **理由**：① 符合架构 §4「admin 读游戏数据只经 persistence」；② Drizzle schema 与 drizzle-kit 迁移集中在 persistence 一处，避免双 client / 双迁移源；③ 与 P2-b「persistence 整体迁 Drizzle、成为唯一 Drizzle 共享层」前向一致。
  - **代价**：persistence 包增益 admin 领域知识——用 `src/admin/` 子命名空间与独立 `AdminStore` 接口隔离，游戏侧代码不感知。
- persistence 新增导出：`createAdminPersistence(env)` → `{ admin: AdminStore, game: AdminGameQueries, close() }`（复用同一 pool；`AdminGameQueries` 为游戏表只读查询面）。

### 3.2 游戏表只读镜像（`AdminGameQueries`）

- 由 **drizzle-kit `introspect`** 现有 `ac_majong` 库生成 Drizzle schema（`persistence/src/admin/gameSchema.ts`），**只读**、不改现有表结构；写入仍由 `MysqlGameStore`(raw mysql2) 负责，对局落库链路零改动。
- 查询能力（分页 `{items,total,page,size}` + 多条件筛选 + 轻量聚合）：

| 方法 | 说明 |
|---|---|
| `listUsers({q,from,to,page,size})` | q 匹配 openid/昵称（LIKE）；按注册时间筛选 |
| `getUserDetail(openid)` | 资料 + `listRoomsByPlayer` + 参赛对局 + 战绩统计（胡局数/累计台数等，由 games.result 聚合） |
| `listRooms({roomId,host,status,from,to,page,size})` | 房间检索 |
| `getRoomDetail(roomId)` | 房间行 + `listMemberEvents` + `listGames` |
| `listGames({roomId,from,to,page,size})` | 对局检索 |
| `getGameBundle(gameId)` | `getGame` + `getInitialState` + `listActions`（回放/详情用） |

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

- 游戏表：`drizzle-kit introspect` 生成只读镜像 schema（**不产出对游戏表的迁移**，避免误改现网结构）。
- admin 自有表：`drizzle-kit generate` 产出迁移 SQL（`persistence/drizzle/` 下），`migrate` 应用到 `ac_majong`；与现有 `schema.sql` 并存（schema.sql 仍管游戏表，admin 表由 drizzle 管）。
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
| GET | `/api/games/:gameId/replay` | V | — | `{meta, frames[]}`（见 §6） |
| GET | `/api/games/:gameId/arbitrations` | V | — | `Arbitration[]` |
| POST | `/api/games/:gameId/arbitrations` | O | `{status,verdict?,note?}` | `{arbitration}` + audit |
| PATCH | `/api/arbitrations/:id` | O | `{status?,verdict?,note?}` | `{arbitration}` + audit |
| GET | `/api/admins` | S | query `page,size` | 分页 `Admin[]`（不含 pass_hash） |
| POST | `/api/admins` | S | `{username,password,role}` | `{admin}` + audit |
| PATCH | `/api/admins/:id` | S | `{role?,status?,password?}` | `{admin}` + audit |
| GET | `/api/audit` | S | query `adminId,action,targetType,from,to,page,size` | 分页 `AuditLog[]` |
| GET | `/api/audit/:id` | S | — | `AuditLog`（含 before/after） |

## 6. 回放帧服务（`lib/replay.ts`）

- **为何服务端逐帧**：`engine.replayRound(snap, actions)` 是**一次性**返回终态 + 全部事件；播放器需**逐帧**，且 admin-web 不得引 `packages/*`（架构 §4）。故 admin-server 逐动作 reduce，产出帧数组。
- **算法**：`getGameBundle(gameId)` → `toRoundSnapshot(game, initialState)` → `rehydrate(snap)` 得初始态 → 依次 `applyAction(state, action)`，每步捕获一帧。
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

- **前端**：`components/replay/` 用牌面贴图（复用 `client/ac-majong/assets/resources/tiles`）渲染 `state`；播放器控制帧游标（前进/后退/跳转/播放）。数据量：一局约百~数百帧，单帧全信息，响应体约数百 KB，可接受；如需再做增量/压缩优化。

## 7. 审计切面（`lib/audit.ts`）

- `withAudit(req, {action,targetType,targetId,before?,after?}, fn)`：执行 `fn`，成功/失败均落 `admin_audit_logs`（含 admin、ip、result）。
- **覆盖**：login/logout、arbitration.create/update、admin.create/update、（bootstrap）。**只读查询不记审计**（一期）。
- 查询：`GET /api/audit`（super），按 admin/action/target/时间筛选。

## 8. 配置与部署

- **环境变量**（admin-server）：`PORT`、`DATABASE_URL`、`REDIS_URL`、`SESSION_SECRET`、`SESSION_TTL_SEC`、`ADMIN_BOOTSTRAP_USERNAME`、`ADMIN_BOOTSTRAP_PASSWORD`、`LOG_LEVEL`。
- **部署**：三容器（game-server / admin-server / admin-web 静态）；**nginx 同源反代**——同域下 `/` → admin-web 静态、`/api` → admin-server，使会话 cookie 同源（免跨域/SameSite 麻烦）。admin 不挂微信云托管公网默认域名，走内网 / IP 白名单 / 独立域名 + HTTPS（呼应 BL-009 合规）。
- **CSP/CORS**：同源无需宽松 CORS；`@fastify/cors` 仅放行同源；生产强制 HTTPS + `Secure`/`HttpOnly`/`SameSite=Lax` cookie。

## 9. 门禁与验收（P2-a）

- `pnpm -r typecheck && pnpm -r test && pnpm -r build` 全绿。
- admin-server 独立起服；drizzle migrate 建 admin 三表；bootstrap 超管可登录。
- 登录 → RBAC 拦截（viewer 访问 `/api/admins` 得 403）→ 一个只读查询（`/api/users`）打通 → 一局 `/api/games/:id/replay` 返回帧序列 → 一条仲裁录入 + 审计留痕。
- **不触碰对局链路**：game-server e2e（单人+Bot 完整一局）保持绿，验证 P2-a 未改游戏写路径。

---

## 维护记录

| 日期 | 概要 |
|---|---|
| 2026-09-19 | 首次产出（BL-015 Admin 一期技术方案细化）：依据 PRD 10 与架构 §6 选型，落定 admin-server/admin-web 服务结构；数据层 Drizzle P2-a（游戏表 introspect 只读镜像 + admin 自有表迁移，统一经 persistence admin 命名空间单一入口）；admins/arbitrations/admin_audit_logs 三表结构；Session(Redis)+RBAC+CSRF+登录限流+超管 bootstrap；REST API 契约（auth/users/rooms/games/replay/arbitrations/admins/audit，权限 V/O/S）；回放帧服务（服务端逐动作 reduce、全信息、帧结构）；审计切面；配置/三容器/nginx 同源部署；P2-a 门禁（不触碰对局链路）|
