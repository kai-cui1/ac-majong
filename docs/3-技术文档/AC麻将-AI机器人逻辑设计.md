# AC麻将 · AI 机器人逻辑设计

> 定位：本文是 AI 机器人模块的**技术方案 / 算法逻辑规格**，逐阶段给出机器人的**决策逻辑、公式与伪代码**。策略选型见《[AC麻将-AI机器人策略调研](./AC麻将-AI机器人策略调研.md)》，阶段划分与架构见《[AI机器人迭代路线图](../5-backlog/AI机器人迭代路线图.md)》。
> 铁律：**AI 只做"在合法动作里选哪个"的决策；合法性、算分、听牌/胡牌判定一律复用 `@ac-majong/engine`（`legalActions`/`previewTai`/`winDecompositions`/`waitingTiles`），AI 侧绝不另立规则口径。**

---

## 0. 符号与总原则

| 记号 | 含义 | 来源 |
|---|---|---|
| `preview` | 台数预览：`{tenpai, waits, tai, canWin, viaDiscard, secured, detail}` | `engine.previewTai(concealed, melds, flowers, opts)` |
| `shanten` | 向听数（0=听牌，-1=胡） | ai 层 `features/shanten`（稳定后下沉 engine） |
| `ukeire` | 受入/进张：使向听前进的牌种类×剩余张数 | ai 层派生 |
| `wallRemaining` | 剩余可摸牌墙张数 | `ViewState` |
| `danger(t)` | 打出牌 t 的放炮危险度 0~1 | ai 层 `features/danger`（P3 起） |
| `cfg` | 人格/难度参数（`aggression`/`scoreWeight`/`defenseThreshold`/`noise`…） | `BotConfig` |

**总原则**
1. **门槛优先**：AC 最小胡 6 台，`previewTai` 已过滤 <6 台的听张（`bestOverWaits`）；因此 `preview.tenpai/canWin/waits` 均是"达标可胡"口径，AI 直接采信，不再自行判胡。
2. **可复现**：所有随机（采样/扰动）走注入的 `rng`，给定种子可复现，便于单测与自对弈评估。
3. **单调叠加**：P2 在 P1 价值函数上加"打点项"，P3 再加"防守项"，P4 用模拟替换手工价值函数——**决策骨架不变**，只替换"给候选动作打分"的评分器。
4. **末盘收敛**：`wallRemaining ≤ RESTRICT_TAIL(8)` 时禁吃/碰/明杠（引擎已在 `legal` 中体现），AI 只需在 `legal` 内选择，天然合规。

---

## 1. 通用框架

### 1.1 决策总流程（AutoPlayer，所有策略共用骨架）

```
decide(ctx) -> Action | null:
  v = ctx.view; seat = ctx.seat; legal = v.you.legal
  switch v.phase:
    case 'draw':
       if v.currentSeat==seat and 'draw' in legal: return {draw, seat}
       return null

    case 'discard':                      # 轮到我：先判胡/杠，再选打哪张
       if 'win_draw' in legal and shouldWin(ctx):     return {declareWin, seat}
       kong = chooseKong(ctx)              # 暗杠/加杠（可选，见各阶段）
       if kong: return kong
       tile = strategy.pickDiscard(ctx)    # ← 策略差异点
       return {discard, seat, tile}

    case 'response':                      # 他家打牌，我是否吃/碰/杠/胡
       if 'win_discard' in legal and shouldWin(ctx):  return {respond, seat, win}
       move = strategy.pickResponse(ctx)   # ← 策略差异点：pong/kong_exposed/chi/pass
       if move: return {respond, seat, move.move, move.chiTiles?}
       if 'pass' in legal: return {respond, seat, pass}
       return null

    default: return null
```

> `strategy` 即 `BotStrategy`；P1-P4 的差异**只体现在 `pickDiscard` / `pickResponse` / `shouldWin` / `chooseKong` 四个钩子**的评分逻辑上。

### 1.2 BotContext 特征派生（懒计算 + 缓存）

