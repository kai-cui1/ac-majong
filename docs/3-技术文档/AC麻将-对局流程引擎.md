# A&C 麻将 · 对局流程引擎（技术方案）

> **模块**：引擎对局流程层（`packages/engine` 的 `table.ts` / `reducer.ts` / `actions.ts` / `rehydrate.ts`）。产品需求见 [`../1-prd/04-对局与牌桌.md`](../1-prd/04-对局与牌桌.md)。
> **关联**：算分细节 [`AC麻将-台数计算规格书.md`](./AC麻将-台数计算规格书.md)｜调用方 [`AC麻将-服务端网关与房间.md`](./AC麻将-服务端网关与房间.md)｜还原落库 [`AC麻将-数据持久化与事件溯源.md`](./AC麻将-数据持久化与事件溯源.md)｜总体 [`AC麻将-联机架构方案.md`](./AC麻将-联机架构方案.md)
> 遵循[《文档总纲》](../README.md)三原则：本文件为对局流程引擎的全量技术说明。

---

## 1. 定位与范围

- **职责**：单局的**权威状态机**——发牌、摸打、吃碰杠胡、响应解析、结算与轮庄、续局；产出状态变更与事件流。
- **不含**：台数/番种识别与算分（见台数计算规格书，本层通过 `scoreAndSettle` 调用）；网络与房间（见服务端网关与房间）；持久化（见数据持久化文档）。
- **形态**：**纯函数 + 纯数据**。`applyAction(state, action) → { state, events }` 无副作用、可移植（Node 与微信小游戏通用），是「服务端权威 + 事件溯源还原」的基础。

## 2. 数据结构（`table.ts`）

```ts
interface PlayerState {
  seat: number;
  concealed: Record<TileId, number>; // 暗牌计数
  melds: Meld[];                      // 成型副（吃/碰/明杠/暗杠/加杠）
  flowers: TileId[];                  // 花区
  zi: number;                         // 子数
  score: number;                      // 积分
}
type Phase = 'draw' | 'discard' | 'response' | 'settled' | 'exhaustive';
interface TableState {
  wall: TileId[];             // 剩余牌墙（末尾 DEAD_WALL=4 张死牌不摸）
  players: PlayerState[];
  dealerSeat: number; currentSeat: number; phase: Phase;
  lastDiscard: { seat; tile } | null;
  discards: { seat; tile }[];  // 全局有序牌河（被吃/碰/杠收走的会移除）
  lastDrawn: { seat; tile; viaKong?; viaFlower?; wasLastDrawable? } | null; // 定位杠开/花开/海底捞
  pending: Record<number, Response | null>; // 响应阶段各家意图（null=待响应）
  robKong?: { seat; tile } | null;          // 抢杠胡待响应
  lianzhuangCount: number; round: number;
}
```

常量：`DEAD_WALL = 4`（末尾死牌）、`RESTRICT_TAIL = 8`（剩 ≤8 张禁吃/碰/碰杠，可摸杠）。派生：`wallRemaining = max(0, wall.length - DEAD_WALL)`、`isTailRestricted`、`isExhaustive`。

## 3. 动作与事件

```ts
type Action =
  | { type:'draw'; seat } | { type:'discard'; seat; tile } | { type:'declareWin'; seat }   // 自摸
  | { type:'kongConcealed'; seat; tile } | { type:'kongAdded'; seat; tile }
  | { type:'respond'; seat; move:'win'|'pong'|'kong_exposed'|'chi'|'pass'; chiTiles? };

type GameEvent =
  | drawn | flower | discarded | responseNeeded | melded | kong | advance
  | win { winners, delta, revealed } | zhahu | exhaustive { revealed } | roundEnd { dealerSeat, lianzhuangCount, round };
```

`applyAction` 先 `clone(state)`（`JSON` 深拷贝，纯数据可移植），按 `action.type` 分派到子流程，收集 `events`，返回新状态。合法性由 `actions.ts` 的 `legalActions(state, seat): ActionKind[]` 判定（服务端在 `handleAction` 中先校验，见网关文档）。

## 4. 状态机相位与转移

