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
| `join` | 需已鉴权；房间获取/恢复后调用 `addPlayer`。既有成员可在仪式/对局中重入，先向本人补权威 roomView，再 broadcastAll；新成员仍受 waiting/空位限制。成功记 `session.roomId`（重建见 §12，仪式恢复见 §13.4） |
| `addBot` | **M-D 新增**：需已鉴权 + 房主 + `waiting` + 有空位；为空位放入 Bot（见 §5 `addBot`、§7）|
| `leave` | `seating`/`playing` 复用 `playerDisconnected`：清连接、保留成员/座位、标记离线并接续原期限托管；普通 `waiting` 保持 `removePlayer` 原逻辑（仅清连接，座位保留）。成员退出流水照旧记录，最后清 `session.roomId` |
| `start` | 房主 + 座位满 4 人（真人 + Bot）开局 |
| `nextRound` | 续局（相位守卫在 RoomActor） |
| `action` | 转 `RoomActor.handleAction(userId, action)` |
| `ping` | 回 `pong` |

- **断开**：`ws.on('close')` 从 sessions 移除；仍有房间绑定时调用 `playerDisconnected`，seating/playing 记离线起点并保留座位，waiting 仅清连接。主动 leave 已清 `session.roomId` 时后续 close 不重复处理。
- 未鉴权发对局消息 → `error:'未鉴权'`；无房间 → `error:'无房间'`。

## 4. RoomManager（`roomManager.ts`）

- `create(hostUserId, conn, maxRounds=8)`：分配 **6 位房间号**（`genId` 去重随机）、`new RoomActor(id, host, maxRounds, seedBase++)`、房主入座。
- **`maxRounds` 取值**：`4/8/16` 为固定局数；**`不限` 以约定值 `0`（或 `null`）表示**，`RoomActor.nextRound` 对其不做上限判定（见 §5）。
- **`rooms` 落库（M-C 接线）**：`create` 成功后调 `GameStore.createRoom({ room_id, host_openid, max_rounds, initial_score, status:'idle' })`；落库失败不阻断建房（弱依赖、记日志，同登录落库策略）。
- `get(id)` / `remove(id)` / `size()`；`seedBase` 默认 `Date.now()%1e6`，逐房递增作对局种子基。

## 5. RoomActor（`roomActor.ts`）——单房间权威状态机

- **串行**：Node 事件循环天然串行处理消息，方法为**同步无异步 IO**（若引入 Redis 快照等异步操作，再加串行队列）。
- **状态**：`phase: 'waiting'|'seating'|'playing'|'finished'`、`state: TableState|null`、`seatOf`(userId→seat)、`userAtSeat`[4]、`connOf`(userId→Connection)、`seed`。
- `addPlayer`：已在座 → 重绑连接、`cancelOffline` 清离线/托管，**先向本人发完整 `roomView`（身份/玩法/仪式），再 `broadcastAll`**；playing 下后者继续下发 gameView。新成员仅 `waiting` 可入、找空座；`removePlayer` 删连接、保留座位，掉线计时入口为 `playerDisconnected`（§13.4）。
- `start(byUserId)`：仅 `waiting` + 房主 + **座位满 4 人（真人 + Bot 混合皆可）** → `phase='seating'`，依次执行逐家选位、选座、首局一次定庄/开牌点骰；完整结果期后 `finalizeCeremony` 才建桌、发牌、进入 playing（§13）。
- `addBot(byUserId, count=1)`（**M-D 新增，Bot 陪玩 FR-房间-08**）：仅 `waiting` + 房主 + 有空位 → 为空位放入至多 `count` 个 Bot（复用 §7 Bot 连接与代打策略）；`broadcastAll` 刷新 `roomView`（座位标记 Bot）。
- `handleAction(userId, action)`：**服务端权威合法性校验**——相位=playing、座位存在、`action.seat===本座`、`actionKind(action) ∈ legalActions(state, seat)`；通过则 `applyAction` → 更新 state → `broadcastGame(events)`。
- `nextRound(byUserId)`：**相位守卫**——仅 `state.phase ∈ {settled, exhaustive}` 才受理（天然防重复推进）；**`maxRounds>0` 且 `round>=maxRounds`** → `phase='finished'` + `broadcastAll`；**`maxRounds=0`（不限）** → 永不因上限 `finished`，仅房主手动解散才结束（解散 → M-D/M-F）；否则先按玩法决定是否进入 `roundBreak`：启用摸牌位骰则等待完整结果期再建下一局，关闭则直接续局；新局广播仍由服务端驱动（§13.3）。
- `broadcastGame(events?)`：先发 `event`（如有），再对每个在座连接发 `gameView = redact(state, seat, id, maxRounds)`（**按座位裁剪**）。
- `broadcastAll`：playing 走 `broadcastGame`；否则发 `roomView`（等待/结束页）。
- `roomView()`：提供 room/phase/hostUserId/maxRounds、seats（userId/seat/nickname/isBot/offline/trusteed）、settings 与当前 seating 快照；既有成员重入无论当前是否 playing 均先向本人补发，局间刷新无需 placeholder 推断真人/Bot/墙模式。`maxRounds=0` 前端显示「不限」。

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
- `wsGateway.test.ts`：真实 WS 端到端（auth→create→join×3→start→各家收 `gameView` 且他家不含暗牌）；登录落库/会话。Spec 分支回归新增 4 例：首局 input 主动 leave、既有离线后 leave、定庄 result 期 leave、waiting 原逻辑；校验 offline/成员保留、600ms 自动掷、完整展示、原离线60s期限托管、真实 WS 代打广播和重入后的座位/非零积分不丢。
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

