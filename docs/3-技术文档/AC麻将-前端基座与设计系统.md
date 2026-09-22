# A&C 麻将 · 前端基座与设计系统（技术方案）

> **模块**：Cocos 客户端基座（`client/ac-majong/assets/scripts/` 下 `ui/` `app/` `screens/`），负责设计令牌、通用组件工厂、屏幕路由与应用装配。
> **关联**：总体架构 [`AC麻将-联机架构方案.md`](./AC麻将-联机架构方案.md)｜网络层 [`AC麻将-客户端网络层.md`](./AC麻将-客户端网络层.md)｜登录页实现 [`AC麻将-登录鉴权.md`](./AC麻将-登录鉴权.md) §5｜牌桌状态 [`AC麻将-对局流程引擎.md`](./AC麻将-对局流程引擎.md)
> **产品**：全局设计基调与页面清单见 [`../1-prd/00-产品总览.md`](../1-prd/00-产品总览.md)；视觉基线为 [`../2-效果图/HTML格式高保真原型/`](../2-效果图/HTML格式高保真原型/_index.html)（`style.css` + 各 `*.html`）。
> 遵循[《文档总纲》](../README.md)三原则：本文件为前端基座与设计系统模块的全量技术说明。

---

## 1. 目标与范围

- **一套跨平台基座**：Cocos Creator 3.8 微信小游戏为主目标，同一套设计令牌与组件规范可平移到未来 HTML5 版。
- **运行时构建、无预制体**：所有 UI 用 `Graphics` + `Label` 动态生成，不依赖 `.prefab`，避免预制体在微信/Web 间的序列化差异，也便于纯代码审阅与 diff。
- **视觉 1:1 还原原型**：设计令牌移植自高保真原型的 `style.css :root`，风格为传统中式（红木质感 + 金色边框 + 深绿桌布）。
- **单 Canvas 多屏路由**：以「屏幕节点显隐」替代 `director.loadScene`，共享网络单例与资源，贴合小游戏「一个包体、页面轻量切换」形态。
- 本文档**不含**具体业务页面（登录/大厅/牌桌/结算）的实现细节——它们各自归属对应模块技术方案，本文只定义其共同依赖的基座。

## 2. 目录结构

```
client/ac-majong/assets/scripts/
├─ app/         应用装配与路由
│  ├─ App.ts          根控制器（挂 Canvas）：装配 SceneRouter、注册屏幕、启动
│  ├─ SceneRouter.ts  Screen 抽象 + 单 Canvas 多屏路由
│  └─ Config.ts       SERVER_URL + 本地 mock 身份（详见登录鉴权 §5.1）
├─ ui/          设计系统
│  ├─ Theme.ts        设计令牌（color/space/radius/size/font）
│  ├─ UiKit.ts        通用组件工厂（背景/文本/按钮/面板/徽章/弹层）
│  └─ AudioManager.ts 音频子系统单例（SFX 播放 + 静音偏好，见 §12）
├─ screens/     业务屏幕（各自 build 节点树）
│  ├─ LoginScreen.ts  登录页（见登录鉴权 §5.3）
│  └─ LobbyScreen.ts  大厅页（见登录鉴权 §5.4）
├─ game/        牌桌渲染与网络服务
│  ├─ NetService.ts   Cocos 侧网络单例（见客户端网络层 §6）
│  ├─ TableView.ts    牌桌视图（对局表现，见对局流程引擎）
│  ├─ TileNode.ts     单张牌节点
│  └─ TileAtlas.ts    牌面贴图寻址
└─ vendor/      monorepo 核心包预编译同步产物（见客户端网络层 §8）
   ├─ engine/  protocol/  client-core/
```

## 3. 设计令牌 `Theme`（`ui/Theme.ts`）

- **来源**：1:1 移植自 [`style.css`](../2-效果图/HTML格式高保真原型/style.css) 的 `:root`，所有 UI 组件与页面均引用此处，保证视觉一致、便于统一调整。
- **结构**：`Theme.color` / `Theme.space` / `Theme.radius` / `Theme.size` / `Theme.font`，另有 `rgba(r,g,b,a∈[0,1])` 辅助函数生成半透明色。

| 分组 | 代表令牌 | 说明 |
|---|---|---|
| 主色调 | `bgTable`#0d4a2a / `bgWood`#3d1f0d / `bgPanel` / `bgCard` | 深绿桌布、红木、半透明面板、木纹卡 |
| 金色系 | `gold`#d4a537 / `goldLight` / `goldDark` / `goldFaint` / `goldHairline` | 描边与标题主色，多档透明度 |
| 牌面 | `tileFace`#fffef5 / `tileBorder` / `tileWan` / `tileTong` / `tileTiao` / `tileWind` | 象牙白底 + 万红/筒蓝/条绿/字黑 |
| 文字 | `textPrimary`#f5e6c8 / `textSecondary` / `textMuted` / `textDark` | 暖白主文字，深字用于浅底 |
| 功能色 | `success` / `warning` / `danger` / `info` | 状态提示 |
| 其它 | `wxGreen`#07c160 / `mask`rgba(0,0,0,.65) | 微信品牌绿（登录按钮）、弹层遮罩 |
| 间距 | `space` xs4 / sm8 / md12 / lg16 / xl24 / xxl32 | 布局栅格 |
| 圆角 | `radius` sm4 / md8 / lg12 / xl16 / full9999 | 组件圆角 |
| 尺寸 | `size` tileW42 / tileH58 / headerH48 / tabH56 / **designW844 / designH390** | 牌张、栏高、**设计分辨率（横屏）** |
| 字号 | `font` hero30 / h2 28 / title18 / body14 / small12 / tiny11 / mini10 | 对齐 `style.css` |

- **设计分辨率 844×390（横屏）**：`uiBackground` / `uiModal` 默认以此为全屏尺寸；Cocos Canvas 配 `Widget`/适配策略后按此比例布局。

## 4. UI 组件工厂 `UiKit`（`ui/UiKit.ts`）

全部运行时用 `Graphics` + `Label` 构建，返回 `Node`，调用方 `setParent` + `setPosition` 装配。私有 `roundRectPath(g,w,h,r)` 在锚点 0.5 的本地坐标画圆角矩形。

| 组件 | 签名要点 | 说明 |
|---|---|---|
| `uiBackground(kind)` | `'table'`\|`'wood'`，默认全屏 | 底色 + 底部 45% 半透明暗部近似渐变 |
| `uiLabel(text, opts)` | `LabelOpts{size,color,bold,width,align}` | 给 `width` 则 `overflow=RESIZE_HEIGHT` 自动换行 |
| `uiButton(text, onClick, opts)` | `ButtonOpts{variant,width,height,fontSize,enabled}` | 4 变体见下；`TOUCH_END` 触发；禁用态不响应 |
| `setButtonEnabled(node, enabled)` | — | 禁用压暗（`UIOpacity`=140）并拦截点击；用于「勾选协议后才可点」 |
| `uiPanel(w, h, opts)` | `variant:'panel'`\|`'gold'` | 半透明黑 + 金描边 / 木纹卡 + 金描边 |
| `uiBadge(text, bg?, fg?)` | 宽度按字数自适应 | 圆角胶囊徽章 |
| `uiModal(title, opts)` | 返回 `{root, panel, close}` | 遮罩 + 居中 gold 面板 + 标题 + ✕；点遮罩或 ✕ 关闭，内容自行加到 `panel` |

**按钮 4 变体**（对应原型按钮规范）：

| variant | 填充 / 描边 / 文字 | 默认尺寸 | 用途 |
|---|---|---|---|
| `primary` | 金底 / 亮金边 / 深木字，圆角=半高 | 180×46 | 主操作（登录、开始） |
| `wx` | 微信绿 / 深绿边 / 白字，圆角=半高 | 280×50 | 微信登录按钮 |
| `action` | 木纹卡 / 金边 / 金字 | 64×40 | 牌桌动作（碰/杠/胡/过） |
| `secondary` | 透明 / 灰描边 / 次级文字 | 180×46 | 次要操作、弹层 ✕ |

- **禁用态**：`disabledMap`（`WeakMap<Node,boolean>`）记录，`TOUCH_END` 命中禁用则直接 `return`；`UIOpacity` 视觉压暗。

## 5. 屏幕抽象与路由（`app/SceneRouter.ts`）

### 5.1 `Screen`（抽象类）

```ts
abstract class Screen {
  abstract readonly name: string;
  router!: SceneRouter;        // 由 router 注入，供屏幕内导航 this.router.show('lobby')
  node: Node | null = null;    // 首次 show 懒构建，之后复用
  abstract build(): Node;      // 构建屏幕节点树并返回根
  onEnter(): void {}           // 每次进入（刷新数据/复位交互态）
  onExit(): void {}            // 每次离开
}
```

### 5.2 `SceneRouter`

- `register(screen)`：注入 `router`、按 `name` 入表，**链式**返回 `this`。
- `show(name)`：目标不存在或已是当前则忽略；否则对当前屏 `onExit()` + `node.active=false`；目标屏首次 `build()` 并 `setParent(root)`，之后仅 `active=true`；置为当前并 `onEnter()`。
- `currentName`：当前屏名。

### 5.3 为什么「单 Canvas 多屏」而非 `loadScene`

- 避免频繁场景加载/卸载开销；
- 便于共享 `NetService` 单例连接与已加载资源（牌面贴图、字体）；
- 屏幕节点懒构建 + 复用，切换即显隐，符合小游戏轻量页面切换形态。

## 6. 根控制器 `App`（`app/App.ts`）

