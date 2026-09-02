import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { DbProvider } from "../infrastructure/db/client.js";
import { sessions, users } from "../infrastructure/db/schema.js";

type UserRow = typeof users.$inferSelect;

export const SESSION_COOKIE = "samryetha_session";

/** DB 只存 token 的 sha256，cookie 持有 raw token，防 DB 泄露直接登入。 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSessionToken(): { token: string; expiresAt: Date } {
  return {
    token: randomBytes(32).toString("base64url"),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  };
}

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export async function createSession(
  db: DbProvider,
  userId: number,
  ctx: { ip?: string; userAgent?: string },
  ttlMs: number = SESSION_TTL_MS,
): Promise<{ token: string; expiresAt: Date }> {
  const { token, expiresAt } = createSessionToken();
  await db.db.insert(sessions).values({
    token_hash: hashToken(token),
    user_id: userId,
    expires_at: expiresAt,
    ip: ctx.ip ?? null,
    user_agent: ctx.userAgent ?? null,
  });
  return { token, expiresAt };
}

export async function getSessionUser(
  db: DbProvider,
  token: string,
): Promise<UserRow | undefined> {
  const row = await db.db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.user_id, users.id))
    .where(and(eq(sessions.token_hash, hashToken(token)), gt(sessions.expires_at, new Date()), isNull(users.deleted_at)))
    .get();
  return row?.user;
}

export async function deleteSession(db: DbProvider, token: string): Promise<void> {
  await db.db.delete(sessions).where(eq(sessions.token_hash, hashToken(token)));
}

export async function deleteUserSessions(db: DbProvider, userId: number): Promise<void> {
  await db.db.delete(sessions).where(eq(sessions.user_id, userId));
}
