import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import { requireUser } from "../app/auth-hook.js";
import { discussionFollows, discussions, users } from "../infrastructure/db/schema.js";

const listQuery = z.object({
  unreadOnly: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const notificationIdParam = z.object({ id: z.coerce.number().int().positive() });

/** 注册通知路由 + outbox 副作用 handler。 */
export function registerNotificationModule(app: FastifyInstance, container: Container): void {
  const { notificationService, db } = container;

  // --- outbox side effects ---
  container.dispatcher.on("reply.created", async ({ payload }) => {
    const { discussionId, replyId, authorId, title } = payload as {
      discussionId: number;
      replyId: number;
      authorId: number;
      title: string;
    };
    const discussion = await db.db.select().from(discussions).where(eq(discussions.id, discussionId)).get();
    if (!discussion) return;
    const replyAuthor = await db.db.select().from(users).where(eq(users.id, authorId)).get();
    const actorName = replyAuthor?.display_name ?? "Someone";
    const followRows = await db.db.select().from(discussionFollows).where(eq(discussionFollows.discussion_id, discussionId));
    const recipients = new Set<number>([discussion.author_id, ...followRows.map((r) => r.user_id)]);
    recipients.delete(authorId);
    const body = `${actorName} 回复了「${title}」`;
    for (const userId of recipients) {
      await notificationService.create({ userId, actorUserId: authorId, type: "reply", discussionId, replyId, body });
      container.events.publish({ type: "notification.created", data: { userId } });
    }
  });

  container.dispatcher.on("user.followed", async ({ payload }) => {
    const { followerId, followeeId } = payload as { followerId: number; followeeId: number };
    if (followerId === followeeId) return;
    const follower = await db.db.select().from(users).where(eq(users.id, followerId)).get();
    if (!follower) return;
    await notificationService.create({
      userId: followeeId,
      actorUserId: followerId,
      type: "follow",
      body: `${follower.display_name} 关注了你`,
    });
    container.events.publish({ type: "notification.created", data: { userId: followeeId } });
  });

  // --- routes ---
  app.route({
    method: "GET",
    url: "/api/notifications",
    schema: { querystring: listQuery },
    handler: async (request: FastifyRequest<{ Querystring: z.infer<typeof listQuery> }>) => {
      const session = requireUser(request);
      return notificationService.list(session.id, {
        unreadOnly: request.query.unreadOnly,
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
    },
  });

  app.route({
    method: "GET",
    url: "/api/notifications/unread-count",
    handler: async (request) => {
      const session = requireUser(request);
      return { unreadCount: await notificationService.unreadCount(session.id) };
    },
  });

  app.route({
    method: "POST",
    url: "/api/notifications/:id/read",
    schema: { params: notificationIdParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof notificationIdParam> }>) => {
      const session = requireUser(request);
      await notificationService.markRead(session.id, request.params.id);
      return { ok: true };
    },
  });

  app.route({
    method: "POST",
    url: "/api/notifications/read-all",
    handler: async (request) => {
      const session = requireUser(request);
      await notificationService.markAllRead(session.id);
      return { ok: true };
    },
  });
}