- 挂在场景 Canvas 上的 `@ccclass('App')` 组件；`start()` 中：
  1. `new SceneRouter(this.node)`（以 Canvas 节点为屏幕根）；
  2. `register(new LoginScreen()).register(new LobbyScreen())`；
  3. `show('login')` 从登录页启动。
- 后续屏幕（房间 / 牌桌 / 结算）实现后在此追加 `register`，路由与生命周期不变。

## 7. 屏幕与业务页面清单

| 屏幕 | 文件 | 归属技术方案 | 状态 |
|---|---|---|---|
| 登录 | `screens/LoginScreen.ts` | [登录鉴权 §5.3](./AC麻将-登录鉴权.md) | ✅ M-B |
| 大厅 | `screens/LobbyScreen.ts` | [登录鉴权 §5.4](./AC麻将-登录鉴权.md) | ✅ M-B（骨架）|
| 房间 / 等待 | 待建 | 房间系统（PRD 03，技术方案待补） | ⬜ M-C/M-D |
| 牌桌 | `game/TableView.ts` | [对局流程引擎](./AC麻将-对局流程引擎.md) + 表现层（PRD 07） | 🔶 渲染雏形 |
| 结算 | 待建 | 结算与积分（PRD 05，技术方案待补） | ⬜ M-F |

> 各业务屏幕内部一律用 `UiKit` 组件 + `Theme` 令牌构建节点树，不得硬编码颜色/尺寸，保证与原型一致且可统一调整。

## 8. 配置 `Config`（`app/Config.ts`）

- `SERVER_URL`：本地联调 `ws://127.0.0.1:8080`，上线改云托管 WSS（M-K）。
- `mockIdentity()`：本地 mock 身份（首次生成并持久化到 `sys.localStorage`，之后复用）。
- 二者用于登录链路，完整语义见[登录鉴权 §5.1](./AC麻将-登录鉴权.md)。

## 9. 视觉近似与后续精修

- **CSS 无直接对应的效果**：线性渐变、`letter-spacing`、复杂阴影在 Cocos 无等价 API，当前用「**纯色 + 描边 + 半透明暗部**」近似（如 `uiBackground` 底部压暗、按钮描边）。
- **精修计划**：渐变贴图、中式字体、动效留到牌桌表现层（M-E）与表现动画模块（PRD 07）统一处理，不在基座内引入图片资源依赖。

## 10. 构建与约束

- **TS 配置**：Cocos 工程用其自带编译（`strict:false`），与 monorepo 服务端/包的 `strict:true` 分离；基座代码仍按严格习惯书写（显式类型、可空判断）。
- **核心包依赖**：`ui`/`app`/`screens` 不直接 `import '@ac-majong/*'`；如需引擎/协议类型，经 `vendor/` 预编译产物引入（同步机制见[客户端网络层 §8](./AC麻将-客户端网络层.md)）。
- **同步保留资源身份（2026-09-20）**：`scripts/sync-to-cocos.mjs` 已改为在既有 vendor 目录原位更新生成 `.ts`、保留已有 `.meta`/UUID，不再整目录删建，避免破坏 Cocos 资源引用。仍经 `pnpm sync:client` 同步、禁止手改生成副本；此变更不承诺恢复此前已变化的 UUID，也不替代运行时验证。
- **无预制体**：新增屏幕/组件一律代码构建，评审以 `.ts` diff 为准。
- **CLI 构建必须显式指定 startScene**：工程含多场景（scene/App/Table），`CocosCreator --build "platform=web-mobile"` 不传 startScene 时 launchScene 会退化为空的 `scene.scene`（Canvas 无 App 组件，页面黑屏且无任何报错）；正确命令：`--build "platform=web-mobile;startScene=01c1425f-8926-40e9-8f67-e149f5238405"`（App.scene 的 uuid）。

---

## 11. 牌桌渲染与牌面资源（TableScreen / TileNode）

### 11.1 布局预算（还原 game.html，844×390 横屏）
- 垂直：状态栏左上 ~30 / 北家 ~47 / 中央牌河 ~232 / 南家 ~105；水平：西 ~78 / 中央牌河 ~688 / 东 ~78。
- 状态栏：左上角胶囊、单行 nowrap、CJK 按字号估宽（标签不设 width，避免 `RESIZE_HEIGHT` 折行）。
- 西/东家：整块垂直居中（pinfo 在上、body(牌背竖条|明牌竖排) 水平居中在下），对齐原型 `left/right:8px`；牌背 >12 张自适应压缩间距并整组上移，避免压南家信息行。

### 11.2 牌面资源加载与缓存（TileNode）
- `resources.load` 异步载入牌面 `SpriteFrame`；模块级 `frameCache` 缓存，命中则**同步**赋值，降低重复载图与异步窗口。
- **终局摊牌**：`win`/`exhaustive`/`zhahu` 三类终局事件存 `revealed` 并重渲染——北家面牌横排、西/东面牌双竖列（16×22），phase 离开 settled/exhaustive 时收起；结算浮层内另设「各家手牌」2×2 牌面区（13×18、cellLeft 布局），结果页内直接看清四家手牌。
- **解散二次确认** `showDissolveConfirm`：结果页「解散牌局」先弹确认框（确认解散/取消），确认框挂 `BlockInputEvents` 防穿透误点，确认后才 `net.dissolve()`。
- **台数预览浮层**：三态状态行（可自摸 · N台 / 打 X 听牌 · N台 / 听牌 · N台）+ 明细行带 `×count`；**结算明细**按张番种附小字行列出具体牌（`tileName` 支持 Z1..Z7 字牌、H1..H8 花牌）。
- **牌面选择器** `showTileChooser`（吃/杠多解共用）：面板高度 = 标题 + 选项数×行高 + 内边距（自适应，不溢出）；每选项渲染为真实牌面组合（`createTileNode` 24×34）。
- **手牌选中**：按**位置索引** `selectedIdx`（非牌 ID），一对牌点选仅抬被点的那张；视图刷新（`render`）时清除选中，出牌按索引从排序手牌取牌 ID。
- **摸牌显示**：`you.drawn` 下发的刚摸牌在排序手牌**原位抬高 10px**（抽出态，取最右一张同牌），选中抬高 18px 以区分；`drawn=null` 时回退连排。
- **竞态守卫**：异步回调可能晚于节点销毁到达（对局中每次 `gameView` 重渲染 `destroyAllChildren`），此时 `sp.node` 为 null，再赋 `spriteFrame` 会触发 Cocos `Sprite` 读 `null._uiProps` 崩溃；回调内必须 `if (!sp.isValid || !sp.node || !sp.node.isValid) return;`。

### 11.3 开局/局间仪式展示基线（BL-017，2026-09-20：已修补当前发现缺项，浏览器视觉验收受阻）

**唯一视觉基线**：[`game.html`](../2-效果图/HTML格式高保真原型/game.html) 仪式区域；仅替换仪式与其评审控制，不改牌河、手牌、结算、四边实际墙排等无关布局。首局仍是①逐家选位骰→②最大者选座→③A**一次掷骰同时定庄与开牌点**；局间仅当前庄家定摸牌位。

**当前实现**：Spec审计列出的legacy总点数、长名Tooltip、可见禁用按钮、步骤闭包/跨步手势、徽章与动效明确缺项已修补，原型末次重掷排名门控与庄徽分带已修正。整体为**已修补当前发现缺项，浏览器视觉验收受阻**，非全Spec完成。`CeremonyPanel` 位于 `game/TableScreen.ts` 内，由牌桌管理创建、增量更新与清理；本节契约和自动化结果**不表示Cocos实机、真实双端或截图通过**（§11.3.4）。其他窗口的结算相关变更保留，不归为本任务实现成果。

#### 11.3.1 布局预算与视觉规则

以下为844×390视口、640×330面板的CSS定位值（面板外框左上为102,30；内容绝对定位相对边框内侧）。Cocos转换仍以画布中心为原点、Y向上，不能把CSS的top当作Cocos的正Y。面板金色主题、红木底色、边框/圆角/阴影沿用既有样式。

