import { Algorithm, hash, verify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbProvider } from "../infrastructure/db/client.js";
import { users as usersTable } from "../infrastructure/db/schema.js";
import type { Env } from "../config/env.js";
import { banned, conflict, forbidden, invalidCredentials } from "../app/error.js";
import { nextDiscriminator, normalizeUsername, type UserDTO, type UserService } from "../users/service.js";
import { createSession, deleteSession, deleteUserSessions } from "./session.js";

/** 合法 argon2id 占位哈希：登录时对不存在的账号也走一次 verify，缓解枚举时序。 */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$zKvRrWt4CvwTThbIAqLc7w$ScmWWJ4FP6+h0VnrJ1fRevG+euV30+s0IOS0lUnA3tQ";

/** 内测期无真实邮箱：注册时生成假邮箱（username 唯一 → 邮箱唯一），后续可无缝切回真邮箱。 */
export const FAKE_EMAIL_DOMAIN = "samryetha.local";

export interface RegisterInput {
  username: string;
  displayName?: string;
  password: string;
}

export interface AuthService {
  register(input: RegisterInput): Promise<{ userId: number }>;
  login(
    identifier: string,
    password: string,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<{ user: UserDTO; token: string; expiresAt: number }>;
  logout(token: string): Promise<void>;
  changePassword(userId: number, currentPassword: string, newPassword: string): Promise<{ ok: boolean }>;
}

export function createAuthService(
  db: DbProvider,
  userService: UserService,
  env: Env,
): AuthService {
  async function register(input: RegisterInput) {
    const username = normalizeUsername(input.username);
    const existing = await db.db.select().from(usersTable).where(eq(usersTable.username, username)).get();
    if (existing) throw conflict("That username is already taken");

    const passwordHash = await hash(input.password, { algorithm: Algorithm.Argon2id });
    // 随机 4 位身份号 + 假邮箱：新用户一律 pending，等待管理员审核
    const discriminator = await nextDiscriminator(db);
    const email = `${username}@${FAKE_EMAIL_DOMAIN}`;

    const userId = await db.tx(async (tx) => {
      const [row] = await tx
        .insert(usersTable)
        .values({
          username,
          display_name: input.displayName?.trim() || username,
          email,
          email_domain: FAKE_EMAIL_DOMAIN,
          password_hash: passwordHash,
          discriminator,
          status: "pending",
        })
        .returning({ id: usersTable.id });
      return row.id;
    });

    return { userId };
  }

  async function login(identifier: string, password: string, ctx: { ip?: string; userAgent?: string }) {
    const user = await db.db
      .select()
      .from(usersTable)
      .where(eq(usersTable.username, normalizeUsername(identifier)))
      .get();
    if (!user) {
      await verify(DUMMY_HASH, randomBytes(16).toString("base64")).catch(() => false);
      throw invalidCredentials();
    }
    const valid = await verify(user.password_hash, password).catch(() => false);
    if (!valid) throw invalidCredentials();
    if (user.status === "banned") throw banned();
    if (user.status === "pending") throw forbidden("Your account is awaiting admin approval");
    if (user.status !== "active") throw forbidden("This account is not active");

    const { token, expiresAt } = await createSession(db, user.id, ctx, env.SESSION_TTL_MS);
    return { user: userService.toDTO(user), token, expiresAt: expiresAt.getTime() };
  }

  async function logout(token: string) {
    if (token) await deleteSession(db, token);
  }

  async function changePassword(userId: number, currentPassword: string, newPassword: string) {
    const user = await userService.getById(userId);
    if (!user) throw invalidCredentials();
    const valid = await verify(user.password_hash, currentPassword).catch(() => false);
    if (!valid) throw invalidCredentials("Current password is incorrect");
    const passwordHash = await hash(newPassword, { algorithm: Algorithm.Argon2id });
    await db.db
      .update(usersTable)
      .set({ password_hash: passwordHash, updated_at: new Date() })
      .where(eq(usersTable.id, userId));
    await deleteUserSessions(db, userId);
    return { ok: true };
  }

  return {
    register,
    login,
    logout,
    changePassword,
  };
}
