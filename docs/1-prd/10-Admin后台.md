# 10 · Admin 后台（管理 + 仲裁）

> **模块**：运营/管理后台系统（`admin-server` + `admin-web`），面向**管理员**而非玩家。
> **职责**：定义本模块产品「做什么 / 怎么做」。全局见 [00-产品总览.md](./00-产品总览.md)，索引见 [README.md](./README.md)。
> **关联**：技术架构 [`../3-技术文档/AC麻将-目录结构重构与Admin系统架构.md`](../3-技术文档/AC麻将-目录结构重构与Admin系统架构.md) §6（技术栈已选型）｜数据源 [`../3-技术文档/AC麻将-数据持久化与事件溯源.md`](../3-技术文档/AC麻将-数据持久化与事件溯源.md)（经 `@ac-majong/persistence` 读游戏数据、`replayRound` 回放）｜玩家侧回放 [09-战绩与回放.md](./09-战绩与回放.md)｜排期 [`../5-backlog/README.md`](../5-backlog/README.md) **BL-015 管理后台子系统一期**。
> **开发状态**：🟢 一期 P2-a 已交付（FR-Admin-01~08 落地 + 真库冒烟绿，2026-09-21）；二期 **FR-Admin-09 诊断包受理 / FR-Admin-10 实时房间监控** 已编码落地（全量门禁绿，2026-09-22；详见 §2.1）；数据看板/运营配置/用户处置仍登记待排期。

---

## 1. 模块目标

为运营方提供一个**与玩家链路完全隔离**的独立后台，用于**查证与仲裁**：管理员可检索用户/房间/对局、调取并逐帧回放任意一局、对争议局录入仲裁结论留痕；所有管理操作可审计。一期聚焦「**管理 + 仲裁核心**」，坚持**只读为主**——不改动游戏权威数据、不介入对局实时链路（数据看板与运营配置归二期）。

**一期范围**（BL-015）：管理员鉴权与角色、用户查询、房间/对局查询、对局回放仲裁、**回放包导出（申诉取证，BL-024）**、审计日志。
**二期范围**：本轮细化并落地 **FR-Admin-09 客户端诊断包受理（BL-023 消费面）** + **FR-Admin-10 实时房间监控（BL-022 消费面）**（详见 §2.1）；数据看板（DAU/对局量/台数分布）、运营配置（公告/规则参数）、用户处置（封禁/改资料）**仍仅登记、暂不排期**。

## 2. 功能需求（FR-Admin）

| 编号 | 需求 | 优先级 | 状态 |
|---|---|---|---|
| FR-Admin-01 | **管理员登录 / 登出**：账号密码（scrypt 哈希，复用 H5 账号鉴权模式）+ 会话（Session 存 Redis）+ CSRF 防护；连续失败限流 | P0 | ✅ 已实现（P2-a） |
| FR-Admin-02 | **RBAC 三档角色**：super / operator / viewer，权限**按模块粗粒度**控制（接口级 + 页面级双重拦截） | P0 | ✅ 已实现（P2-a） |
| FR-Admin-03 | **管理员账号管理**（仅 super）：创建 / 停用管理员、分配角色、重置密码；首个超管由 seed/环境变量 bootstrap | P1 | ✅ 已实现（P2-a） |
| FR-Admin-04 | **用户查询与详情（只读）**：按 openid / 昵称 / 注册时间范围检索；详情 = 资料 + 房间史 + 对局史（战绩聚合归 P2-b） | P1 | ✅ 已实现（P2-a） |
| FR-Admin-05 | **房间 / 对局查询（只读）**：按 room_id / 房主 / 状态 / 时间检索；房间详情 = 成员进出 + 局列表 + 积分账本 + 最终分；对局详情 = 初始态 + 动作序列 + 结算明细 | P1 | ✅ 已实现（P2-a） |
| FR-Admin-06 | **对局回放仲裁**：对局详情内嵌 **web 回放播放器**（服务端逐帧还原，前端用 Unicode 麻将牌区渲染）；管理员主动检索定位争议局（**无工单**），录入**仲裁结论**（受理状态 / 结论 / 备注）**纯记录留痕**，不回写游戏数据 | P1 | ✅ 已实现（P2-a） |
| FR-Admin-07 | **审计日志**：记录所有管理员**写操作**（登录/登出、仲裁录入、管理员账号管理、诊断包受理、实时监控调用）；字段 = who / when / what / target / 前后值 / ip / result；仅 super 可查全部 | P1 | ✅ 已实现（P2-a；09/10 动作随二期并入） |
| FR-Admin-08 | **导出单局回放包**（申诉取证，BL-024）：回放/对局详情页提供「导出回放包」，下载自包含、离线可确定性重演的 `ReplayBundle`；operator+ | P1 | ✅ 已实现（P2-a） |
| FR-Admin-09 | **客户端诊断包受理**（BL-023 消费面，详见 §2.1）：粘贴玩家诊断包 JSON → 后端校验/规范化受理（记审计）→ 结构化展示（现场 ctx / 消息环 / 报错栈）→ 凭 room/round 跳回放仲裁；operator+ | P2 | ✅ 已实现（二期·门禁绿） |
| FR-Admin-10 | **实时房间监控（上帝全知视角）**（BL-022 消费面，详见 §2.1）：对卡顿 playing 房经 game-server **内网预共享密钥只读 inspect 端点**抓**实时全量台态**（牌墙实牌 / 四家暗牌 / 牌河 / 副露花子分 / 在等谁 / 响应意图）+ 不可达降级 MySQL 事实；operator+ | P2 | ✅ 已实现（二期·门禁绿） |

