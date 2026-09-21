import { z } from 'zod';

/** 分页 + 时间范围的公共 zod 片段（query 参数为字符串，用 coerce 转数字/日期） */
export const pageFields = {
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(200).optional(),
};
export const dateRangeFields = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};
