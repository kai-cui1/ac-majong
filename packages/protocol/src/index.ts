import type { Action, GameEvent, ActionKind, Meld, TableState } from '@ac-majong/engine';

// 便捷再导出，客户端无需直接依赖 engine 也能拿到这些类型
export type { Action, GameEvent, ActionKind, Meld };

/** 对局阶段（房间层） */
export type RoomPhase = 'waiting' | 'seating' | 'playing' | 'finished';

/** BL-017 房间玩法参数（建房时房主设定，开局后不可改） */
export interface RoomSettings {
  /** 牌墙模式：physical=物理牌墙固化展示 / random=随机发牌（默认） */
  wallMode: 'physical' | 'random';
  /** 摸牌位骰：每局庄家掷骰定开牌点（默认关） */
  breakDice: boolean;
  /** BL-020 先看吃再碰：吃家选定后全桌公开吃意图（副露区留空位预览），碰家看见后再决（默认开） */
  chiFirstView: boolean;
  /** BL-018 公开房间：开=进入大厅房间列表可被发现；关=仅房号/分享卡可入（默认开） */
  isPublic: boolean;
}

/** BL-018 大厅公开房间列表行（仅公开且未关闭房；无积分/隐私字段） */
export interface PublicRoomEntry {
  room: string;
  /** 房主昵称 */
  host: string;
  /** 已入座人数（含 Bot） */
  seats: number;
  maxRounds: number;
  status: 'waiting' | 'playing';
  /** BL-018 缺陷修复（2026-09-20）：当前拉列表者是否该房成员——自己的房即使对局中/满员也可「重入」 */
  mine: boolean;
}

/** 仪式操作绑定用户当前看到的输入步骤；旧端可省略。 */
export interface CeremonyToken {
  ceremonyId: string;
  stepId: number;
}

/** 最终两枚骰面由服务端独立生成，客户端不得按总和反推。 */
export interface CeremonyDice {
  d1: number;
  d2: number;
  sum: number;
}

/** 仪式完整展示快照；时间戳与时长单位均为毫秒。 */
export interface CeremonyPresentation extends CeremonyToken {
  startedAt: number;
  deadline: number;
  serverNow: number;
  phase: 'input' | 'rolling' | 'result' | 'summary';
  actor: { userId: string; seat: number } | null;
  rerollRound: number;
  pendingRollUserIds: string[];
  resultsByUserId: Record<string, CeremonyDice & { rerollRound: number }>;
  ceremonyDice: CeremonyDice | null;
  summaryKind: 'ranking' | 'reroll' | 'seated' | null;
}

/** BL-017 开局仪式/摸牌位骰视图（roomView 与 gameView 共用下发）；2026-09-19 流程合并：dealerDice+breakDice → dealerBreak（A 一掷同时定庄+定开牌点） */
export interface SeatingView {
  stage: 'roll' | 'pick' | 'dealerBreak' | 'roundBreak';
  /** 各座位当前骰点和（未掷=null，按现座位下标） */
  rolls: (number | null)[];
  /** 同点待重掷标记 */
  reroll: boolean[];
  /** 选位顺序（点数降序的座位列表，roll 完成后下发） */
  order: number[];
  picker: number | null;
  picked: number | null;
  /** 定庄摸牌位骰结果（dealerBreak 阶段）：N 同时定庄+定开牌点 */
  dealerDice: number | null;
  dealerSeat: number | null;
  breakN: number | null;
  /** roundBreak 阶段：待掷摸牌位骰的庄家 */
  roller: number | null;
  /** 各家当前子数（局间罗盘卡展示用，下标=座位） */
  ziCounts?: number[];
  /** 新版仪式完整下发；缺失时客户端静态兼容旧业务字段。 */
  presentation?: CeremonyPresentation;
}

/**
 * 按座位裁剪后的牌桌视图（服务端 → 客户端）。
 * 防透视关键：`you.concealed` 给完整暗牌；`others` 只给 `concealedCount`，绝不含具体牌。
 */
