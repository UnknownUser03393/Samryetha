/**
 * 幂等 seed：确保内置 admin/dev 账号存在（与 server 启动逻辑共用）。
 * 用法：pnpm seed
 * 说明：示例数据已随 release 清理；如需本地造演示数据另行编写脚本。
 */
import { loadEnv } from "../config/env.js";
import { buildContainer } from "../app/container.js";
import { ensureBuiltInAccounts } from "../auth/bootstrap.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const container = await buildContainer(env, { runMigrations: true });
  try {
    await ensureBuiltInAccounts(container.db, env, container.logger);
    console.log("Built-in accounts ready (admin / dev).");
  } finally {
    await container.close();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