```
buildContext(view, seat, cfg, rng) -> BotContext:
  you = view.you
  preview = engine.previewTai(you.concealed, you.melds, you.flowers,
              {isDealer: seat==view.dealerSeat, wallRemaining: view.wallRemaining,
               lianzhuangCount: view.lianzhuangCount, drawn: you.drawn, myZi: you.zi})
  features = { shanten:null, ukeire:null, danger:null, value:null }  # 按需填充并缓存
  return { view, seat, cfg, rng, preview, features }
```

### 1.3 特征层算法

**（a）向听数 `shanten`（P1 核心）**——取三种牌型的最小向听，与引擎 `winDecompositions` 的三种胡型（standard / pairs8 / orphans13）一致：

```
shanten(concealed, formedMelds):
  need = 4 - formedMelds                       # 还需凑的面子数
  # 标准型：经典公式
  std = 8 - 2*mentsu - taatsu - jantai
        其中 mentsu=暗牌中已成型面子数, taatsu=搭子数(对子算搭子),
        jantai=是否已有将(0/1); 约束 taatsu+mentsu ≤ need(+将)
  # 八对半（pairs8）：shanten = 6 - 对子数（需 8 对）
  p8  = 6 - countPairs(concealed)
  # 十三幺（orphans13）：shanten = 13 - 幺九字种类数 - (是否已有幺九对)
  orph= 13 - distinctTerminalsHonors - hasTerminalPair
  return min(std, p8, orph)
```

**（b）受入 `ukeire`**：对当前手牌，枚举所有牌 t，若 `shanten(加入 t)` < `shanten(当前)`，则 t 为有效进张；`ukeire = Σ 剩余张数(t)`（剩余 = 4 − 已见于自家暗牌/副露/全场牌河）。

**（c）听张/台数**：直接用 `preview.waits`（已过滤 <6 台）、`preview.tai`、`preview.secured`、`preview.viaDiscard`。

**（d）危险度 `danger(t)`（P3）**：见 §4.1。

**（e）期望台数 `value`（P2）**：见 §3.1。

---

## 2. P1 · 效率型机器人（"最大概率打法"）

**目标**：最快听牌 + 听牌后和率×达标台数最优 + 合理副露。价值函数只看**速度与和率**。

### 2.1 打牌决策 `pickDiscard`

对暗牌中每一张候选 `t`，模拟打出后的手牌 `h_t`，打分：

```
score_discard(t):
  h_t = concealed - t
  s   = shanten(h_t)
  u   = ukeire(h_t)                     # 打出后剩余受入（越大越好）
  pv  = previewTai(h_t)                 # 若打后听牌，取其台数
  base = -1000*s + u                    # 主序：向听最小 → 受入最大
  if pv.tenpai: base += 200 + 5*pv.tai  # 听牌奖励 + 达标台数微加成
  # 搭子质量微调（可选）：保留两面/中张，优先弃孤张、边张、字牌
  base += shapeBonus(t)                 # 孤张/老张加分(优先弃)，中张减分(优先留)
  return base + noise(cfg)              # 拟人化扰动

pickDiscard(ctx):
  return argmax_{t ∈ 暗牌} score_discard(t)
```

> 若 `preview.canWin`（已可自摸）→ 由 `shouldWin` 处理，不进打牌。
> 若打后即听牌（`pv.tenpai`），引擎已保证 `pv.waits` 达标（≥6 台），无诈胡风险。

### 2.2 副露决策 `pickResponse`（吃/碰/明杠）

原则：**副露只在"能实质推进向听"或"不损听牌/台数"时才做**；否则过（门清更灵活）。

```
pickResponse(ctx):
  tile = view.lastDiscard.tile
  # 碰：手中≥2张。评估碰前/碰后向听
  if 'pong' in legal:
     if shanten(碰后手牌) < shanten(当前手牌) or 已听牌且碰不降台数: return pong
  # 明杠：手中≥3张。杠能加分(见PATTERN_TAI 明杠)但会暴露+改结构；效率档保守
  if 'kong_exposed' in legal:
     if 杠后仍听牌 or 杠能提升 secured 且不推向听: return kong_exposed
  # 吃：仅下家可吃，且引擎已给 chiOptions
  if 'chi' in legal:
     best = argmax_{组合} ( -shanten(吃后) , ukeire(吃后) )
     if shanten(吃后) < shanten(当前): return chi(best.chiTiles)
  return pass
```

