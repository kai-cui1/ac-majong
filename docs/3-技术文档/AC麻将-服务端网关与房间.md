# A&C 麻将 · 服务端网关与房间（技术方案）

> **模块**：服务端联机层（`apps/game-server/src` 的 `wsGateway.ts` / `roomManager.ts` / `roomActor.ts` / `redact.ts` / `connection.ts` / `devBots.ts` / `index.ts`）。产品需求见 [`../1-prd/04-对局与牌桌.md`](../1-prd/04-对局与牌桌.md)、[`../1-prd/03-房间系统.md`](../1-prd/03-房间系统.md)。
> **关联**：对局状态机 [`AC麻将-对局流程引擎.md`](./AC麻将-对局流程引擎.md)｜鉴权 [`AC麻将-登录鉴权.md`](./AC麻将-登录鉴权.md)｜持久化 [`AC麻将-数据持久化与事件溯源.md`](./AC麻将-数据持久化与事件溯源.md)｜总体 [`AC麻将-联机架构方案.md`](./AC麻将-联机架构方案.md)
> 遵循[《文档总纲》](../README.md)三原则：本文件为服务端网关与房间模块的全量技术说明。

---

## 1. 定位与范围

- **职责**：承载 WebSocket 连接、鉴权路由、房间生命周期、**单房间权威状态机**、防透视下发。是「服务端权威」的落点。
- **形态**：Node.js + TypeScript + `ws`；平台无关（微信/Web 客户端都连此网关，仅 identity 与 transport 不同）。
- **不含**：对局规则（委托引擎 `applyAction`）；存储实现（委托持久化层）。

## 2. 分层与消息流

```
WebSocket 客户端
   │  ClientMsg（JSON）
   ▼
wsGateway（连接/会话/心跳/路由）── identity（鉴权，见登录鉴权）
   │                              └─ persistence（登录落库/会话，见数据持久化）
   ▼
RoomManager（房间号分配/查询/回收）
   ▼
RoomActor（单房间权威状态机）── engine.applyAction（对局推进）
   │  每步 redact 按座位裁剪
   ▼
Connection.send（ServerMsg：gameView/roomView/event/ack/…）
```

`Connection`（`connection.ts`）为平台无关连接抽象：`{ userId; send(msg); close(code?,reason?) }`。网关包装真实 socket，测试与 Bot 用 mock。

## 3. wsGateway（`wsGateway.ts`）

- **启动** `startGateway(opts: GatewayOptions): Gateway`，`opts` 含 `port` / `identity` / `heartbeatMs?` / `autoBots?` / `persistence?`（缺省内存实现）。返回 `{ wss, rooms, close }`。
- **连接**：每个 socket 建 `Session { ws, userId, roomId, alive, headers }`，并暴露受控的 `Connection`（`userId` getter/setter 绑定 session）。
- **心跳**：`setInterval` 内 `ping`；一个周期内未 `pong`（`alive=false`）则 `terminate`。
- **消息路由** `handleMsg(session, conn, msg, rooms, identity, autoBots, send, persistence)`，按 `msg.t` 分派：

| `ClientMsg.t` | 处理 |
|---|---|
| `auth` | 鉴权 + 登录落库/会话 + `authOk{userId,profile}`（详见[登录鉴权](./AC麻将-登录鉴权.md)） |
| `create` | 需已鉴权；`rooms.create(userId, conn, maxRounds)`（**含 `rooms` 落库，M-C 接线**）；`ack.reason=房间号`。开发期 `AUTO_BOTS>0` 仍可自动补 Bot 满员开局（本地便利，将被 M-D「房主主动放 Bot」取代，见 §7） |
| `join` | 需已鉴权；校验房间存在 / 未满 / 未开始 → `rooms.get(room).addPlayer`；成功记 `session.roomId`（`room_member_events` 落库 → M-D） |
| `addBot` | **M-D 新增**：需已鉴权 + 房主 + `waiting` + 有空位；为空位放入 Bot（见 §5 `addBot`、§7）|
| `leave` | 从房间移除，清 `session.roomId` |
| `start` | 房主 + 座位满 4 人（真人 + Bot）开局 |
| `nextRound` | 续局（相位守卫在 RoomActor） |
| `action` | 转 `RoomActor.handleAction(userId, action)` |
| `ping` | 回 `pong` |