| 相位 | 含义 | 主要出口 |
|---|---|---|
| `draw` | 轮到 `currentSeat` 摸牌 | 摸牌→`discard`；无可摸→`exhaustive` |
| `discard` | 摸牌后出牌 / 可自摸胡 / 可杠 | 出牌→`response`；自摸胡→`settled`；杠→补摸回`discard` |
| `response` | 他家对弃牌（或抢杠）响应 | 有胡→`settled`；碰/杠/吃→`discard`；全过→`draw`（下家） |
| `settled` | 有人胡，本局结束 | 由 `startNextRound` 开下局 |
| `exhaustive` | 荒庄，本局结束 | 由 `startNextRound` 开下局 |

## 5. 关键子流程

### 5.1 建桌发牌 `createTable(dealerSeat, seed, seats)`
`shuffle(fullWall(), seed)`（mulberry32 确定性洗牌）→ 庄 17 / 闲 16 发牌 → **花处理**（摸到花移入花区并从可摸区补摸，直到手中无花）→ `phase='discard'`、`currentSeat=dealerSeat`。

### 5.2 摸牌与补花 `drawWithFlowers`
从牌墙摸牌，遇花则移入花区并继续补摸（发 `flower` 事件）；`wall.length <= DEAD_WALL` 时返回 `null` → `doExhaustive`（荒庄）。记录 `viaFlower` / `wasLastDrawable`（海底捞）。

### 5.3 出牌进响应 `doDiscard` → `enterResponse`
出牌入牌河、发 `discarded`。`enterResponse` 对每个非打牌家算 `legalActions`：有可响应动作（非 pass）→ `pending[seat]=null`（待响应）并收入 `actionable`；否则 `pending[seat]={pass}`。若 `actionable` 为空 → 直接 `advance`（下家摸牌）；否则发 `responseNeeded`。

### 5.4 响应解析 `resolveResponses`（优先级：胡 > 碰/明杠 > 吃 > 过）
- 抢杠态（`robKong`）单独走 `resolveRobKong`。
- **胡**：`seatsWithMove('win')` → `settleWins`（支持一炮多响）。
- **碰/明杠**：候选按 `closestByTurn`（从打牌家起的最近座位）取一家执行。
- **吃**：取候选执行 `applyChi`（`chiTiles` 为选用的两张手牌；多解选择器为客户端 BL-005）。
- 全过 → `advance`。碰/吃/明杠会 `discards.pop()`（该弃牌被收走）。

### 5.5 杠与抢杠 `doKong`
- **暗杠**：直接完成（4 张入 melds）→ `drawAfterKong`（补摸，标 `viaKong` → 杠开胡）。
- **加杠**：先给他家**抢杠胡**机会（非末尾限制时，`canWinDiscard` 者进入 `response` + `robKong`）；无人抢则 `completeAddedKong`（碰副升级为加杠）→ 补摸。

### 5.6 胡牌与结算 `settleWins` / `doSelfWin`
`buildHand` 组装 `Hand`（暗牌/副/花/胡张/自摸或点炮/庄闲/剩余牌墙/连庄数/各家子数/flow：杠开·花开·海底捞）→ `scoreAndSettle`（见台数规格书）得 `score` 与 `delta`。
- **诈胡**（`!win || zhaHu`）：`applyZhahuPenalty`（向其它每家付 300）；若无有效胡 → `endRoundNoWin`。
- 有效胡：`applyDeltas`，点炮方（或被自摸的三家）`zi` 清零，发 `win` 事件（含 `revealed` 亮牌）。

### 5.7 局末轮庄 `endRound` / `doExhaustive`
- **庄胡连庄**（`lianzhuangCount+1`）、**闲胡换庄**（下家上庄、`lianzhuangCount=0`）；上庄/连庄者 `zi+1`；`phase='settled'`；发 `roundEnd`。
- **荒庄** `doExhaustive`：不计分、庄家连庄（`lianzhuangCount+1`、`zi+1`）、`phase='exhaustive'`；发 `exhaustive` + `roundEnd`。

