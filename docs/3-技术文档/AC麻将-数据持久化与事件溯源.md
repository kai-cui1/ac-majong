# A&C 麻将 · 数据持久化与事件溯源（技术方案）

> **模块**：存储层（`server/src/persistence/`）+ 引擎还原（`rehydrate`）+ 本地基础设施（`deploy/`）。
> **关联**：总体架构 [`AC麻将-联机架构方案.md`](./AC麻将-联机架构方案.md) §11（存储概览，本文档为落地细节）｜还原入口 [`AC麻将-对局流程引擎.md`](./AC麻将-对局流程引擎.md) §6｜登录落库 [`AC麻将-登录鉴权.md`](./AC麻将-登录鉴权.md)｜接线方 [`AC麻将-服务端网关与房间.md`](./AC麻将-服务端网关与房间.md) §11
> **产品**：FR-积分-04（无账户、全量持久化用于审计/还原，见 [`../1-prd/05-结算与积分战绩.md`](../1-prd/05-结算与积分战绩.md)）、决策 D-32。
> 遵循[《文档总纲》](../README.md)三原则。

---

## 1. 目标与范围

- **权威永久保存**：每次房间创建、进出记录、每局对局（初始牌墙 + 各家手牌 + 动作日志 + 结算），支持「**真实还原每一次对局**」。
- **事件溯源**：只存「业务事实」，不存每步 `TableState`；依赖引擎确定性用 `rehydrate` + `replayRound` 还原。
- **双层存储**：Redis（热 / 实时）+ MySQL（权威 / 永久）。
- **可插拔**：内存实现（测试 / 无 Docker）↔ MySQL + Redis（生产），按环境变量切换。

## 2. 存储分层

| 层 | 载体 | 存什么 | 生命周期 |
|---|---|---|---|
| 热 / 实时 | Redis | 会话 / 房间快照 / 动作缓冲 / 实例路由 | 短（TTL / 局内） |
| 权威 / 永久 | MySQL | users / rooms / room_member_events / games / game_initial_states / game_actions | 永久 |

## 3. 事件溯源还原

- 引擎确定性（`createTable` 由 `seed` 决定牌墙、`applyAction` 纯函数）→ 只存「**初始快照 + 动作日志**」即可 100% 重放。
- `snapshotRound` / `rehydrate` / `replayRound`（见[对局流程引擎 §6](./AC麻将-对局流程引擎.md)）。
- **存量对比**：约 15–40 KB/局 vs 全量快照 0.5–1.3 MB/局。
- **算法无关**：`rehydrate` 只依赖存下的牌墙 + 手牌，`seed` 仅交叉校验（对应架构风险 A8）。

## 4. MySQL schema（6 表，[`../../deploy/schema.sql`](../../deploy/schema.sql)）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `users` | `openid`(PK) / nickname / avatar_url / created_at / last_login_at | 登录 upsert |
| `rooms` | `room_id`(PK) / host_openid / max_rounds / initial_score(JSON) / final_score(JSON) / status / created_at / closed_at | 积分随房间生命周期（D-32，不做账户余额）|
| `room_member_events` | room_id / openid / seat / event(`create`/`join`/`leave`/`ready`) / at | 进出流水 |
| `games` | `game_id`(PK) / room_id / round_no / dealer_seat / seed / end_type / result(JSON) / started_at / ended_at | 每局一行 |
| `game_initial_states` | `game_id`(PK) / wall(JSON) / hands(JSON) / lianzhuang_count | 初始牌墙 + 各家起手 |
| `game_actions` | game_id / seq / seat / action_type / payload(JSON) / at；`unique(game_id,seq)` | 动作日志，payload 为完整 Action |

## 5. Repository 契约（`persistence/entities.ts`）

- **`GameStore`**（MySQL）：`upsertUser/getUser`｜`createRoom/getRoom/closeRoom`｜`addMemberEvent/listMemberEvents`｜`createGame/saveInitialState/appendActions/finishGame/getGame/getInitialState/listActions/listGames`｜`close`。
- **`RealtimeStore`**（Redis）：`saveSession/getSession/delSession`｜`saveRoomSnapshot/getRoomSnapshot`｜`setRoomInstance/getRoomInstance`｜`bufferActions/drainActions`｜`close`。
- **实体**：`UserRow/RoomRow/MemberEventRow/GameRow/InitialStateRow/ActionRow/SessionData`；`toRoundSnapshot(game, initial) → RoundSnapshot`（组装 replay 输入）。

## 6. 实现

- **内存**（`memory.ts`）：`MemoryGameStore` / `MemoryRealtime`，`structuredClone` 隔离，无外部依赖 → 单测与无 Docker 兜底。
- **MySQL**（`mysql.ts`）：`MysqlGameStore.create(url)` → `mysql2` 连接池；JSON 列写入 `stringify`、读取 `parse`（兼容返回字符串或对象）；`BIGINT seed → Number`；`DATETIME → Date`。
- **Redis**（`redis.ts`）：`RedisRealtime.create(url)` → `ioredis`；键 `sess:` / `snap:` / `inst:` / `buf:`；会话 `SET ... EX ttl`；`drainActions` 用 `multi(lrange + del)` 取出并清空。
- **工厂**（`index.ts`）：`createPersistence(env)` → 同时设 `DATABASE_URL` + `REDIS_URL` 用 MySQL+Redis（`kind='sql'`），否则内存（`kind='memory'`）。与 `IdentityProvider` 同款可插拔策略。

## 7. 写入时机（BL-013 接线进度）