export interface ViewState {
  room: string;
  round: number;
  /** 本房间总局数上限（用于客户端判断“下一局/对局结束”与进度显示） */
  maxRounds: number;
  /** 各家展示昵称（下标=座位），供 pinfo 显示真实昵称（M-还原度） */
  names: string[];
  phase: TableState['phase'];
  dealerSeat: number;
  currentSeat: number;
  wallRemaining: number;
  lianzhuangCount: number;
  lastDiscard: { seat: number; tile: string } | null;
  /** BL-020 先看吃再碰（开关 ON 时下发）：某家已选吃的意图公开——seat=吃家，tiles=其暗牌中出的两张，called=被吃牌；吃失败/窗结束即消失 */
  pendingChi?: { seat: number; tiles: string[]; called: string };
  /** 全局有序弃牌河（公开信息），供客户端渲染中央牌河 */
  discards: { seat: number; tile: string }[];
  you: {
    seat: number;
    concealed: Record<string, number>;
    /** 刚摸到的牌（仅自己回合 discard 相位下发，供客户端「抽出抬高」显示）；其余为 null */
    drawn: string | null;
    melds: Meld[];
    flowers: string[];
    zi: number;
    score: number;
    legal: ActionKind[];
  };
  others: {
    seat: number;
    concealedCount: number;
    melds: Meld[];
    flowersCount: number;
    zi: number;
    score: number;
  }[];
  /** BL-017 physical 模式：四边牌墙栈高（0/1/2）+ 开牌点；random 模式无此字段 */
  wallInfo?: {
    rows: { seat: number; stacks: number[] }[];
    breakSeat: number;
    breakGroups: number;
  };
  /** BL-017：局间摸牌位骰阶段（roundBreak）随 gameView 下发 */
  seating?: SeatingView;
}

/** 房间/等待页视图 */
export interface RoomView {
  room: string;
  phase: RoomPhase;
  hostUserId: string;
  maxRounds: number;
  /** BL-017 房间玩法参数 */
  settings?: RoomSettings;
  /** BL-017 开局仪式视图（phase=seating 时下发） */
  seating?: SeatingView;
  seats: ({ userId: string; seat: number; nickname?: string; isBot?: boolean; offline?: boolean; trusteed?: boolean } | null)[];
}

/** 散场原因：打满局数上限 / 房主主动解散（不限局数时） */
export type RoomEndReason = 'maxRounds' | 'dissolve';

/** 散场最终排名（单家）：座位 + 累计积分 + 胡牌局数（散场战绩页 P8 用） */
export interface FinalStanding {
  seat: number;
  userId: string;
  isBot: boolean;
  score: number;
  wins: number;
}

/** 单局回顾（散场战绩页局数列表用）：胡牌则记赢家/台数/最高番种/自摸，荒庄则 winnerSeat=null */
export interface RoundReview {
  round: number;
  endType: 'win' | 'exhaustive';
  winnerSeat: number | null;
  tai: number;
  topFan: string | null;
  zimo: boolean;
}

/** 用户展示资料：昵称/头像由客户端上报，身份（openid）由服务端校验（微信下 openid 权威） */
export interface UserProfile {
  nickname: string;
  avatarUrl: string;
}

/** BL-012：回放列表——单局摘要 */
export interface ReplayRoundSummary {
  gameId: string;
  roundNo: number;
  endType: 'win' | 'exhaustive';
  winnerSeats: number[];
  /** 座位号 → 赢牌台数（荒庄为空） */
  taiBySeat: Record<number, number>;
  /** 结束时间 ISO */
  at: string | null;
}
/** BL-012：回放列表——房间级（房间→局） */
export interface ReplayRoomSummary {
  roomId: string;
  createdAt: string;
  status: string;
  /** 座位号 → 昵称（列表行显示赢家用，机器人为空） */
  seatNames: Record<number, string>;
  rounds: ReplayRoundSummary[];
}
/** BL-012：起始快照（与引擎 RoundSnapshot 同构，避免协议包依赖 engine） */
export interface ReplaySnapshot {
  wall: string[];
  players: { seat: number; concealed: Record<string, number>; melds: unknown[]; flowers: string[]; zi: number; score: number }[];
  dealerSeat: number;
  currentSeat: number;
  lianzhuangCount: number;
  round: number;
}
/** BL-012：回放的单个动作行（action 为引擎 Action 的 JSON，客户端自行断言） */
export interface ReplayActionRow {
  seq: number;
  seat: number | null;
  action: unknown;
}

