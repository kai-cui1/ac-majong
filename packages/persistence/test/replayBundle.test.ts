import { describe, it, expect } from 'vitest';
import { buildReplayBundle, type GameStore } from '../src/index';

// BL-024 单局回放包组装（原 apps/game-server/test/diag.test.ts，随 buildReplayBundle 下沉 persistence 一并迁移）
describe('BL-024 buildReplayBundle', () => {
  it('对局/快照缺失返回 null', async () => {
    const store = { getGame: async () => null } as unknown as GameStore;
    expect(await buildReplayBundle(store, 'nope')).toBeNull();
  });

  it('由存储行组装 snapshot/actions/names（snapshot 自带墙，离线可重演）', async () => {
    const store = {
      getGame: async () => ({ roomId: 'R1', roundNo: 2, dealerSeat: 1 }),
      getInitialState: async () => ({ wall: ['W1', 'W2'], hands: [{ seat: 0, concealed: { M1: 2 }, melds: [], flowers: [], zi: 0, score: 0 }], lianzhuangCount: 1 }),
      listActions: async () => [{ seq: 1, seat: 0, payload: { type: 'draw', seat: 0 } }],
      listMemberEvents: async () => [{ openid: 'a', seat: 0 }],
      getRoom: async () => ({ maxRounds: 8, settings: null, seating: null }),
      getUser: async () => ({ nickname: '甲' }),
    } as unknown as GameStore;
    const b = await buildReplayBundle(store, 'R1-g1');
    expect(b).toBeTruthy();
    expect(b!.v).toBe(1);
    expect(b!.room.id).toBe('R1');
    expect(b!.game).toMatchObject({ gameId: 'R1-g1', roundNo: 2, dealerSeat: 1 });
    expect(b!.snapshot.wall).toEqual(['W1', 'W2']);
    expect(b!.snapshot.players[0]).toMatchObject({ seat: 0, zi: 0 });
    expect(b!.actions).toEqual([{ seq: 1, seat: 0, action: { type: 'draw', seat: 0 } }]);
    expect(b!.names).toEqual({ 0: '甲' });
  });
});