### 2.1 二期功能细化（FR-Admin-09 / FR-Admin-10）

> 二者均为**已完成底座能力的 Admin 消费面**：FR-Admin-09 消费 BL-023 客户端错误遥测的诊断包，FR-Admin-10 消费 BL-022 服务端可观测性的 `RoomActor.inspect()`。均**不改游戏权威数据、不介入对局实时写链路**。

**FR-Admin-09 客户端诊断包受理**
- **输入**：运营从玩家处取得的诊断包 JSON（玩家侧设置弹层「复制诊断包」/ `__AC__.diag.copy()` 产出），结构 = `{ at, ctx, ring, errors[] }`：`ctx`={screen,room,round,phase,cur,mySeat}，`ring`=最近消息/视图环（cap 60），`errors[]`（cap 5）每条 ={at,msg,stack?,ctx,ring}。
- **受理（后端 POST）**：admin-web 粘贴 JSON → `POST /api/diag/intake`（operator+）→ admin-server 用 zod 校验/规范化（截断超大 ring/stack、标记缺字段）→ 回结构化结果 + 记一条「诊断包受理」审计（不落原始全文，仅记 room/round/errors 数/受理人）。**无上报管线、不落库诊断包本体**（纯受理/解析）。
- **展示**：现场上下文（screen/room/round/phase/cur/mySeat）+ 消息环时间线 + 报错列表（msg/stack 折叠）。
- **联动**：凭 `ctx.room`+`ctx.round` 拼 `gameId={room}-g{round}`（连字符，对齐 game-server `beginGame` 真实形态 `{room}-g{seq}`）一键跳「回放仲裁」；room 存在但 round 缺失时跳房间详情。
- **边界**：诊断包来自玩家设备、可能含昵称/openid，受理后不回传玩家、不二次分发，仅内部定位。

**FR-Admin-10 实时房间监控**
- **数据源（升级为全量台态）**：`RoomActor.inspect()` 由「运维摘要」**扩展为携带完整 `TableState`**（`state`）——含 `wall`（牌墙实牌顺序）、`players[]`（各家 `concealed` 暗牌明细 / `melds` 副露 / `flowers` 花 / `zi` 子 / `score` 分）、`discards`（牌河）、`pending`（各家响应意图）、`lastDiscard`/`currentSeat`/`dealerSeat`/`phase`/`round`；运维摘要字段（`seats`/`game.legalBySeat`/`seating`/`timers`/`stall`）保留。game-server **单实例进程内存态**，MySQL 无。**全量台态只在服务端与 admin 特权侧存在**（下发玩家的 `ViewState` 仍裁剪防透视）。
- **通道（预共享密钥 header）**：game-server 新增**内网 + 鉴权 + 只读**端点 `GET /internal/rooms/:id/inspect`，校验预共享密钥请求头（`INTERNAL_TOKEN`，仅内网可达、生产不对公网开放）；**不复用** dev-only 无鉴权 `/dev/*`。admin-server **服务端**携带密钥调用后转呈前端。
- **展示（上帝全知视角 · 游戏同款贴图）**：对 `status=playing` 房，**复用回放牌桌俯视图**（共享 `<TableBoard>`，牌面用游戏同款贴图 `tiles/*.png`）呈现「一帧活的回放」——牌墙实牌顺序、四家横排手牌全露（对齐游戏牌桌布局）、弃牌按家分区（北/南/西/东各一区）、副露、**花牌独立区**（每家花牌移出手牌、单列金牌边小盒，取自 `flowers` 独立字段，对齐游戏）、子/分、当前座高亮；右栏运维摘要「在等谁」（currentSeat + legalBySeat）、`stall.idleMs`、`pending` 响应意图、seating 仪式、timers（托管待转/离线起）。**含牌墙未来摸牌顺序**（真·全知，admin 特权）。**实时机制 = 快照轮询 ~2s**（admin 不持 WS、非推送动画流），整桌随牌局推进重渲染。
- **降级**：game-server 不可达 / 房已回收 / 非 playing → 回退展示 MySQL 已落库事实（rooms.status/member_scores）并标注「实时态不可用」。
- **审计 + 边界**：**审计节流**——开启监控 / 手动刷新时记一条 `monitor.inspect`（who/room/result），自动轮询不逐条记（避免 2s 刷屏）；这是对「admin 不介入实时链路」的**受控例外**——仅只读、网络隔离、独立鉴权；admin 仍不持有 WS/RoomManager、不写实时态（见架构 §4 依赖规则修订）。