## 13. 开局仪式与摸牌位骰（BL-017：已修补当前发现缺项，浏览器视觉验收受阻）

> 2026-09-20：当前 Spec 审计列出的网关、原型与 Cocos 明确缺项已修补；网关 seating 主动 leave 已复用 playerDisconnected 接续原60s。主助手最终全量 **393 pass / 3 integration skipped**、包/Cocos类型检查及指定App场景H5 CLI **13:39 Finished** 已汇总（§13.5）。整体仍为**已修补当前发现缺项，浏览器视觉验收受阻**，非全Spec完成；Cocos实机、真实双端/截图未完成。产品见 PRD04 FR-对局-18/19、§4.1，视觉基线见 `game.html`。

### 13.1 业务阶段与不变玩法

- `RoomSettings { wallMode: 'physical'|'random', breakDice: boolean }` 随建房持久化，开局后不可改、重建沿用；选位恒开。`breakDice` 控制**局间**摸牌位骰，不取消首局合并骰。
- 开局 `waiting → seating → playing`；保留 `SeatingView.stage = roll | pick | dealerBreak | roundBreak` 四个业务阶段，不为展示细分再增业务阶段。首局 `roll → pick → dealerBreak`，**A 一次掷 N 同时定庄/定开牌点**，不再有独立 dealerDice→breakDice 两掷阶段（旧 `dealerDice` 数值字段仍可兼容保留）。
- 从房主开始，固定仪式开始时的下手轮转用户队列；四家按队列逐家掷骰。每轮结束**仅在本轮掷骰者（未定序组）内**判同点：点数唯一者当轮即定序、不再参与后续判重与比大小；仍同点者组成待决组按原轮转序重掷；非重掷者结果保留。
- 服务端以有序槽位表（已定序座位 + 待决并列组）逐轮细化定序；无待决组时展平槽位表确定 `order`（并列组在其预留名次块内由后续轮定序，不与已定序者比大小），最大者 A 自由选座，其他依次坐 A 下手 `(picked+i)%4`；重排座号映射，历史两骰、昵称、操作者以稳定 `userId` 匹配，不能按旧数组位置认人。
- A 上 1 普通子；`dealerSeat=(seatA+(N-1)%4)%4`，首庄 B 上庄 +1 子（A=B 合计2），`breakN=N`。结果展示的预计子数与 `createTable(opts.initialZi)` **同源计算**；不得为展示先改 zi 再在建局重复加子。
- physical 模式保持 `buildPhysicalLayout(seed)` 四排×36张与 `drawOrderFromLayout(layout,dealerSeat,breakN)`：庄家门前墙**视觉右端跳 N 组（2N张）、第 N+1 组开摸**，排尽续上手排、末尾回跳区；random 沿用线性随机发牌，不展示虚构物理位置。计子、连庄、骰点分布、开关语义均不变。

