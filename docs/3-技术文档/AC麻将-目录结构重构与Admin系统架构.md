# A&C 麻将 · 目录结构重构与 Admin 系统架构（技术方案）

> **模块**：monorepo 目录结构（多系统边界）+ Admin 后台系统（`admin-server` / `admin-web`）架构蓝图。
> **关联**：总体架构 [`AC麻将-联机架构方案.md`](./AC麻将-联机架构方案.md)｜持久化 [`AC麻将-数据持久化与事件溯源.md`](./AC麻将-数据持久化与事件溯源.md)（persistence 抽包来源、Admin 读游戏数据入口，§9「admin 全量复用预留」）｜网关房间 [`AC麻将-服务端网关与房间.md`](./AC麻将-服务端网关与房间.md)。
> **产品**：Admin 后台为**新增系统**，其产品 PRD 另行立项（见 §8）；本文档承载「目录重构」与「Admin 技术架构」两部分设计。已定决策：Admin 后端为**独立服务**、**复用同一 MySQL 库（ac_majong）** 并经 `packages/persistence` 读游戏数据。
> 遵循[《文档总纲》](../README.md)三原则。

---

## 1. 背景与目标

- **背景**：现有目录围绕**单一游戏系统**组织（`server/` 游戏网关 + `client/ac-majong` Cocos 客户端 + `packages/` 共享库）。即将启动**后端 Admin 系统**开发，多系统共存使现有平铺结构失去清晰边界。
- **目标**：
  1. 建立「**系统 / 共享库 / 编辑器工程**」三分的顶层边界，使多系统可共存且互不侵入。
  2. 把存储层 `persistence` 从游戏服务端内部**抽为共享包**，作为 Admin 复用游戏数据的唯一正规入口。
  3. 为 Admin（独立后端服务 + 独立 Web 控制台）预留清晰的落位与依赖规则。
- **非目标**：不做微服务大爆炸拆分；不改动 `packages` 现有三层依赖（protocol/engine/client-core）；不改动游戏规则与对局逻辑；不在本次重构中实现 Admin 功能。

## 2. 现状与问题

当前顶层：`packages/`(protocol·engine·client-core) + `server/`(游戏网关，内含 `src/persistence/`) + `client/ac-majong/`(Cocos) + `miniwxapp/`(空壳) + `deploy/` + `docs/` + `scripts/` + `run/`。

| # | 问题 | 后果（Admin 进来后） |
|---|---|---|
| 1 | 无「系统 vs 库」边界：可部署系统 `server/`、共享库 `packages/`、编辑器客户端 `client/` 平铺顶层 | 新增 admin 后端/前端后顶层拥挤、语义混乱 |
| 2 | `persistence/` 锁在 `server` 包内 | Admin 读同库数据只能反向依赖 game-server 内部，耦合方向错误 |
| 3 | workspace 成员含空壳 `miniwxapp`，真客户端 `client/ac-majong` 非成员（靠 `scripts/sync-to-cocos.mjs` 喂养） | 名实不符，多系统后更难排查 |
| 4 | `deploy/` 单服务视角（Dockerfile `COPY server`、compose 单 `server` 服务） | Admin 独立成服务后编排无处安放 |

## 3. 目标目录结构（三分法）

```
ac-majong-new/
├─ apps/                      # 可独立部署的「系统」（系统边界所在）
│  ├─ game-server/            # ← 现 server/：游戏 WS 网关（包名 @ac-majong/game-server）
│  ├─ admin-server/           # 新：Admin 后端（HTTP/REST + RBAC），P2 落地
│  └─ admin-web/              # 新：Admin 控制台 SPA，P2 落地
├─ client/
│  └─ ac-majong/              # Cocos 编辑器工程：保持原样，不进 apps/、不做 pnpm 成员
├─ packages/                  # 跨系统共享库
│  ├─ protocol/  engine/  client-core/      # 保持现有三层依赖，不动
│  └─ persistence/            # ← 新：自 server/src/persistence 抽出（game/admin 共用）
├─ deploy/                    # 按服务拆分编排（game-server / admin-server / admin-web）
├─ docs/  scripts/  run/      # 保持
└─ （删除空壳 miniwxapp/）
```

