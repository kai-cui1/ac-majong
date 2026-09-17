# A&C 麻将 · 服务端网关与房间（技术方案）

> **模块**：服务端联机层（`server/src` 的 `wsGateway.ts` / `roomManager.ts` / `roomActor.ts` / `redact.ts` / `connection.ts` / `devBots.ts` / `index.ts`）。产品需求见 [`../1-prd/04-对局与牌桌.md`](../1-prd/04-对局与牌桌.md)、[`../1-prd/03-房间系统.md`](../1-prd/03-房间系统.md)。
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

---

## 维护记录

| 日期 | 概要 |
|---|---|
| 2026-09-16 | 首次产出（补记 t8 服务端骨架 + 续局 + M-B 持久化注入）：分层与消息流、wsGateway 路由/心跳/鉴权/persistence、RoomManager 房间号、RoomActor 权威状态机（合法性校验/nextRound 相位守卫/redact 广播/重连）、redact 防透视、devBots、入口与部署、测试、BL-013 待接线 |
| 2026-09-16 | PRD 全量拆分与持久化（04）产出后回填交叉引用：产品需求 03-房间系统由「待拆分」占位改指真实 PRD、关联持久化由「待补」占位改指 `AC麻将-数据持久化与事件溯源.md` |
| 2026-09-16 | M-C 文档先行：细化 `create` 的 `rooms` 落库接线（§4）与 `maxRounds`「不限」=`0`/`null` 表示、`nextRound` 不限不做上限判定（§5）、`join` 房号校验；将 Bot 从「本地自动补齐」演进为「房主主动陪玩」设计（§7 + `addBot` 协议 + `roomView.isBot`，落地 M-D）；更新 §11 接线进度（房间创建→M-C）|
| 2026-09-16 | M-C 实现回填：§11「房间创建」转 ✅ 已接线（网关 `create` 分支 `rooms.create` 后调 `createRoom`）；`roomActor.nextRound` 已改为 `maxRounds>0 &&` 守卫（不限=0 不因上限 finished）；e2e + MySQL `rooms` 落库验证（创建/加入/入座广播/房号校验/不限=0），server 24 测试绿 |