### 5.8 续局 `startNextRound(state, seed)`
保留各家 `score`/`zi` 与 `lianzhuangCount`，用新 `seed` 重新 `createTable`，`round+1`。**相位守卫在服务端**（仅 `settled`/`exhaustive` 受理，见网关文档）。

### 5.9 物理牌墙与开牌点（BL-017，`wallMode=physical`）

- `buildPhysicalLayout(seed)`：`shuffle(fullWall(), seed)` 后按 seat 0..3 切 4 排 × 36 张（18 组，排内自右端 g1 起 `[上,下]` 成组）；布局固化入快照（`game_initial_states.layout`），不依赖洗牌算法可长期还原。
- `drawOrderFromLayout(layout, dealerSeat, breakGroups)`：循环摸牌序列 S = [庄家排 g(N+1)..18 → 上手家排 g1..18 → 再上手 → 再上手 → 庄家排 g1..N]（排尽续**上手家**排，2026-09-18 用户确认），组内先上后下；`createTable/startNextRound` 以 S 为 `wall`（开牌点即 `wall[0]`），其余发牌/摸牌/死牌逻辑不变（末尾 4 张=开牌点前最后 2 组）。
- `breakGroups=0`（摸牌位骰关）= 自庄家排右端第 1 组开摸；`random` 模式不走布局、直接线性洗牌（现状）。
- 展示数据：`redact` 下发 `wallInfo`（各排栈高 0/1/2 数组 + 开牌排/跳组数），客户端按已摸张数确定性推算（补花/杠补摸均顺序消耗，组高可为 1）。

## 6. 事件溯源还原（`rehydrate.ts`）

- `snapshotRound(state)`：抽取一局开始的「业务事实」（发牌后剩余牌墙 + 各家 concealed/melds/flowers/zi/score + 庄家/连庄/round）。
- `rehydrate(snap)`：**算法无关**重建 `TableState`（`phase='discard'`、`currentSeat=庄家`），不依赖洗牌/发牌算法，`seed` 仅交叉校验。
- `replayRound(snap, actions)`：折叠 `applyAction` 得最终状态与全部事件——对局回放/审计还原的核心。落库与读取见数据持久化文档。

## 7. 确定性与可移植

- 纯函数、纯数据（`clone` 用 `JSON`，兼容微信小游戏，无 `structuredClone` 依赖）；洗牌用 mulberry32（`seed` 决定牌墙）。
- 因此「初始快照 + 动作日志」可**逐帧重放**得到与实时一致的状态（事件溯源前提，对应架构风险 A8）。

## 8. 测试

`packages/engine/test/`：`reducer-flow` / `reducer` / `table-actions` / `rehydrate` 等；`rehydrate` 4 用例覆盖「快照↔重建恒等、确定性、单动作/整局回放一致」。当前引擎共 136 测试通过。

## 9. 待复核（BL-008 规则引擎待复核项）

一炮多响的轮庄取值（现按最近赢家）、实例级去重、八只花摸第 8 花即胡、门清一摸二等边界，详见 [`../5-backlog/README.md`](../5-backlog/README.md) BL-008 与台数规格书 N1–N10。

---

## 维护记录

| 日期 | 概要 |
|---|---|
| 2026-09-16 | 首次产出（补记 M0 对局流程 + 续局 + M-A2 还原）：TableState/PlayerState/Phase 数据结构、Action/GameEvent、状态机相位转移、摸牌补花/响应解析优先级/杠与抢杠/胡牌结算/诈胡罚/轮庄/续局、`rehydrate`·`replayRound` 事件溯源还原、确定性与可移植、测试与 BL-008 待复核项 |
| 2026-09-16 | 持久化技术方案（04）产出后回填交叉引用：头部「还原落库」由指向 README 的「待补」占位链接改为真实的 `AC麻将-数据持久化与事件溯源.md` |
| 2026-09-18 | **BL-017 立项**：新增 §5.9 物理牌墙与开牌点（buildPhysicalLayout/drawOrderFromLayout/wallInfo 展示推算；排尽续上手家排、组内先上后下、跳组循环末尾摸）；§5.1/5.8 增 `opts{layout,breakGroups,initialZi}` 分支 |
