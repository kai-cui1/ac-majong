# A&C 麻将 · 客户端网络层（技术方案）

> **模块**：平台无关客户端核心 `packages/client-core/` + Cocos 侧网络单例 `NetService` + `vendor/` 预编译同步。
> **关联**：总体架构 [`AC麻将-联机架构方案.md`](./AC麻将-联机架构方案.md)（决策 3 传输抽象 / 决策 A 预编译同步）｜协议与服务端 [`AC麻将-服务端网关与房间.md`](./AC麻将-服务端网关与房间.md)｜登录链路 [`AC麻将-登录鉴权.md`](./AC麻将-登录鉴权.md) §5.2｜前端基座 [`AC麻将-前端基座与设计系统.md`](./AC麻将-前端基座与设计系统.md)
> **产品**：全局通信约定见 [`../1-prd/00-产品总览.md`](../1-prd/00-产品总览.md)。
> 遵循[《文档总纲》](../README.md)三原则：本文件为客户端网络层模块的全量技术说明。

---

## 1. 目标与范围

- **平台无关**：网络核心只依赖 `Transport` 抽象，微信小游戏与 Web/HTML5 共用同一套 `GameClient`（架构决策 3）。
- **服务端权威下的瘦客户端**：客户端只发送意图（动作/房间指令）、接收裁剪后的视图与事件，不含任何规则判定。
- **预编译 + 同步**：monorepo 核心包（engine/protocol/client-core）以源码同步进 Cocos 工程 `vendor/`，规避 Cocos 无 workspace 包解析的限制（架构决策 A）。
- 本文覆盖 `Transport` / `GameClient` / `NetService` / 客户端机器人 / `vendor` 同步 / 端到端数据流；协议字段定义以 [`packages/protocol`](../../packages/protocol/src/index.ts) 为准。

## 2. 分层架构

```
业务屏幕 (LoginScreen / LobbyScreen / TableView …)
        │  订阅回调 / 调用意图方法
        ▼
NetService（Cocos 单例，game/NetService.ts）
        │  封装
        ▼
GameClient（平台无关，client-core/client.ts）
        │  只依赖
        ▼
Transport（抽象，client-core/transport.ts）
   ├─ WebTransport     全局 WebSocket（Web / Node / 本地联调）
   └─ WeChatTransport  wx.cloud.connectContainer（微信云托管，M-K 实机）
        ▲
        │  跨包类型（Action / ViewState / ClientMsg …）经 vendor 预编译同步引入
   packages/protocol · packages/engine
```

## 3. `Transport` 抽象（`client-core/transport.ts`）

```ts
interface Transport {
  connect(): Promise<void>;
  send(data: string): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (code?: number, reason?: string) => void): void;
  close(): void;
}
```

| 实现 | 载体 | 环境 | 要点 |
|---|---|---|---|
| `WebTransport` | 全局 `WebSocket` | 浏览器 / Node ≥22 / 本地联调 | 无全局 `WebSocket` 则 `reject`；`onmessage` 统一转字符串 |
| `WeChatTransport` | `wx.cloud.connectContainer` | 微信小游戏云托管 | 以 `globalThis.wx` **弱引用**，非微信环境不报错；返回标准 `socketTask`，免配域名 |

- 传输层只搬运字符串，不做 JSON 解析/序列化（交给 `GameClient`），保持职责单一。

## 4. `GameClient`（`client-core/client.ts`）

平台无关的对局客户端，持有一个 `Transport` 与一组 `handlers`。

**内部状态**：`seq`（自增序号）、`received`（已收消息，供 `waitFor` 回溯）、`waiters`（等待队列）、`view`/`room`/`userId`/`profile`（最新快照）。

**收消息 `onMsg`**：入 `received` → 按 `t` 分派：
- `authOk` → 存 `userId`/`profile`，触发 `onAuth`；
- `roomView` → 存 `room`，触发 `onRoomView`；
- `gameView` → 存 `view`，触发 `onGameView`；仅在 `room` 为空时合成房号/路由用占位 room，兼容仅发 gameView 的旧服务端。新版既有成员重入先收到权威 roomView 再按相位收到后续视图，不用占位资料推断身份、玩法或仪式；
- `event` → 触发 `onEvent`；`ack` → 触发 `onAck`；
- 最后遍历 `waiters`，命中谓词则 resolve 并移除。

