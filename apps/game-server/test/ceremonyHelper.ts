import type { RoomActor } from '../src/roomActor';

/**
 * BL-017 测试助手：同步驱动开局仪式至完成——
 * 选位骰（四家逐掷，同点自动重掷）→ 最大者选座（保留自己当前座位）→ 定庄骰 → 摸牌位骰（若启用）。
 * 每轮重读 roomView 以适配选座后的座位重排。
 */
export function driveCeremony(room: RoomActor): void {
  for (let i = 0; i < 80; i++) {
    const sv = room.roomView().seating;
    if (!sv) return;
    const users = new Map<number, string>();
    for (const s of room.roomView().seats) if (s) users.set(s.seat, s.userId);
    if (sv.stage === 'roll') {
      for (const [seat, u] of users) if (sv.rolls[seat] == null) room.handleRoll(u);
    } else if (sv.stage === 'pick') {
      const u = users.get(sv.picker!);
      if (u) room.handlePickSeat(u, sv.picker!);
    } else {
      const roller = sv.stage === 'dealerDice' ? sv.picker : sv.stage === 'roundBreak' ? sv.roller : sv.dealerSeat;
      const u = roller == null ? undefined : users.get(roller);
      if (u) room.handleRoll(u);
    }
  }
}