### 13.2 展示快照 contract（所有时间均为毫秒）

`SeatingView` 新增 **optional `presentation`**；旧业务字段 `rolls/reroll/order/picker/picked/dealerDice/dealerSeat/breakN/roller/ziCounts` 兼容维护。新版仪式每次广播下表完整快照；开局随 `RoomView.seating`，局间随 `ViewState.seating` 下发，不只发增量事件。

| `presentation` 字段 | 类型 / 含义 |
|---|---|
| `ceremonyId` | `string`，一次仪式的唯一标识，局间/新开仪式不得复用 |
| `stepId` | `number`，同一仪式内单调递增的步骤号；每次输入/滚动/结果/汇总转移递增，重复广播不变 |
| `startedAt` | `number`，当前步骤实际进入的服务端 Unix 时间戳，ms |
| `deadline` | `number`，当前输入或展示步骤的到期 Unix 时间戳，ms；不得混用秒 |
| `serverNow` | `number`，生成本次快照时的服务端 Unix 时间戳，ms；重复广播仍更新时钟样本 |
| `phase` | `input \| rolling \| result \| summary`，与业务 `stage` 正交 |
| `actor` | `{userId: string, seat: Seat} \| null`；输入/滚动/结果指当前操作者，汇总为 null，座位取当前映射 |
| `rerollRound` | `number`，初轮0，每次开启新的重掷队列递增 |
| `pendingRollUserIds` | `string[]`，原轮转顺序中的待揭晓队列，包含当前正在输入/滚动的人；本人落定后移出；同点汇总可提前给出下一轮队列，非选位阶段为空 |
| `resultsByUserId` | 用户ID→`{d1:number,d2:number,sum:number,rerollRound:number}`；仅含**已揭晓**结果，每枚骰1..6，sum=d1+d2；重掷时旧值保留至该用户再次落定，非重掷者不清除 |
| `ceremonyDice` | `{d1:number,d2:number,sum:number} \| null`；定庄/局间骰的已揭晓结果；输入/滚动为null，结果期才填充 |
| `summaryKind` | `ranking \| reroll \| seated \| null`；仅汇总期给出对应种类，其余为null |

- 服务端**独立生成两枚1..6**骰面（保持现有随机分布）；接受掷骰后可私存新结果，但在 rolling 中不得通过 presentation 或旧总点数字段提前泄露。result 进入时广播真实两骰并同步旧总点数；客户端不能从和拼造新版最终骰面。
- 同点汇总展示旧结果，进入重掷后尚未再次落定的用户显示「上次／待重掷」；新版客户端结合队列/重掷轮次与旧 `reroll` 名单判定，不清空四家已揭晓数据。定庄/局间的结果期保留全部必要结果和预计子数，不能提前移除仪式。

### 13.3 合法推进与固定时长

| 业务阶段 / 展示步骤 | 时长（ms）与推进 |
|---|---|
| `roll/input` | 仅队首操作者；真人10000，Bot/离线/托管600后代掷；接受一次输入→rolling |
| `roll/rolling → result` | rolling完整1200后揭晓；result完整2000后进入下一家input；队列空则summary |
| `roll/summary:ranking` | 2000后进入 `pick/input`；不提前开放选座 |
| `roll/summary:reroll` | 2000展示待决组及旧结果，后仅待决组按原轮转序执行完整 input→1200 rolling→2000 result，再仅待决组内汇总判同点 |
| `pick/input → summary:seated` | 仅A可选；真人10000，Bot等600后选当前座位；超时亦保留当前座位；落座汇总1500后进入 `dealerBreak/input` |
| `dealerBreak/input → rolling → result` | A输入规则同上；rolling1200、result3000；结果期结束才 `finalizeCeremony` 清仪式、建首局发牌 |
| `roundBreak/input → rolling → result` | 当前庄家输入规则同上；rolling1200、result3000；结束才 `beginNextRoundWithBreak` 清仪式、建下一局发牌 |