**`waitFor(pred, timeout=5000)`**：先在 `received` 里找（支持「先收到后等待」的竞态），否则挂起等待，超时 reject。用于登录等待 `authOk`、测试等待特定消息。

**发送方法**（均 `send` + `nextSeq`）：`auth(token, profile?)` / `create(maxRounds=8, settings?)`（BL-017 携玩法设置） / `join(room)` / `leave()` / `start()` / `roll(ceremonyToken?)` / `pickSeat(seat, ceremonyToken?)`（BL-017 仪式掷骰/选座；本轮已实现签名见 §5.2） / `nextRound()` / `action(action)` / `ping()` / `close()`。

**`handlers`**：`onAuth` / `onGameView` / `onRoomView` / `onEvent` / `onAck` / `onClose`，均可选。

## 5. 协议（`packages/protocol`）

- **客户端 → 服务端 `ClientMsg`**：`auth` / `create`（BL-017 可选 `settings`） / `join` / `leave` / `start` / `roll` / `pickSeat`（BL-017 仪式） / `nextRound` / `action` / `ping`（均带 `seq`）。
- **服务端 → 客户端 `ServerMsg`**：`authOk` / `roomView` / `gameView` / `event` / `legal` / `ack` / `pong` / `error`。
- **视图**：`ViewState`（牌桌）/ `RoomView`（房间）/ `UserProfile`（资料）。
- **防透视关键**：`ViewState.you.concealed` 给完整暗牌；`others[]` 只给 `concealedCount`，**绝不含具体牌**。裁剪在服务端 `redact` 完成（见[服务端网关与房间](./AC麻将-服务端网关与房间.md)）。
- 协议再导出 `Action`/`GameEvent`/`ActionKind`/`Meld`，客户端无需直接依赖 engine 即可取类型。

### 5.1 视图增补字段（M-D/M-F）

- 终局事件 `win`/`exhaustive`/`zhahu` 均带 `revealed: Record<seat, concealed>`（各家终局暗牌），供客户端终局摊牌渲染（前端基座 §11）。
- `ViewState.names`：各家昵称（服务端经 `roomActor`/`redact` 下发），牌桌 pinfo 直接显示，不再用座位号占位。
- `ViewState.you.drawn`：刚摸的牌（服务端 redact 从 `state.lastDrawn` 取，仅自己回合 discard 相位下发；`concealed` 已含该牌），供客户端抽出抬高显示。
- 台数预览 `previewTai`：**非协议字段**，由客户端接引擎 `previewTai`（听牌时按自摸最佳听张复用 `scoreHand`）本地计算，渲染「💡 N台」徽章与明细浮层。

### 5.2 BL-017 开局仪式与摸牌位骰 contract（2026-09-20：已修补当前发现缺项，浏览器视觉验收受阻）

#### 5.2.1 业务视图与兼容性

- `RoomSettings { wallMode: 'physical'|'random', breakDice: boolean }` 继续随 `RoomView.settings` 下发；选位恒开。首局A**一次骰同时定庄与开牌点**，`breakDice`仅控制局间仪式，不恢复旧的两掷流程。
- `SeatingView.stage` 保留 `roll | pick | dealerBreak | roundBreak`；兼容旧 `rolls/reroll/order/picker/picked/dealerDice/dealerSeat/breakN/roller/ziCounts` 业务字段，新增 **optional `presentation`**。开局取最新 `RoomView.seating`（room phase=seating）；局间取当前 `ViewState.seating`（stage=roundBreak）。只有权威快照已清除仪式才关闭遮罩，不能在本地倒计时归零时擅自发牌/清场。
- `RoomView.seats[].nickname` 为昵称主来源；`userId`用于稳定身份匹配及识别自己，机器人身份以 `isBot` 标记为准，不从ID字符串推断；座号不是稳定身份。首局不能让上局缓存的 `ViewState` 覆盖最新房间座位；局间当前庄家徽章使用当前 `ViewState.dealerSeat`，不依赖首局临时变量。
- **新版重入顺序**：`RoomActor.addPlayer` 对既有成员重绑、清离线/托管后，先向本人补完整 `roomView`（seats 身份/昵称/isBot、settings 玩法/墙模式、seating 当前仪式），再 `broadcastAll`；playing 时后者发送 `gameView`。因此局间刷新已拥有权威身份与玩法，不能概括成「重入只有 gameView」。旧服务端 gameView-only 路径仍由 GameClient 合成占位 room、NetService 补记记忆房，仅为历史兼容。
- `ViewState.wallInfo { rows: {seat, stacks[18]}[], breakSeat, breakGroups }`：physical 模式栈高0=已摸留缺口、1=半透、2=满栈；跳区常色牌背。仪式墙条从视觉右端跳N组、第N+1组开摸；random无物理墙条与虚构开牌位置。

