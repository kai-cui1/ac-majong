import type { BotStrategy } from '../types';
import { efficiencyStrategy } from './efficiency';
import { trusteeStrategy } from './trustee';

/**
 * 策略注册表：name -> BotStrategy。
 * 新增打法 = 实现 BotStrategy + registerStrategy，不改接入层与引擎（可扩展铁律）。
 */
const REGISTRY = new Map<string, BotStrategy>();

export function registerStrategy(s: BotStrategy): void {
  REGISTRY.set(s.name, s);
}

export function getStrategy(name: string): BotStrategy | undefined {
  return REGISTRY.get(name);
}

export function strategyNames(): string[] {
  return [...REGISTRY.keys()];
}

// P1 内置策略
registerStrategy(efficiencyStrategy);
registerStrategy(trusteeStrategy);