- **每段实际进入时单独起算** `startedAt/deadline`；回调晚触发，不从早先总时间轴扣减下一段。90ms跳面、200ms落定缩放、1000ms庄家金光属客户端表现；后两者包含在结果期内，不延长业务期限。
- `nextRound` 先按既有规则确定当前庄家；`breakDice=true` 才进入 `roundBreak`，false直接沿用续局（physical默认右端第1组开摸）；不增加第二次定庄或额外计子。
- 结果期结束前**不发牌、不建新局、不启动新局Bot行牌**；期间拒绝 `nextRound/handleAction` 重入。实际计子、仪式日志、建局收尾各执行一次。开局仍可先广播清除seating的roomView再广播gameView，但只能在完整结果期之后。

### 13.4 操作与生命周期守卫

- `ClientMsg.roll` 与 `ClientMsg.pickSeat` 增 **optional `ceremonyToken:{ceremonyId:string,stepId:number}`**（仍带原seq，pickSeat仍带seat）；新版客户端在有presentation时必传当前显示步骤token，`GameClient/NetService`贯通透传，网关透传到房间权威校验。
- 玩家请求须同时满足：身份属于房间、匹配当前actor、正确业务stage、`phase=input`、服务端当前时间早于deadline、token匹配当前仪式/步骤；pickSeat另校验座位合法。接受即转步，拒绝重复、提前、迟到、越权与旧仪式请求。按钮禁用不能代替服务端校验。
- 缺token的旧端仅提供基本身份/阶段守卫（仍限制当前操作者与期限）；无法承诺跨步骤防重放。缺presentation的旧服务端配新客户端只静态降级，完整体验要求前后端同步升级。
- 操作计时与展示计时分离；自动代操作是服务端输入期限处理，不伪装成过期玩家消息。每个回调捕获 `ceremonyId/stepId/预期stage/phase`；切步、重开、散场取消旧计时器并再次校验捕获值，旧回调不得推进新步骤。
- 真人在input掉线/转托管，将截止时间缩短到 `min(原deadline, serverNow+600)`，广播同一步骤的新deadline；若已到期立即处理。重连不延长期限、不重启演出；rolling/result/summary不因离线缩短。普通行牌60秒离线托管规则不变。
- **网关主动退出分支**：`leave` 在 `seating` 与 `playing` 均调用完整 `playerDisconnected`，保留成员/座位并向其他玩家广播 offline；不再让首局仪式退出仅走 `removePlayer` 而漏记离线起点。普通 waiting 的原分支、退出流水及 `session.roomId` 清理不变；重复 leave 或既有掉线后 leave 不延长 `offlineSince`。本轮只补网关调用，复用下述既有 RoomActor 收尾与重入实现，不另写计时逻辑。
- **首局仪式掉线 → playing 接续托管**：`playerDisconnected` 在 seating/playing 仅于首次掉线记 `offlineSince`；首局仪式期间保留离线起点，`finalizeCeremony` 发牌进入 playing 后为仍离线者调用 `scheduleOfflineTrustee`，按 `max(0, offlineSince + trusteeAfterMs - Date.now())` 补挂剩余计时，已过期限则零延时接续。正式 `trusteeAfterMs=60000` 不变，不能从发牌时重新算 60s，也不能因仪式期间未挂行牌计时而漏托管。重复 disconnect 不改起点、不重复挂定时器；已托管直接返回，不能卸除代打连接。
- **既有成员重入的权威顺序**：`addPlayer` 重绑并 `cancelOffline` 后，先 `conn.send(roomView)` 给本人（身份/昵称/isBot、玩法 settings、仪式 seating），再 `broadcastAll`。playing 下随后收到 gameView；刷新局间无需 placeholder 推断真人/Bot/墙模式。gameView-only 是旧服务端兼容路径，不是新版重入契约（客户端网络层 §5.2.1）。
- 在线服务端重连下发当前完整快照；弱网/后台不补播历史，也不等待全员确认。**本轮不增加服务器宕机后的仪式持久化恢复**。既有 `rooms.seating` 仪式日志与 `game_initial_states.layout/break_group`、`RoundSnapshot.layout/breakGroups/initialWallLen` 回放能力保留，不等同于实时步骤恢复。