#### 5.2.2 presentation 完整字段（时间戳与时长一律ms）

| 字段 | 契约 |
|---|---|
| `ceremonyId` / `stepId` | `string`仪式ID / `number`仪式内单调递增步骤ID；新仪式换ID，重复广播不换步骤 |
| `startedAt` / `deadline` / `serverNow` | `number`服务端Unix毫秒：步骤实际进入/步骤到期/快照采样时刻 |
| `phase` | `input \| rolling \| result \| summary`，独立于业务stage |
| `actor` | `{userId:string,seat:Seat} \| null`；输入/滚动/结果指当前操作者，汇总为null |
| `rerollRound` | `number`；初轮0，每次开始新的重掷队列递增 |
| `pendingRollUserIds` | `string[]`，稳定用户ID的待揭晓队列，包含当前输入/滚动者，落定移出；同点汇总带下一轮队列，非选位阶段为空 |
| `resultsByUserId` | 用户ID→`{d1:number,d2:number,sum:number,rerollRound:number}`；已揭晓两骰与总和，d1/d2各1..6，sum=d1+d2；重掷保留旧值至本人再次落定 |
| `ceremonyDice` | `{d1:number,d2:number,sum:number} \| null`；定庄/局间已揭晓双骰；输入/滚动为null |
| `summaryKind` | `ranking \| reroll \| seated \| null`，只在summary设置，其余null |

- 新版服务端每次发送完整presentation，滚动时不下发新终值，落定才同步两骰和旧总点数；全桌最终骰面必须一致。**不再采用从和固定拆分骰面的约定**，本地随机只用于90ms间隔的中间帧。
- 同点提示持续2000ms；旧结果标「上次／待重掷」，按队列/轮次（必要时结合兼容reroll名单）保留到本人再次落定；每轮以全体最新和判同点，不能在客户端擅自用座序打破平局。

#### 5.2.3 发送意图与步骤token

- `roll`、`pickSeat` 消息均保留 `seq`，后者保留 `seat`；新增 **optional `ceremonyToken:{ceremonyId:string,stepId:number}`**。`GameClient.roll(ceremonyToken?)`、`pickSeat(seat,ceremonyToken?)` 与 `NetService` 同名方法原样透传，网关→RoomActor继续透传并权威校验。
- 有presentation的新版客户端**必传当前显示的输入步骤token**；每个新step对持续存在的掷骰/四座按钮先 `Node.off` 移除TOUCH_START/TOUCH_END/TOUCH_CANCEL监听，再 `Node.on` 绑定捕获 `{ceremonyId,stepId}` 的闭包，相同步骤不重绑。TOUCH_START记录起始step，TOUCH_CANCEL清手势；真实TOUCH_END若起始step不匹配当前绑定token则丢弃，不能在回调执行时换取新token。submit再次校验token、actor、input、期限与本步未提交，**disposed后旧回调无效**；dispose清手势/计时器并销毁根节点。仅本人有效输入期启用，发出立即本地禁用，仍以服务端ack/新快照为准，拒绝不重置倒计时。
- 服务端校验当前actor、业务stage、input、期限、token及座位；拒绝重复、提前、迟到、越权/旧步骤请求。旧端不带token只保留基本身份/阶段/期限守卫，不能保证跨步骤防重放。
- 旧服务端没有presentation时，新端已实现**静态降级**：选位卡只显示旧总点数与「旧版仅提供总点数」，定庄/局间仅显示「总点数 N 点」；不从总和拆分两骰、不伪造真实骰面或制造本地正式流程，旧接口允许省token。此处缺presentation与§5.2.1的gameView-only占位房间兼容是不同边界；完整新体验要求前后端同步升级。

