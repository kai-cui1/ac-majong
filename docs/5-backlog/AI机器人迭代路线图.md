# AC麻将 · AI 机器人迭代路线图

> 归属：`docs/5-backlog`（"什么时候做"）。本路线图定义 AI 机器人模块的**可扩展架构**与**分阶段迭代计划**；策略选型依据见《[AC麻将-AI机器人策略调研](../3-技术文档/AC麻将-AI机器人策略调研.md)》，各阶段**具体决策逻辑**见《[AC麻将-AI机器人逻辑设计](../3-技术文档/AC麻将-AI机器人逻辑设计.md)》。
> 状态：**已确认（2026-09-22）**，已登记 **BL-031 AI 机器人可扩展模块**。确认结论：本轮范围=**仅 P1**（效率型「最大概率打法」+ 可扩展框架）；代码位置=**新建 `packages/ai`**；**需要**「选择机器人难度/策略」产品 UI 入口（→ 须补 PRD 模块 + 高保真原型）；向听数先置于 `packages/ai` 层。P2~P5 后续增量。

---

## 0. 现状盘点（起点）

| 现状项 | 位置 | 说明 |
|---|---|---|
| 骨架 Bot（服务端） | `apps/game-server/src/devBots.ts` | `pickAction`：能胡则胡 + 摸/打/过；打牌=`Object.keys(concealed)[0]`（第一张）；**从不吃碰杠** |
| 骨架 Bot（客户端核心） | `packages/client-core/src/bot.ts` | `pickDiscard`（第一张）+ `botStep`；同上保守逻辑 |
| 托管代打 | `devBots.makeTrusteeConnection` | 比 Bot 更保守：不主动胡，响应一律过 |
| 引擎能力（可复用） | `packages/engine` | `previewTai`（听牌/听张/**实时台数**/viaDiscard/**保底台数 secured**）、`legalActions`、`winDecompositions`、`waitingTiles`、`partialDecomps`、完整番种表 `PATTERN_TAI` |
| 机器人可见信息 | `ViewState`（裁剪版） | 自家暗牌/副露/花/子/legal；他家暗牌数/副露/花数/子；公开牌河 `discards`、`lastDiscard`、`wallRemaining`、`dealerSeat`、`round` |

**缺口**：① 无通用「向听数 / 受入」计算（`previewTai` 只判 0 向听=听牌）；② Bot 决策硬编码、无策略抽象、两处重复；③ 无吃/碰/杠/防守/打点决策；④ 无难度/人格配置。

---

## 1. 设计目标与原则

1. **策略可插拔**：新增一种机器人打法 = 新增一个策略实现 + 注册，**不改接入层、不改引擎**。
2. **规则口径唯一**：合法性、算分、听牌判定**全部复用 `@ac-majong/engine`**，AI 只做"在合法动作里选哪个"。
3. **纯函数可测**：策略是 `(上下文) → 动作` 的纯函数，给定随机种子可复现，便于单测与自对弈评估。
4. **前后端共用**：同一套策略既服务服务端陪玩/托管 Bot，也可用于客户端本地练习 Bot。
5. **难度人格化**：同一策略通过参数产出"新手/普通/高手/大师"，覆盖陪玩、托管、练习场景。
6. **渐进增强**：从"会打"→"打得好"→"会攻会守"→"期望最优"，每阶段独立可交付、可回滚。

---

## 2. 可扩展架构（目标形态）

新增独立包 **`packages/ai`**（依赖 `@ac-majong/engine` + `@ac-majong/protocol`，纯逻辑无平台 API），供 `game-server` 与 `client-core` 共同引用。

```
packages/ai/
  src/
    context.ts        # BotContext：把 ViewState + engine 派生特征封装成决策上下文
    features/
      shanten.ts      # 向听数 / 受入（若引擎未提供，先在 ai 层实现，稳定后下沉 engine）
      danger.ts       # 危险度评估（现物/筋/壁/副露/牌河）——P3 起
      value.ts        # 期望台数 / 打点潜力评估
    strategies/
      registry.ts     # 策略注册表：name -> BotStrategy 工厂
      efficiency.ts   # P1 效率型（最大概率打法）
      bigHand.ts      # P2 台数最大化（追求大牌）
      balanced.ts     # P3 攻防一体（稳健/高手）
      monteCarlo.ts   # P4 蒙特卡洛期望值（大师）
    autoPlayer.ts     # AutoPlayer：统一决策入口（选阶段/摸打/响应），替换现有硬编码
    index.ts
```

### 2.1 核心接口（草案）

```ts
/** 机器人策略：纯函数，给定上下文返回一个合法动作（null=不行动） */
export interface BotStrategy {
  readonly name: string;              // 'efficiency' | 'bigHand' | 'balanced' | 'monteCarlo'
  readonly displayName: string;       // 展示名，如「最大概率打法」
  decide(ctx: BotContext): Action | null;
}

