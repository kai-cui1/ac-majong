import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../lib/rbac';
import { notFound } from '../lib/errors';
import { dateRangeFields, pageFields } from '../lib/query';

const listQuery = z.object({
  roomId: z.string().max(16).optional(),
  host: z.string().max(64).optional(),
  status: z.enum(['idle', 'playing', 'closed']).optional(),
  ...dateRangeFields,
  ...pageFields,
});

/** 房间查询（只读，FR-Admin-05） */
export async function roomRoutes(app: FastifyInstance): Promise<void> {
  const { game } = app.deps;

  app.get('/api/rooms', { preHandler: requireAuth }, async (req) => {
    const q = listQuery.parse(req.query);
    return game.queryRooms(q);
  });

  app.get('/api/rooms/:roomId', { preHandler: requireAuth }, async (req) => {
    const { roomId } = req.params as { roomId: string };
    const detail = await game.getRoomDetail(roomId);
    if (!detail.room) throw notFound('房间不存在');
    return detail;
  });
}