#### 5.2.4 时序、缓存与恢复

- 服务端时长：真人input **10000ms**；Bot/离线/托管 **600ms**；逐家rolling **1200ms**→result **2000ms**；ranking/reroll summary **2000ms**；seated summary **1500ms**；dealerBreak/roundBreak rolling **1200ms**→result **3000ms**。200ms落定缩放、1000ms庄光包含在结果期。服务端每段进入时重新起算，不因上一回调延迟压缩下一段。
- 收快照时记录 `serverNow` 与本地单调时钟采样值，估算 `当前服务端时间=样本serverNow+(本地单调现在-接收时单调值)`，剩余 `max(0,deadline-估算当前时间)`；弱网样本存在传输误差，仅供显示，期限与推进始终由服务端裁定。
- 相同 `ceremonyId+stepId` 的重复广播更新数据/时钟样本但**不重启Tween、面板入场或倒计时**；同一步骤离线缩短deadline可立即应用，不得让进度/倒计时倒退或延长期限。较旧步骤忽略，旧仪式延迟回调不得覆盖当前仪式。
- `RoomScreen.onEnter`/切页路由检查已缓存仪式，覆盖首条广播早于订阅；playing 快捷路由还须确认缓存对局房号匹配当前房间。`TableScreen` 内 `CeremonyPanel` 保留仪式根节点，按用户ID/步骤增量更新。首局优先最新RoomView，局间使用当前ViewState的庄家/子数及权威RoomView的身份/玩法，选座重排更新身份映射与actor.seat。
- **重开缓存隔离**：`NetService.restart(maxRounds=8)` 调 `this.leave()` 清 `client.view/client.room/ceremonyClock`，再 `client?.create(maxRounds, lastSettings)`；不能仅调用底层 `client.leave()` 留下旧 playing 缓存，供新增路由误用。保留连接及玩法设置；无连接时仍清时钟且不创建房间。此问题由一次 CodeReview 指出并已修复，3 个 restart 回归包含在最终 client-core/UI 100 项内，不另行加总；此前维护记录的旧数字保留。
- 重连/后台回前台只恢复当前步骤与剩余进度；已落定立即显示真实结果，不补播历史。缺终值且本地预计期限已过，停在等待权威更新态，不推断骰面、不自行推进。退出/结束取消本页Tween与计时回调，disposed标志使已捕获的旧提交闭包及后续update/tick失效。
- 服务器在完整结果期后才清仪式、建局/发牌并启动新局Bot；客户端不增跳过、倍速、全员确认。首局仪式主动leave与掉线均经 `playerDisconnected` 保留最初 `offlineSince`，发牌进入 playing 后按 `max(0, offlineSince + trusteeAfterMs - 当前时间)` 接续托管剩余等待；重复 disconnect 不延后，正式 60s 规则不变（网关 §13.4）。在线内存仪式重连恢复不等于宕机持久化恢复，本轮不扩展后者。
- 核心包修改后经 `pnpm sync:client` 同步，禁止手改vendor生成副本；`sync-to-cocos.mjs` 已改为原位更新 `.ts` 并保留既有 `.meta`/UUID，详见 §8。类型检查入口为 `pnpm typecheck` 与 `npx tsc --noEmit -p client/ac-majong/temp/tsconfig.check.json`。本次仅回填已完成实现/验证记录，不执行同步、测试、构建或业务编码。

#### 5.2.5 本轮验证结果与未完成边界