| 原型节点/区域 | 布局与视觉约束 |
|---|---|
| `.ceremony-panel` | 640×330，居中；padding 12px 20px，box-sizing:border-box；不靠增加面板高度容纳说明 |
| `.ceremony-title` / `.ceremony-stage` | 标题17px、行高23；阶段10px、行高14；标题带约top12..49 |
| `.ceremony-body` | left/right20、top58、height158；四横卡与罗盘共用同一主体带，互斥显示 |
| `.ceremony-seats` / `.pcard` | 4个等宽minmax列、gap12、高158，绝不改2×2；卡片以userId持续存在，已揭晓结果不随下一家消失；昵称13px单行省略，身份9px，结果13px、状态10px |
| `.dice-zone` / `.die` | 主双骰32×32、间距6；象牙白底，1/4红点、其余黑点；两骰与总和一起读成「4＋3＝7点」；落定卡片90ms达1.03峰值、200ms回1，分段CSS ease，包含在结果期内 |
| `.sum.pending` / `Sum` | 10px、textMuted弱色、普通字重；已揭晓总和恢复13px金色粗体，不把待掷/掷骰中文字加粗 |
| 昵称 `title` / `NameTooltip` | 原型保留完整名title；Cocos悬停/点击昵称显示完整原文Tooltip，560×34位于面板局部(0,119)，2秒自动关闭，移开/点击提示或切step也关闭；不扩卡、不暂停倒计时 |
| `.ceremony-old` | 卡内19px独立旧结果行，旧双骰16×16+旧总和；待重掷/滚动期间标「上次」，到本人落定才消失 |
| `.compass` / `.scard` | 上北下南左西右东；卡118×46；北居中top0、南居中bottom0、西left64/top56、东right64/top56；昵称11px、身份与子数8px；位置取最新座位映射 |
| `.scard .wind` / `WindBadge` | 20×20圆徽，CSS top:-8px/right:-6px；Cocos相对卡中心(x55,y21)，圆半径10，风字10px |
| 罗盘庄徽 / `DealerBadge` | 高14px，CSS top:auto/bottom:0/right:-35px；Cocos相对卡中心(x76,y-16)、宽34，红底金边；与风徽上下分带 |
| `.scard.dealer-hit` / `Glow` | 结果期内1000ms外发光，半径14→24→14（0/500/1000ms，分段CSS ease），不以细描边透明度代替 |
| `.compass-dice` | left50%居中、top54、双骰40×40、间距8；总和/算式置双骰下方top42，11px、宽122，不再悬挂到右侧卡片 |
| `.ceremony-info` | left/right20、top220、height38；四横卡显示排名/落座两行，罗盘显示墙条/说明，均不挤入按钮区 |
| `.wall-strip` / `.ws` | 18组，每组12×16、gap3；从视觉左至右的组号为18..1，右端N组带skip语义但仍常色牌背，第N+1组pt金框；N=7时右端7组跳过、第8组开摸；random不渲染该条 |
| `.ceremony-hint` | top262、height16、11px；单行省略并保留完整title，直接说明谁操作/坐庄/上子，不展示mod公式；自己的输入提示goldLight金色粗体，1秒ease-in-out脉冲，其他提示次级色普通字重 |
| `.ceremony-cd` / `.ceremony-foot` / `CeremonyClock` | 进度条top282、左右60、高3；按钮行top291、高27、左右20；时钟宽74px，Cocos y-139.5，掷骰时x89、选座时x150；按钮与时钟左右分离 |
| 主钮 / `CeremonyRoll` | 非pick阶段始终可见；本人有效input可用「掷骰」，他人input禁用「等待当前玩家」、rolling禁用「掷骰中…」、选位result禁用「查看结果」、定庄/局间result禁用「即将自动发牌」、summary禁用「仪式进行中…」 |
| `.seat-pick.selected` / `CeremonyPick0..3` | pick/input与pick/summary-seated都保留四座；他人/汇总期全部禁用，已选座保留金色selected（描边、文字、淡金底，原型含光晕），不以隐藏替代禁用 |
| `.ceremony-demo-tools` | 视口底部3px、22px高；仅原型场景选择/重新演示/关闭，与正式面板分离，不作为客户端玩家入口 |

- 「我」独立金框/淡金底/角标（`.me`），不依靠昵称后缀才能识别；长昵称省略但可查看完整名。机器人身份与座位行一直保留；提示、排名与定庄结果中的名字追加「我」或同名玩家的当前风位，不能仅在卡片身份行区分同名机器人。
- `.die.rolling`每500ms循环，0/125/250/375/500ms时的CSS角度为−24/10/26/−8/−24度，缩放为1/1.08/1/0.94/1，段内线性插值；Cocos的Y向上坐标系使用相反旋转角，两枚骰子同节奏，不用额外相位偏移。
- 长昵称卡片保留完整原文，截断仅用于常态排版；悬停或点击昵称时在面板上方暂显完整名，移开/点击提示或2秒后关闭，不增加推进确认。
- 非本人输入也保留禁用主钮，文字随input/rolling/result/summary变化；pick的input与落座summary均展示四座钮，非本人或summary禁用，已选座金底。倒计时槽固定74px，按钮与时钟左右分离。
- `.sum.pending`为10px弱色普通字重；“轮到你”提示为金色粗体并按1秒ease-in-out脉冲。落定90ms（45%）达缩放1.03峰值、200ms终点回1，分段CSS ease；庄家1秒金光以外发光半径14→24→14变化表达，不仅改变细描边透明度。风位圆徽位置x55/y21，庄徽改为x76/y−16，互不遮挡。
- 当前操作者以`.is-actor`金色外描边+「当前操作」文字标明；最终最大者`.max-roll`+排名文字；同点者红徽/`.is-reroll`+「待重掷」文字，不能只用颜色。
- 定庄/局间已揭晓后`.dealer-hit`播放1000ms金光，红底金边庄家徽章与风位徽章错开；首局A普通子及B庄子在卡内子数行显示，A=B为2；局间显示实际存子数、不得为摸牌位骰再加子。

#### 11.3.2 原型状态类 → 客户端对齐

| 层级 / 原型状态类 | 快照映射与行为 |
|---|---|
| `stage-roll` / `stage-pick` | 对应业务stage；四横卡，选座时仍保留真实骰面/排名 |
| `stage-dealerBreak` / `stage-roundBreak` | 对应业务stage；罗盘；首局合并骰/局间当前庄家，不增加两掷步骤 |
| `phase-input` | presentation.phase=input；仅自身为actor且期限内可操作；真人10000ms，Bot/离线/托管600ms |
| `phase-rolling` / `.die.rolling` | 完整1200ms；每90ms仅更新当前一家的两枚中间骰面，旧重掷结果独立保留；终值尚未揭晓 |
| `phase-result` / `.pcard.reveal` | 选位结果2000ms（含200ms缩放）；定庄/局间3000ms（含1000ms庄光）；等待服务端转步 |
| `phase-summary.summary-ranking` | 仅全体无同点的最终汇总才显示排名/最大者，展示2000ms后开放选座；原型重掷input/rolling/末次result不因旧order或队列清空提前宣布最终名次 |
| `phase-summary.summary-reroll` | 同点者与旧结果展示2000ms，然后按开始时的原轮转序仅同点者重掷，可连续多轮 |
| `phase-summary.summary-seated` | 最新落座归属展示1500ms，四个选座按钮可见且全禁用、金色selected保留；之后进入定庄输入，不立即发牌 |
| `.is-actor` / `.is-reroll` / `.max-roll` / `.me` | 相互独立的卡片状态；不能用当前数组索引替代userId来匹配 |
| `.seat-pick.selected` / `disabled` | 选中座位金色；仅A在input可点，提交后锁定；其他玩家与所有展示阶段禁用 |

面板还输出 `data-ceremony-id/data-step-id/data-phase/data-actor`；四卡输出 `data-user-id`，墙组输出 `data-from-right`。这些是原型对账标识，不是新协议字段。布局、状态、文案、颜色、字号须一起还原，不只复用函数结构。

#### 11.3.3 快照驱动、时钟与生命周期

- 使用网络层 §5.2 的 **optional `presentation`**：`ceremonyId/stepId/startedAt/deadline/serverNow/phase/actor/rerollRound/pendingRollUserIds/resultsByUserId/ceremonyDice/summaryKind`，所有时间为毫秒；保留业务stage不变。
- 面板与卡片节点持续存在，按仪式ID/步骤/用户ID增量更新；仅新仪式首个input开始250ms内按原型opacity ease淡入，以服务端步骤时间为锚，中途重入或后续步骤直接显示，**不得每次roomView/gameView销毁所有仪式子节点再弹出**。相同步骤重复广播不重置动画/倒计时，已揭晓终值只能取权威两骰，禁止从和拼造。
- 服务端时间样本+本地单调计时估算当前进度；弱网/重连/后台返回恢复当前步骤与剩余时间，不补播错过历史。旧步骤/旧仪式回调失效；退出/结束取消本页Tween、schedule与定时器。具体token/兼容/超时语义见网络层 §5.2与网关 §13。
- `RoomScreen.onEnter`已接入缓存仪式检查并切牌桌，覆盖首次广播早于订阅；playing 快捷路由须确认当前房间与缓存对局房号匹配。首局身份优先最新RoomView，局间庄家/子数取当前ViewState、身份/玩法取权威RoomView；重排后历史结果仍按userId匹配。
- **刷新局间的资料来源**：新版服务端 `addPlayer` 既有成员重入先向本人发完整 roomView（各家 userId/nickname/isBot、settings 玩法/墙模式、seating 仪式），再 broadcastAll；playing 时后续给 gameView。无需 placeholder 猜真人/Bot/墙模式；仅旧服务端 gameView-only 路径保留房号/路由占位兼容，不视为完整身份资料。
- **restart 缓存隔离**：一次 CodeReview 指出旧 playing 缓存被新增路由误用，已将 `NetService.restart` 改为先 `this.leave()` 清 client.view/client.room/ceremonyClock，再沿用 lastSettings create；保留连接，断连时只清理、不创建。3 个回归覆盖默认/指定局数与无连接情形，包含在最终client-core/UI 100项内，不重复加总。
- **首局离线托管接续**：服务端在发牌进入 playing 后按最初 offlineSince+trusteeAfterMs 的剩余时间接续托管，重复 disconnect 不延后；不是重置或改动正式 60s 规则，也不压缩仪式展示时长（网关 §13.4）。
- `roll/pickSeat`透传 **optional `ceremonyToken:{ceremonyId,stepId}`**；每个新step以Node.off/on重绑掷骰/四座按钮，闭包捕获当步token，相同步骤不重绑。TOUCH_START记录起始step，TOUCH_END跨步拒绝、TOUCH_CANCEL清手势；submit复核token/actor/input/期限/重复提交，disposed后旧提交与update/tick无效。旧端无token只基本守卫；旧服无presentation时已改为仅显示总点数，不拼造两骰。完整结果期前不发牌、不启动新局Bot；无跳过、倍速或全员确认。

