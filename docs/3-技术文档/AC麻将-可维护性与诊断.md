# AC麻将-可维护性与诊断（BL-022 / BL-023 / BL-024）

> 文档先行（2026-09-21）：本方案源自近期联调/实报问题的反推——「服务端沉默无从定位」「客户端崩溃只有截图」「想复现某一局拿不到数据」。P0 取四类能力中各两件：服务端自检+停滞看门狗（BL-022）、客户端错误遥测（BL-023）、单局回放包导出（BL-024）；其余（时序压缩/repro CLI/手牌导出/契约与生命周期测试）归 BL-025 路线图。BL-023 玩家侧「复制诊断包」已随设置弹层+原型 settings.html 落地（2026-09-21）；BL-024 玩家/仲裁侧导出 UI 改挂 Admin 子系统（BL-015），客户端不做入口。

## 1. 设计目标

| 目标 | 对应能力 | 解决的典型场景 |
|---|---|---|
| 卡住/沉默时知道「在等谁、其 legal、卡在哪」 | BL-022 inspect + 停滞看门狗 | 全自动局疑似停滞、仪式/响应期无推进 |
| 报错时拿得到上下文而非截图 | BL-023 诊断包 | 局中 TypeError（如 CdBar 销毁竞态） |
| 任意一局可离线确定性重演/申诉取证 | BL-024 回放包 | 复现争议局、回归某局 UI 序列 |

## 2. BL-022 服务端自检与停滞看门狗

### 2.1 `RoomActor.inspect()`（权威状态 dump）
一次返回定位所需全部状态，**不含令牌/密码**：
- `room/phase/maxRounds/settings/names/seats`；
- `game`：`round/phase/currentSeat/wallLen/legalBySeat[4]`（各家当前合法动作，直接回答「在等谁、能做什么」）；
- `seating`：`stage/rolls/reroll/order/picker/dealerSeat/breakN/roller` + 逐轮淘汰槽位表 `slots`（已定序座位+待决并列组）+ `presentation{stepId,phase,actor,rerollRound,pending}`；
- `timers`：`trusteePending/offlineSince/seatingInputActive`；
- `stall`：`lastActionAt/idleMs`（playing 时距最近一次成功动作的毫秒，**按需计算、不依赖看门狗启用**）。

### 2.2 停滞看门狗
- 进入 playing（finalizeCeremony / beginNextRoundWithBreak）时 `armStallWatchdog()`；成功 `handleAction` 重置计时；散场/回收 `stopStallWatchdog()`。
- 阈值 `RoomTimings.stallWatchdogMs`，**默认 0=不启用**（保护既有「零遗留定时器」测试不变式）；服务端经 `STALL_WATCHDOG_MS`（默认 20000）启用。
- 超阈无动作仅 `log.warn` 一次（含 room/round/phase/curSeat/expected/legal/wallLen/idleMs），不广播、不影响对局；有新动作后再次停滞可再告警。

### 2.3 dev 自检 HTTP（`DEV_TOOLS=1` 才启动，端口 `DEV_HTTP_PORT` 默认 port+1）
| 端点 | 作用 |
|---|---|
| `GET /dev/rooms` | 活跃房 id+phase |
| `GET /dev/room/:id` | `inspect()` dump |
| `GET /dev/export/:gameId` | 单局回放包（见 §4） |
不做鉴权、仅本地诊断；生产不启用该端口。实现见 `apps/game-server/src/diag.ts`。

## 3. BL-023 客户端错误遥测（Diag）
- `client/.../app/Diag.ts`：`install()` 挂 `window.onerror` / `unhandledrejection`（WX 无 window 静默降级）；报错时记录 `{at,msg,stack,ctx,ring}`（cap 5）并持久化 `sys.localStorage['ac-diag']`。
- 上下文 `ctx` 由屏幕喂入：TableScreen.render 每次设 `{screen,room,round,phase,cur,mySeat}`；`ring` 为最近消息/视图相位环（cap 60）。
- 取出：dev/自动化 `__AC__.diag.dump()` / `__AC__.diag.copy()`（web 顺带写剪贴板）。玩家侧出口：设置弹层「复制诊断包」（FR-设置-05）→ `Diag.copy()`，回显「已复制诊断包 ✓」2s；原型 settings.html 同批增钮。