- **已修补当前发现缺项，浏览器视觉验收受阻**：兼容总点数显示、每step闭包/跨步触摸守卫及当前明确表现缺项已修补，非全Spec完成。主助手最终实际执行 `pnpm test`：engine **179 pass**、client-core/UI **100 pass**、game-server **108 pass**、persistence **6 pass + 3 integration skipped**，合计 **393 pass / 3 skip**；跳过项不计为通过。
- UI100从AST抽取真实 `CeremonyPanel` 及相关生产类成员，配严格mock检查生命周期、节点状态与绘制指令（含既有restart回归），**非GPU/真实字体/实机渲染**。原型专项agent为 **10 scenario / 131状态 + 6门控** 的JS/节点替身验证，非Browser视觉，不与393项重复加总。
- `pnpm typecheck`、上述Cocos tsc均通过；H5 CLI显式 `startScene=01c1425f-8926-40e9-8f67-e149f5238405`（App）构建 **13:39 Finished**，日志已核实；构建成功不证明场景已运行。
- 浏览器连续三轮目标turn均 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`、hidden/attached=false，用户已打开仍不可用；`window.open`返回false，rAF暂停导致Cocos无scene（scene=null、无__AC__）。**必要验收证据无法生成，属外部阻塞；Cocos实机、真实双端与截图对照未完成**，不得宣称全Spec或100%视觉通过。用户8080未重启；历史8093内存服务浏览器未连成功，不计e2e。完整修补/验证见 [BL-017详表](../5-backlog/README.md#bl-017-开局仪式与摸牌位骰实现与验证流水)，本次仅文档回填，不重跑验证。

## 6. `NetService`（Cocos 单例，`game/NetService.ts`）

封装 `GameClient`，向 UI 提供**订阅式回调**与**意图方法**，屏蔽传输细节。

- **单例**：`NetService.instance`（懒建）。
- **幂等连接** `connect(url, token, profile?)`：`if (this.client) return` —— 登录先建连，房间/牌桌沿用同一连接；内部 `new GameClient(new WebTransport(url), handlers)` → `connect()` → `auth(token, profile)` → `waitFor('authOk')`；`onAuth` 回调缓存 `profile`。
- **只读态**：`view` / `profile` / `userId` / `connected` getters。
- **订阅**：`onView(cb)` / `onRoom(cb)` / `onEvent(cb)`，屏幕注册后由对应 `ServerMsg` 广播驱动刷新。
- **断连** `disconnect()`：`client.close()` + 清 `client`/`_profile`（返回登录时调用）。
- **房间指令**：`createRoom(maxRounds=8, settings?)`（BL-017：玩法设置随建房下发，`lastSettings` 记忆供 `restart` 沿用） / `requestRoomList()`（BL-018：返回 `PublicRoomEntry[]`，等待器先注册再发送） / `joinRoom(room)` / `start()` / `roll(ceremonyToken?)` / `pickSeat(seat, ceremonyToken?)`（BL-017 本轮已实现签名，见 §5.2） / `nextRound()` / `restart(maxRounds=8)`（先 `this.leave()` 清旧视图/仪式时钟，再沿用玩法 create；见 §5.2.4）。
- **动作透传**（`seat` 由调用方按 `view.you.seat` 提供，客户端不判定合法性）：`draw` / `discard` / `declareWin` / `kongConcealed` / `kongAdded` / `respond(move, chiTiles?)`。

> 登录页如何用 `NetService.connect` + `Config.mockIdentity` 完成登录，见[登录鉴权 §5.2–5.4](./AC麻将-登录鉴权.md)。

## 7. 客户端机器人（`client-core/bot.ts`）

- `pickDiscard(view)`：骨架策略——打暗牌第一张（生产可换安全牌/听牌策略）。
- `botStep(client)`：按当前 `view` 决定并发送一个动作（能胡则胡 → 否则摸/打/过），返回是否发出动作。
- 用途：本地演示与联调时驱动空位；**与服务端 `devBots` 区分**——服务端 Bot 见[服务端网关与房间](./AC麻将-服务端网关与房间.md)。

## 8. `vendor` 预编译同步（`scripts/sync-to-cocos.mjs`）

Cocos 工程不识别 `@ac-majong/*` workspace 包，故以脚本把核心包源码同步进工程：

- **同步范围**：`engine` / `protocol` / `client-core` 的 `packages/<pkg>/src/*.ts` → `client/ac-majong/assets/scripts/vendor/<pkg>/`。
- **重写 import**：`rewriteImports` 把 `'@ac-majong/<pkg>'` 改写为相对 `vendor/<pkg>/index` 的路径，使 Cocos 自带 TS 编译可直接处理。
- **原位更新与资源身份（2026-09-20）**：`syncPkg` 在既有目标目录逐个更新生成 `.ts`，不再删除并重建整个目录；保留已有 `.meta` 及其中 UUID，避免同步破坏 Cocos 资源引用。保留的是同步时已有的资源身份，不承诺恢复此前已变化的 UUID，也不代表 GPU/运行时验证通过。
- **同步素材**：`docs/2-效果图/.../res/tiles/*.png` → `assets/resources/tiles/`（供 `resources.load`）。
- **触发**：`pnpm sync:client`（根 `package.json`）。改动核心包后须重新同步，Cocos 侧方能生效。
- Cocos 侧引入示例：`import { GameClient, WebTransport } from './vendor/client-core/index';`

## 9. 端到端数据流

**登录**：
```
LoginScreen → Config.mockIdentity() → NetService.connect(SERVER_URL, token, profile)
  → GameClient.connect()（Transport 建连） → auth(token, profile)
  → 服务端校验 + upsertUser + saveSession → authOk{userId, profile}
  → GameClient.onMsg 存 profile + waitFor('authOk') 兑现 → 进大厅
```

**对局**（登录沿用同一连接）：
```
TableView 交互 → NetService.action(seat, …) → GameClient.action(Action)
  → 服务端 roomActor 合法性校验 + engine.applyAction → gameView(裁剪) + event
  → GameClient.onMsg 分派 → NetService.onView/onEvent 广播 → 屏幕刷新
```

## 10. 待办与边界

- **微信实机传输**：`WeChatTransport` 云托管 `connectContainer` 实机联调、`SERVER_URL` 换 WSS → **M-K**。
- **断线重连**：`onClose` 后以「服务端签发 session token + 房间快照」恢复对局 → **M-I**（当前 `token` 为客户端 mock，见[登录鉴权 §4.3](./AC麻将-登录鉴权.md)）。
- **发送可靠性**：`seq`/`ack` 已具雏形，重发与乱序去重随 M-I 完善。
- **机器人策略**：`bot.ts` 为骨架，正式托管 AI 策略另行设计（PRD 06 断线重连与托管）。

---

## 维护记录

历史流水按发生时点保留；文档先行的待实现、旧服务端 gameView-only 修复及历史 e2e 不作为新版当前行为或本轮验收结论。

| 日期 | 概要 |
|---|---|
| 2026-09-20 | **BL-017 当前缺项修补与最终验证回填**：legacy仅显总点数；新step由Node.off/on重绑捕获token，跨步touch与disposed旧回调拒绝；seating主动leave接续原离线期限。最终393 pass/3 skip（UI100）、包/Cocos类型检查通过，H5指定App场景13:39 Finished（日志已核实）；浏览器视觉验收外部受阻、整体未验收，详见 [BL-017流水](../5-backlog/README.md#bl-017-开局仪式与摸牌位骰实现与验证流水)。仅文档回填，历史记录不倒写 |
| 2026-09-20 | **BL-017 本轮实现收口（文档先行之后）**：protocol/server/CeremonyPanel/NetService/RoomScreen 实现及原型更新完成；presentation、ceremonyToken、单调时钟、缓存早到路由与恢复已接线。新版 addPlayer 既有成员重入先给本人权威 roomView（身份/玩法/仪式）再 broadcastAll，局间刷新不靠 placeholder 猜真人/Bot/墙模式；旧服务端兼容说明保留。首局离线托管按原 offlineSince+trusteeAfterMs 接续，非改 60s 规则 |
| 2026-09-20 | **BL-017 审查修复与同步维护**：一次 CodeReview 指出 restart 旧 playing 缓存被新增路由误用，NetService.restart 改为 `this.leave()` 后 create，3 个回归覆盖默认/指定局数、缓存先清与设置沿用、无连接；sync-to-cocos 改原位更新源码、保留既有 .meta/UUID，正文 §8 同步 |
| 2026-09-20 | **BL-017 本轮验证收口**：最终主助手 `pnpm test` 实跑 engine 179 pass、persistence 6 pass + 3 integration skipped、client-core 37 pass（AST 真实 Cocos 类/成员 + 严格 mock，非 GPU）、game-server 104 pass；`pnpm typecheck`、Cocos tsc 通过；H5 CLI 指定 startScene 构建 Finished（12:28）。浏览器 hidden/attached=false 与 NATIVE_BROWSER_VIEWPORT_UNAVAILABLE 阻塞，JS 导航不等于 Cocos 初始化成功；实机/双端浏览器/截图未完成。8080 未重启，8093 浏览器未连通，不计 e2e；状态为「实现完成，视觉联验受阻/待完成」，详见 §5.2.5。本次仅回填文档，未重跑验证 |
| 2026-09-20 | **BL-017 文档先行**：§5.2重写为四业务阶段+optional presentation完整字段、毫秒时钟与稳定用户ID；roll/pickSeat的optional ceremonyToken贯通目标签名；移除正文从总和造骰面约定，明确旧端静态降级、重复广播不重播、缓存早到、选座身份重排与重连恢复；待业务实现和双端联验，保留既有重入修复记录 |
| 2026-09-16 | 首次产出（补记已实现网络层）：分层架构、`Transport` 抽象（WebTransport / WeChatTransport）、`GameClient`（状态 / `onMsg` 分派 / `waitFor` / 发送方法 / handlers）、协议与防透视、`NetService` 单例（幂等连接 / 订阅 / 动作透传）、客户端机器人 `bot.ts`、`vendor` 预编译同步（`pnpm sync:client`）、登录与对局端到端数据流、待办（M-K 微信传输 / M-I 重连）|
| 2026-09-17 | M-I：RoomView seats 增 `offline`/`trusteed` 字段（协议同步 vendor）；NetService 自动重连与 `onReconnect` 订阅见前端基座 §11 |
| 2026-09-17 | 补记视图增补字段（§5.1）：`ViewState.names` 昵称下发；台数预览 `previewTai` 为客户端接引擎本地计算（非协议字段） |
| 2026-09-17 | §5.1 补 `you.drawn`：刚摸的牌下发（仅自己回合 discard 相位），供摸牌抽出抬高显示 |
| 2026-09-18 | **BL-016**：`joinRoom` 兼容重进「对局中」房间（服务端直接下发 gameView 无 roomView：等待器先注册再发送，ack ok:true 后补等视图；gameView 视为加入成功）；`lastGameViewAt` 时间戳供大厅判定切牌桌；`leave` 清陈旧 view/room 缓存防误判 |
| 2026-09-18 | **BL-017 开局仪式与摸牌位骰**：新增 §5.2——`ClientMsg` 增 `roll`/`pickSeat`/`create.settings`；`RoomView.settings/seating`、`ViewState.wallInfo/seating` 视图字段；`GameClient.roll()/pickSeat()/create(maxRounds, settings?)`；`NetService.createRoom` 带设置 + `lastSettings` 供 `restart` 沿用；骰面和固定拆分展示约定 |
| 2026-09-18 | **BL-018 公开房间列表**：`GameClient.requestRoomList()`（`t=roomList`）；`NetService.requestRoomList()` 返回 `PublicRoomEntry[]`；大厅 onEnter 拉一次 + 5s 轮询、onExit 清定时器；建房弹层增「公开房间」开关（默认开）随 settings 下发 |
| 2026-09-20 | **重入缺陷修复（BL-016/BL-018 联动）**：对局中重进服务端仅发 gameView（无 roomView）——①client-core `GameClient` 在 gameView 且 room 为空时合成占位 room（`phase:'playing'`+房号，修 `joinRoom` 返回 null 致大厅点「重进」抛错卡死）；②`NetService.onGameView` 补记 `lastRoom`+持久化记忆房（变更时才写）；③大厅重进钮判定升级 mine 双源（服务端 `PublicRoomEntry.mine` 权威标记跨设备 + 本地 `storedLastRoom()` 兼容旧服务端）；e2e：建房→3Bot 开局→刷新自动重入→大厅「重进」回牌桌全绿 |
