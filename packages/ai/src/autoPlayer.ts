import { previewTai } from '@ac-majong/engine';
import type { Action } from '@ac-majong/engine';
import type { ViewState } from '@ac-majong/protocol';
import { DEFAULT_PERSONA, personaById, type PersonaId } from './personas';
import { getStrategy } from './strategies/registry';
import type { BotConfig, BotContext } from './types';

/** 把 ViewState + 引擎派生特征封装成决策上下文（previewTai 已内建 6 台门槛） */
export function buildContext(view: ViewState, seat: number, cfg: BotConfig, rng: () => number): BotContext {
  const you = view.you;
  const preview = previewTai(you.concealed, you.melds, you.flowers, {
    isDealer: seat === view.dealerSeat,
    wallRemaining: view.wallRemaining,
    lianzhuangCount: view.lianzhuangCount,
    drawn: you.drawn ?? undefined,
    myZi: you.zi,
  });
  return { view, seat, cfg, rng, preview };
}

export interface AutoPlayer {
  readonly personaId: PersonaId;
  /** 统一决策入口：给定视图与座位返回一个合法动作（null=不行动） */
  decide(view: ViewState, seat: number): Action | null;
}

/**
 * 创建统一决策器：按 personaId 解析「策略 + 人格配置」。
 * 未知/锁定 persona 回落默认打法，保证接入层永不因配置缺失崩溃。
 */
export function createAutoPlayer(personaId: string = DEFAULT_PERSONA, rng: () => number = Math.random): AutoPlayer {
  const persona = personaById(personaId) ?? personaById(DEFAULT_PERSONA)!;
  // 未注册策略（如锁定档被误设）回落默认策略，保证 Bot 永不停摆
  const strategy = getStrategy(persona.strategy) ?? getStrategy(personaById(DEFAULT_PERSONA)!.strategy);
  return {
    personaId: persona.id,
    decide(view: ViewState, seat: number): Action | null {
      if (!strategy) return null;
      return strategy.decide(buildContext(view, seat, persona.config, rng));
    },
  };
}