- **断开**：`ws.on('close')` 从 sessions 移除并 `removePlayer`（座位保留以支持重连）。
- 未鉴权发对局消息 → `error:'未鉴权'`；无房间 → `error:'无房间'`。

## 4. RoomManager（`roomManager.ts`）

- `create(hostUserId, conn, maxRounds=8)`：分配 **6 位房间号**（`genId` 去重随机）、`new RoomActor(id, host, maxRounds, seedBase++)`、房主入座。
- **`maxRounds` 取值**：`4/8/16` 为固定局数；**`不限` 以约定值 `0`（或 `null`）表示**，`RoomActor.nextRound` 对其不做上限判定（见 §5）。
- **`rooms` 落库（M-C 接线）**：`create` 成功后调 `GameStore.createRoom({ room_id, host_openid, max_rounds, initial_score, status:'idle' })`；落库失败不阻断建房（弱依赖、记日志，同登录落库策略）。
- `get(id)` / `remove(id)` / `size()`；`seedBase` 默认 `Date.now()%1e6`，逐房递增作对局种子基。

## 5. RoomActor（`roomActor.ts`）——单房间权威状态机

- **串行**：Node 事件循环天然串行处理消息，方法为**同步无异步 IO**（若引入 Redis 快照等异步操作，再加串行队列）。
- **状态**：`phase: 'waiting'|'playing'|'finished'`、`state: TableState|null`、`seatOf`(userId→seat)、`userAtSeat`[4]、`connOf`(userId→Connection)、`seed`。
- `addPlayer`：已在座 → 重连（`broadcastAll` 重发）；否则仅 `waiting` 可入、找空座；`removePlayer`：删连接、**保留座位**（支持重连）。
- `start(byUserId)`：仅 `waiting` + 房主 + **座位满 4 人（真人 + Bot 混合皆可）** → `createTable(0, seed++)`、`phase='playing'`、`broadcastGame`。
- `addBot(byUserId, count=1)`（**M-D 新增，Bot 陪玩 FR-房间-08**）：仅 `waiting` + 房主 + 有空位 → 为空位放入至多 `count` 个 Bot（复用 §7 Bot 连接与代打策略）；`broadcastAll` 刷新 `roomView`（座位标记 Bot）。
- `handleAction(userId, action)`：**服务端权威合法性校验**——相位=playing、座位存在、`action.seat===本座`、`actionKind(action) ∈ legalActions(state, seat)`；通过则 `applyAction` → 更新 state → `broadcastGame(events)`。
- `nextRound(byUserId)`：**相位守卫**——仅 `state.phase ∈ {settled, exhaustive}` 才受理（天然防重复推进）；**`maxRounds>0` 且 `round>=maxRounds`** → `phase='finished'` + `broadcastAll`；**`maxRounds=0`（不限）** → 永不因上限 `finished`，仅房主手动解散才结束（解散 → M-D/M-F）；否则 `startNextRound(state, seed++)` + `broadcastGame`。
- `broadcastGame(events?)`：先发 `event`（如有），再对每个在座连接发 `gameView = redact(state, seat, id, maxRounds)`（**按座位裁剪**）。
- `broadcastAll`：playing 走 `broadcastGame`；否则发 `roomView`（等待/结束页）。
- `roomView()`：`{ room, phase, hostUserId, maxRounds, seats:[{userId,seat,isBot?}|null] }`（**M-D 起 `seats` 增加 `isBot` 标识**，前端区分真人/机器人；`maxRounds=0` 前端显示「不限」）。

## 6. redact 防透视（`redact.ts`）

