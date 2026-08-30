import { Algorithm, hash, verify } from "@node-rs/argon2";
import { randomBytes, randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbProvider } from "../infrastructure/db/client.js";
import { emitEvent } from "../infrastructure/db/client.js";
import {
  emailVerificationTokens as emailTokensTable,
  passwordResetTokens as resetTokensTable,
  sessions as sessionsTable,
  users as usersTable,
} from "../infrastructure/db/schema.js";
import type { Env } from "../config/env.js";
import {
  AppError,
  ErrorCodes,
  banned,
  conflict,
  emailNotVerified,
  invalidCredentials,
  tokenInvalid,
} from "../app/error.js";
import { assertEmailDomainAllowed, emailDomain } from "../schools/service.js";
import { normalizeUsername, type UserDTO, type UserService } from "../users/service.js";
import { createSession, deleteSession, deleteUserSessions, hashToken } from "./session.js";

/** 合法 argon2id 占位哈希：登录时对不存在的账号也走一次 verify，缓解枚举时序。 */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$zKvRrWt4CvwTThbIAqLc7w$ScmWWJ4FP6+h0VnrJ1fRevG+euV30+s0IOS0lUnA3tQ";

const EMAIL_CODE_TTL_MS = 15 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export interface RegisterInput {
  email: string;
  username: string;
  displayName: string;
  password: string;
}