要点：
- **`apps/` 只放可独立部署的系统**；**`packages/` 只放跨系统共享库**；**`client/` 只放 Cocos 编辑器工程**（编辑器工程非标准 pnpm app，保持独立）。
- `miniwxapp/` 为空壳且非真实同步目标（`sync-to-cocos.mjs` 实际目标为 `client/ac-majong`），予以删除并从 workspace 移除。

## 4. 系统边界与依赖规则

| 依赖方 → 被依赖方 | 允许 | 说明 |
|---|---|---|
| `apps/game-server` → `packages/*` | ✅ | protocol / engine / client-core(dev) / persistence |
| `apps/admin-server` → `packages/persistence`、`packages/protocol`、`packages/engine` | ✅ | 读游戏数据只经 persistence；算分/还原可复用 engine |
| `apps/admin-server` → `apps/game-server` 内部 | ❌ | 严禁跨系统内部依赖 |
| `apps/admin-web` → `apps/admin-server`(REST) | ✅ | 唯一数据通道 |
| `apps/admin-web` → `packages/*` / game-server | ❌ | 控制台不直连游戏链路 |
| `packages/persistence` → `packages/engine`、`packages/protocol` | ✅ | 现状依赖方向保持 |
| `packages/*` → `apps/*` | ❌ | 共享库不得反向依赖系统 |
| `client/ac-majong` → `packages/*`(经 sync 预编译) | ✅ | 现状保持 |

## 5. persistence 共享包设计（P0）

- **新包**：`packages/persistence`，包名 `@ac-majong/persistence`；源码 `src/`（自 `server/src/persistence/` 整体 `git mv`）。
- **依赖**：`@ac-majong/engine`、`@ac-majong/protocol`、`mysql2`、`ioredis`（即现状 persistence 的外部依赖，随包迁移）；devDeps：`typescript`、`vitest`、`@types/node`。
- **导出面**：`createPersistence(env)` 工厂、`GameStore`/`RealtimeStore` 契约、entities、`rehydrate`/`snapshotRound`/`replayRound` 等还原入口（与 [04 持久化](./AC麻将-数据持久化与事件溯源.md) 一致）。
- **测试随包迁移**：`persistence.test.ts`、`persistence.integration.test.ts`（`DB_IT=1` 门控保持）、`rehydrate.test.ts`。
- **game-server 侧改造**：删除内部 `./persistence/*` 引用，改为 `import … from '@ac-majong/persistence'`；`mysql2`/`ioredis` 依赖从 game-server 移除（仅 persistence 使用），保留 `ws`。
- **tsconfig**：包内 `tsconfig.json` 继承 `../../tsconfig.base.json`，与现有包一致。

## 6. Admin 系统架构（蓝图，P2 落地）

### 6.1 admin-server（独立后端服务）
- **形态**：独立 Node + TypeScript **HTTP/REST** 服务（`apps/admin-server`），独立进程/容器，可独立重启而不影响对局。
- **鉴权**：管理员账号 + **RBAC**（会话或 JWT），与玩家侧 `x-wx-openid`/code2Session 身份体系**完全隔离**。
- **数据**：
  - **读游戏数据**：只经 `@ac-majong/persistence`（含 [04 §9](./AC麻将-数据持久化与事件溯源.md) 回放接口「admin 全量复用预留」），不直连 game-server。
  - **自有写表**：同库 `ac_majong` 新增 `admins` / `roles` / `admin_audit_logs` 等管理表（schema 迁移随 Admin 立项产出）。
- **不做**：不持有 WS、不持有 RoomManager、不介入对局实时链路。

### 6.2 admin-web（控制台前端）
- **形态**：独立 SPA（`apps/admin-web`），建议 **React + Vite + TypeScript**（与 monorepo TS 体系一致）；静态构建独立部署。
- **数据**：仅调用 `admin-server` REST；不直连游戏服务端、不引 `packages/client-core`。

### 6.3 部署
- `deploy/` 按服务扩展：`game-server`（现状单实例约束不变）、`admin-server`、`admin-web`(静态)。Admin 与游戏服务**分容器**，互不阻塞。