`redact(state, seat, room, maxRounds): ViewState` 按座位裁剪：
- `you`：**完整暗牌** `concealed` + melds + flowers + zi + score + `legal`（`legalActions(state,seat)`）。
- `others`：**只给 `concealedCount`（张数）+ flowersCount**，绝不含具体暗牌；melds/zi/score 公开。
- 公开：`round`/`maxRounds`/`phase`/`dealerSeat`/`currentSeat`/`wallRemaining`/`lianzhuangCount`/`lastDiscard`/`discards`（全局有序牌河）。

> 防透视是硬性安全要求（NFR-03）；`redact.test.ts` 断言序列化后他家不含 `concealed` 具体牌。

## 7. Bot（`devBots.ts`）——从「本地开发自动补齐」演进为「房主主动陪玩」

- `fillDevBots(room, count)`：为房间补 `dev-bot-i`，走**与真实客户端相同的裁剪 ViewState**（不经网络）。
- `pickAction(view)`：保守策略——能胡则胡（`win_draw`/`win_discard`），否则摸 / 打第一张 / 过。**此策略同时用于 M-D 的 Bot 陪玩与 M-I 的断线托管**（FR-房间-08 / FR-断线-03）。
- 去重：以 `action + round + wallRemaining + lastDiscard` 为 key，避免重复动作；`setTimeout(220+i*80ms)` 延迟，避免递归广播堆栈并给客户端动画留时间。
- **两种触发方式**：
  - **开发期自动补齐**（现状）：网关 `AUTO_BOTS>0` 时 `create` 后自动补满并开局，仅本地联调用；**生产 `AUTO_BOTS=0`**。
  - **房主主动陪玩**（M-D，FR-房间-08）：房主在等待页发 `addBot` 指令 → `RoomActor.addBot` 复用本模块 Bot 连接与 `pickAction` 为空位放 1~3 Bot；Bot 座位在 `roomView` 标 `isBot`，真人加入优先占空位、房主可移除多余 Bot。

## 8. 入口与部署（`index.ts`）

- `pickIdentity(process.env.IDENTITY)`：`wechat` / `web` / `mock`（默认）。
- `createPersistence(process.env)`：设 `DATABASE_URL`+`REDIS_URL` → MySQL+Redis，否则内存（见[登录鉴权](./AC麻将-登录鉴权.md)、数据持久化文档）。
- `PORT`（默认 8080）、`AUTO_BOTS`（默认 0）；`SIGTERM/SIGINT` 优雅关闭（关网关 + 关持久化）。
- 部署形态（单实例 / 房间亲和 / 快照写 Redis）见 [`AC麻将-联机架构方案.md`](./AC麻将-联机架构方案.md) §12。

## 9. 协议

`ClientMsg` / `ServerMsg` / `ViewState` / `RoomView` 定义于 `packages/protocol`（客户端经 vendor 同步复用，见[客户端网络层](./AC麻将-客户端网络层.md)）。

**M-C / M-D 协议演进**（改协议须同步更新 `packages/protocol` 与本文档）：
- **M-C**：`create` 的 `maxRounds` 支持「不限」约定值（`0`/`null`）；`RoomView.maxRounds=0` 前端显示「不限」。
- **M-D**：新增 `ClientMsg` `{ t:'addBot'; seq; count? }`（房主放 Bot，可选 `{ t:'removeBot'; seq; seat }`）；`RoomView.seats` 项增加 `isBot?: boolean`；成员进出触发 `room_member_events` 落库。

## 10. 测试

- `roomActor.test.ts`：房间生命周期、权限（仅房主开始/满 4 人）、`nextRound` 相位守卫、非法操作拦截。
- `wsGateway.test.ts`：真实 WS 端到端（auth→create→join×3→start→各家收 `gameView` 且他家不含暗牌）；登录落库/会话。
- `redact.test.ts`：防透视断言。`integration.test.ts`：全链路。

## 11. 待接线（BL-013 持久化接入实时对局流程）

