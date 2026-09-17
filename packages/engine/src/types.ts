/** 花色：万 W、条 T、筒 B、字 Z、花 H */
export type Suit = 'W' | 'T' | 'B' | 'Z' | 'H';

/** 牌唯一 ID，如 "W1".."W9"、"T1".."T9"、"B1".."B9"、"Z1".."Z7"、"H1".."H8" */
export type TileId = string;

/** 胡牌方式：自摸 / 点炮 */
export type WinBy = 'zimo' | 'dianpao';

/** 补牌胡 / 末尾胡 等依赖「怎么胡的」的流程上下文 */
export interface WinFlowContext {
  /** 杠开胡：开杠后补摸的那张牌胡 */
  winAfterKong?: boolean;
  /** 花开胡：摸花后补摸的那张牌胡 */
  winAfterFlower?: boolean;
  /** 抢杠胡：抢别人加杠的那张牌 */
  robbedKong?: boolean;
  /** 海底捞：自摸牌墙最后一张可摸牌（第 140 张） */
  isLastDrawable?: boolean;
}

/** 副类型：吃(顺) / 碰(明刻) / 明杠 / 暗杠 / 加杠 */
export type MeldType = 'chi' | 'pong' | 'kong_exposed' | 'kong_concealed' | 'kong_added';

export interface Meld {
  type: MeldType;
  tiles: TileId[];
}

/** 一手胡牌的完整信息（供 winCheck / 番种识别 / 结算） */
export interface Hand {
  /** 暗牌计数：TileId -> 张数（含胡牌张） */
  concealed: Record<string, number>;
  /** 已成型副（含亮明的吃/碰/明杠 与 暗杠） */
  melds: Meld[];
  /** 花区（摸到即亮、补摸） */
  flowers: TileId[];
  /** 胡的那张牌 */
  winTile: TileId;
  winBy: WinBy;
  /** 点炮来源座位（自摸为空） */
  fromSeat?: number;
  /** 胡牌方是否庄家 */
  isDealer: boolean;
  /** 牌墙剩余可摸张数 */
  wallRemaining: number;
  /** 连庄次数 n */
  lianzhuangCount: number;
  /** 各家桌上「子」数 */
  seatsZi: Record<number, number>;
  /** 补牌胡/末尾胡等流程上下文 */
  flow?: WinFlowContext;
}

/** 一个已识别成立的番种（count 用于见花/见字按只/刻计） */
export interface MatchedPattern {
  name: string;
  count?: number;
  /** 显式覆盖台数（默认 = 表值 × count） */
  tai?: number;
  /** 构成该番种的具体牌（供客户端展开显示，如见花列出哪几朵花） */
  tiles?: TileId[];
}

export interface ScoreDetail {
  name: string;
  tai: number;
  /** 按张计台的番种的张数（如见花=花数） */
  count?: number;
  /** 构成该番种的具体牌（供展开显示） */
  tiles?: TileId[];
}

export interface ScoreResult {
  total: number;
  detail: ScoreDetail[];
  zhaHu: boolean;
  minimalHu: boolean;
}

export interface ScoreOptions {
  /** 是否满足最小胡四条件（由识别层判定后传入，见规格书 3.13） */
  minimal?: boolean;
}