/** 决策上下文：ViewState + 引擎派生特征 + 配置 + 随机源（全部只读） */
export interface BotContext {
  view: ViewState;                    // 裁剪后的当前视图
  seat: number;                       // 机器人座位
  cfg: BotConfig;                     // 人格/难度参数
  rng: () => number;                  // 可注入随机源（复现/测试）
  // 引擎派生特征（懒计算/缓存）
  preview: TaiPreview;                // previewTai 结果：听牌/听张/台数/viaDiscard/secured
  features: DerivedFeatures;          // 向听/受入/危险度等（按阶段填充）
}

/** 人格 / 难度配置 */
export interface BotConfig {
  aggression: number;                 // 激进(冲张)↔保守(防守) 0~1
  scoreWeight: number;                // 打点权重（大牌偏好）
  defenseThreshold: number;           // 转防守的危险度阈值
  mcSamples?: number;                 // 蒙特卡洛模拟次数（P4）
  noise?: number;                     // 随机扰动（降低难度、拟人化）
  thinkMs?: number;                   // 决策延迟（拟人化，接入层用）
}
```

### 2.2 接入改造（替换硬编码，保持行为兼容）

- `apps/game-server/src/devBots.ts`：`pickAction(view, canWin)` → 改为 `autoPlayer.decide(ctx)`；`makeBotConnection` 增加 `strategyName`/`BotConfig` 参数（默认 `efficiency`，兼容"能胡则胡"托管仍走保守配置）。
- `packages/client-core/src/bot.ts`：`pickDiscard`/`botStep` → 复用 `packages/ai` 的 `autoPlayer`，消除两处重复逻辑。
- **托管（Trustee）**保持"最保守"语义：绑定一个 `保守配置的效率策略`或专用 `trustee` 策略，不主动副露、危险即过。

---

## 3. 分阶段迭代计划（P0 → P5）

> 每阶段可独立交付验收，后阶段在前阶段之上叠加。P0 为现状，P1 起为本次立项内容。

### P0 · 现状（骨架 Bot）— 已完成
- 能力：能胡则胡 + 摸/打第一张 + 响应过；不吃碰杠。
- 定位：保底陪玩/托管，避免牌局卡死。**保留为"最低难度档"的回退实现**。

### P1 · 效率型机器人（"最大概率打法" v1）— 首个正式里程碑
- **目标**：会打牌——按**牌效率**快速听牌、听牌后选**和率×达标台数**最优的打法；开始合理使用吃/碰/杠（仅当能推进向听或不损台数）。
- **关键能力**：向听数/受入计算；`previewTai` 驱动听张与台数选择；副露价值判断；末盘/末尾限制感知。
- **交付物**：`packages/ai` 骨架（context/autoPlayer/registry/features.shanten）+ `efficiency` 策略 + 单测 + 接入改造（两处 Bot 收敛到 ai 包）。
- **验收**：自对弈中 P1 vs P0，P1 **和率显著更高、诈胡率≈0**；不吃碰杠导致的明显失误消失。
- **依赖**：向听数计算（先 ai 层实现，评估后下沉 engine）。

### P2 · 台数最大化机器人（"追求胡大牌"）— 打点派
- **目标**：在效率基础上加**打点维度**：识别可发展的高台番种（清一色/碰碰胡/混一色/一条龙/三元/风一色/八对半等），在速度损失可接受时锁定高台路线；用 `secured`（保底台数）做打点下限。
- **关键能力**：期望台数评估、番种潜力识别、"速度 vs 打点"权衡、副露对门清/番种的影响判断。
- **交付物**：`features.value` + `bigHand` 策略 + 参数（`scoreWeight`）+ 单测。
- **验收**：自对弈 P2 vs P1，P2 **平均胡牌台数更高**（在可接受的和率下降范围内）；能稳定做出 ≥15 台牌型。

### P3 · 攻防一体机器人（稳健/高手档）— 防守派
- **目标**：加入**危险度评估与攻守切换**：牌河/副露/余墙分析，估算他家听牌概率与损失台数；自家领先或高台听牌则进攻，落后且他家危险则弃和打安全牌（保子）。
- **关键能力**：现物/筋/壁安全牌（**须按 AC 规则校验筋逻辑成立性**）、他家听牌推断、攻守阈值（`aggression`/`defenseThreshold`）。
- **交付物**：`features.danger` + `balanced` 策略（融合效率+打点+防守）+ 单测。
- **验收**：自对弈 P3 vs P2，P3 **放炮率明显下降、净积分更高**；高方差局（他家大牌）中损失收敛。

### P4 · 蒙特卡洛期望值机器人（大师档）
- **目标**：对未知牌墙/他家暗牌**采样 + rollout**，用期望值（期望得失台数/子）统一融合速度/打点/防守，逼近"概率最优打法"。
- **关键能力**：剩余牌分布采样、快速 rollout（复用 P1-P3 策略做模拟内决策）、对手建模、并发限流/降采样。
- **交付物**：`monteCarlo` 策略 + 采样/模拟器 + 性能压测 + 单测。
- **验收**：自对弈 P4 vs P3 胜率提升；单步决策耗时在服务端并发下可接受（设定 ms 预算与采样上限）。

### P5 · 学习型机器人（远期 / 研究性，暂不排期）
- 方向：MCTS-NN 或 RL（Suphx/Mortal/Evo-Sparrow 思路）；需训练基建 + 自对弈数据 + 特征工程，且与 AC 番种强耦合（改规则要重训）。
- **本路线图仅预留策略接口，不投入实现**。

---

## 4. 里程碑与优先级建议

| 阶段 | 名称 | 优先级 | 相对工作量 | 依赖 |
|---|---|---|---|---|
| P1 | 效率型（最大概率打法） | **高** | 中 | 向听数计算 |
| P2 | 台数最大化（追求大牌） | 高 | 中 | P1 + previewTai/secured |
| P3 | 攻防一体（稳健/高手） | 中 | 中-高 | P2 + 危险度模型 |
| P4 | 蒙特卡洛（大师） | 中 | 高 | P1-P3 作 rollout 内核 |
| P5 | 学习型 | 低（远期） | 很高 | 训练基建 |

**建议交付顺序**：先做 **P0→P1 的架构改造 + 效率策略**（含 ai 包骨架与两处接入收敛），跑通"可扩展框架"这条主线并验收；再按 P2→P3→P4 增量叠加策略。P5 挂起。

---

## 5. 文档与流程约束（遵循项目"文档先行 + 同批同步"）

- **PRD**：AI 机器人属新功能，需在 `docs/1-prd/` 新增模块（如 `11-AI机器人.md`），描述机器人**产品形态**（陪玩/托管/练习选择、难度档、人格展示）。
- **技术方案**：《AC麻将-AI机器人逻辑设计》承担各阶段算法逻辑（已在 `3-技术文档`）。
- **原型**：若涉及房间创建/设置里"选择机器人难度/策略"的 UI，需同步高保真原型（`docs/2-效果图/HTML格式高保真原型`）。
- **backlog**：确认方案后在 `docs/5-backlog/README.md` 登记 **BL-031 AI 机器人可扩展模块**（含 P1-P4 子里程碑），完成项按季度归档。
- **同批同步**：任一阶段落地时，PRD/技术方案/原型/维护记录须同批更新。

---

## 6. 风险与注意事项

1. **向听数计算成本**：通用 shanten 搜索若逐张枚举可能较慢；需评估性能，必要时做牌型缓存或下沉引擎优化。
2. **筋/壁等日麻防守概念未必适用于 AC 规则**：落地前须用 AC 规则验证"安全牌"推断是否成立，避免错误防守。
3. **最小胡 6 台门槛**：所有"是否胡/听哪张"必须走 `previewTai`（已过滤 <6 台诈胡），严禁 AI 侧自造听牌判定，否则会诈胡罚分。
4. **蒙特卡洛并发开销**：服务端多房间同时跑 MC bot 会吃 CPU；需设采样上限、单步耗时预算、必要时降级为启发式。
5. **拟人化与延迟**：保留决策延迟（`thinkMs`）与随机扰动（`noise`），避免机器人"秒出、机械"，并防止去重键失效导致的重复广播（沿用现有 `lastActionKey` 去重）。
6. **托管语义不回退**：M-I 断线托管必须保持"最保守、不主动胡/副露"，改造时单独绑定保守配置，勿被新策略默认值覆盖。

---

## 7. 已确认决策（2026-09-22）

1. **落地范围**：本轮**仅 P1**（效率型「最大概率打法」+ 可扩展框架 + 收敛两处硬编码 Bot）；P2/P3/P4 后续增量，P5 挂起。
2. **新包位置**：**新建 `packages/ai`**（依赖 engine + protocol，纯逻辑），供 game-server 与 client-core 共用。
3. **向听数归属**：`shanten` **先放 `packages/ai`**（快速落地），稳定后再评估下沉 engine。
4. **产品 UI 入口**：**要做**——房间创建/托管设置处提供「选择机器人难度/策略」入口；须同批补 **PRD 新模块（`docs/1-prd/11-AI机器人.md`）** + **高保真原型**（遵循文档先行 + 同批同步）。
5. **BL 登记**：**已登记 BL-031 AI 机器人可扩展模块**（见 `README.md` 活跃表），本轮聚焦其 P1 子里程碑。

### P1 交付清单（确认后按此顺序推进）
1. 文档先行：新增 PRD `11-AI机器人.md`（产品形态/难度档/入口）+ 高保真原型（机器人难度/策略选择）。
2. `packages/ai` 骨架：`context` / `autoPlayer` / `strategies/registry` / `features/shanten`。
3. `efficiency` 策略（§2 逻辑）+ 单元测（向听数/受入/打牌/副露/胡牌）。
4. 接入改造：`devBots.ts` 与 `client-core/bot.ts` 收敛到 `autoPlayer`；托管绑定保守配置（语义不回退）。
5. UI 入口接线 + 自对弈基准（P1 vs P0：和率↑/诈胡≈0）。

*（P1 编码尚未开工，待指令启动。）*