#### 11.3.4 原型演示与验收边界

- `?ceremony=full`：1真人3Bot完整流程；`reroll`：连续三轮重掷，包含与未重掷者旧结果再撞点；`pick-mine/pick-wait`：我/他人选座起播，继续落座→定庄→发牌门控；`dealer/roundbreak`：定庄/局间从input起播。
- `roundbreak-off`直接续局；`random`完整随机墙流程；`long`长昵称/同名机器人；`offline`真人输入2000ms后离线，剩余缩为600ms。旧`rolling/reveal`入口兼容映射到`full/reroll`。均可从面板外原型工具栏选择，不改变正式玩家权限。
- 原型最终骰面为明确的双骰夹具，本地随机只用于中间帧；仅模拟权威时序，不连接真实房间、不改示例牌桌和其他业务区域。结果期结束自动关闭仪式并提示「进入发牌」，不是已实现真实发牌或服务端同步。
- **原型记录边界**：原型专项agent完成 **10 scenario / 131状态 + 6门控** 的JS/节点替身验证，非Browser视觉，不等于真实DOM布局/GPU或截图验收，也不与下述393项重复加总；历史文档先行记录原样保留。
- **最终主助手实际执行的自动化（2026-09-20）**：

| 项目 | 可核实结果 | 边界 |
|---|---|---|
| `pnpm test` · engine | 179 pass | 引擎自动化 |
| `pnpm test` · persistence | 6 pass + 3 integration skipped | 跳过项不算通过 |
| `pnpm test` · client-core/UI | 100 pass（含既有restart等回归） | AST真实生产类 + 严格mock，验证生命周期、节点状态与绘制指令；非GPU/真实字体/截图 |
| `pnpm test` · game-server | 108 pass | 服务端/WS自动化，不是真实双端浏览器e2e |
| `pnpm test` · 合计 | **393 pass / 3 integration skipped** | 主助手最终实跑；跳过项不计通过 |
| `pnpm typecheck` | 通过 | 包类型检查 |
| `npx tsc --noEmit -p client/ac-majong/temp/tsconfig.check.json` | 通过 | Cocos CLI 静态检查，不是实机初始化 |
| H5 CLI：`startScene=01c1425f-8926-40e9-8f67-e149f5238405` | **13:39 Finished**（构建日志已核实） | 显式App起始场景构建成功，不代表场景已运行 |

