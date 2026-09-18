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
| 大厅（战绩/回放入口+规则条+⚙设置） | `…/home.html` | 2026-09-17 回补 |
| 房间等待 | `…/room.html` | 既有 |
| 牌桌（庄徽章/连N/离线托管/响应框/按钮簇/重连遮罩/结算浮层/摊牌2×2/听牌浮层） | `…/game.html` | 2026-09-17 回补 |
| 散场战绩 | `…/result.html` | 既有（无变更） |
| 规则（弹层形态注记+D-25 算账） | `…/rules.html` | 2026-09-17 回补 |
| 设置弹层 | `…/settings.html` | 2026-09-17 新建 |
| 牌面视觉 | `…/tile-faces.html` | 既有 |
| 回放列表/播放器（P9/P10） | `…/replay-list.html` / `replay-player.html` | 2026-09-18 新建（BL-012） |

> 流程门槛：凡 UI/交互变更，同批更新对应原型（改版或新建）；批次收尾按本表自检。**涉及交互界面细节的前端开发必须 100% 还原高保真原型**（颜色/字体/间距/圆角/描边/阴影/组件状态/文案逐点对齐；确需偏离先改原型再实现；验收对照原型逐目比对）。

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