## 4. BL-024 单局回放包（ReplayBundle）
- 协议：`ClientMsg.exportReplay{gameId}` → `ServerMsg.replayBundle{bundle}`；成员校验同 replayLoad（参赛四方可导，D-29）。`NetService.exportReplayBundle(gameId)` 返回 `ReplayBundle`。
- `ReplayBundle = { v:1, exportedAt, room{id,maxRounds,settings,seating}, game{gameId,roundNo,dealerSeat}, snapshot, actions, names }`。
- **离线可确定性重演**：`snapshot.wall` 自带整副洗好的墙，重放 `actions` 无需 seed；`settings`/`seating` 随包带出，避免「不知道当时开了什么开关」。
- 组装自事件溯源存储（getGame/getInitialState/listActions/listMemberEvents/getRoom），见 `diag.ts buildReplayBundle`；dev 亦可 `GET /dev/export/:gameId`。
- 玩家/仲裁侧导出 UI 改挂 Admin 子系统（BL-015）完成；客户端仅保留 `NetService.exportReplayBundle` API 与 dev 端点，不做玩家入口。

## 5. 排查手册
1. **局卡住/沉默**：`curl :DEV/dev/room/<房号>` → 看 `game.phase/currentSeat/legalBySeat` 与 `stall.idleMs`；服务端日志搜「停滞看门狗」。
2. **客户端报错**：让用户/自测 `__AC__.diag.copy()` 贴诊断包（含 ctx+ring+历史 errors）。
3. **复现某一局**：成员端 `exportReplayBundle(gameId)` 或 dev `/dev/export/<gameId>` → 得 ReplayBundle → 离线 rehydrate+applyAction 重放（或喂 repro CLI，BL-025）。

## 6. 与 Admin 后台的集成（BL-015）

> 这三类能力原为 dev/客户端自救手段；运营化后部分能力入 Admin 后台（详见 [Admin 后台技术方案](./AC麻将-Admin后台技术方案.md) §10、PRD [10-Admin后台](../1-prd/10-Admin后台.md)）。

| 能力 | Admin 集成 | 阶段 | 关键改动 |
|---|---|---|---|
| **BL-024 回放包** | 回放仲裁页「导出回放包」（申诉取证）与 Admin 回放器**共用同一 `ReplayBundle`** | **一期** | `buildReplayBundle` 从 `apps/game-server/src/diag.ts` **下沉 `@ac-majong/persistence`** 供 game/admin 共用（消除跨 app import）；dev `/dev/export/:gameId` 保留 |
| **BL-023 诊断包** | 「诊断包受理」页（FR-Admin-09）：粘贴 `ac-diag` JSON → 后端 `POST /api/diag/intake` 规范化受理（记审计、不落本体）→ 结构化展示（ctx/ring/stack）→ 凭 room/round 派生 gameId 跳回放仲裁 | 二期·进行中 | 数据来源现有 `__AC__.diag.copy()` / 设置页「复制诊断包」；纯受理/解析、无上报管线 |
| **BL-022 实时观测** | 「实时房间监控」页（FR-Admin-10，**上帝全知视角**）：卡顿 playing 房查 `inspect()` **实时全量台态**（牌墙实牌/四家暗牌/牌河/副露花子分/在等谁/响应意图），复用回放牌桌俯视图（共享 `<TableBoard>`）+ 不可达降级 MySQL 事实 | 二期·进行中 | `inspect()` 扩展携带完整 `state: TableState`（纯只读投影、不含 seed）；game-server 新增**内网预共享密钥只读** inspect 端点 `GET /internal/rooms/:id/inspect`（`x-internal-token`、`INTERNAL_PORT`，非 dev `/dev/*`）供 admin-server 服务端代理（`lib/gameInspect.ts`）+审计；停滞看门狗 warn 仍走服务端日志 |