export interface AuthService {
  register(input: RegisterInput): Promise<{ userId: number }>;
  verifyEmail(email: string, code: string): Promise<{ user: UserDTO; token: string; expiresAt: number }>;
  resendVerification(email: string): Promise<{ ok: boolean }>;
  login(
    email: string,
    password: string,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<{ user: UserDTO; token: string; expiresAt: number }>;
  logout(token: string): Promise<void>;
  forgotPassword(email: string): Promise<{ ok: boolean }>;
  resetPassword(token: string, newPassword: string): Promise<{ ok: boolean }>;
  changePassword(userId: number, currentPassword: string, newPassword: string): Promise<{ ok: boolean }>;
}

export function createAuthService(
  db: DbProvider,
  userService: UserService,
  env: Env,
): AuthService {
  const userByEmail = (email: string) =>
    db.db.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase())).get();

  async function register(input: RegisterInput) {
    assertEmailDomainAllowed(env, input.email);
    const email = input.email.trim().toLowerCase();
    const username = normalizeUsername(input.username);
    const displayName = input.displayName.trim();

    const [existingEmail, existingUsername] = await Promise.all([
      db.db.select().from(usersTable).where(eq(usersTable.email, email)).get(),
      db.db.select().from(usersTable).where(eq(usersTable.username, username)).get(),
    ]);
    if (existingEmail) throw conflict("An account with this email already exists");
    if (existingUsername) throw conflict("That username is already taken");

    const passwordHash = await hash(input.password, { algorithm: Algorithm.Argon2id });
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");

    const userId = await db.tx(async (tx) => {
      const [row] = await tx
        .insert(usersTable)
        .values({
          email,
          username,
          display_name: displayName,
          password_hash: passwordHash,
          email_domain: emailDomain(email),
        })
        .returning({ id: usersTable.id });
      await tx.insert(emailTokensTable).values({
        user_id: row.id,
        token_hash: hashToken(code),
        expires_at: new Date(Date.now() + EMAIL_CODE_TTL_MS),
      });
      await emitEvent({
        type: "user.registered",
        aggregate: { type: "user", id: String(row.id) },
        payload: { email, displayName, code },
      });
      return row.id;
    });

    return { userId };
  }

  async function verifyEmail(email: string, code: string) {
    const user = await userByEmail(email);
    if (!user) throw tokenInvalid();
    if (user.email_verified_at) {
      throw new AppError(ErrorCodes.EMAIL_ALREADY_VERIFIED, "Email already verified", 409);
    }
    const tokenRow = await db.db
      .select()
      .from(emailTokensTable)
      .where(eq(emailTokensTable.user_id, user.id))
      .get();
    if (!tokenRow || tokenRow.expires_at < new Date()) throw tokenInvalid();
    if (tokenRow.token_hash !== hashToken(code.trim())) throw tokenInvalid();

    await db.tx(async (tx) => {
      await tx
        .update(usersTable)
        .set({ status: "active", email_verified_at: new Date(), updated_at: new Date() })
        .where(eq(usersTable.id, user.id));
      await tx.delete(emailTokensTable).where(eq(emailTokensTable.user_id, user.id));
      await emitEvent({
        type: "user.email_verified",
        aggregate: { type: "user", id: String(user.id) },
        payload: { userId: user.id, email: user.email },
      });
    });

    const { token, expiresAt } = await createSession(db, user.id, {});
    const fresh = await userService.getById(user.id);
    return { user: userService.toDTO(fresh ?? user), token, expiresAt: expiresAt.getTime() };
  }

  async function resendVerification(email: string) {
    const user = await userByEmail(email);
    if (!user || user.email_verified_at) return { ok: true };
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await db.tx(async (tx) => {
      await tx.delete(emailTokensTable).where(eq(emailTokensTable.user_id, user.id));
      await tx.insert(emailTokensTable).values({
        user_id: user.id,
        token_hash: hashToken(code),
        expires_at: new Date(Date.now() + EMAIL_CODE_TTL_MS),
      });
      await emitEvent({
        type: "user.registered",
        aggregate: { type: "user", id: String(user.id) },
        payload: { email: user.email, displayName: user.display_name, code },
      });
    });
    return { ok: true };
  }

  async function login(email: string, password: string, ctx: { ip?: string; userAgent?: string }) {
    const user = await userByEmail(email);
    if (!user) {
      await verify(DUMMY_HASH, randomBytes(16).toString("base64")).catch(() => false);
      throw invalidCredentials();
    }
    const valid = await verify(user.password_hash, password).catch(() => false);
    if (!valid) throw invalidCredentials();
    if (user.status === "banned") throw banned();
    if (user.status !== "active" || !user.email_verified_at) throw emailNotVerified();

    const { token, expiresAt } = await createSession(db, user.id, ctx, env.SESSION_TTL_MS);
    return { user: userService.toDTO(user), token, expiresAt: expiresAt.getTime() };
  }

  async function logout(token: string) {
    if (token) await deleteSession(db, token);
  }

  async function forgotPassword(email: string) {
    const user = await userByEmail(email);
    if (!user) return { ok: true }; // 恒返回 ok，防枚举
    const resetToken = randomBytes(32).toString("base64url");
    await db.tx(async (tx) => {
      await tx.delete(resetTokensTable).where(eq(resetTokensTable.user_id, user.id));
      await tx.insert(resetTokensTable).values({
        user_id: user.id,
        token_hash: hashToken(resetToken),
        expires_at: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      });
      await emitEvent({
        type: "user.password_reset_requested",
        aggregate: { type: "user", id: String(user.id) },
        payload: {
          email: user.email,
          displayName: user.display_name,
          link: `${env.APP_ORIGIN}/reset?token=${resetToken}`,
        },
      });
    });
    return { ok: true };
  }

  async function resetPassword(token: string, newPassword: string) {
    const row = await db.db
      .select()
      .from(resetTokensTable)
      .where(eq(resetTokensTable.token_hash, hashToken(token)))
      .get();
    if (!row || row.expires_at < new Date() || row.used_at) throw tokenInvalid();

    const passwordHash = await hash(newPassword, { algorithm: Algorithm.Argon2id });
    await db.tx(async (tx) => {
      await tx
        .update(usersTable)
        .set({ password_hash: passwordHash, updated_at: new Date() })
        .where(eq(usersTable.id, row.user_id));
      await tx.update(resetTokensTable).set({ used_at: new Date() }).where(eq(resetTokensTable.id, row.id));
      await tx.delete(sessionsTable).where(eq(sessionsTable.user_id, row.user_id));
    });
    return { ok: true };
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
    verifyEmail,
    resendVerification,
    login,
    logout,
    forgotPassword,
    resetPassword,
    changePassword,
  };
}