## 3. 角色与权限矩阵

粗粒度按模块授权（✔=可用，—=不可用）：

| 功能模块 | viewer（只读客服） | operator（运营） | super（超管） |
|---|:--:|:--:|:--:|
| 用户查询 / 详情（FR-04） | ✔ | ✔ | ✔ |
| 房间 / 对局查询（FR-05） | ✔ | ✔ | ✔ |
| 对局回放查看（FR-06 播放） | ✔ | ✔ | ✔ |
| 导出回放包（FR-08） | — | ✔ | ✔ |
| 录入 / 编辑仲裁结论（FR-06 写） | — | ✔ | ✔ |
| 诊断包受理（FR-09） | — | ✔ | ✔ |
| 实时房间监控（FR-10） | — | ✔ | ✔ |
| 管理员账号管理（FR-03） | — | — | ✔ |
| 审计日志查看（FR-07） | — | — | ✔ |

- **鉴权隔离**：管理员账号体系（`admins` 表）与玩家身份（`x-wx-openid` / code2Session / H5 账号）**完全隔离**，互不通用。
- **双重拦截**：后端接口按角色鉴权（权威），前端按角色隐藏/禁用入口（体验）；前端拦截不作为安全边界。

## 4. 交互与页面

> **高保真原型已产出**（桌面控制台 / AntD 5 风格，与玩家侧移动端为两套设计语言）：[`../2-效果图/HTML格式高保真原型/admin/_index.html`](../2-效果图/HTML格式高保真原型/admin/_index.html)（导航）。admin-web 为独立 SPA（Vite+React 18+AntD 5，自建布局）。

| 页面 | 原型文件 | 要点 |
|---|---|---|
| 登录页 | [`admin/login.html`](../2-效果图/HTML格式高保真原型/admin/login.html) | 账号密码登录、错误/限流提示、审计告知 |
| 主框架 | （各页共用侧栏+顶栏） | 左侧导航按角色显示 + 顶栏当前管理员/角色/登出 |
| 用户管理 | [`admin/users.html`](../2-效果图/HTML格式高保真原型/admin/users.html) | 检索栏 + 结果表（分页）+ 详情抽屉（资料/战绩/房间史）；一期只读 |
| 房间/对局 | [`admin/rooms.html`](../2-效果图/HTML格式高保真原型/admin/rooms.html) | 房间检索 + 房间详情（成员进出 + 局列表 + 积分账本/最终分）|
| 回放仲裁 ★核心 | [`admin/replay.html`](../2-效果图/HTML格式高保真原型/admin/replay.html) | 逐帧回放播放器（全信息牌桌）+ 动作序列 + 仲裁面板（受理/结论/备注）|
| 诊断包受理（二期）| [`admin/diag.html`](../2-效果图/HTML格式高保真原型/admin/diag.html) | 粘贴 ac-diag JSON → 现场 ctx / 消息环 / 报错栈结构化展示 → 凭 room/round 跳回放 |
| 实时房间监控（二期）| [`admin/monitor.html`](../2-效果图/HTML格式高保真原型/admin/monitor.html) | **上帝全知视角**：复用回放牌桌俯视图呈现实时全量台态（牌墙实牌 / 四家暗牌 / 牌河 / 副露花子分）+ 右栏运维摘要（在等谁 / stall / pending / timers）+ 不可达降级 |
| 管理员管理（super）| [`admin/admins.html`](../2-效果图/HTML格式高保真原型/admin/admins.html) | 管理员列表 + 新建/停用/改角色/重置密码 |
| 审计日志（super）| [`admin/audit.html`](../2-效果图/HTML格式高保真原型/admin/audit.html) | 写操作流水 + before/after + 按管理员/动作/时间检索 |