### 2.3 胡牌决策 `shouldWin`
```
shouldWin(ctx):
  # preview.canWin / legal 含 win_* 时，引擎已保证达标(≥6台)。效率档：能胡就胡。
  return true
```

### 2.4 杠（暗杠/加杠）`chooseKong`
```
chooseKong(ctx):
  # 暗杠/加杠能加 secured 台数(PATTERN_TAI: 暗杠2/明杠1)，但改结构、可能破坏听牌
  if 杠后仍听牌(previewTai(杠后).tenpai) or 杠后 shanten 不变:
     return 对应 kong action        # 收益(台数+可能杠开胡)且不掉速 → 杠
  return null                        # 否则不杠，保结构
```

**P1 验收指标**：自对弈 P1 vs P0 → 和率↑、诈胡率≈0、平均听牌巡目↓。

---

## 3. P2 · 台数最大化机器人（"追求胡大牌"）

**目标**：在 P1 速度基础上，最大化**期望台数**。价值函数加入打点项，允许为高台番种**适度放慢速度**。

### 3.1 打点潜力评估 `value(hand)`

利用引擎既有能力评估"当前手牌可达的台数上限/期望"：

```
handValue(ctx):
  securedNow = preview.secured                    # 已锁定保底台数（花/杠/门清/风刻）
  # 潜力番种识别：扫描手牌结构，估计可发展方向（对齐 PATTERN_TAI 高台项）
  potential = 0
  if 单一花色占比高:  potential += w(清一色40 / 混一色15)
  if 对子/刻子多:     potential += w(碰碰胡15 / 八对半30 / 四暗坎15 / 三暗坎8)
  if 字牌刻多:        potential += w(大三元30 / 小三元15 / 大小四喜40-60 / 风一色60)
  if 同花色123/456/789齐: potential += w(一条龙8)
  if 三花色同序刻:    potential += w(三相逢8 / 三姊妹15 / 四姊妹30)
  if 花数接近8:       potential += w(八只花40)
  return securedNow + λ * potential               # λ = cfg.scoreWeight
```

### 3.2 速度 vs 打点权衡效用函数

打牌评分在 P1 的 `base` 上叠加打点项：

```
score_discard_P2(t):
  h_t = concealed - t
  s = shanten(h_t); u = ukeire(h_t); pv = previewTai(h_t)
  speed = -1000*s + u
  score = pv.tenpai ? pv.tai : handValue(h_t)     # 听牌用真实台数，否则用潜力
  # 效用：速度 + 打点权重 × 期望台数
  utility = speed * (1 - cfg.scoreWeight*0.3) + cfg.scoreWeight * K * score
  # 约束：不允许为打点跌破"可胡性"——若打后无任何达标听张且向听恶化过多，降权
  if not pv.tenpai and s > shanten(concealed)+1: utility -= penalty
  return utility + noise(cfg)
```

### 3.3 副露对番种的影响（关键）
```
pickResponse_P2(ctx):
  # 副露会破坏"门清"(门清/门清一摸加成)、可能改变花色纯度
  gain_speed   = shanten(当前) - shanten(副露后)
  lose_score   = handValue(当前) - handValue(副露后)   # 门清番/清一色纯度损失
  do = cfg.scoreWeight * lose_score < gain_speed * SPEED_W
  return do ? 对应副露 : pass
  # 特例：杠能直接加 secured(明杠1/暗杠2/九万九筒特番10-15) 且不掉台路线 → 倾向杠
```

**P2 验收指标**：自对弈 P2 vs P1 → 平均胡牌台数↑（和率允许小幅下降）；≥15 台牌型出现率↑。

