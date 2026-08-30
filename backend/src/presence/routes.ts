import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Container } from "../app/container.js";
import { requireActiveUser } from "../app/auth-hook.js";
import { users } from "../infrastructure/db/schema.js";

const HEARTBEAT_TTL_MS = 60_000;

export function registerPresenceRoutes(app: FastifyInstance, container: Container): void {
  const { presence, db } = container;

  // 客户端每 45s 上报一次，TTL 60s
  app.route({
    method: "POST",
    url: "/api/presence/heartbeat",
    handler: async (request) => {
      const session = requireActiveUser(request);
      await presence.heartbeat(session.id, HEARTBEAT_TTL_MS);
      return { onlineCount: await presence.onlineCount() };
    },
  });

  app.route({
    method: "GET",
    url: "/api/presence",
    handler: async () => {
      const userIds = await presence.onlineUserIds();
      const rows = userIds.length
        ? await db.db.select({ id: users.id, username: users.username, display_name: users.display_name }).from(users).where(inArray(users.id, userIds))
        : [];
      return {
        onlineCount: rows.length,
        onlineUsers: rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name })),
      };
    },
  });
}