/** BL-024 可维护性/申诉：单局回放包（离线可确定性重演）。snapshot 自带整副洗好的墙，故无需 seed 即可重放 */
export interface ReplayBundle {
  v: 1;
  exportedAt: number;
  room: { id: string; maxRounds: number; settings: RoomSettings | null; seating: unknown };
  game: { gameId: string; roundNo: number; dealerSeat: number };
  snapshot: ReplaySnapshot;
  actions: ReplayActionRow[];
  names: Record<number, string>;
}

/** 客户端 → 服务端 */
export type ClientMsg =
  | { t: 'auth'; seq: number; token?: string; account?: { username: string; password: string }; profile?: UserProfile }
  | { t: 'create'; seq: number; maxRounds?: number; settings?: RoomSettings }
  | { t: 'roomList'; seq: number } // BL-018：拉取公开房间列表
  | { t: 'join'; seq: number; room: string }
  | { t: 'leave'; seq: number }
  | { t: 'start'; seq: number }
  | { t: 'roll'; seq: number; ceremonyToken?: CeremonyToken }              // BL-017：掷骰（选位/定庄/摸牌位，语境由服务端阶段决定）
  | { t: 'pickSeat'; seq: number; seat: number; ceremonyToken?: CeremonyToken } // BL-017：选位最大者选座
  | { t: 'addBot'; seq: number; count?: number }
  | { t: 'removeBot'; seq: number; seat: number }
  | { t: 'nextRound'; seq: number }
  | { t: 'dissolve'; seq: number }
  | { t: 'action'; seq: number; action: Action }
  | { t: 'replayList'; seq: number }                // BL-012：战绩/回放列表（房间→局）
  | { t: 'replayLoad'; seq: number; gameId: string } // BL-012：加载单局回放（参赛四方可看，D-29）
  | { t: 'exportReplay'; seq: number; gameId: string } // BL-024：导出单局回放包（参赛四方可导，申诉/复现用）
  | { t: 'resendSettlement'; seq: number } // BL-026：结算相位晚进入/晚挂载时请求补发本局终局事件（重建结算浮层）
  | { t: 'ping'; seq: number };

/** 服务端 → 客户端 */
export type ServerMsg =
  | { t: 'authOk'; userId: string; profile: UserProfile; session?: string }
  | { t: 'roomList'; rooms: PublicRoomEntry[] } // BL-018：公开房间列表响应
  | { t: 'roomView'; room: RoomView }
  | { t: 'gameView'; view: ViewState }
  | { t: 'event'; events: GameEvent[] }
  | { t: 'roomEnd'; room: string; reason: RoomEndReason; standings: FinalStanding[]; rounds: RoundReview[] }
  | { t: 'legal'; seat: number; actions: ActionKind[] }
  | { t: 'ack'; seq: number; ok: boolean; reason?: string }
  /** BL-012：回放列表（仅本人参赛房间；房间→局两级） */
  | { t: 'replayList'; rooms: ReplayRoomSummary[] }
  /** BL-012：单局回放数据（起始快照+动作序列；names=座号→昵称；客户端 rehydrate+applyAction 确定性重演） */
  | { t: 'replayData'; gameId: string; snapshot: ReplaySnapshot; actions: ReplayActionRow[]; names: Record<number, string>; viewSeat: number }
  | { t: 'replayBundle'; bundle: ReplayBundle }                      // BL-024：单局回放包（exportReplay 的响应）
  | { t: 'pong' }
  | { t: 'error'; reason: string };