- **登录**：✅ 已接线（`users` + 会话，M-B）。
- **房间创建**：✅ 已接线（M-C）——网关 `create` 分支在 `rooms.create` 后调 `createRoom`（弱依赖、失败不阻断），e2e + MySQL 验证（含「不限」=`max_rounds:0`）。
- **成员进出**：`room_member_events` → M-D；**Bot 陪玩**（`addBot` 协议 + `RoomActor.addBot`）→ M-D。
- **开局 / 每动作 / 结算 / 房间关闭**：`games` / `game_initial_states` / `game_actions` / `final_score` → M-E/M-F/M-G。

见 [`../5-backlog/README.md`](../5-backlog/README.md) BL-013。

## 12. 房间积分周期与重启重建（BL-016，✅ 已实现 2026-09-18）

- **积分账本**：`GameHooks.onGameEnd(roomId, gameId, endType, result, scores)` 每局末带出各家累计分 → 网关写 `rooms.member_scores`（与 drain/finishGame 同批 fire-and-forget）。
- **房号全局唯一**：`RoomManager.genUniqueId()` 双重查重（内存活跃房 + `GameStore.roomIdExists` 历史表）；`create` 支持传入预生成房号；散场后房号永不复用。
- **重进/重启重建**：`join` 内存未命中 → `rebuildRoomFromStore`（已关闭→拒绝「房间已关闭」；否则：座位/昵称 ← `room_member_events`+`users`；对局现场 ← 最新一局 `game_initial_states` 快照（积分以账本注入）+ `game_actions` + Redis `peekActions` 未落盘缓冲 → `replayRound` 重演；回顾/胡数 ← `games.result`）→ `RoomManager.createRestored` + `RoomActor.restore`；Bot 座位 `attachBot` 挂回，未重连真人对局中立即转托管。
- **降级路径**：重演失败/快照缺失 → `waiting` + 账本作为下局各家初始累计分（BL-017 后于仪式收尾 `finalizeCeremony` 建桌时注入）。
- **Bot 流水**：`addBot` 消息与 AUTO_BOTS 自动补位均补记 `room_member_events:join`（重建时恢复 Bot 座位）。
- 验证：roomScore.test 5 例（账本/重启重建/局中缓冲重演/已关闭拒绝/房号不复用/waiting 重建）+ 真实环境 e2e（重启后 H5 重进第 7 局局中现场、积分 25/-10/-5/-10 保留，CDP 截图）。

## 13. 开局仪式与摸牌位骰（BL-017，✅ 已实现 2026-09-18）

- **房间玩法参数**：`RoomSettings { wallMode: 'physical'|'random', breakDice: boolean }` 随 `create` 消息携带 → `rooms.settings` 落库；开局后不可改；重建（`createRestored`）沿用。选位仪式为每房标准流程恒开启（无开关）。
- **seating 状态机**：`RoomPhase` 新增 `'seating'`（waiting→seating→playing）。`start()` 不再直接发牌，而是进入仪式：`roll`（四家选位骰 2d6，同点者仅同点者重掷）→ `pick`（点数最大者 A 自由选座，其余按点数降序依次坐 A 下手位 `(picked+i)%4`，座位/昵称/骰点全量重索引）→ `dealerDice`（A 掷 N，`dealerSeat=(seatA+(N-1)%4)%4`，7=对面、9=自己）→ `breakDice`（若启用，首庄掷摸牌位骰）→ `finalizeCeremony`。
- **仪式收尾**：A 上 1 子 + 首庄庄子（同一家则 2）映射到引擎 `createTable(opts.initialZi)`，后续轮次沿用既有 zi 语义（上庄/连庄 +1，计分公式不变）；physical 模式 `buildPhysicalLayout(seed)` 固化 4 排×36 张，`drawOrderFromLayout(layout, dealerSeat, breakN)` 生成摸牌序（庄家排 g(N+1) 起、排尽续上手家排、末尾循环回跳区）；仪式日志经 `GameHooks.onSeating` 落 `rooms.seating`。
- **局间摸牌位骰**：`breakDice` 启用时 `nextRound` 不直接开新局，而是进入 `roundBreak` 阶段（掷骰者=轮换后庄家 `state.dealerSeat`，随 gameView 下发 `view.seating`），掷后 `beginNextRoundWithBreak` 按新开牌点建墙开局；期间 `nextRound`/`handleAction` 被拒。
- **超时自动**：手动掷按钮 + 真人 10s 超时自动代掷；Bot 0.4~0.8s 自动掷；选座超时=保留自己当前座位。
- **协议**：`ClientMsg` 新增 `roll`/`pickSeat`/`create.settings`；`RoomView` 新增 `settings`/`seating`；`ViewState` 新增 `wallInfo`（四边牌墙栈高 0/1/2 + 开牌点，physical 模式）/`seating`（roundBreak）。仪式结束后先广播 `roomView`（seating 已清，客户端关闭仪式 UI）再广播 `gameView`。
- **快照/回放**：`game_initial_states` 新增 `layout`/`break_group` 列；`RoundSnapshot` 携 `layout`/`breakGroups`/`initialWallLen` 三字段，`rehydrate` 还原后回放/重建可复现牌墙展示。
- 验证：`seatingCeremony.test.ts` 12 例（状态机/同点重掷/选座重排/定庄骰四方位映射/仪式子/breakDice/roundBreak/视图携带）+ 引擎 `bl017-physical-wall.test.ts` 10 例（布局确定性/摸牌序/快照往返/栈高推算）；既有测试经 `ceremonyHelper.driveCeremony`/`driveCeremonyWs` 驱动仪式后全绿。