- **必要验收证据外部阻塞**：浏览器连续三轮目标turn均 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`、hidden/attached=false，用户打开后仍不可用；`window.open`返回false，rAF暂停导致Cocos无scene（scene=null、无__AC__）。**Cocos实机、1真人3Bot/2真人2Bot真实双端顺序/骰面/时长联验及截图对照未完成**；不得宣称全Spec完成或100%视觉通过。
- **环境隔离**：用户原8080未重启；历史8093独立内存服务浏览器未连成功，不计e2e。整体为「已修补当前发现缺项，浏览器视觉验收受阻」，未验收、不归档；本次仅回填文档，不操作Browser、启停服务、同步、测试或构建。完整修补与验证见 [BL-017详表](../5-backlog/README.md#bl-017-开局仪式与摸牌位骰实现与验证流水)。

## 12. 音频子系统 `AudioManager`（`ui/AudioManager.ts`）

> 对应 PRD [07-表现动画音效](../1-prd/07-表现动画音效.md) §3.2 与 FR-表现-02、PRD [08-规则页与设置](../1-prd/08-规则页与设置.md) FR-设置-01（BL-014）。**只做音效（SFX），不做 BGM**。

### 12.1 职责与设计

- **单例、平台无关入口**：`AudioManager` 为客户端全局单例，封装 Cocos `AudioSource`；业务层只调 `AudioManager.play(name)`，不直接接触 `AudioSource`。
- **SFX 并发**：麻将音效短促且可能叠加（多家连续出牌/响应），用 `AudioSource.playOneShot(clip)` 播放，天然支持多实例并发，无需为每条音效建独立节点。
- **懒加载 + 缓存**：`resources.load('audio/<name>', AudioClip)` 首次播放时载入，模块级 `Map<string, AudioClip>` 缓存；加载失败静默降级（不抛错、不阻断对局），保证缺素材时游戏仍可运行。
- **静音持久化**：`muted` 状态存 `sys.localStorage`（key `ac_muted`），构造时读取；`setMuted(bool)` 切换并回写。静音时 `play()` 直接 return。

### 12.2 触发接线

| 音效来源 | 接线点 | 说明 |
|---|---|---|
| 牌张拟音 / 番种语音 / 可响应提示 / 结算 | `TableScreen` 消费 `NetService.onEvent` 处，按 `GameEvent` 类型映射到 `play()` | 与未来 M-J 动画复用同一事件入口；映射表见 PRD 07 §3.2.1 |
| 按钮点击 | `UiKit.uiButton` 的 `TOUCH_END` 回调统一 `play('click')` | 一处生效，全局按钮自动带点击音 |
| 倒计时警告 | `TableScreen` 倒计时逻辑本地触发（剩余 ≤5s） | |
| 发牌 | 开局（首次进入 playing 相位）一次性触发 | |

- **杠/胡的事件语义映射**（依据引擎 `reducer.ts`）：`kong.kind` → `exposed`=「杠」/`kong_concealed`=「暗杠」/`kong_added`=「补杠」（三种区分）；`win` 事件自摸(`declareWin`)与点炮(`resolveDiscardWin`)均发同一事件 → 统一「胡了」，**不区分**。

### 12.3 资源约定

- 目录 `client/ac-majong/assets/resources/audio/`，格式 **mp3**（微信小游戏兼容最佳），单条控制体积（几十 KB）。
- 命名 = 事件资源名（见 PRD 07 §3.2.1）：`discard / draw / flower / deal / chi / pong / kong_exposed / kong_concealed / kong_added / win / zhahu / exhaustive / click / alert / countdown / settle`。
- **素材来源**：牌张拟音 + 系统/UI 音取自 Pixabay（royalty-free 可商用）；番种中文语音用 Edge-TTS 生成。缺失资源时 `play()` 静默降级，不影响联调。

### 12.4 静音开关 UI（最简，先行）

- 完整设置弹层（M-H）落地前，先在大厅用户条与牌桌菜单放一个 **🔊/🔇 切换按钮**：点击调 `AudioManager.setMuted(!muted)` 并刷新图标；偏好写 `localStorage`，跨屏与重启沿用。M-H 就绪后并入设置页统一管理。

---

## 附录 A · 屏幕 → 高保真原型映射（批次自检用，2026-09-17 建立）

| 屏幕/弹层 | 原型文件 | 最近同步 |
|---|---|---|
| 登录（H5 账号表单/微信一键/mock 三态） | `2-效果图/HTML格式高保真原型/login.html` | 2026-09-17 回补 |
| 大厅（战绩/回放入口+规则条+⚙设置；**建房弹层时间档分段两行 BL-032**） | `…/home.html` | 2026-09-22 创建弹层左列增思考/响应时间档分段行（10/15/20/30 与 5/8/10/15，默认 15/8） |
| 房间等待（含**机器人打法弹层**+**房间玩法弹层**+Bot「✎改打法」 BL-031/FR-房间-12） | `…/room.html` | 2026-09-22 原型增打法/玩法弹层（`?botDemo=1`/`?rpDemo=1` 直开）+modify 态补「移除」钮；**Cocos 已落地**（`ui/BotPersonaModal.ts`/`ui/RoomRulesModal.ts` + RoomScreen 接线） |
| 牌桌（庄徽章/连N/离线托管/响应框/按钮簇/重连遮罩/结算浮层/摊牌2×2/听牌浮层；BL-017逐家仪式） | `…/game.html` | 2026-09-20 已修补当前发现缺项，浏览器视觉验收受阻；本轮仅指仪式 |
| 散场战绩 | `…/result.html` | 2026-09-22 BL-033 结算手牌区重排（名称上移/13×18/17 张基准/整手全景） |
| 规则（弹层形态注记+D-25 算账） | `…/rules.html` | 2026-09-17 回补 |
| 设置弹层（含**断线托管打法**预设行 BL-031） | `…/settings.html` | 2026-09-22 原型增托管打法行（面板高 292→326）；**Cocos 已落地**（`SettingsModal` 动态布局+托管 pills 行，仅房间内） |
| 牌面视觉 | `…/tile-faces.html` | 既有 |
| 回放列表/播放器（P9/P10） | `…/replay-list.html` / `replay-player.html` | 2026-09-18 新建（BL-012） |

> 流程门槛：凡 UI/交互变更，同批更新对应原型（改版或新建）；批次收尾按本表自检。**涉及交互界面细节的前端开发必须 100% 还原高保真原型**（颜色/字体/间距/圆角/描边/阴影/组件状态/文案逐点对齐；确需偏离先改原型再实现；验收对照原型逐目比对）。

## 维护记录

历史流水按发生时点保留；文档先行的待实现状态、先前版本高保真审核与截图记录不作为本轮逐家仪式验收结论。

| 日期 | 概要 |
|---|---|
| 2026-09-20 | **BL-017 当前缺项修补与最终验证回填**：样式表对齐Wind/Dealer分带、74px时钟、pending弱字/自己金粗脉冲、2秒Tooltip、可见禁用按钮/落座selected、90ms峰值/200ms终点CSS ease与14→24→14庄光；legacy与每step闭包守卫已修补。最终393 pass/3 skip（UI100）、包/Cocos类型检查通过，H5指定App场景13:39 Finished（日志已核实）；非GPU或Browser视觉验收，详见 [BL-017详表](../5-backlog/README.md#bl-017-开局仪式与摸牌位骰实现与验证流水)。其他窗口结算变更保留，不计本任务成果 |
| 2026-09-20 | **BL-017 开局仪式与摸牌位骰·契约缺项补齐**：复核发现旧兼容仍拼造双骰、长名无完整读取、按钮隐藏/选中态缺失、旧点击未绑定步骤，以及罗盘风徽/提示脉冲/待掷字重/落定与庄光偏差；先更新原型与正文，再同批实现和追加回归。整体维持未完整验收，不概括为只差截图 |
| 2026-09-20 | **BL-017 开局仪式与摸牌位骰·逐项复核**：补齐首步250ms淡入不重播、同名玩家在提示/排名中的风位指代、骰子500ms线性关键帧与Y轴旋转转换；新增3项精确关键帧、首步重入及同名指代测试；本次全量engine179/client-core40/server104/persistence6通过、3项集成跳过，包与Cocos类型检查通过，12:54指定App场景重建Finished。浏览器仍hidden/attached=false，画布读出全黑；测试页渲染替代调用未获执行，未生成有效截图，视觉联验继续待完成 |
| 2026-09-20 | **BL-017 本轮实现收口（文档先行之后）**：TableScreen 内 CeremonyPanel 已完成逐家真实双骰、重掷旧结果、四横卡/罗盘、墙条、快照增量更新及生命周期清理；protocol/server/NetService/RoomScreen 接线完成，原型已更新。新版重入先给本人权威 roomView（身份/玩法/仪式）再 broadcastAll，局间不靠 placeholder 猜身份/墙模式；首局仪式掉线在 playing 按原 offlineSince+trusteeAfterMs 接续托管、重复 disconnect 不延期，60s 不变 |
| 2026-09-20 | **BL-017 审查修复与资源同步维护**：一次 CodeReview 发现 restart 旧 playing 缓存被新增路由误用，NetService.restart 改 `this.leave()` 后 create，3 个回归纳入自动化；sync-to-cocos 原位更新生成源码并保留已有 .meta/UUID，避免整目录重建破坏资源引用；§10/§11.3 与附录 A 同步 |
| 2026-09-20 | **BL-017 本轮验证收口**：最终主助手 `pnpm test`：engine 179 pass、persistence 6 pass + 3 integration skipped、client-core 37 pass（AST 真实 Cocos 类/成员 + 严格 mock，非 GPU）、game-server 104 pass；`pnpm typecheck`、Cocos tsc 通过；H5 CLI 显式 startScene=01c1425f-8926-40e9-8f67-e149f5238405 构建 Finished（12:28）。浏览器反复 NATIVE_BROWSER_VIEWPORT_UNAVAILABLE、hidden/attached=false，用户打开后仍失败；JS 导航成功但 scene=null/无 __AC__，实机/双端浏览器/截图未完成。8080 未重启，8093 浏览器未连通，不计 e2e；状态为「实现完成，视觉联验受阻/待完成」，详见 §11.3.4。本次仅文档回填，未重跑验证 |
| 2026-09-20 | **BL-017 文档先行**：§11.3与game.html同步640×330四横卡/罗盘分带、逐家1200+2000ms、汇总2000ms/落座1500ms、定庄与局间1200+3000ms；输出stage/phase/summary及卡片状态类、用户身份映射、右端墙条、optional presentation/token与恢复规范；10场景原型假时钟/DOM核对通过，截图受浏览器不可见限制，业务编码/双端验收待进行 |
| 2026-09-16 | 首次产出（补记 M-A 前端基座）：目录结构、设计令牌 `Theme`（移植 `style.css :root`，844×390 横屏）、`UiKit` 组件工厂（背景/文本/按钮 4 变体/面板/徽章/弹层，运行时 `Graphics`+`Label` 无预制体）、`Screen` 抽象与 `SceneRouter` 单 Canvas 多屏路由、`App` 根控制器、屏幕清单、`Config`、视觉近似与构建约束 |
| 2026-09-17 | 补记牌桌渲染与牌面资源（§11）：TableScreen 布局预算（状态栏单行/西东成组垂直居中/牌背压缩）、TileNode 牌面 `SpriteFrame` 缓存 + `_uiProps` 异步竞态守卫 |
| 2026-09-17 | §11 补摸牌显示：`you.drawn` 刚摸牌原位抬高 10px（抽出态），选中 18px 区分 |
| 2026-09-17 | §11 补手牌选中按位置索引 `selectedIdx`：一对牌仅抬被点的那张 |
| 2026-09-17 | §11 补牌面选择器 `showTileChooser`：自适应高度 + 选项渲染为真实牌面组合 |
| 2026-09-17 | §11 补台数预览三态状态行 + 结算明细个数/具体牌展开 + tileName 字/花映射 |
| 2026-09-17 | §11 补解散二次确认框 showDissolveConfirm（防结果页误点） |
| 2026-09-17 | §11 补终局摊牌渲染（revealed → 北横排/西东双竖列面牌） |
| 2026-09-17 | §11 终局摊牌覆盖诈胡（zhahu 事件同带 revealed） |
| 2026-09-17 | §11 结算浮层增「各家手牌」2×2 牌面区（结果页内看清摊牌） |
| 2026-09-17 | §11 摊牌时序缺陷修复：onEvents 只存 revealed 不立即 render（旧相位视图会抹掉 revealed），翻面由 settled 视图触发 |
| 2026-09-17 | §11 pinfo 子数标签换行修复：估宽改 CJK≈字号(9)+数字≈6 并加余量（估窄致 Label 按宽折行；HTML 原型 inline span 无此问题） |
| 2026-09-17 | §11 庄家标识优化：状态栏去连庄段；drawPinfo 增 lianzhuang 参，庄家徽章红底(danger)白字+goldLight 环 22×16，连庄>0 时框内追加「连N」金字标签 |
| 2026-09-17 | §11 响应提示框加高 92→112：hint y38 / CdBar y24 / 按钮 y-16 三层分离，修复文案与倒计时条互相遮挡 |
| 2026-09-17 | §11 M-H 新增 `ui/RulesModal.ts`（openRulesModal：uiModal+ScrollView 分节内容，番种速查取引擎 PATTERN_TAI，实底 Graphics 底衬）与 `ui/SettingsModal.ts`（openSettingsModal：静音切换/退出房间/返回登录/版本协议钩子）；大厅「规则说明/⚙设置」+ 牌桌右上簇（右→左：静音/✕/规则/⚙）接入 |
| 2026-09-17 | 验证基建修正：Cocos 生成 `temp/tsconfig.cocos.json` 的 types 相对路径致 CLI tsc 仅报 TS2688 并跳过语义检查（假绿）；新增 `temp/tsconfig.check.json`（修正 types 路径 + strict:false + skipLibCheck）作为唯一 CLI 检查入口；SettingsModal 补 UITransform 导入修复运行时 ReferenceError |
| 2026-09-18 | BL-012 回放双屏：ReplayListScreen（房间→局折叠列表）/ReplayPlayerScreen（rehydrate+applyAction 重演+播放控制+全亮）；大厅增🎬入口；坑：Cocos web 构建下 Set 展开失效→关键帧改纯数组 |
| 2026-09-17 | 原型回补批：login/home/game/rules 改版 + settings.html 新建 + _index 卡片；附录 A 屏幕→原型映射表建立（流程门槛：UI 变更同批更新原型） |
| 2026-09-17 | §11 H5 账号鉴权客户端：UiKit 增 uiInput（EditBox 暗底圆角框；**label 锚点须 (0,1)**——EditBox 引擎按左上锚点自管布局）；LoginScreen 三态（微信一键/H5 表单+会话免密复登/mock）；NetService 会话持久化 ac_session + 凭据选择序 + ack 失败抛错展示 |
| 2026-09-17 | §11 H5 网页发布路线：Config 增 IS_WEB + detectServerUrl（WS 跟随页面主机 8080，一份构建部署任意服务器）；App 竖屏旋转提示遮罩；deploy/docker-compose.prod.yml（mysql+redis+server+nginx 静态站单机部署）；CLI 无头构建命令固化（**必须带 startScene=scenes/App.scene 参数**，否则构建到空壳 scene.scene 黑屏；编辑器预览走当前打开场景、构建走起始场景，二者可背离）|
| 2026-09-17 | §11 M-K 平台分支：Config 增 IS_WX/WX_CLOUD_ENV/WX_CLOUD_SERVICE/wxIdentity；NetService.connect 增 transport 注入参（微信端 WeChatTransport(connectContainer)，重连复用同一 transport）；LoginScreen 按平台选身份与传输 |
| 2026-09-17 | §11 结算简化配套（D-25）：结算浮层副标题「1 台 = 1 积分」；付方 delta 超胡方台数部分小字「含子/连庄 +N」+面板加高；previewTai 调用传 myZi；RulesModal 结算节文案同步 |
| 2026-09-17 | §11 M-J 动画：TableScreen.runAnims 以 ViewState 差值驱动 tween（发牌 stagger / 摸牌·弃牌 RTileLast·副露 Melds<seat> pop / 结算面板 backOut pop）；render 末尾统一触发，重渲染自然校准 |
| 2026-09-17 | §11 听牌提示门槛修复：previewTai（vendor engine）听张按 6 台起胡门槛过滤，不足门槛不提示听牌；客户端听牌条/徽章随引擎自动修正 |
| 2026-09-17 | §11 M-I 客户端：NetService 增自动重连（凭据记忆+退避 1/2/4/8s+重入记忆房间+`onReconnect` 状态回调）；TableScreen 断线遮罩（重连中/失败文案）+ pinfo「离线」(灰)/「托管」(绿)徽章（seatFlags 取 roomView） |
| 2026-09-17 | 新增 §12 音频子系统 `AudioManager`（BL-014 游戏音效）：单例封装 `AudioSource`、SFX `playOneShot` 并发、`resources` 懒加载缓存、静音 `localStorage` 持久化；触发接线（`onEvent` 事件映射 / `uiButton` 点击音）、杠三种区分·胡不区分的事件语义、mp3 资源命名约定、最简静音开关；只做音效不做 BGM |
| 2026-09-18 | **BL-016**：`ResultScreen` 底部提示改为「房间已关闭、积分定格 · 请按积分差线下相互结算」（还原 result.html final-note 新文案）；`LobbyScreen.doJoin` 重进对局中房间直接切牌桌（`lastGameViewAt` 判定，RoomScreen 未构建不错过 gameView 广播） |
| 2026-09-17 | §11 uiInput 可读性修复与视觉升级：修复 textLabel 误用不存在的 `Theme.color.text`（undefined → 近黑不可读）改用 `textPrimary` 暖白（同类 tsc 假绿教训）；输入框加高 34→42、圆角 10、左侧金色 accent 竖条、聚焦监听 EditBox `EDITING_DID_BEGIN/END` 重绘亮金边；LoginScreen placeholder 带 👤/🔒/✏️ 图标，三框/按钮/协议/提示 Y 坐标随框高重排 |
| 2026-09-18 | **BL-017 开局仪式与物理牌墙 UI**：`UiKit` 新增 `uiSwitch`（40×22 金轨开关，`interactive:false` 供整行点击托管）；`LobbyScreen` 建房弹层重排（380×402）——局数 2×2 单选（金底选中态自绘）+「玩法设置」双开关行（物理牌墙展示/摸牌位骰，`.play-row` 还原）+ 恒开提示 + 「创建并分享」；`RoomScreen` 房卡增玩法参数行（FR-房间-10）+ phase='seating' 时切牌桌；`TableScreen` 新增 `SeatingLayer` 仪式遮罩（四骰槽/同点重掷徽章/选位顺序榜/东南西北选座行/定庄·摸牌位横幅/掷骰按钮/10s 超时提示，`roomView.seating` 与 `view.seating`(roundBreak) 双通道驱动）与 `WallBoard` 四边牌墙排（18 组/排：spent 淡出/skip 金虚线/breakpt 金框光晕 + 开牌点图例，`view.wallInfo` 驱动，random 模式不渲染）；`diceFaces` 骰点和固定拆分展示 |
| 2026-09-18 | **BL-017 缺陷修复（用户实跑报障）**：`TableScreen.renderSeating` 的 `isMePicker` 误声明在 for 循环内、循环外引用 → pick 阶段运行时 ReferenceError 崩溃；提升至 pick 分支作用域。**根因**：`temp/tsconfig.check.json` 缺 `include`（默认仅编译 temp/ 下 .d.ts）+ 缺 `lib`，客户端 tsc 长期假绿未检查 `assets/scripts`；补 `include=../assets/scripts/**/*` + `lib=ES2019+DOM` 后暴露并同批修复 4 处存量隐患：`LobbyScreen.doJoin` 结果变量遮蔽参数（TDZ 运行时崩）、`App.ts` 转屏提示误用不存在的 `Theme.color.text`、`TableView.connect` cred 传字符串、`UiKit` EditBox 事件名 `EDITING_DID_BEGIN/END`→`BEGAN/ENDED`；H5 重建 + CDP 复验 pick 阶段 roomView 达客户端渲染零异常、仪式完成发牌 |
| 2026-09-18 | **建房弹层还原度复核（用户报障：提示文字跑出面板）**：根因 `uiLabel` 指定 width 时 anchor 仍为 0.5、按中心定位致 play-row 副文案溢出面板外；重排为原型规格——play-row 名称/副文案 `anchorX=0` 左对齐双行（376×52 行、开关右置）、局数单选改单行 4 项主+副双行（原型 `.rounds-option` grid 4 列；选中=透金底+金边+金字）、补 `modal-hint`、面板 380×402→400×352 适配横屏；**两开关默认均开**（用户要求，home.html 原型与 PRD03 FR-房间-10 同批同步）；CDP 复验：弹层无溢出、行点击切换正常、创建后 `rooms.settings={physical,true}` |
| 2026-09-18 | **牌桌布局碰撞修复（BL-017 墙排批次）**：`renderWalls` 东西列 x ±286→±264（原型值）、图例 y -128→-48；`renderRiver` 东西块 perRow 12→4、cx ∓214→∓312（原型横屏 4 列靠边）；southTop 听牌/台数徽章 RIGHT-86/RIGHT-58 → x 136/206（w50/84）避开东墙列与东手牌列；CDP 中局 17 弃牌复验零重叠零异常 |
| 2026-09-18 | **吃副渲染 v2（用户定案）**：`TableScreen.drawMelds`/`ReplayPlayerScreen.drawMelds` 删除横置 `mkCalledTile`（angle=90+描边+占位互换）→ `orderOf` 被吃牌居中（[others0, called, others1]）全竖放 + `mkCalledBadge` 右上小圆形角标（r=max(4, w*0.22) 金底+暗「吃」字）；CDP 真实吃牌复验（tiles W7W8W9 called W8）截图零异常 |
| 2026-09-18 | **结算浮层 v2**：`showSettlement` 重构——角色横幅（meSeat vs winners/delta 判定三态）+ 积分变动列子注（ziOf 取 you.zi/others[].zi；付方=底台+胡方子+自身子+连庄，零项省略；胡方=收付构成）+「我累计」= you.score+delta[me]（修复结算事件先于视图更新的滞后）+ 面板高度按子注行数自适应；CDP 经 router.screens 直调 showSettlement 构造 ev 验证胡方/付方/无关三视角截图零异常 |
| 2026-09-18 | **BL-017 牌墙展示简化 + 图例瞬态化（用户要求）**：`renderWalls` 墙栈仅留满栈实心/半栈半透两态——删 spent 残影与 skip 金虚线分支、`height===0` 直接 `continue` 留缺口、死代码 `dashRect` 同删；开牌点图例改 `showWallLegend`/`hideWallLegend` 瞬态管理：`v.round` 变化显示一次、`scheduleOnce` 5s 淡出自隐、`renderActions` 在 `acts.length>0` 时立即隐藏防与浮层重叠；wallRoot 改选择性销毁（仅毁 `WStack`、图例独立存活）；原型 game.html 同批（去 .spent/.skip、增 .half/.gone、图例 5s 淡出） |
| 2026-09-18 | **牌河西/东弃牌排列方向修正（用户报障）**：`drawRiverBlock` 的 `align` 原为死参数（`posOf` 恒逐行居中）→ 启用：`left`=列位固定自左→右填、`right`=列位镜像自右→左填（不满行分别靠左/右缘对齐）、`center`=逐行居中（北/南不变）；`renderRiver` 西块传 'left'、东块传 'right'（边缘→中心，用户确认）；原型 game.html 同批（`.river-east` 加 `row-reverse`） |
| 2026-09-18 | **明牌区/牌墙区分带重排·方案A（用户确认）**：`TableScreen` 常量 `MELD_ME` 24×34→20×28、`HAND_T` 54→48；`southTop` -100→-104、`southHand` -150→-156；`renderWalls` 南排 -104→-62、北排 +126→+116；`renderRiver` 北/南弃牌首行局部 ∓88→∓66；`renderSouthTop` 花牌固定槽 x-208（16×22、面板 h26）避西墙列带、明牌行自 x-160 右排且超宽 271 降 14×19、听牌/台数徽章 x140/210；`renderSouthHand` 抬升 18/10→8/6 + 选中金边 `Graphics` 圆角描边；图例 y-48→-16；原型 game.html 同批（墙排 top71/bottom125、图例 top201、手牌 38×48、明牌 20×28、花牌 16×22、selected -8px） |
| 2026-09-18 | **侧牌河移入墙列内侧（用户确认，效果图标注评审）**：`renderRiver` 西/东块 4 列靠边（cx=∓312，墙列外侧违反手牌→牌墙→牌河语义）→ **6 列横排 cx=∓150、cy=+40 行向下排**（墙列与风盘之间；间隙：墙列内缘 56/风盘 71/明牌行顶 32/北首行 25）；align 保持 left/right（边缘→中心）；原型 game.html 同批（.river-middle padding 0 92px、.river-side 改 6 列 grid + margin-top 74、.river-east 改 direction:rtl、窄屏媒体查询同步） |
| 2026-09-18 | **墙排遮挡操作浮层 bugfix（用户报障）**：根因非 z 值（Cocos 3.x 2D 渲染序=节点树兄弟顺序，不看 z）而是 `build()` 中 `wallRoot` 创建序在 `overlay` 之后→墙排画在浮层上；方案A 墙排上移 y-62 后横穿浮层按钮区使潜伏 bug 暴露；修复=创建序移至 `southHand` 后、`overlay` 前（牌桌层<墙排<浮层<仪式遮罩） |
| 2026-09-18 | **刷新后无法回房 bugfix（用户报障）**：根因三连——①`NetService.lastRoom` 仅内存（页内断线重连可用、刷新即丢）→ 增 `ac_last_room` 持久化（roomView 写/散场与登出清）；②登录成功固定 `show('lobby')` 无人重入 → `LoginScreen.enterAfterAuth`：有记忆房间先 `joinRoom` 并按 phase/view 切 table/room，失败清记忆回落大厅；③大厅列表 `off=playing||full` 不认成员身份→记忆房间改显可点「重进」钮；顺带 `joinFromList` 路由对齐 doJoin（对局中/仪式重进直切牌桌）；服务端本就支持（addPlayer 原座位重绑）；原型 home.html 增重进态演示行+foot 文案、PRD06 FR-断线-02 扩刷新重入语义 |
| 2026-09-18 | **大厅列表头标题溢出面板 bugfix（用户报障，还原度对齐）**：`buildRoomList` head 三标签仅设 `align` 未设锚点（默认中心锚）→ 标题「📋 公开房间」半宽溢出面板左缘；修复=title/count `anchorX=0`（-226/-160，原型 padding 14+gap 8）、auto `anchorX=1`（198，与手动钮 gap 6）；原型 home.html 本就正确未动；同 BL-018 行内 host 列锚点教训（左对齐标签必须显式设锚） |
| 2026-09-18 | **start-client.sh 端口可配（用户要求，防旧产物误连）**：新增 `--port`（默认 **7456 编辑器预览站**，reimport 即生效；8081=构建产物静态站需先 CLI 构建），未显式 `--page` 时按端口推导页面地址（两站根路径均服务入口页）；顺带修 `open-player.mjs` 位置参数误收 `--page` 取值（URL 被当房号校验失败）与默认页改 7456、超时提示文案区分两站 |
| 2026-09-18 | **open-player 登录失败立即报错（用户报障「一直自动登录」）**：根因=账号服务端密码非默认 AC_PLAYER_PASS（WS 探针实测 e2e_p1 默认密码 authOk、cuikai01/02 账号或密码错误）而 mjs 登录循环无声重试 15 次呈假象；修复=点击登录后扫描登录页 Label 错误文案（密码/失败/错误/过期）命中即 fail 并提示 AC_PLAYER_PASS 用法与 --fresh 边界（只清本机 profile 不改服务端密码） |
| 2026-09-18 | **start-client.sh 改纯手动登录（用户要求）**：移除全部自动登录/自动入座/CDP 驱动——`open-player.mjs` 重写为「每次运行 mkdtemp 全新临时 profile + spawn 独立 Chrome + 立即退出」（无残留会话免密复登，登录/注册/入房全手动）；参数简化为 `[窗口名] [--port N] [--page url]`（窗口名仅临时目录前缀/日志标识，默认 manual）；废弃 .player-profiles 命名 profile 与 --fresh/房号/AC_PLAYER_PASS 约定；start-client.sh 同步改用法文案 |
| 2026-09-18 | **大厅还原度专项对齐（用户报障「未严格按效果图」+ 截图对比审核）**：逐元素对账 home.html 修正 `LobbyScreen`——品牌区（logo40@(-378,+161)、title20/sub10 左锚 @-346）、用户条 216×44（avatar30/name13/id9 左锚）、返回钮 86×30 pill、版本号右锚 @+358、静音钮 28@(+384,-167)；列表 head 底纹+分隔线、计数按标题实测宽校准（`alignListCount` 进大厅 AFTER_UPDATE 一次）、刷新钮 20×20、「5s 自动刷新·hh:mm:ss」时间戳（`stampListAuto`）、面板改 gold 木纹底、行高 44+行分隔线、状态徽标胶囊、入口卡 46×46 图标容器；`UiKit` 新增 `dark` 按钮变体（黑 .25 填+淡金 .12 描边，`radius` 可覆写；注意 `rgba()` 的 a∈[0,1] 传 255 制会被钳为不透明）用于 subrow/返回/静音；验证=CDP 导航前 `Emulation.setDeviceMetricsOverride` 锁 844×390（headless=new 窗口内高不足致引擎竖裁）+ 注入公开房后截图与原型上下合成对比 |
| 2026-09-18 | **BL-019 原型全横屏化（用户确认）**：原型画布统一 844×390 横屏（与客户端设计坐标一致）；home/login/room/result/replay-list 横屏重排，rules/settings 改横屏弹层形态，profile.html 废弃（信息并入大厅用户条）；顺序 home(含 BL-018 房间列表右列)→login/room/result/replay-list→rules/settings→profile；此后高保真 100% 还原基准以横屏原型为准 |
| 2026-09-18 | **响应倒计时锚定（bugfix）**：TableScreen 增 `cdRespKey`（`${round}:${discards.length}:${lastDiscard.seat}:${lastDiscard.tile}`），renderActions 窗内重建不再 startCountdown 重启；配合 engine legalActions「已响应者本窗无合法动作」双层修复重复点吃/碰刷倒计时 |
| 2026-09-18 | **BL-018 大厅横屏重排 + 公开房间列表**：LobbyScreen 按 home.html 横屏原型改双列——左列横卡入口 300×92（创建/加入）+ 战绩/规则/设置三钮；右列公开房间列表面板 480×272（head 标题+计数+5s 自动+🔄；body ≤4 行：房号/房主/人数/局数/状态徽标/加入钮，对局中·满员置灰；空态+创建钮；foot 说明 + 加入失败 toast）；建房弹层增「公开房间」开关（首行默认开）；行内左对齐标签须显式 `anchorX=0`（align left 不设锚点会与邻列重叠） |
| 2026-09-18 | **房卡底注标签陈旧同步（D-25 遗留，用户问询触发）**：RoomScreen 房卡「底注 20 积分/台」改「底 1 台 = 1 积分」，对齐 room.html 原型与 1:1 结算口径 |
| 2026-09-19 | **BL-021 保底台数展示**：TableScreen 徽章两态（未听牌 `💡 保底 N台 ▴` 宽 96@x216 / 听牌预览台数）；`toggleScorePop` 重构=保底区块常显（块题+明细+小计，无则「暂无锁定番种」）+状态行（未听牌灰态文案）+听牌明细+合计；数据来自 vendor engine `previewTai.secured/securedDetail` |
| 2026-09-19 | **BL-021 保底口径 v2**：客户端无改动（数据来自 vendor engine `previewTai.secured`）；engine 侧改 recognize 全量口径后徽章/浮层自动生效 |
| 2026-09-19 | **BL-017 开局仪式 v2 落地（用户确认流程合并+高保真审核通过）**：协议 `SeatingView.stage` 合并 `dealerDice`+`breakDice`→`dealerBreak` + 新增 `ziCounts`；`RoomView.seats` 增 `nickname`；服务端 `handleRoll` 合并为一掷定庄+定开牌点（breakN=N），删除 breakDice 独立阶段；客户端 `TableScreen.renderSeating` 全重写：①② 四家卡横排（经典骰面 Graphics 红/黑点+昵称主显+「我」金框角标+同点重掷徽章+选座倒计时）；③/局间 罗盘式落座布局（上北下南左西右东 scard+中央骰子+庄家金光徽章+牌墙条 18 组示意跳区/开牌点+去算法化文案）；新增 `drawClassicDie`/`dicePair` 工具；`RoomScreen.displayName` 优先取 `seats[].nickname`；vendor/protocol 同步；测试 252 绿 |
| 2026-09-20 | **结算浮层 v3 还原度对齐（用户报障：积分变动信息不全/面板过小按钮贴底，proto-imp 流程）**：`showSettlement` 全重写对齐 result.html v3——面板固定 620×370（原 560×动态高至 404 溢屏致按钮贴底；屏上下各留 10px 边距）、遮罩 0.55、标题 19 goldLight、横幅 420×22 胶囊三态（Graphics 填+描）、双列边界锚定（`uiLabel` 新增 `anchorX` 选项：左列名 anchorX=0/值 anchorX=1 贴列缘，子注/我累计右对齐贴右列缘，修复原子注溢出面板）、积分变动三色（正 #9fe9b0/负 #f3b1b1/零灰）、付方子注恒列胡方子/自身子含 0、合计行上分隔线、左列行距自适应压缩防溢出、各家手牌标题与牌行拉开（标题 -ph/2+74+分隔线+牌行 48/25）+牌距 15+胡/炮角色后缀、主钮 200×34 底距 12（双钮 -73/+108）；新增 `?settleDemo=win` 演示态（App 直开 table + mock 视图/摊牌/win 事件对齐原型演示数据）供 CDP 截图自检；原型 result.html 牌面改 res/tiles 素材图+增标题、game.html result-overlay 移植 v3；PRD05 §4.1/game-design v2.7 同批 |
| 2026-09-21 | **BL-026 客户端自愈**：`NetService.resendSettlement()`（client-core `GameClient.resendSettlement` → `ClientMsg.resendSettlement`）；`TableScreen` 增 `settleRound` 占位：render 遇 settled/exhaustive 且 `!v.seating` 且浮层缺失且本轮未请求过 → 请求补发终局事件重建结算浮层（含摊牌/下一局钮）；showSettlement 标记已建；服务端网关§15 同批 |
| 2026-09-21 | **BL-023 玩家出口 + 牌桌/设置弹层还原度对齐（用户浏览器批注：设置弹层无「复制诊断包」+右上簇/弹层布局与高保真不符，proto-imp 流程）**：①`SettingsModal` 增「复制诊断包」行（`Diag.copy()`+回显 2s，FR-设置-05）；②右上簇对齐 game.html `.top-cluster`：四钮 28×28 圆钮（黑.5 填+淡金.2 描边+字号13）左→右 🔊/✕/📋/⚙ 于 x=296/330/364/398、y=175（原为镜像序+40 宽矩形「规则」+30 静音钮）；`UiKit.uiButton` 增 `fill/stroke` 覆盖、`uiMuteToggle(size,style)`；③设置弹层全量对齐 settings.html：面板 320×292/252（含/不含退出行）、行宽 284、`.st-btn` 金调 pill（金.12 填+金.35 描）与 `.st-btn.action` 黑.25 pill（240×27）、退出房间改「标签+副注左/退出 pill 右」行式、页脚改 gap10 居中组（协议/隐私+版本号）；CDP 实测四钮坐标与原型 getBoundingClientRect 逐点一致；对比图 cmp_table/cmp_settings3 |
| 2026-09-22 | **BL-033 结算手牌区溢面板修复（用户报障，原型先行确认后动代码）**：result.html 各家手牌重排——名称移牌行上方（左对齐）、牌面 14×20→13×18（与客户端结算牌尺寸一致）、牌行享整列宽 284（17 张×pitch15=253 不溢）、顶部外边距/行距压缩抵消名称行增高（面板仍 620×370、两列明细不裁）、演示增 17 张行（四杠+单张）；TableScreen showSettlement 同口径：名称上移 cy+16 左对齐、牌行 cellLeft 起享 colW=283、行位 84/61→80/47、牌行内容=整手全景（暗牌 revealed+副露展开杠计4张）、超 17 张自动压缩牌距；?settleDemo 演示数据对齐原型（含四杠 17 张行）；PRD05 §4.1 同批 |
| 2026-09-22 | **BL-032 倒计时改服务端 deadline 同步显示＋建房时间档 UI**：TableScreen 移除本地倒计时与客户端自动 pass（旧 `tickCountdown` 先 stop 清回调再调 `cdOnTimeout?.()` 致自动过永不发出的回归根因）——新增 250ms `tickDeadline` 按 `view.deadline{kind,seats,at,totalMs}`+`net.viewNow()`（gameView serverNow 采样单调钟）刷新响应条/出牌环/⏱（自己响应窗优先，否则当前行动家回合窗），超时动作全由服务端产出；LobbyScreen 建房弹层左列增时间档分段两行（makeSegRow，还原 home.html .seg pill）＋弹层加高 300→380＋status/submit/hint 下移；RoomScreen 玩法摘要增「思Ns/响Ns」；home.html 原型同批增两行分段选择；client-core 100 绿＋Cocos typecheck 绿 |
| 2026-09-22 | **BL-031 P1 立项（文档先行·原型同批）**：`room.html` 新增「机器人打法选择弹层」（PRD11 §3.1/§4）——金色木纹风 468×≤348 面板、打法卡纵向列表（图标+名+一句话描述+状态徽标）、选中态金边+透金底（对齐建房弹层局数单选）、锁定态置灰+「敬请期待」、底部 取消/添加 双 pill；「添加机器人」钮触发弹层、座位标签由「Bot·保守代打」改「Bot·{打法名}」；`?botDemo=1` 直开供截图自检；附录 A 房间等待行同步。**本轮仅原型，客户端 UI 实现待编码** |
| 2026-09-22 | **BL-031 用户 review 反馈折回（原型同批）**：①`room.html` Bot 座位增「✎ 改打法」可点击（复用打法弹层、标题切「修改机器人打法」）；②`room.html` 新增「房间玩法」弹层（FR-房间-12：局数/牌墙 pills + 摸牌位骰/先看吃再碰/公开 三开关 + 「开局前可改·开局锁定」注记），房号卡增 ⚙ 入口、玩法摘要补全，`?rpDemo=1` 直开；③`settings.html` 增「断线托管打法」预设行（保守/新手/最大概率 pills，默认保守，面板高 292→326）；附录 A 房间等待/设置弹层行同步。**仍待用户复核后编码** |
| 2026-09-22 | **BL-031 P1 Cocos 客户端 UI 落地（收官）**：新建 `ui/BotPersonaModal.ts`（bp-panel 468×320，数据驱动 vendor/ai `PERSONAS`：图标+名+描述+推荐/敬请期待徽标+选中圈，锁定档置灰不可点；add/modify 双模式，modify 附「移除」危险钮）与 `ui/RoomRulesModal.ts`（rp-panel 400×272：局数/牌墙 pills + 摸牌位骰/先吃再碰/公开 uiSwitch，locked 态保存禁用）；`UiKit.ButtonOpts` 增 `textColor` 覆盖（危险钮红字）；`RoomScreen` 接房号卡「⚙」（仅房主）+添加机器人选打法+Bot 座位「✎改打法」（标签「Bot·{打法名}」，点击进 modify 弹层）；`SettingsModal` 重构为动态纵向布局（首行距顶56/行距38/页脚距底22）+「断线托管打法」pills 行（仅房间内，h=252+leave40+trustee34）；`personas.ts` 增 `icon`；client-core `GameClient` + `NetService` 暴露 addBot(personaId)/updateBotPersona/updateRoom/setTrusteePersona；sync-to-cocos 同步 vendor（ai 9/client-core 4/protocol 1）。原型同批：`room.html` modify 态补「移除」钮+bpOk/bpRemove 切换（先改原型再实现）。验证：`temp/tsconfig.check.json` 权威检查 **0 输出（干净编译）**，`pnpm -r typecheck` 全绿，ai/client-core/game-server 15/100/141 全过 |
| 2026-09-22 | **BL-034 台数徽章移右下角（用户报障与明牌区/下家牌背列重叠）**：TableScreen 徽章自明牌行右端 (216,0)@southTop 宽96 → 右下角 (370,-36)@southTop（绝对 y-140，出牌钮右侧、手牌行上沿带）宽88；详情浮层 ScorePop 锚点 (RIGHT-12-w/2,-40) → (RIGHT-8-w/2, -121+h/2)（徽章正上方）；明牌行超宽降规格阈值注释改听牌钮左缘 115（徽章已不在该行）；原型 game.html `.score-badge` 绝对定位 right8/bottom42、`.score-popover` bottom74/right8 同批；新增 `?tableDemo=1` mock 视图直渲牌桌供截图自检（同 ?settleDemo 模式）；碰撞核算：明牌4组右延极限250/东牌背列 y≥-114/14张手牌出牌钮环右缘324 均不触徽章左缘326；Cocos typecheck 绿＋H5 构建＋对比图 cmp_game_badge_bl034 自检 |
| 2026-09-22 | **BL-035 副露节点改名致布局查找失配（缺陷修复）**：TableScreen `drawMelds` wrap 名 `Melds${seat}`（pop 动画按座位查找）与 renderNorth/renderSide 布局 `getChildByName('Melds')` 失配 → 副露列停 body 中心：侧家与牌背竖条重叠（用户报障西家）、北家与牌背横条重叠；修复=两处改 `` `Melds${o.seat}` ``；教训：**节点改名须全仓 grep 所有 getChildByName/findByName 引用点同批更新**；?tableDemo=1 mock 增三家副露；Cocos typecheck 绿（顺带 pnpm sync:client 同步另一窗口 client-core 新 API 至 vendor）＋H5 构建＋对比图 cmp_melds_bl035 |
| 2026-09-22 | **BL-036 结算庄/子凸出＋算番公式（用户报障展示太弱，原型先行确认）**：TableScreen showSettlement 增 settleChip（Graphics pill：红 庄·连N/金 子N/灰 子0，接行名后）、drawFormula（公式子注分段着色右对齐；**Label 实宽须首帧渲染后测**——估宽致分段重叠/溢右缘、AFTER_UPDATE 早于渲染相位仍测不到，最终双 rAF 校准）、左列子/连庄加成行金色＋口径后缀、底注改算番图例、底番反算 B=T0−3w−胡方涉庄连庄加成（修正旧子注把含加成合计误标为「底」致算不平）；原型 result.html 同批（.rs-dchip/.rs-zchip/.rs-formula/.rs-row.addrow＋演示数据自洽重设）；?settleDemo 对齐；PRD05 FR-积分-02/§4.1 同批；Cocos typecheck 绿＋H5 构建＋对比图 cmp_settle_bl036 |
| 2026-09-22 | **BL-037 时间档入等待页玩法弹层（补 BL-031 遗留缺口·原型先行）**：room.html `.rp-panel` 增思考/响应两行 rp-pill 单选（id rpTurn/rpResp，档位 TURN 10/15/20/30 默认15、RESP 5/8/10/15 默认8，与 home.html 建房弹层同源；复用 rpPill 互斥交互无新 JS）＋房号卡 `.rm-play` 摘要补「思 15s · 响 8s」；?rpDemo=1 无头截图自检（面板加两行仍不溢 390 舞台）；客户端 RoomRulesModal（400×272）增两行 pills＋updateRoom 增传 turnSec/respSec 待用户确认后编码（面板需加高约 56） |
| 2026-09-22 | **BL-037 客户端落地（用户确认原型后编码）**：RoomRulesModal 面板 400×272→340（ROW1_Y/FOOT_Y 改面板相对公式）、行序增思考/响应两行 pills（TURN 10/15/20/30、RESP 5/8/10/15，默认 15/8，档位常量与建房弹层/服务端 normalizeRoomSettings 同源）、保存 onConfirm settings 增传 turnSec/respSec（服务端 merge 不丢其他项）；RoomScreen 增 ?rpDemo=1 直开弹层自检钩子（同 ?settleDemo 模式）；Cocos typecheck 绿＋reimport＋H5 构建＋对比图 cmp_room_bl037（七行同序/默认选中一致/面板不溢） |