---

## 4. P3 · 攻防一体机器人（稳健 / 高手档）

**目标**：在 P2 基础上加入**防守**——评估放炮风险，动态攻守切换。AC 麻将点炮清零子，防守价值极高。

### 4.1 危险度模型 `danger(t)`（对目标家/全场）

```
danger(t):
  d = 0
  # 1) 现物：t 出现在某家牌河 → 对其绝对安全（不能胡自己打过的）
  if t ∈ 某家 discards: return 对该家 0（记为安全牌）
  # 2) 筋/壁（须按 AC 规则校验成立性）：无筋张、壁张相对安全
  d += sujiKabeAdjust(t)
  # 3) 他家听牌嫌疑：副露数多 + 牌河整齐 + 打牌突然转安全 → 疑听牌
  for opp in others:
     sus = 听牌嫌疑(opp.melds 数, opp 牌河, opp.concealedCount)
     d += sus * 预计损失台数(opp)         # 大牌嫌疑(字一色/清一色副露)权重高
  # 4) 生张(未现)且中张(3-7) → 更易放炮
  d += isRawMiddle(t) ? rawPenalty : 0
  # 5) 余墙越少、越到末盘，危险越高
  d *= endgameFactor(wallRemaining)
  return clamp(d, 0, 1)
```

### 4.2 攻守切换
```
mode(ctx):
  myAdv = preview.tenpai ? preview.tai : -shanten*... # 自家进度/打点
  # 自家听牌且台数高 → 进攻；自家落后(向听大) 且 他家高危险 → 防守(弃和保子)
  if preview.tenpai and preview.tai ≥ cfg.attackTai: return ATTACK
  if maxOppDanger ≥ cfg.defenseThreshold and 自家未听牌: return DEFEND
  return BALANCE
```

### 4.3 打牌决策（融合）
```
score_discard_P3(t):
  util = score_discard_P2(t)                 # 进攻价值
  if mode==DEFEND:
     util = -1000 * danger(t) + 0.1*util     # 防守压倒：优先最安全牌
  elif mode==BALANCE:
     util = util - cfg.aggression_inv * danger(t) * 预计损失
  return util + noise(cfg)

pickResponse_P3: 同 P2，但 DEFEND 模式下不副露（避免暴露/推进他家），倾向 pass
shouldWin_P3: preview.canWin 即胡（达标已由引擎保证）
```

**P3 验收指标**：自对弈 P3 vs P2 → 放炮率↓、净积分/子↑；他家大牌局损失收敛。

---

## 5. P4 · 蒙特卡洛期望值机器人（大师档）

**目标**：用采样模拟的**期望得失**替换手工价值函数，天然融合速度/打点/防守。

### 5.1 采样未知信息
```
sampleDeal(ctx, rng):
  known = 自家暗牌 + 全场副露 + 全场牌河 + 花牌
  rest  = 全牌 − known                        # 未知牌池（牌墙 + 他家暗牌）
  shuffle(rest, rng)
  # 按他家 concealedCount 分配暗牌，其余作牌墙；可加对手建模偏置
  return 完整局面（含各家暗牌 + 牌墙顺序）
```

### 5.2 rollout（模拟到本局结束）
```
rollout(deal, fromAction, rng):
  用 engine.applyAction 推进（复用确定性 reducer）
  各家决策用轻量策略（P1/P2）快速代打，直至 win/exhaustive
  return 结算结果（各座位积分/子变动）
```

### 5.3 期望值决策
```
pickDiscard_P4(ctx):
  best = null
  for t in 候选打牌:
     ev = 0
     for i in 1..cfg.mcSamples:
        deal = sampleDeal(ctx, rng)
        r = rollout(deal, {discard, t}, rng)
        ev += 我方结算收益(r)         # 期望台数/子净得（含放炮损失，天然含防守）
     ev /= cfg.mcSamples
     if ev > best.ev: best = {t, ev}
  return best.t
# 副露/胡同理：对每个候选动作估计 EV，取最大
```

