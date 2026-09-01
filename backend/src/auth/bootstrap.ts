import { Algorithm, hash } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import type { DbProvider } from "../infrastructure/db/client.js";
import { users } from "../infrastructure/db/schema.js";
import type { Env } from "../config/env.js";
import { nextDiscriminator } from "../users/service.js";
import { FAKE_EMAIL_DOMAIN } from "./service.js";

/**
 * 幂等确保内置账号（admin / dev）存在。启动时调用，部署即用；
 * 已在 seed 脚本里作为手动兜底复用。
 */
export async function ensureBuiltInAccounts(
  db: DbProvider,
  env: Env,
  logger: { info(obj: unknown, msg?: string): void },
): Promise<void> {
  const accounts: { username: string; password: string }[] = [
    { username: "admin", password: env.ADMIN_PASSWORD },
    { username: "dev", password: env.DEV_PASSWORD },
  ];
  for (const { username, password } of accounts) {
    const existing = await db.db.select({ id: users.id }).from(users).where(eq(users.username, username)).get();
    const passwordHash = await hash(password, { algorithm: Algorithm.Argon2id });

    if (existing) {
      await db.db.update(users).set({
        password_hash: passwordHash,
        role: "admin",
        status: "active",
        email_verified_at: new Date(),
      }).where(eq(users.id, existing.id));
      continue;
    }

    const discriminator = await nextDiscriminator(db);
    await db.db.insert(users).values({
      username,
      display_name: username,
      email: `${username}@${FAKE_EMAIL_DOMAIN}`,
      email_domain: FAKE_EMAIL_DOMAIN,
      password_hash: passwordHash,
      role: "admin",
      status: "active",
      discriminator,
      email_verified_at: new Date(),
    });
    logger.info({}, `created built-in account: ${username}`);
  }
}