### 13.5 本轮最终验证与验收边界（2026-09-20）

- 仪式测试已适配异步逐步推进：正式时长集中在 `CEREMONY_MS`，测试可注入缩短时长，边界用假时钟、固定双骰与深拷贝快照检查；测试中的缩时不是玩家倍速功能。相关服务端用例及原有房间/托管/积分/WS/物理墙回归计入下述 game-server、engine 结果。
- **主助手最终实跑摘要**：`pnpm test` 为 engine **179 pass**、client-core/UI **100 pass**、game-server **108 pass**、persistence **6 pass + 3 integration skipped**，合计 **393 pass / 3 skip**。3项跳过不计为通过，服务端WS自动化不等于真实双端浏览器e2e。
- UI100采用 **AST真实生产类 + 严格mock**，覆盖生命周期、节点状态与绘制指令（含既有restart回归），非GPU/真实字体/实机；原型专项agent的 **10 scenario / 131状态 + 6门控** 为JS/节点替身验证，非Browser视觉。
- `pnpm typecheck` 与 `npx tsc --noEmit -p client/ac-majong/temp/tsconfig.check.json` 均通过；H5 CLI 显式 `startScene=01c1425f-8926-40e9-8f67-e149f5238405`（App）构建 **13:39 Finished，日志已核实**。构建成功不证明场景运行；同步脚本原位更新并保留既有.meta/UUID的说明见客户端网络层§8。
- **网关分支回归**：seating leave复用playerDisconnected与既有RoomActor收尾，不另写计时逻辑；新增4例真实WS回归，修复后WS **15/15**、服务端 **108/108**。独立`port:0`/内存存储，正式时长配合业务假时钟验证600ms代掷、既有offlineSince不延期、原60s期限托管、完整结果期、重入卸托管/座位/非零积分保留及waiting不变；服务端与测试文件严格类型检查通过。旧基线及失败复现保留于历史维护记录，当前全量结果以上述393/3为准。
- **必要验收证据外部阻塞**：浏览器连续三轮目标turn均 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`、hidden/attached=false，用户打开后仍不可用；`window.open`返回false，rAF暂停导致Cocos无scene（scene=null、无__AC__）。Cocos实机、1真人3Bot/2真人2Bot真实双端顺序/骰面/时长及截图对照均未完成，不宣称全Spec完成或100%视觉通过。
- **环境与回填边界**：用户原8080未重启；历史8093内存测试服务未被浏览器连通，不算e2e。本次仅更新文档，不操作Browser、启停服务或重跑测试/构建；详细修补与验证集中于 [BL-017流水](../5-backlog/README.md#bl-017-开局仪式与摸牌位骰实现与验证流水)，不归档。

---

## 14. 公开房间与大厅列表（BL-018，✅ 已实现 2026-09-18）

- **协议**：`RoomSettings` 增 `isPublic`（默认开；create 缺省字段网关补 true）；新增 `ClientMsg roomList{seq}`（仅登录态可拉）与 `ServerMsg roomList{rooms: PublicRoomEntry[]}`；`PublicRoomEntry = { room, host(房主昵称), seats(已入座含 Bot), maxRounds, status: waiting|playing, mine(拉列表者是否该房成员，2026-09-20 增：自己的房对局中/满员亦可重入) }`，无积分/隐私字段。`RoomManager.publicRooms(viewer)` 按请求者标记 mine（`RoomActor.isMember`）。
- **聚合**：`RoomActor.listEntry()` 仅 `isPublic !== false` 且 phase ∈ {waiting, seating, playing} 时返回（seating 归 waiting；finished/解散后房从 `rooms` 移除自然消失）；`RoomManager.publicRooms()` 等待先于对局中、同组按 `createdAt` 倒序、上限 20 行（FR-房间-11）。
- **刷新**：服务端不推送；客户端进大厅拉一次 + 5s 自动轮询 + 手动 🔄 钮（弱一致可接受，PRD03 §3.3）。
- **测试**：wsGateway.test 1 例（公开房在列且含房主/人数/局数/状态；非公开房不下发），server 67 例绿。

## 15. 结算事件补发（BL-026，✅ 已实现 2026-09-21）
- **问题**：结算浮层仅由终局事件（win/exhaustive/zhahu）驱动；重连/晚进入/晚挂载的客户端只拿到 settled/exhaustive 的 gameView 而拿不到已广播过的事件 → 无浮层、无「下一局」钮，房间看似卡死（用户报障：房 212817 round2 exhaustive 进入无反应）。
- **服务端**：`RoomActor.lastTerminal` 缓存本局终局事件（`noteTerminal` 于 handleAction 后）；新局（createTable/startNextRound 三处）清空；`resendSettlement(userId)` 仅在**成员 + 非仪式中（!seating）+ phase∈{settled,exhaustive}** 时返回。重连分支（addPlayer 既有座位）在 broadcastAll 后向该连接补发 `{t:'event',events:[lastTerminal]}`。
- **协议**：`ClientMsg.resendSettlement{seq}` → 命中回投 `{t:'event'}`，未命中 `ack ok:false`（覆盖晚挂载/在大厅错过事件后回牌桌等路径）；客户端 `TableScreen.render` 在 settled/exhaustive 且 `!v.seating` 且浮层缺失且本轮未请求过时发一次（`settleRound` 占位防重）。
- **不变式**：仪式/局间摸牌位骰进行中不补发（避免浮层盖住仪式 UI）；seatingCeremony 重入快照断言保持「最后一条为 roomView/gameView」。
- **测试**：diag.test 增 2 例（playing 不补发；全 Bot 局终局后成员可补发+重连连接收到 event+非成员 null），服务端 117 绿。

## 维护记录

历史流水按发生时点保留；文档先行及先前批次的测试/e2e/截图记录不作为本轮仪式验收结论。

| 日期 | 概要 |
|---|---|
| 2026-09-21 | **BL-017 定座位逐轮淘汰定序修订**：§13 选位骰同点判定改为仅本轮掷骰者（未定序组）内判重；RoomActor 新增 seatingSlots（有序槽位表：已定序座位+待决并列组）与 seatingRollers，resolveSeatingRolls 逐轮细化、已定序者不再参与判重/比大小；同步原型 cerSummarize 与展示文案；seatingCeremony 新增 3 例（撞点不重掷/块内定序/三轮细化）并修订连续重掷例，全量 engine179/UI100/server111/persistence6 通过、包与 Cocos assets 类型检查无新增错误 |
| 2026-09-20 | **BL-017 当前缺项修补与最终验证回填**：seating leave接入playerDisconnected并接续原60s，复用既有收尾/重入；最终全量engine179/UI100/server108/persistence6通过、3项integration跳过，合计393/3；包/Cocos类型检查通过，指定App场景H5 CLI13:39 Finished（日志已核实）。整体已修补当前发现缺项、浏览器视觉验收外部受阻，非全Spec完成；[BL-017详表](../5-backlog/README.md#bl-017-开局仪式与摸牌位骰实现与验证流水)集中记录，旧流水不倒写 |
| 2026-09-20 | **Spec 分支补齐·服务端验证**：仅改 wsGateway leave 的 seating 分支，复用 playerDisconnected 与既有 finalize 接续。新增真实 WS 4 例，旧分支 input/result 退出 2 例因缺 offline 失败，修复后服务端 104→108 pass、WS 11→15 pass；服务端 typecheck 及测试文件严格 tsc 通过。独立随机端口/内存存储，正式时长+业务假时钟验证600ms代掷、原60s期限、完整结果期、重入卸托管/座位/非零积分及 waiting；用户服务未重启，RoomActor 与其测试未改。本轮尚待项目全量汇总，浏览器仍待验收（§13.5） |
| 2026-09-20 | **Spec 分支补齐·文档先行**：§3/§13.4 对齐 PRD06，seating/playing 主动 leave 均复用 playerDisconnected，waiting、成员退出流水与会话清理不变；不重写 RoomActor finalize 接续，正式60s、600ms代掷、展示期及既有 offlineSince 均不延期/不压缩。拟补独立内存随机端口真实 WS 回归并跑服务端 test/typecheck；本轮尚待全量汇总，浏览器仍待验收 |
| 2026-09-20 | **BL-017 本轮实现收口（文档先行之后）**：protocol/server/CeremonyPanel/NetService/RoomScreen 与原型更新完成；逐家展示、真实双骰、重掷与门控、token/生命周期守卫已落地。首局仪式离线按最初 offlineSince+trusteeAfterMs 在 playing 接续剩余托管计时，重复 disconnect 不延期、不卸托管，60s 规则不变；addPlayer 既有成员重入先给本人权威 roomView（身份/玩法/仪式）再 broadcastAll，刷新局间无需 placeholder 推断 |
| 2026-09-20 | **BL-017 审查与配套维护**：一次 CodeReview 发现 restart 旧 playing 缓存被新增路由误用，NetService.restart 已修为 `this.leave()` 后 create，并补 3 个回归；sync-to-cocos 已改原位更新保留 .meta/UUID，技术正文与维护记录同步 |
| 2026-09-20 | **BL-017 已执行历史验证摘要（最新）**：既有 `pnpm test` 结果 engine 179 pass、persistence 6 pass + 3 integration skipped、client-core/UI 40 pass（AST 真实 Cocos 类/成员 + 严格 mock，非 GPU）、game-server 104 pass；`pnpm typecheck`、Cocos tsc、指定 startScene 的 H5 CLI Finished（12:54）通过。浏览器 hidden/attached=false 阻塞 Cocos 初始化，实机/双端浏览器/截图未完成；8080 未重启，8093 浏览器未连通，不计 e2e。以上为已执行历史结果，本轮网关分支补齐另记、尚待全量汇总，不宣称整个 Spec 完成（§13.5） |
| 2026-09-20 | **BL-017 逐家仪式文档先行**：§13纠正首局旧两掷为一次dealerBreak，定义optional presentation完整字段、毫秒时钟、逐家/重掷/汇总/定庄/局间门控、optional ceremonyToken透传与守卫、离线缩短期限及计子/建局一次性；旧兼容与宕机边界保留；列待执行测试，不宣称本轮业务实现或验收完成 |
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
| 2026-09-21 | **BL-026 结算事件补发**（用户报障：进入已结算房间无反应看似卡死）：新增 §15——lastTerminal 缓存+重连补发+`resendSettlement` 协议消息（仪式中不补）；PRD06 FR-断线-07、前端基座、backlog BL-026 同批；服务端 117 绿 |
| 2026-09-20 | BL-018 缺陷修复（重入报障）：`PublicRoomEntry` 增 `mine`（viewer 标记，`publicRooms(viewer)`+`isMember`）——自己的房对局中/满员在大厅列表显「重进」可点（BL-016 重绑口径）；wsGateway 测试补 mine 双端断言（11 例绿）；e2e：开局→刷新→自动重入+列表重进全绿 |
| 2026-09-18 | **BL-020 服务端**：`RoomSettings.chiFirstView`（默认 true，create/构造/恢复三处缺省补齐）；redact 增 settings 参——开关 ON 且响应窗内存在 chi pending 时向全桌 ViewState 下发 `pendingChi{seat,tiles,called}`（公开信息，防透视原则不冲突）；OFF 不下发、时序不变 |