---

## 14. 公开房间与大厅列表（BL-018，✅ 已实现 2026-09-18）

- **协议**：`RoomSettings` 增 `isPublic`（默认开；create 缺省字段网关补 true）；新增 `ClientMsg roomList{seq}`（仅登录态可拉）与 `ServerMsg roomList{rooms: PublicRoomEntry[]}`；`PublicRoomEntry = { room, host(房主昵称), seats(已入座含 Bot), maxRounds, status: waiting|playing }`，无积分/隐私字段。
- **聚合**：`RoomActor.listEntry()` 仅 `isPublic !== false` 且 phase ∈ {waiting, seating, playing} 时返回（seating 归 waiting；finished/解散后房从 `rooms` 移除自然消失）；`RoomManager.publicRooms()` 等待先于对局中、同组按 `createdAt` 倒序、上限 20 行（FR-房间-11）。
- **刷新**：服务端不推送；客户端进大厅拉一次 + 5s 自动轮询 + 手动 🔄 钮（弱一致可接受，PRD03 §3.3）。
- **测试**：wsGateway.test 1 例（公开房在列且含房主/人数/局数/状态；非公开房不下发），server 67 例绿。

## 维护记录

| 日期 | 概要 |
|---|---|
| 2026-09-16 | 首次产出（补记 t8 服务端骨架 + 续局 + M-B 持久化注入）：分层与消息流、wsGateway 路由/心跳/鉴权/persistence、RoomManager 房间号、RoomActor 权威状态机（合法性校验/nextRound 相位守卫/redact 广播/重连）、redact 防透视、devBots、入口与部署、测试、BL-013 待接线 |
| 2026-09-16 | PRD 全量拆分与持久化（04）产出后回填交叉引用：产品需求 03-房间系统由「待拆分」占位改指真实 PRD、关联持久化由「待补」占位改指 `AC麻将-数据持久化与事件溯源.md` |
| 2026-09-16 | M-C 文档先行：细化 `create` 的 `rooms` 落库接线（§4）与 `maxRounds`「不限」=`0`/`null` 表示、`nextRound` 不限不做上限判定（§5）、`join` 房号校验；将 Bot 从「本地自动补齐」演进为「房主主动陪玩」设计（§7 + `addBot` 协议 + `roomView.isBot`，落地 M-D）；更新 §11 接线进度（房间创建→M-C）|
| 2026-09-16 | M-C 实现回填：§11「房间创建」转 ✅ 已接线（网关 `create` 分支 `rooms.create` 后调 `createRoom`）；`roomActor.nextRound` 已改为 `maxRounds>0 &&` 守卫（不限=0 不因上限 finished）；e2e + MySQL `rooms` 落库验证（创建/加入/入座广播/房号校验/不限=0），server 24 测试绿 |
| 2026-09-17 | M-I 断线/托管接线：WS close 与对局中 leave 均走 `RoomActor.playerDisconnected`（离线标记+60s 计时→`enterTrustee` 挂 `makeTrusteeConnection` 保守代打）；重连 addPlayer 重绑+`cancelOffline` 卸托管；roomView seats 增 `offline`/`trusteed`；散场清计时器 |
| 2026-09-18 | **BL-016 房间积分周期**：新增 §12——`onGameEnd` 带出累计分写 `rooms.member_scores` 账本；`genUniqueId` 双重查重房号永不复用；`join` 未命中走 `rebuildRoomFromStore` 事件溯源重建（快照+动作+Redis 缓冲重演，座位/积分/回顾恢复，Bot 挂回/真人转托管）+ `RoomActor.restore`/`createRestored`；已关闭拒绝「房间已关闭」；Bot 入座补流水；roomScore.test 5 例 + 真实环境重启重进 e2e + CDP 截图 |
| 2026-09-18 | **BL-017 开局仪式与摸牌位骰**：新增 §13——`RoomSettings` 建房参数落库；seating 状态机（选位骰同点重掷→最大者选座重排→定庄骰四方位映射→摸牌位骰）；仪式子 initialZi；physical 物理墙固化+开牌点摸牌序；局间 roundBreak；超时自动代掷；协议 roll/pickSeat/wallInfo/seating；快照 layout/break_group 回放可复现；seatingCeremony.test 12 例 + 引擎 bl017 10 例，既有测试适配仪式驱动全绿 |
| 2026-09-18 | 目录重构 P1：模块路径 `server/src` 更新为 `apps/game-server/src` |
| 2026-09-18 | `run/start-server.sh` 默认值定案（用户）：Bot 数 3→**0**（陪玩改由房主等待页手动加 Bot，FR-房间-08）；鉴权默认 mock→**account**（`-i` 可切回 mock/wechat）；补 `DATABASE_URL/REDIS_URL` 本地默认（防误退内存库丢账号）；已用新脚本重启 8080（autoBots=0, persistence=sql） |
| 2026-09-18 | **start-server 改 plain tsx 启动**：Node 25 下 `pnpm dev`（tsx watch）链实测两缺陷——跑一段时间后事件循环停摆（新 WS 握手挂起、日志停更），且 kill 子进程会被 watch 复活并重绑端口（子进程命令行不含 "tsx watch"，pkill 模式易漏）；脚本改 `pnpm --filter @ac-majong/game-server exec tsx src/index.ts`；清残留须按 PID/`tsx/dist/cli.mjs watch` 模式 |
| 2026-09-18 | 新增 `run/start-client.sh`：一人多席位独立客户端启动器（封装 `scripts/open-player.mjs`），无参/`-h` 打印完整用法；每账号独立 Chrome profile（`.player-profiles/<账号>`），可选房号自动入座、`--fresh` 全新身份 |
| 2026-09-18 | **BL-018 公开房间与大厅列表**：新增 §14——`RoomSettings.isPublic`（默认开）；`roomList` 请求/响应协议 + `PublicRoomEntry`；`RoomActor.listEntry()`/`createdAt`、`RoomManager.publicRooms()`（等待优先/同组创建时间倒序/上限 20）；网关 roomList 分支（仅登录态）+ create 补 isPublic 缺省；wsGateway 测试 1 例，server 67 例绿；e2e：p1 建公开房→p2 列表可见并一键加入、非公开房不下发 |
| 2026-09-18 | **BL-020 服务端**：`RoomSettings.chiFirstView`（默认 true，create/构造/恢复三处缺省补齐）；redact 增 settings 参——开关 ON 且响应窗内存在 chi pending 时向全桌 ViewState 下发 `pendingChi{seat,tiles,called}`（公开信息，防透视原则不冲突）；OFF 不下发、时序不变 |