### 5.4 性能与降级
- 设**单步耗时预算**（如 ≤50ms）与**采样上限**（如 200-2000 次，按 `cfg.mcSamples`）；超预算则降采样或回退到 P3 启发式。
- 服务端多房间并发：MC bot 决策放入异步队列，避免阻塞事件循环（现有 `setTimeout` 延迟机制可复用）。

**P4 验收指标**：自对弈 P4 vs P3 胜率↑；单步耗时/内存压测通过。

---

## 6. P5 · 学习型机器人（远期占位）

- 方向：MCTS-NN / RL（Suphx 全局奖励预测 + 先知引导 + 运行时自适应；或 Evo-Sparrow 进化优化 LSTM）。
- 需：特征编码（手牌/牌河/副露/子/余墙张量化）、自对弈训练基建、离线评估。
- **本阶段仅保留 `BotStrategy` 接口占位**，不设计实现细节；规则（番种表）变更需重训，成本高。

---

## 7. 人格 / 难度参数矩阵

同一策略通过 `BotConfig` 产出多档，供陪玩/托管/练习选择：

| 档位 | 策略 | aggression | scoreWeight | defenseThreshold | mcSamples | noise |
|---|---|---|---|---|---|---|
| 新手 | efficiency | 0.3 | 0.1 | 0.9（几乎不防守） | – | 高（会犯错） |
| 普通 | efficiency | 0.5 | 0.3 | 0.7 | – | 中 |
| 高手 | balanced | 0.6 | 0.5 | 0.5 | – | 低 |
| 大师 | monteCarlo | 0.6 | 0.6 | 0.4 | 500-2000 | 极低 |
| 大牌狂 | bigHand | 0.4 | 0.9 | 0.6 | – | 低 |
| 托管 | efficiency(保守) | 0.1 | 0.0 | 0.3（危险即过/不副露） | – | 0 |

> **托管专用**：绑定"保守配置"，语义等价现 `makeTrusteeConnection`——不主动胡/副露、危险即过，直至玩家重连。

---

## 8. 评估与测试方法

1. **单元测**（纯函数、注入 `rng` 种子）：
   - `shanten`/`ukeire` 对标准牌例断言（含八对半/十三幺边界）；
   - 各策略在构造局面下的 `pickDiscard`/`pickResponse` 断言（听牌选择、达标门槛、危险牌规避）。
2. **自对弈基准**：同一引擎跑 N 局（如 1000 局）四策略对打，统计**和率 / 诈胡率 / 放炮率 / 平均胡牌台数 / 平均净子**；用于阶段验收（P1>P0、P2 台数>P1、P3 放炮<P2、P4 胜率>P3）。
3. **性能压测**：MC bot 单步耗时分布、并发房间下的 CPU 占用。
4. **回归护栏**：托管语义、现有 `lastActionKey` 去重、末尾限制合规不因改造回退。

---

## 9. 与引擎的接口清单（实现时依赖）

| 引擎 API | 用途 |
|---|---|
| `legalActions` / `ViewState.you.legal` | 候选动作边界（AI 只在此集合内选） |
| `previewTai(concealed, melds, flowers, opts)` | 听牌/听张/实时台数/viaDiscard/**secured 保底** |
| `winDecompositions` / `waitingTiles` / `isWin` | 胡型与听张枚举（shanten 与 rollout 用） |
| `partialDecomps` | 部分分解（打点潜力/secured 复用） |
| `PATTERN_TAI` / `recognizePatterns` | 番种与台数（大牌潜力评估对齐口径） |
| `applyAction`（reducer） | P4 rollout 推进局面 |
| `computeTai` / `settle` | rollout 结算收益 |

**新增（ai 层，稳定后可下沉 engine）**：`shanten(concealed, formedMelds)`、`ukeire(...)`、`remainingCount(tile, view)`（剩余张数统计）。

---

*（本文为技术方案讨论稿；确认阶段范围后，P1 起进入编码，并按"文档先行 + 同批同步"补 PRD/原型/维护记录。）*