| 时机 | 落库 | 状态 |
|---|---|---|
| 登录 | `upsertUser` + `saveSession` | ✅ 已接线（M-B）|
| 房间创建 | `createRoom`（`rooms`：房号/房主/`max_rounds` 含「不限」=`0`/status） | ✅ 已接线（M-C）|
| 成员进出 | `addMemberEvent`（`room_member_events`：create/join/leave/ready） | ⬜ M-D |
| 开局 | `games` + `game_initial_states`（`snapshotRound`）| ✅ 已接线（M-E，RoomActor.start→GameHooks.onGameStart）|
| 局内动作 | 先 `bufferActions` 到 Redis，局末 `drainActions` → `appendActions` 批量落 MySQL | ✅ 已接线（M-E，handleAction→onGameAction 缓冲、局末→onGameEnd drain+appendActions）|
| 结算 / 关闭 | `finishGame`（M-E 局末，`result` JSON 含台数明细/积分/亮牌）+ `closeRoom(final_score)`（M-G 散场）| ✅ 均已接线：`finishGame`（M-E，M-F 补 `win` 事件台数明细 `detail` 透传入 `result`）、`closeRoom`（M-G，RoomActor 散场→GameHooks.onRoomEnd→`closeRoom(final_score)`+`status=closed`）|

> **登录**（M-B）/**房间创建**（M-C）/**成员进出**（M-D）/**对局事件溯源**（M-E：开局 `games`+`game_initial_states`、局内动作 Redis 缓冲、局末 `drainActions`→`appendActions`+`finishGame`）/**结算台数明细**（M-F：`win` 事件透传 `detail` 入 `games.result`）/**散场关闭**（M-G：`closeRoom(final_score)`+`status=closed`）均已接线并端到端验证（e2e：单人+3Bot 打满 2 局→散场 `roomEnd`→MySQL `rooms.status=closed`+`final_score` 零和、`games`×2 `end_type`、`game_actions`、`game_initial_states`；不限局数房主 `dissolve` 散场同样落库）；6 表全量写入路径打通（见 [`../5-backlog/README.md`](../5-backlog/README.md) BL-013）。

## 8. 本地基础设施（`deploy/`）

- `docker-compose.yml`：MySQL 8（3306，库 `ac_majong`，首启自动执行 `schema.sql` 建表）+ Redis 7（6379），均带 healthcheck。
- `server/.env.example`：`DATABASE_URL` / `REDIS_URL` / `PORT` / `DB_IT`（连接账号口令见此文件与 compose，不写入其它文档）。
- 启动：`cd deploy && docker compose up -d`。

## 9. 回放数据接口（BL-012 前端回放 UI，低优先）

读回 `getGame` + `getInitialState` + `listActions` → `toRoundSnapshot` → `replayRound` → 逐帧事件供前端回放 UI 消费。

## 10. 测试

- `persistence.test.ts`（内存，always）：房间 + 一局记录往返、事件溯源（驱动一局 → 存业务事实 → 读回 → `replayRound` 与实时一致）、Realtime 会话 / 快照 / 缓冲。
- `persistence.integration.test.ts`（`DB_IT=1` gated）：真实 MySQL/Redis 落库读回 + replay；实测落库整局 **156 条动作**并还原一致。默认 `pnpm test` 跳过（无 `DB_IT`）。

## 11. 保留与规模

永久保留；预估约 1000 局/天；对局回放 UI 优先级低（BL-012）。

---

## 维护记录

| 日期 | 概要 |
|---|---|
| 2026-09-16 | 首次产出（补记 M-A2）：存储分层、事件溯源还原、MySQL 6 表 schema、Repository 契约（GameStore + RealtimeStore）、内存 / MySQL / Redis 实现、`createPersistence` 工厂、写入时机（BL-013 接线进度）、`deploy` 基础设施、回放接口、测试（含真实库 156 动作还原）|
| 2026-09-16 | M-C 文档先行：§7 写入时机拆分「房间创建」（`createRoom`，M-C 接线中，`max_rounds`「不限」=`0`）与「成员进出」（M-D）；明确房间创建落库为弱依赖不阻断建房 |
| 2026-09-16 | M-C 实现回填：§7「房间创建」由「接线中」转 ✅ 已接线（网关 `create` 分支调 `createRoom`）；e2e + MySQL 验证 `rooms` 落库（含「不限」=`max_rounds:0`、`status=idle`、初始积分）|
| 2026-09-16 | M-D 实现回填：§7「成员进出」转 ✅（网关 create/join/leave 经 `logMember` 弱依赖落 `room_member_events`）；e2e + MySQL 验证 create/join 流水 |
| 2026-09-16 | M-E 实现回填：§7「开局/局内动作/结算」转 ✅（RoomActor `GameHooks` 同步触发 + 网关 fire-and-forget 落库：`createGame`+`saveInitialState`、`bufferActions`、局末 `drainActions`→`appendActions`+`finishGame`）；e2e 单人+3Bot 打完一局验证 MySQL `games`(end_type=exhaustive)/`game_actions`(171)/`game_initial_states`(wall75/hands4) |
| 2026-09-16 | M-F/M-G 实现回填：§7「结算/关闭」全转 ✅——M-F `win` 事件透传台数明细 `detail`（随 `finishGame` 入 `games.result`，engine 136 测试断言 `detail` 合计=总台数）；M-G 散场 `RoomActor.finishRoom`（打满上限/房主 `dissolve` 共用）→ `GameHooks.onRoomEnd` → 网关 `closeRoom(final_score)`+`status=closed`，`RoomManager.remove` 回收房间。e2e 双场景验证：打满 2 局散场（`rooms.status=closed`+`final_score` 零和+`games`×2+`game_actions`+`game_initial_states`×2）、不限局数房主解散散场（`status=closed`）；server 35 测试绿 |
