# 技术文档 · 索引

> **职责**：定义技术「怎么实现」。遵循[《文档总纲》](../README.md)三原则（分模块成文件 / 全量说明不打补丁 / 文末维护记录）。
> 产品需求见 [`../1-prd/`](../1-prd/README.md)；业务基线见 [`../0-业务规则/AC麻将游戏规则说明书.md`](../0-业务规则/AC麻将游戏规则说明书.md)。
> **命名**：统一 `AC麻将-<模块>.md`。

## 文档清单

| 序 | 文档 | 覆盖模块 | 状态 |
|---|---|---|---|
| 00 | [AC麻将-联机架构方案.md](./AC麻将-联机架构方案.md) | 总体架构：服务端权威模型 / 通信协议 / 房间服务 / 部署 / 存储概览 | ✅ 已有 |
| 01 | [AC麻将-台数计算规格书.md](./AC麻将-台数计算规格书.md) | 引擎算分：牌张编码 / 胡牌判定 / 番种识别 / 台数与必然包含去重 / 结算 | ✅ 已有 |
| 02 | [AC麻将-对局流程引擎.md](./AC麻将-对局流程引擎.md) | `TableState` / `reducer` 状态机 / `Action`·`GameEvent` / 续局相位守卫 / `rehydrate` 还原 | ✅ 已补（M0 / 续局 / M-A2） |
| 03 | [AC麻将-服务端网关与房间.md](./AC麻将-服务端网关与房间.md) | `wsGateway` / `roomActor` / `roomManager` / `redact` 防透视 / `identity` / `devBots` | ✅ 已补（t8） |
| 04 | [AC麻将-数据持久化与事件溯源.md](./AC麻将-数据持久化与事件溯源.md) | 存储分层 / 6 表 schema / Redis 热存储 / 事件溯源落库与还原 / Repository 契约 | ✅ 已补（M-A2） |
| 05 | [AC麻将-前端基座与设计系统.md](./AC麻将-前端基座与设计系统.md) | `Theme` 设计令牌 / `UiKit` 组件工厂 / `SceneRouter` / `App` / `Screen` | ✅ 已补（M-A） |
| 06 | [AC麻将-登录鉴权.md](./AC麻将-登录鉴权.md) | `identity` 可插拔 / auth 流程 / `UserProfile` / `users` 落库 / Redis 会话 | ✅ 已补（M-B） |
| 07 | [AC麻将-客户端网络层.md](./AC麻将-客户端网络层.md) | client-core `GameClient` / `Transport` / `NetService` / vendor 预编译同步 | ✅ 已补 |
| 08 | [AC麻将-目录结构重构与Admin系统架构.md](./AC麻将-目录结构重构与Admin系统架构.md) | monorepo 三分法（apps/packages/client）/ persistence 抽包 / Admin 独立服务蓝图与技术栈选型 / P0-P2 迁移 | ✅ P0/P1 已执行（P2 Admin 立项中）|
| 09 | [AC麻将-Admin后台技术方案.md](./AC麻将-Admin后台技术方案.md) | Admin 一期落地：Drizzle P2-a 数据层 / admin 自有表 schema / Session+RBAC / REST API 契约 / 回放帧服务 / 审计切面 | ✅ 已定稿（待编码）|

> **说明**：02–07 为「文档先行」规范下补充的模块技术方案，覆盖当前已开发模块（对局引擎 / 网关房间 / 持久化 / 前端基座 / 登录 / 网络层），均已产出。架构方案（00）§11 为存储**概览**，落地细节以 [04 数据持久化与事件溯源](./AC麻将-数据持久化与事件溯源.md) 为准。

## 阅读顺序

总体架构（00）→ 引擎算分（01）/ 对局流程（02）→ 服务端（03）/ 持久化（04）→ 前端基座（05）/ 网络层（07）/ 登录（06）。

## 维护记录

| 日期 | 概要 |
|---|---|
| 2026-09-16 | 建立技术文档索引与 `AC麻将-<模块>` 命名规范；登记现有 2 份（架构 / 台数），规划 6 份模块技术方案（对局引擎 / 网关房间 / 持久化 / 前端基座 / 登录 / 网络层）待逐模块补充 |
| 2026-09-16 | 补齐 04 数据持久化与事件溯源、05 前端基座与设计系统、07 客户端网络层三份技术方案（对应 M-A2 / M-A / 网络层）；清单 02–07 全部由「待补」转「已补」并补全相对链接 |
| 2026-09-18 | 新增 08 目录结构重构与Admin系统架构：多系统三分法目标结构、persistence 抽包（P0）、server→apps/game-server（P1）、Admin 独立服务+同库蓝图（P2）；状态「设计已定稿，待执行」 |
| 2026-09-18 | 08 状态转「✅ P0/P1 已执行」：persistence 抽包 + server→apps/game-server + 清 miniwxapp 落地，门禁全绿；P2（Admin）待立项 |
| 2026-09-19 | 新增 09 Admin 后台技术方案（schema + API 契约）：Drizzle P2-a 数据层（游戏表只读镜像 + admin 自有表，统一经 persistence admin 命名空间）、admins/arbitrations/admin_audit_logs 三表、Session+RBAC+CSRF、REST 契约、回放帧服务、审计切面；对应 PRD 10-Admin后台 与 BL-015 |