## 7. 迁移步骤与验证门禁

> 每步一个原子提交；任一步门禁不绿即停止并回滚（`git revert`）。

### P0 · 抽 persistence 共享包
1. 新建 `packages/persistence`（package.json / tsconfig.json）。
2. `git mv server/src/persistence/* → packages/persistence/src/`。
3. game-server 内 `./persistence/*` 引用改 `@ac-majong/persistence`；server/package.json 增该依赖、移除 `mysql2`/`ioredis`。
4. `pnpm install` 更新 lockfile。
- **门禁**：`pnpm -r typecheck && pnpm -r test && pnpm -r build` 全绿。

### P1 · server → apps/game-server + 清 miniwxapp
1. `git mv server apps/game-server`；包名 `@ac-majong/server` → `@ac-majong/game-server`。
2. `pnpm-workspace.yaml`：`'server'` → `'apps/game-server'`；删除 `'miniwxapp'`。
3. 同步硬引用：`run/start-server.sh`（`--filter @ac-majong/game-server`）、`deploy/Dockerfile`（`COPY apps/game-server` + `--filter` 名）、`deploy/docker-compose.prod.yml`（服务/构建上下文）、文档内 `server/` 路径引用、`.gitignore` 路径项。
4. 删除空壳 `miniwxapp/`。
5. `pnpm install`。
- **门禁**：typecheck/test/build 全绿 + `docker compose config` 校验 + `run/start-server.sh` 起服冒烟 + 单人+Bot 打完一局 e2e（验证 persistence 链路未断）。

### P2 · Admin 落地（启动 Admin 开发时）
1. **先产出 Admin 产品 PRD**（新增 `1-prd` 模块）与 admin 表 schema 迁移。
2. 脚手架 `apps/admin-server` + `apps/admin-web`；`deploy/` 增服务。
- **门禁**：Admin 独立起服 + 登录 RBAC + 至少一个只读查询接口打通。

## 8. 与文档先行流程的衔接

- 本 doc 的 **P0/P1 为纯结构重构，不改变产品行为**，故无需 PRD；但执行时须**同批**更新：[00 联机架构方案](./AC麻将-联机架构方案.md) 部署/拓扑章节、[04 持久化](./AC麻将-数据持久化与事件溯源.md) 内 `server/src/persistence` 路径引用、以及各文档维护记录。
- **Admin 功能编码前**必须先立 Admin 产品 PRD（建议 `1-prd` 新增模块「Admin 后台」），本文 §6 仅为其技术蓝图。
- 「什么时候做」的排期统一记入 [`5-backlog/`](../5-backlog/README.md)，不在本文展开。

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| Dockerfile `--filter` 名与新包名不匹配致镜像构建失败 | P1 同步改 `--filter @ac-majong/game-server` 并 `docker build` 验证 |
| lockfile / workspace 成员变更引发解析错误 | 每步 `pnpm install` 后立即 typecheck 门禁 |
| Cocos 同步受影响 | `sync-to-cocos.mjs` 目标为 `packages/*` + `client/ac-majong`，不涉 `server`，P0/P1 不影响 |
| 重构引入隐性行为变化 | P1 门禁含单人+Bot 完整一局 e2e + MySQL 落库抽查 |
| 回滚 | 每步原子提交，`git revert` 单步回退 |

---

## 维护记录

| 日期 | 概要 |
|---|---|
| 2026-09-18 | 首次产出：目录三分法目标结构、系统依赖规则、persistence 抽包设计（P0）、Admin 系统架构蓝图（独立服务 + 同库 ac_majong，P2）、P0/P1/P2 迁移步骤与验证门禁、风险与回滚 |
| 2026-09-18 | **P0/P1 执行完成**：persistence 抽为共享包 `@ac-majong/persistence`（源码+测试随包迁移）；`server`→`apps/game-server`（包名 `@ac-majong/game-server`）；workspace 改 `apps/*` 并清除空壳 miniwxapp；同步 Dockerfile/compose.prod/start-server/.gitignore 与 03/04/06 文档路径。门禁：typecheck/test(64+172+6)/build、compose config(dev+prod)、8082 起服冒烟 全绿 |
