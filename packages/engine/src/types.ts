/** 花色：万 W、条 T、筒 B、字 Z、花 H */
export type Suit = 'W' | 'T' | 'B' | 'Z' | 'H';

/** 牌唯一 ID，如 "W1".."W9"、"T1".."T9"、"B1".."B9"、"Z1".."Z7"、"H1".."H8" */
export type TileId = string;

/** 胡牌方式：自摸 / 点炮 */
export type WinBy = 'zimo' | 'dianpao';

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
}

/** 一个已识别成立的番种（count 用于见花/见字按只/刻计） */
export interface MatchedPattern {
  name: string;
  count?: number;
  /** 显式覆盖台数（默认 = 表值 × count） */
  tai?: number;
}

export interface ScoreDetail {
  name: string;
  tai: number;
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
