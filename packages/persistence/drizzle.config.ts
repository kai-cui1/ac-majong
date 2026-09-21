import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle 迁移配置（BL-015 / Admin 技术方案 §3.4）。
 * schema 只指向 admin 自有表（admins/arbitrations/admin_audit_logs）——`generate` 仅产出这三表 DDL；
 * 游戏 6 表由 deploy/schema.sql 管理，其只读镜像见 src/admin/gameSchema.ts，**不参与迁移**，避免误改现网结构。
 */
export default defineConfig({
  dialect: 'mysql',
  schema: './src/admin/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'mysql://root:root@127.0.0.1:3306/ac_majong',
  },
});
