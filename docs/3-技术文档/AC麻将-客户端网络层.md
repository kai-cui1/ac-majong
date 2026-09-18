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
- `gameView` → 存 `view`，触发 `onGameView`；
- `event` → 触发 `onEvent`；`ack` → 触发 `onAck`；
- 最后遍历 `waiters`，命中谓词则 resolve 并移除。

**`waitFor(pred, timeout=5000)`**：先在 `received` 里找（支持「先收到后等待」的竞态），否则挂起等待，超时 reject。用于登录等待 `authOk`、测试等待特定消息。

**发送方法**（均 `send` + `nextSeq`）：`auth(token, profile?)` / `create(maxRounds=8, settings?)`（BL-017 携玩法设置） / `join(room)` / `leave()` / `start()` / `roll()` / `pickSeat(seat)`（BL-017 仪式掷骰/选座） / `nextRound()` / `action(action)` / `ping()` / `close()`。

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

### 5.2 BL-017 开局仪式与物理牌墙字段

- `RoomSettings { wallMode: 'physical'|'random', breakDice: boolean }`：建房参数，`RoomView.settings` 随房间视图下发（等待页展示/建房沿用）。
- `SeatingView { stage, rolls, reroll, order, picker, picked, dealerDice, dealerSeat, breakN, roller }`：仪式状态；开局仪式随 `RoomView.seating`（phase='seating'）下发，局间摸牌位骰随 `ViewState.seating`（stage='roundBreak'）下发；仪式结束后字段消失 = 客户端关闭遮罩。
- `ViewState.wallInfo { rows: {seat, stacks[18]}[], breakSeat, breakGroups }`：physical 模式四边牌墙栈高（0=已摸淡出/1=半高/2=满栈）+ 开牌点；random 模式无此字段（不渲染牌墙排）。
- 客户端仅收到骰点**和**（2..12），骰面展示按固定拆分 `d1=max(1,min(6,v-6))` 还原两骰。

## 6. `NetService`（Cocos 单例，`game/NetService.ts`）

封装 `GameClient`，向 UI 提供**订阅式回调**与**意图方法**，屏蔽传输细节。

- **单例**：`NetService.instance`（懒建）。
- **幂等连接** `connect(url, token, profile?)`：`if (this.client) return` —— 登录先建连，房间/牌桌沿用同一连接；内部 `new GameClient(new WebTransport(url), handlers)` → `connect()` → `auth(token, profile)` → `waitFor('authOk')`；`onAuth` 回调缓存 `profile`。
- **只读态**：`view` / `profile` / `userId` / `connected` getters。
- **订阅**：`onView(cb)` / `onRoom(cb)` / `onEvent(cb)`，屏幕注册后由对应 `ServerMsg` 广播驱动刷新。
- **断连** `disconnect()`：`client.close()` + 清 `client`/`_profile`（返回登录时调用）。
- **房间指令**：`createRoom(maxRounds=8, settings?)`（BL-017：玩法设置随建房下发，`lastSettings` 记忆供 `restart` 沿用） / `requestRoomList()`（BL-018：返回 `PublicRoomEntry[]`，等待器先注册再发送） / `joinRoom(room)` / `start()` / `roll()` / `pickSeat(seat)`（BL-017 仪式） / `nextRound()` / `restart(maxRounds=8)`（离开旧房 + 重新建房，服务端补 Bot 并开局）。
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

| 日期 | 概要 |
|---|---|
| 2026-09-16 | 首次产出（补记已实现网络层）：分层架构、`Transport` 抽象（WebTransport / WeChatTransport）、`GameClient`（状态 / `onMsg` 分派 / `waitFor` / 发送方法 / handlers）、协议与防透视、`NetService` 单例（幂等连接 / 订阅 / 动作透传）、客户端机器人 `bot.ts`、`vendor` 预编译同步（`pnpm sync:client`）、登录与对局端到端数据流、待办（M-K 微信传输 / M-I 重连）|
| 2026-09-17 | M-I：RoomView seats 增 `offline`/`trusteed` 字段（协议同步 vendor）；NetService 自动重连与 `onReconnect` 订阅见前端基座 §11 |
| 2026-09-17 | 补记视图增补字段（§5.1）：`ViewState.names` 昵称下发；台数预览 `previewTai` 为客户端接引擎本地计算（非协议字段） |
| 2026-09-17 | §5.1 补 `you.drawn`：刚摸的牌下发（仅自己回合 discard 相位），供摸牌抽出抬高显示 |
| 2026-09-18 | **BL-016**：`joinRoom` 兼容重进「对局中」房间（服务端直接下发 gameView 无 roomView：等待器先注册再发送，ack ok:true 后补等视图；gameView 视为加入成功）；`lastGameViewAt` 时间戳供大厅判定切牌桌；`leave` 清陈旧 view/room 缓存防误判 |
| 2026-09-18 | **BL-017 开局仪式与摸牌位骰**：新增 §5.2——`ClientMsg` 增 `roll`/`pickSeat`/`create.settings`；`RoomView.settings/seating`、`ViewState.wallInfo/seating` 视图字段；`GameClient.roll()/pickSeat()/create(maxRounds, settings?)`；`NetService.createRoom` 带设置 + `lastSettings` 供 `restart` 沿用；骰面和固定拆分展示约定 |
| 2026-09-18 | **BL-018 公开房间列表**：`GameClient.requestRoomList()`（`t=roomList`）；`NetService.requestRoomList()` 返回 `PublicRoomEntry[]`；大厅 onEnter 拉一次 + 5s 轮询、onExit 清定时器；建房弹层增「公开房间」开关（默认开）随 settings 下发 |
