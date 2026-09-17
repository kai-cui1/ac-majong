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
│  └─ UiKit.ts        通用组件工厂（背景/文本/按钮/面板/徽章/弹层）
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
- **无预制体**：新增屏幕/组件一律代码构建，评审以 `.ts` diff 为准。

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

## 维护记录

| 日期 | 概要 |
|---|---|
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
