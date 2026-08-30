import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DbProvider } from "../infrastructure/db/client.js";
import { getSessionUser, SESSION_COOKIE } from "../auth/session.js";
import type { UserRole, UserStatus } from "../infrastructure/db/schema.js";
import { authRequired, banned, emailNotVerified } from "./error.js";

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: UserRole;
  status: UserStatus;
}

declare module "fastify" {
  interface FastifyRequest {
    currentUser?: SessionUser | null;
  }
}

export function toSessionUser(row: {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
}): SessionUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    status: row.status,
  };
}

/** 全局 preHandler：有 session cookie 就解析出 currentUser（未登录则为 null）。 */
export function registerAuthHook(app: FastifyInstance, db: DbProvider): void {
  app.decorateRequest("currentUser", null);
  app.addHook("preHandler", async (request) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) return;
    const user = await getSessionUser(db, token);
    request.currentUser = user ? toSessionUser(user) : null;
  });
}

export function requireUser(request: FastifyRequest): SessionUser {
  const user = request.currentUser;
  if (!user) throw authRequired();
  return user;
}

export function requireActiveUser(request: FastifyRequest): SessionUser {
  const user = requireUser(request);
  if (user.status === "banned") throw banned();
  if (user.status !== "active") throw emailNotVerified();
  return user;
}