- **边界**：Admin 对游戏数据以**只读**为主（经 persistence / 内网鉴权端点），不写实时态、不持有 WS/RoomManager；BL-022 的内网鉴权端点为「admin 不介入实时链路」的**受控例外**（架构 §4）。

## 7. 验证
- `apps/game-server/test/diag.test.ts` 4 例（BL-022）：inspect seating/playing 字段、看门狗超阈 warn 一次+动作重置+dispose 清理、RoomManager.list。
- `packages/persistence/test/replayBundle.test.ts` 2 例（BL-024）：buildReplayBundle 缺失 null / 有行组装 snapshot·actions·names（随下沉迁至 persistence）。
- 全量 `pnpm test`：engine179 / client-core100 / game-server115 / persistence8+3skip；`pnpm typecheck` 全包 Done；Cocos `assets/scripts` tsc 0 错误（vendor 已 sync）。

## 8. 维护记录
| 日期 | 概要 |
|---|---|
| 2026-09-21 | 初稿（P0）：BL-022 inspect+看门狗+dev HTTP、BL-023 Diag 采集器、BL-024 ReplayBundle+exportReplay+dev export；diag.test 6 例；玩家侧 UI 入口与原型同批待补（BL-023/024 🟡），P1/P2 归 BL-025 |
| 2026-09-21 | 新增 §6「与 Admin 后台的集成」：BL-024 回放包导出纳入 Admin 一期（`buildReplayBundle` 下沉 persistence 共用）；BL-023 诊断包受理、BL-022 实时房间监控列 Admin 二期（BL-022 经 game-server 内网鉴权只读 inspect 端点，为受控例外）；验证/维护记录顺延为 §7/§8 |
| 2026-09-21 | BL-023 玩家出口落地：设置弹层「复制诊断包」（FR-设置-05，SettingsModal 增行+回显 2s）+ 原型 settings.html 同批；BL-024 玩家/仲裁导出 UI 改挂 Admin（BL-015），客户端不做入口 |
| 2026-09-21 | **诊断包首战（BL-026 定位）**：用户报障附 `ac-diag` 包（screen=table/round=2/phase=exhaustive/ring 仅 view:exhaustive/errors 空）→ 免截图直接定位「结算浮层仅事件驱动、重入者无浮层看似卡死」；修复见 BL-026（网关§15/PRD06 FR-断线-07） |
| 2026-09-21 | **BL-024 `buildReplayBundle` 下沉已执行**（Admin P2-a 编码第一步）：新增 `packages/persistence/src/replayBundle.ts` 并从 index 导出；game-server `diag.ts`/`wsGateway.ts` 改从 `@ac-majong/persistence` 引入（消除跨 app import）；BL-024 测试随包迁至 `persistence/test/replayBundle.test.ts`（diag.test 仅留 BL-022 4 例）。门禁：typecheck 全 Done / game-server 115 / persistence 8+3skip 全绿 |
| 2026-09-21 | **二期开工（FR-Admin-09/10）**：§6 表 BL-023/BL-022 行转「二期·进行中」并写实具体机制——BL-023诊断包走后端 `POST /api/diag/intake` 规范化受理（记审计不落本体、派生 gameId 跳回放）；BL-022实时监控走 game-server 内网预共享密钥只读端点 `GET /internal/rooms/:id/inspect`（`x-internal-token`/`INTERNAL_PORT`）+ admin `lib/gameInspect.ts` 服务端代理 + 不可达降级。详 Admin 技术方案 §10.2/§10.3 |
| 2026-09-21 | **FR-Admin-10 升级「上帝全知视角」**（文档折回）：§6 表 BL-022 行「Admin 集成」改为实时全量台态（牌墙实牌/四家暗牌/牌河/副露花子分/响应意图）、复用回放牌桌俯视图（共享 `<TableBoard>`）；关键改动补 `inspect()` 扩展携带完整 `state: TableState`（纯只读投影、不含 seed）。同批 PRD §2.1 + monitor.html 原型 + Admin 技术方案 §10.3 |
