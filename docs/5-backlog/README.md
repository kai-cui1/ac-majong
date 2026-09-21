# 5-backlog · 待办事项与开发计划

## 约定
- 本目录记录所有「**什么时候做**」的内容：待办事项、开发版本规划、迭代规划、里程碑、排期。
- **PRD 只负责「怎么做」**（产品功能的分模块设计与描述），不含版本/迭代/排期/里程碑——这些一律放本目录。
- **已完成**的条目移动到 `docs/5-backlog/归档/`（建议按季度归档，如 `归档/2026-Q3.md`）。
- 引用任一条目时用「**编号 + 描述**」（例：`BL-003 视觉层对齐高保真稿`），不要只写编号。

## 条目格式
| 字段 | 说明 |
|---|---|
| 编号 | `BL-###`，全局递增、不复用 |
| 描述 | 一句话说清要做什么 |
| 分类 | 规则 / 规则引擎 / 对局流程 / 联机 / Cocos客户端 / 上线合规 … |
| 状态 | 待办 / 进行中 / 已完成(→归档) / 挂起 |
| 优先级 | 高 / 中 / 低 |
| 备注 | 关联文档、依赖、待确认点 |

## 当前待办（Active）
> 首批录入，来源为近期联调中确认的开放项，请审阅 / 增删 / 调整优先级。