## 5. 数据与审计

- **读游戏数据**：一律经 `@ac-majong/persistence`（唯一数据入口，见架构 §4）；回放还原用 `engine.replayRound`，还原逻辑在 **admin-server 服务端**执行，前端只渲染帧（admin-web 不引 `packages/*`）。
- **admin 自有表**（同库 `ac_majong`，详细字段随技术方案/schema 迁移产出）：
  - `admins`：管理员账号（用户名、密码哈希、角色、状态、时间戳）。
  - `roles`（或 `admins.role` 枚举）：super / operator / viewer。
  - `arbitrations`：仲裁记录（game_id、admin_id、受理状态、结论、备注、时间）。
  - `admin_audit_logs`：审计流水（who/when/what/target/before/after/ip/result）。
- **一期只读为主**：对游戏表（users/rooms/games/…）**只读**；写仅限 admin 自有表（仲裁、管理员、审计）。**不修改游戏权威数据**（呼应 D-32：积分随房间生命周期、无账户钱包、无跨房持久化战绩——故仲裁不产生积分/战绩回写）。

## 6. 依赖与边界

- **依赖**：`@ac-majong/persistence`（读游戏数据 + admin 自有表读写，一期经 Drizzle 只读查询面，见架构 §6.4 P2-a；回放包 `buildReplayBundle` 下沉至此共享）；`@ac-majong/engine`（`replayRound`/`rehydrate` 回放还原）；Redis（会话）；MySQL（同库 `ac_majong`）。二期实时房间监控需 game-server 暴露**内网鉴权只读 inspect 端点**（受控例外，见技术方案 §10.3）。
- **边界（不在本模块）**：
  - 不介入对局实时**写**链路、不持有 WS / RoomManager（FR-Admin-10 实时房间监控为**受控只读例外**：经 game-server 内网预共享密钥 inspect 端点服务端调用，见 §2.1）；
  - 用户处置（封禁/改资料）、数据看板、运营配置**仍归后续**（二期本轮只做 FR-Admin-09/10）；
  - 仲裁**不回写**游戏数据，仅记录留痕供线下处理；
  - admin 与游戏服务分容器部署、网络隔离（见架构 §6.3）。

---

## 维护记录

