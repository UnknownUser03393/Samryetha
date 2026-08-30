import { DatabaseSync } from "node:sqlite";
import { migrate as drizzleMigrate } from "drizzle-orm/sqlite-proxy/migrator";
import type { Db } from "./client.js";

/**
 * 执行 drizzle migration 文件夹。
 * 注：Node 内置 node:sqlite 未编译 FTS5 模块，搜索第一版用 LIKE 子串匹配
 * （对中文同样有效），未来切 PostgreSQL 时换 to_tsvector + GIN 即可。
 */
export async function migrateDb(db: Db, raw: DatabaseSync, migrationsFolder: string): Promise<void> {
  await drizzleMigrate(
    db,
    async (queries) => {
      for (const query of queries) raw.exec(query);
    },
    { migrationsFolder },
  );
}