| 编号 | 描述 | 分类 | 状态 | 优先级 | 备注 |
|---|---|---|---|---|---|
| BL-001 | 生产环境续局门控：当前任何玩家点「下一局」即推进，正式 4 真人局需改为房主点 / 全员准备 / 倒计时 | 对局流程 | 待办 | 中 | 见联机架构方案 |
| BL-006 | 摸牌交互：现自动摸牌，可做「摸牌」按钮 / 动画 | Cocos客户端 | 待办 | 低 | 摸牌抽出显示已做（2026-09-17：`you.drawn` + 原位抬高）；余「摸牌按钮/动画」归 M-J |
| BL-009 | 上线合规前置：资质 / 版号等（视运营形态确认） | 上线合规 | 挂起 | 高 | 上线前必须澄清 |
| BL-012 | 前端对局回放 UI（按 `game_id` 重放动作日志） | 前端/表现 | ✅ 已完成·归档 2026-Q3 | 中 | PRD09 + 两原型 + 双屏 + CDP 验证 |
| BL-015 | 管理后台子系统一期：管理员鉴权角色 + 用户管理 + 对局/回放仲裁 + 审计日志（独立 Web SPA + Admin REST API） | 平台/运营 | 🟡 编码中（P2-a 后端+前端脚手架已落地，待真实库冒烟） | 中 | 范围已确认（2026-09-17）：管理+仲裁核心；看板/运营配置二期；复用事件溯源回放能力。**技术栈选型已定（2026-09-18）**：admin-server=Fastify 5+zod、Session+RBAC（会话存 Redis+CSRF）；admin-web=Vite+React 18+TS+AntD 5(自建布局)+TanStack Query；数据层目标全面 Drizzle 化但分 P2-a（仅 admin 自有表+游戏表只读，不碰对局写链）/P2-b（persistence 整体迁 Drizzle）两阶段。详见技术方案《目录结构重构与Admin系统架构》§6；Admin 产品 PRD 已产出（[1-prd/10-Admin后台](../1-prd/10-Admin后台.md)）+ 技术方案已定稿（[3-技术文档/AC麻将-Admin后台技术方案](../3-技术文档/AC麻将-Admin后台技术方案.md)，schema+API 契约，2026-09-19）；高保真原型已产出（2-效果图/…/admin/ 6 页 + _index）；**并入可维护性能力**：一期含 BL-024 回放包导出（FR-Admin-08），二期含 BL-023 诊断包受理（FR-Admin-09）+ BL-022 实时房间监控（FR-Admin-10）；**编码进行中**：P2-a 数据层（buildReplayBundle 下沉 + admin Drizzle 命名空间 createAdminPersistence + 0000_admin_init 迁移）与 **admin-server 后端脚手架**（Fastify5+Session/Redis+RBAC+CSRF+限流，auth/users/rooms/games[含回放帧·导出包·仲裁]/admins/audit 全路由，inject 测 8 例）、**admin-web 前端脚手架**（Vite6+React18+AntD5+TanStack Query+Zustand，登录/用户/房间·对局/回放仲裁/管理员/审计 6 页 + 深色侧栏布局 + CSRF fetch 封装；回放播放器内聚 pages/Replay.tsx、牌面用 Unicode 麻将牌区）均已落地，全量门禁绿（含 admin-web vite build）；同批已回填技术方案 §2.2/§6 与 users/rooms 原型（富字段归 P2-b）；下一步 P2-a 门禁收尾（docker compose 起 MySQL+Redis → db:migrate → 真实库起服登录 RBAC 冒烟） | 
| BL-017 | 开局仪式与摸牌位骰：逐家选位（连续同点重掷/A 选座）+ 首局一次骰同时定庄与开牌点 + 局间庄家摸牌位骰 + 物理牌墙固化展示；房间参数（牌墙模式/摸牌位骰） | 对局流程/联机 | **已修补当前发现缺项；无头CDP浏览器验收部分完成（开局全流程/双端一致/长昵称遮挡/看完才发牌均有真实截图），局间roundBreak帧残差；整体仍未100%验收**（2026-09-20） | 高 | PRD04 FR-对局-18/19/20、§4.1 + PRD03 FR-房间-10 + PRD06/07；网关§13/网络层§5.2/前端基座§11.3已回填。主助手最终pnpm test：engine179/client-core100/game-server108/persistence6 pass+3 integration skipped，合计393 pass/3 skip；包/Cocos类型检查通过，指定App起始场景H5 CLI13:39 Finished（日志已核实）。UI为AST真实生产类+严格mock，非GPU；必要视觉证据受外部阻塞，真实双端/截图未完成，用户8080未重启，不归档。见 [本轮修补与验证详表](#bl-017-开局仪式与摸牌位骰实现与验证流水) |
| BL-020 | 先看吃再碰：房间开关 chiFirstView（默认开）；吃家选定后全桌公开吃意图（副露区留空位预览+金字标签），碰家看见后再决；选定即锁定；Bot/托管不读意图 | 对局流程/联机 | 🟢 已完成（2026-09-18 实现+验证） | 中 | PRD04 FR-对局-21 + PRD03 FR-房间-10 ③；protocol pendingChi+RoomSettings.chiFirstView；redact 下发；TableScreen 副露区预览；建房弹层横屏双列+开关；home/game 原型同批 |
| BL-021 | 保底台数展示：台数徽章/浮层增「保底」口径=当前最佳拆解跑 recognize 全量计入（除胡牌流程/听牌型番种），实时重算；未听牌徽章显保底 N台（不再显 0），浮层保底区块常显 | 对局流程/体验 | 🟢 已完成（2026-09-19 口径 v2 用户复核确认） | 中 | PRD04 FR-对局-22；engine partialDecomps+securedLines+TaiPreview.secured；TableScreen 徽章两态+浮层重构；game.html 原型同批；pipeline.test 6 例 |
| BL-022 | 服务端可观测性：房间状态自检 dump（RoomActor.inspect：game.legalBySeat/currentSeat/seating 槽位表/timers/stall.idleMs）+ dev HTTP /dev/rooms、/dev/room/:id（DEV_TOOLS=1）+ 停滞看门狗（playing 超 STALL_WATCHDOG_MS 无动作 warn 在等谁/legal；默认关以保测试零定时器不变式） | 可维护性/服务端 | 🟢 P0 已完成（2026-09-21） | 高 | 技术方案《可维护性与诊断》§2；diag.test 6 例；全量 test/typecheck 通过；Admin 实时房间监控列二期（经 game-server 内网鉴权只读 inspect 端点，见 Admin 技术方案 §10.3 / PRD10 FR-Admin-10） |
| BL-023 | 客户端错误遥测：onerror/unhandledrejection 捕获 + 上下文(screen/room/round/phase)+消息环 → localStorage『ac-diag』诊断包；__AC__.diag.dump()/copy()；设置弹层「复制诊断包」玩家出口 | 可维护性/客户端 | 🟢 已完成（2026-09-21：采集器+设置弹层出口+原型 settings.html 同批） | 高 | Diag.ts + App/TableScreen 喂上下文 + SettingsModal FR-设置-05；技术方案§3；Admin 诊断包受理/解析面列二期（PRD10 FR-Admin-09） |
| BL-024 | 单局回放包导出（申诉/复现）：exportReplay/replayBundle + buildReplayBundle（snapshot 自带墙→离线确定性重演，含 settings/seating/names）+ dev /dev/export/:gameId；成员校验同 replayLoad | 可维护性/联机 | 🟢 服务端+协议+client-core 已完成（2026-09-21）；**玩家/仲裁侧导出 UI 改挂 Admin 子系统（BL-015）完成，客户端不做入口** | 高 | protocol ReplayBundle；NetService.exportReplayBundle；技术方案§4；Admin 侧见 BL-015（一期 FR-Admin-08 导出取证）；buildReplayBundle 待下沉 @ac-majong/persistence 供 game/admin 共用 |
| BL-025 | 可维护性 P1/P2 路线图：P1=时序压缩钩子产品化/repro CLI（回放包→无头重放逐帧截图）/手牌听牌自检导出；P2=e2e 协议契约测试/客户端组件生命周期测试/视图通道断言/房间级事件环+关联日志 | 可维护性 | 待办（未排期；**2026-09-21 用户拍板优先级降低**） | 低 | 来源 2026-09-21 讨论「各取两件先做 P0」；P0=BL-022/023/024 已完成；手牌自检导出在 1独 类问题再现时可提前单拉 |
| BL-026 | 结算事件补发（缺陷修复）：结算浮层原仅终局事件驱动，重连/晚进入/晚挂载只拿 settled gameView → 无浮层无「下一局」钮看似卡死（房 212817 报障）；服务端 lastTerminal 缓存+重连补发+resendSettlement 协议（仪式中不补）+客户端浮层缺失自愈 | 联机/缺陷 | 🟢 已完成（2026-09-21：服务端+协议+客户端+diag.test 2 例，服务端 117 绿） | 高 | PRD06 FR-断线-07；网关§15；前端基座；可维护性§3 诊断包首战定位 |
| BL-027 | 房号发号加固（A 案）：`genUniqueId` 同步占位关 check-then-insert 竞态（并发 create 同抽一号+INSERT 撞主键被吞→内存 Map 覆盖串房）；撞主键识别 dup-key 重抽不再 log-and-ignore；重试上限（拟 50 次→ack false『发号繁忙』）替代 `for(;;)` 死循环；历史房数阈值耗尽观测/告警 | 联机/健壮性 | 待办（未排期；2026-09-21 讨论立项，用户拍板仅记 backlog 不动代码） | 中 | 现状=90 万空间+内存/rooms 历史双查重+`rooms.room_id` 主键兜底（单实例下撞号几乎不可能）；触发线=并发建房量上升或累计房数>10 万；dev 内存存储重启后房号可复用属预期 |
| BL-028 | 房号冷却复用（B 案）：关闭超 N 天（拟 90）且无在途引用的房号允许复用→空间事实无限；分享卡/加入链带 join epoch 或令牌防「旧卡进新房」；涉及 protocol join 校验+PRD03 FR-房间-07 口径修订+原型同批 | 联机/产品 | 待办（未排期；触发线=累计房数>30 万 或 公开匹配/放量上线） | 中 | 前提 BL-027 已落地；『永不复用』为现口径，启用 B 须先改 PRD03 与分享卡格式；耗尽数学：第 N+1 房期望抽取=1/(1−N/90万)，N=81万→10 次、89万→100 次 |
| BL-029 | 听牌型新口径引擎实施：单听优先分类顺序（`|waits|==1`→独独，多摆法不升级；多听→实际新胡张整手拆解归属见证判1独，无见证且两对子补刻判对碰）+ 八对半三种特殊听法计台（单张补对→独独；两刻补第四张／八对补第三张→1独）；含包含表/互斥处理、previewTai 逐听张同源、保底区仍剔除听牌型 | 引擎/规则 | 待办（规则文档 2026-09-21 全部定案、A.1~A.6 关闭并经用户确认「准确无误」；**代码实施待用户授权后启动**） | 高 | 依据：业务规则 §4.2/§6.2/D-10/D-13；台数规格书 §2.3/§2.5/§9.4（TC-1D-01~06、TC-8D-01~03）/§9.5；PRD04 §3.1；验收以文档牌例为准，当前 engine 179 绿不代表新口径已实现 |
| BL-019 | 原型全横屏化：8 个竖屏原型页统一 844×390 横屏（home/login/room/result/replay-list 重排；rules/settings 弹层化；profile 废弃并入大厅用户条）；形态对齐客户端实现 | 设计/原型 | 🟢 已完成（2026-09-18 客户端大厅同批横屏重排落地） | 中 | 顺序 home(含 BL-018 列表)→login/room/result/replay-list→rules/settings→profile；逐页横屏截图核对 |
| BL-018 | 公开房间与大厅房间列表：建房增「公开」开关（默认开）；大厅列公开房列表（等待/对局中徽标、一键加入/置灰、5s 自动刷新+手动钮、空态）；非公开仅房号可入 | 联机/大厅 | 🟢 已完成（2026-09-18 实现+e2e 全过） | 中 | PRD03 FR-房间-11 + §3.3；网关 §14；前端基座大厅重排；e2e：公开房列表可见可加入/非公开不下发/对局中置灰 |

## 维护记录

### BL-017 开局仪式与摸牌位骰实现与验证流水

**当前状态：已修补当前发现缺项；无头CDP已产出真实浏览器截图（1真人3Bot全流程、2真人2Bot一致、长昵称遮挡、看完才发牌），仅局间roundBreak帧残差；整体未100%验收，不归档。** 当前明确缺项可记为已修补，但不能泛称全Spec完成或100%视觉通过；必要验收证据无法生成属于外部阻塞。仅回填已有修补与主助手最终验证事实，不调整排期/计划。下方旧流水及旧数字按发生时点保留，不倒写；最新结果以下方393/3与13:39构建摘要为准。

| 日期 / 阶段 | 记录 |
|---|---|
| 2026-09-18 · 历史基础实现 | 基础仪式/物理墙实现及既有引擎 bl017 10 例、seatingCeremony 12 例通过，仅为历史记录，不代表本轮逐家展示已验收 |
| 2026-09-20 · 文档先行（历史时点） | PRD04/06/07、网关 §13、网络层 §5.2、前端基座 §11.3 与连续原型先更新：逐家1200ms滚动+2000ms结果、排名/同点汇总2000ms、落座1500ms、定庄/局间1200ms+3000ms；optional presentation/ceremonyToken、稳定身份与恢复契约。当时记录原型10场景假时钟/DOM核对通过、截图受浏览器不可见限制，业务实现/双端联验/截图对齐待完成；不改写该历史状态 |
| 2026-09-20 · 本轮实现完成 | protocol、server、TableScreen 内 CeremonyPanel、NetService、RoomScreen 已完成逐家展示与门控、权威真实双骰、连续重掷旧结果、输入 token、缓存早到路由和当前步骤恢复；原型已更新。实现完成不等于视觉联验通过 |
| 2026-09-20 · 同批离线与重入设计补齐 | RoomActor 首局仪式掉线记录最初 offlineSince，发牌进入 playing 后按 max(0, offlineSince+trusteeAfterMs-当前时间) 接续托管剩余等待；重复 disconnect 不延后、不卸已接管连接，避免进入 playing 漏托管，正式 60s 规则未改。addPlayer 既有成员重入先向本人补权威 roomView（身份/玩法/仪式），再 broadcastAll；刷新局间不再依赖 placeholder 推断真人/Bot/墙模式，gameView-only 仅保留旧服务端兼容说明 |
| 2026-09-20 · CodeReview 后修复 | 一次 CodeReview 指出 restart 旧 playing 缓存被新增路由误用；NetService.restart 已改为先 `this.leave()` 清旧 view/room/仪式时钟，再 create 并沿用玩法设置。3 个 restart 回归覆盖默认局数、指定局数以及无连接分支，计入最终 client-core 37 项，不重复加总 |
| 2026-09-20 · 同步脚本维护 | sync-to-cocos 已改为原位更新生成源码、保留已有 .meta/UUID，不再整目录删建，避免破坏 Cocos 资源引用；技术正文与维护记录已注明。保留现有资源身份不等于恢复此前已变化的 UUID |
| 2026-09-20 · Spec 逐项复核补齐 | 补齐首input 250ms淡入且重复/重入不重播、同名机器人在提示/排名/定庄说明中用当前风位区分、旋转/缩放逐点对齐原型500ms线性关键帧（转换CSS与Cocos角度方向）。新增3项回归后全量329通过、3项集成跳过，包与Cocos类型检查通过；H5指定App场景12:54构建Finished。Browser仍hidden/attached=false，Cocos帧数0，画布读取全黑；替代渲染验证调用未获执行，无有效截图，保持视觉联验未完成。仅本次临时测试进程/脚本已清理，未触碰用户8080服务 |
| 2026-09-20 · 最终主助手验证 | 实际执行 `pnpm test`、`pnpm typecheck`、Cocos tsc 与指定起始场景的 H5 CLI 构建，结果如下；这是本轮实现后的已执行记录，本次文档收口没有重新执行这些命令 |
| 2026-09-20 · 当前缺项修补与最终验证回填 | seating主动leave接续原60s、原型重掷末次result门控与庄徽下移、Cocos legacy总点数/Tooltip/可见禁用按钮/74px时钟/步骤闭包与动效明确缺项已修补（详表见下）。主助手最终实跑393 pass/3 skip、包/Cocos类型检查通过，H5指定App场景13:39 Finished（日志已核实）；原型专项为10 scenario/131状态+6门控的JS/节点替身验证，非Browser视觉。连续三轮目标turn浏览器不可用，真实双端/截图未完成，整体未验收、不归档；本次仅文档回填，其他窗口结算变更保留且不归为本任务成果 |
| 2026-09-20 · 无头CDP浏览器验收（部分） | 原生Browser面板仍报NATIVE_BROWSER_VIEWPORT_UNAVAILABLE(hidden)，改用系统Chrome headless=new+CDP(软件WebGL swiftshader)驱动H5构建(8095静态站)+独立8093内存测试服(account鉴权/AUTO_BOTS=0)，经__AC__调试钩子程序化登录/建房/加Bot/开始并逐(stepId,phase)截图。**1真人3Bot**：逐家input/rolling/result、同点重掷summary、ranking、选座、seated、定庄rolling/result及「看完结果才发牌」共50张、0控制台错误；**2真人2Bot**：双CDP会话同房，两家presentation逐step对比0字段差异(顺序/骰面/结果/排名/落座/庄)，B端渲染正确含「我」标记；**长昵称(20字)**省略号截断不遮挡按钮/墙条。**局间roundBreak已补齐**：此前未捕获系验证脚本三处误用——①以roomView.phase==='settled'判定结算（实际结算在gameView相位settled/exhaustive，room相位恒为playing）；②建房未开breakDice（默认关，roundBreak仅在该设置开启时触发）；③roundBreak仪式随gameView.seating下发而非roomView.seating。修正后roundBreak input/rolling/result 双端各3帧截图（temp-verify/shots-rb3），罗盘/骰面/庄家徽/「即将自动发牌」渲染正确。无服务端缺陷（此前「全自动局停滞」系脚本误判，已排除）。验证资源(8093/8095/chrome profiles)验后已清理，用户8080未触碰；截图与驱动脚本留存temp-verify/ |
| 2026-09-21 · 定座位逐轮淘汰定序 | 用户指出定座位每轮在全部4人判同点有误：首轮点数唯一者当轮即定序、不应参与后续同点比较。修订为仅本轮掷骰者（未定序组）内判重、并列组在其预留名次块内定序（经用户确认：块内定序 + 已定序者不参与判重）。RoomActor 新增 seatingSlots/seatingRollers 槽位表实现，原型 cerSummarize 与牌桌/原型展示文案同批同步；seatingCeremony 新增3例（撞点不重掷/块内定序/三轮细化）并修订连续重掷例，全量 engine179/client-core100/game-server111/persistence6 通过、包与 Cocos assets 类型检查无新增错误；PRD04/网关§13/本流水同批回填 |

**本轮当前缺项修补详表**（以下「已修补」仅指当前明确缺项，不等于全Spec或视觉验收通过）：

| 范围 | 已修补内容 | 验证依据 / 边界 |
|---|---|---|
| 网关主动退出 | phase=seating与playing的leave均走playerDisconnected；保留成员/座位/最初offlineSince，发牌后接续原60s期限；waiting不变，不重写既有RoomActor收尾 | 新增4例真实WS回归，WS15/15包含在server108内；正式时长+业务假时钟/独立随机端口与内存存储，非浏览器双端 |
| 原型连续重掷与徽章 | 最后一次重掷result不宣布最终名次/最大者，仅无同点最终summary-ranking及后续选座显示；庄徽top:auto、bottom:0、right:-35px，与风徽分带；保留原骰子夹具/轮转序/全体判同点规则 | 专项agent的10 scenario/131状态+6门控为JS/节点替身验证；CSS静态核对，非Browser视觉 |
| Cocos旧协议 | 缺presentation仅显示旧总点数；选位卡提示「旧版仅提供总点数」，定庄/局间显示「总点数 N 点」，不从和拼双骰 | AST真实生产类+严格mock；与gameView-only占位room兼容分别说明，见网络层§5.2 |
| 长昵称与按钮/时钟 | 悬停/点击昵称显示完整名Tooltip，2秒关闭（移开/点击提示/切step也关闭）；非pick主钮在他人/展示期可见禁用并显示对应文案；pick/summary保留禁用四座与金色selected；时钟固定74px | UI100中的节点状态/生命周期断言，非真实字体/GPU |
| 步骤闭包与触摸生命周期 | 每新step以Node.off/on重绑捕获token的处理器，相同步骤不重绑；TOUCH_START跨step到TOUCH_END拒绝，TOUCH_CANCEL清手势；disposed后旧提交回调无效 | UI100真实生产类回归，不以仅改按钮禁用代替token/生命周期守卫 |
| 字体与风/庄徽 | pending文字10px、textMuted弱色、普通字重；自己的输入提示goldLight金色粗体+1秒ease-in-out脉冲；Wind圆徽相对卡中心(x55,y21)，Dealer徽(x76,y-16)、高14px | 生产类节点/绘制指令与静态CSS核对，非截图对照 |
| 落定与庄光 | 落定90ms达1.03峰值、200ms回1，分段CSS ease；庄光1000ms外发光半径14→24→14，均包含在服务端结果期内 | UI100关键帧/绘制指令断言，不代表实际GPU动效观感通过 |

**主助手本轮最终测试/构建摘要**（本次文档回填未重跑）：

| 最终自动化项目 | 结果 | 验证边界 |
|---|---|---|
| `pnpm test` · engine | **179 pass** | 引擎测试 |
| `pnpm test` · persistence | **6 pass + 3 integration skipped** | 3 项跳过不算通过 |
| `pnpm test` · client-core/UI | **100 pass** | AST真实生产类 + 严格mock，生命周期/节点状态/绘制指令回归；非GPU、真实字体或截图；包含既有restart等用例 |
| `pnpm test` · game-server | **108 pass** | 服务端与WS自动化，不是真实双端浏览器e2e |
| `pnpm test` · 合计 | **393 pass / 3 integration skipped** | 179+100+108+6=393；3项跳过不算通过，专项原型验证不重复加总 |
| `pnpm typecheck` | **通过** | 包类型检查 |
| `npx tsc --noEmit -p client/ac-majong/temp/tsconfig.check.json` | **通过** | Cocos CLI 静态检查，不证明实机初始化 |
| H5 CLI，`startScene=01c1425f-8926-40e9-8f67-e149f5238405` | **13:39 Finished**（构建日志已核实） | 指定App起始场景构建，不证明场景已运行 |

**视觉联验阻塞与环境边界**：

- Browser连续三轮目标turn均报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`、hidden/attached=false；用户已经打开仍不可用，不再把「用户打开浏览器」当作已经解除阻塞。
- `window.open`返回false；rAF暂停使Cocos初始化卡在scene=null、无__AC__。JS导航成功不等于场景运行，脚本/节点替身验证不等于Browser视觉。
- **原生Browser面板仍是外部阻塞，但已用无头CDP产出大部分真实浏览器证据**：1真人3Bot全流程/2真人2Bot一致/长昵称遮挡/看完才发牌均有截图；仅局间roundBreak帧残差（第1局无头150s未结算）。不得宣称全Spec完成或100%视觉通过，整体保持未100%验收、不归档。
- 8080为用户原服务，未重启以保护真实牌局；8093为历史独立内存测试服务，浏览器未连成功，不计e2e。
- 本次仅更新PRD04/06/07、网关/网络层/前端基座与本backlog共7份既有文档；未改业务、测试或计划，未创建文档，未操作Browser、启停服务或重跑测试/构建。源码及文档中其他窗口的结算相关变更原样保留，不描述为本任务实现结算。

## 归档
已完成条目移至 `归档/`，保留编号与完成时间，便于追溯。
- 2026-09-16：BL-010 后端持久化基座、BL-011 engine `rehydrate` 还原入口 → `归档/2026-Q3.md`
- 2026-09-16：BL-002 局数上限选择（含「不限」）、BL-004 大厅与创建/加入房间流程 → `归档/2026-Q3.md`（路线图 M-C）