| 日期 | 概要 |
|---|---|
| 2026-09-19 | 首次产出（BL-015 管理后台子系统一期立项）：依据 2026-09-18 技术栈选型与本次 4 项产品决策（角色三档粗粒度 / 用户管理一期纯只读 / 仲裁纯记录留不回写 / 无工单主动检索）落定一期范围=管理员鉴权角色 + 用户查询 + 房间对局查询 + 回放仲裁 + 审计日志；定义 FR-Admin-01~07、角色权限矩阵、页面信息架构、admin 自有表（admins/roles/arbitrations/admin_audit_logs）与「只读为主、不改游戏权威数据」边界；看板/运营配置/用户处置归二期。交互高保真原型与技术方案 schema/API 细化为后续步骤 |
| 2026-09-19 | §4 交互与页面：高保真原型已产出（新增 `2-效果图/…/admin/` 子目录：admin.css 设计系统 + 登录/用户/房间对局/回放仲裁/管理员/审计 6 页 + _index 导航，桌面 AntD 5 风格），§4 改为「页面→原型文件」映射表 |
| 2026-09-21 | 关联可维护性能力（BL-022/023/024）：**一期新增 FR-Admin-08 导出单局回放包**（BL-024 申诉取证，权限矩阵 operator+，复用 persistence `buildReplayBundle`）；二期登记 FR-Admin-09 诊断包受理（BL-023）与 FR-Admin-10 实时房间监控（BL-022，经 game-server 内网鉴权只读端点）；§1 一/二期范围与 §6 依赖同步更新 |
| 2026-09-21 | **二期启动（收窄范围）**：用户拍板二期**先只做 FR-Admin-09 客户端诊断包受理 + FR-Admin-10 实时房间监控**，数据看板/运营配置/用户处置暂不排期。§2 FR 表回填一期 01~08 为 ✅已实现（P2-a）、09/10 转 🟡进行中并展开；新增 **§2.1 二期细化**（诊断包 `{at,ctx,ring,errors[]}` 结构 + 后端 `POST /api/diag/intake` 受理留痕 + 跳回放；`inspect()` 实时态 + game-server 内网预共享密钥 `GET /internal/rooms/:id/inspect` 端点 + admin 服务端代理 + 降级 + 受控例外）；§3 权限矩阵、§4 页面表（diag.html/monitor.html）、§6 边界同步。两项均 operator+。决策：FR-Admin-10 端点鉴权=预共享密钥 header；FR-Admin-09 解析=后端 POST 受理。下一步：原型 → 技术方案 → 编码 |
| 2026-09-21 | **FR-Admin-10 升级为「上帝全知视角」**（文档折回）：用户提出实时监控应如上帝俯瞰牌局、知晓一切。核查确认底层全量态本就在 `TableState`（牌墙实牌 / 四家暗牌 / 牌河 / 副露花子分 / 响应意图），`inspect()` 原仅吐摘要属刻意收窄；回放页早已是全信息特权视角（`ReplayFrame.state`=完整 TableState、无防透视）。据此 §2.1 FR-Admin-10「数据源」升级为 inspect() 携带完整 `state`、「展示」改为复用回放牌桌俯视图（共享 `<TableBoard>`）呈现全量台态；§2 FR 表、§4 页面表同步。决策：牌墙未来摸牌顺序**全量展示**（真·全知）、呈现**复用回放俯视图**。同批重做 monitor.html 原型 + 技术方案 §10.3 + 可维护性 §6 |
| 2026-09-21 | **牌面贴图化 + 实时口径**（文档折回#2）：用户要求监控牌桌/牌墙用游戏同款图案风格、并实时跟随牌局。查实牌面为 44 张独立 PNG、架构 §6.2 原本就要求复用贴图（与技术方案当初选 Unicode 相矛盾，本批回归贴图）。§2.1 FR-Admin-10「展示」补游戏同款贴图 + **实时机制定为快照轮询 ~2s**（admin 不持 WS、非推送动画流）；「审计」改为**节流**（开启监控/手动刷新记一条、自动轮询不逐条记）。决策：监控页+回放页**统一贴图**。同批重做 monitor.html + replay.html 原型 + 技术方案 §2.2/§6/§10.3 + 架构 §6.2 |
| 2026-09-22 | **牌桌布局对齐游戏（用户批注）**（文档折回#3）：用户批注要求西/东家手牌横排（竖排占空间难读）、弃牌区按家分区（参考游戏、非单一总牌河）。§2.1 FR-Admin-10「展示」改为四家横排手牌全露 + 弃牌按家分区（北/南/西/东各一区）。同批重做 monitor.html + replay.html 原型（CSS 网格 3×3 + min-width，浏览器核验 0 重叠 0 溢出）+ 技术方案 §10.3 |
| 2026-09-22 | **牌桌·花牌独立区（用户批注）**（文档折回#4）：每家花牌从手牌移出、单列 `.flower-area`（金牌边小盒，对齐游戏；取自 `PlayerState.flowers` 独立字段——花牌摸到即亮出补牌、本就不属打牌手牌）。§2.1 FR-Admin-10「展示」补花牌独立区。同批修 monitor.html（四家均补花牌区）+ replay.html（北/南补花牌区演示）原型 + 技术方案 §10.3 |
| 2026-09-22 | **二期编码落地（FR-Admin-10 c2 + FR-Admin-09 c1）**：两项均实现并全量门禁绿（typecheck 7 / test / build，未碰对局链路）。FR-Admin-10：game-server inspect() 扩全量态+内网端点、admin-server 代理(审计节流+降级)、admin-web 共享 <TableBoard>+Monitor 2s 轮询+Replay 重构。FR-Admin-09：admin-server `POST /api/diag/intake`(zod 规范化+截断+派生 gameId+审计不落本体)、admin-web `Diag.tsx`。**修正**本文 §2.1 FR-Admin-09 联动 `gameId={room}:g{round}` 冒号笔误→连字符 `{room}-g{round}`（与 diag.html 原型及 beginGame 真实形态一致）。§2 FR 表 09/10 状态→✅已实现。详技术方案 §10.2/§10.3 维护记录 |