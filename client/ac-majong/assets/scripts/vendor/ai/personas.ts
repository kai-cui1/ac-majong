import type { BotConfig } from './types';

/** 打法（人格）标识 */
export type PersonaId =
  | 'efficiency-novice'
  | 'efficiency-normal'
  | 'big-hand'
  | 'balanced'
  | 'monte-carlo'
  | 'trustee';

export interface Persona {
  id: PersonaId;
  displayName: string;
  /** 面板图标（emoji，对齐高保真原型 room.html .bp-ico） */
  icon: string;
  /** 注册表中的策略名 */
  strategy: string;
  description: string;
  /** P1 仅开放 efficiency-* 与 trustee；其余为锁定预告（P2~P4 解锁） */
  available: boolean;
  config: BotConfig;
}

const base: BotConfig = {
  aggression: 0.5,
  scoreWeight: 0.2,
  defenseThreshold: 0.7,
  noise: 0,
  thinkMs: 260,
  canWin: true,
  allowMeld: true,
};

export const PERSONAS: Persona[] = [
  {
    id: 'efficiency-novice',
    displayName: '新手陪练',
    icon: '🐣',
    strategy: 'efficiency',
    description: '会打但常失误，适合新手练习',
    available: true,
    config: { ...base, noise: 0.5, thinkMs: 320 },
  },
  {
    id: 'efficiency-normal',
    displayName: '最大概率打法',
    icon: '🎯',
    strategy: 'efficiency',
    description: '追求最快听牌与最高和率，稳健的“最大概率”打法',
    available: true,
    config: { ...base, noise: 0.05 },
  },
  {
    id: 'big-hand',
    displayName: '追求大牌',
    icon: '🀄',
    strategy: 'bigHand',
    description: '宁可慢一点，也要冲清一色/碰碰胡等高台大牌',
    available: false,
    config: { ...base, scoreWeight: 0.9 },
  },
  {
    id: 'balanced',
    displayName: '稳健高手',
    icon: '🛡️',
    strategy: 'balanced',
    description: '攻防一体，危险时弃和保子，机会时果断进攻',
    available: false,
    config: { ...base, aggression: 0.6, scoreWeight: 0.5, defenseThreshold: 0.5 },
  },
  {
    id: 'monte-carlo',
    displayName: '概率大师',
    icon: '🧮',
    strategy: 'monteCarlo',
    description: '蒙特卡洛模拟期望最优，接近高手的“算牌”打法',
    available: false,
    config: { ...base, aggression: 0.6, scoreWeight: 0.6, defenseThreshold: 0.4 },
  },
  {
    id: 'trustee',
    displayName: '托管（保守）',
    icon: '🤖',
    strategy: 'trustee',
    description: '掉线代打默认档：只摸打、不吃碰杠胡，不主动吃亏',
    available: true,
    config: { aggression: 0.1, scoreWeight: 0, defenseThreshold: 0.3, noise: 0, thinkMs: 400, canWin: false, allowMeld: false },
  },
];

export const DEFAULT_PERSONA: PersonaId = 'efficiency-normal';
export const TRUSTEE_PERSONA: PersonaId = 'trustee';

export function personaById(id: string): Persona | undefined {
  return PERSONAS.find((p) => p.id === id);
}
