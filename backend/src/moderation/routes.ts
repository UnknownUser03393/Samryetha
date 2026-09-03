import { z } from "zod/v4";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import { requireActiveUser } from "../app/auth-hook.js";
import { eq } from "drizzle-orm";
import { users } from "../infrastructure/db/schema.js";

const createReportBody = z.object({
  reportableType: z.enum(["discussion", "reply", "user"]),
  reportableId: z.number().int().positive(),
  reason: z.string().min(1).max(2000),
});

const listReportsQuery = z.object({
  status: z.enum(["open", "in_progress", "resolved", "dismissed"]).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const reportIdParam = z.object({ id: z.coerce.number().int().positive() });

const resolveReportBody = z.object({
  status: z.enum(["open", "in_progress", "resolved", "dismissed"]),
  action: z.string().max(100).optional(),
  reason: z.string().max(1000).optional(),
});

const banUserBody = z.object({
  username: z.string().min(1).max(30),
  reason: z.string().max(1000).optional(),
  durationHours: z.number().int().positive().max(24 * 365).optional(),
});

const unbanUserBody = z.object({
  reason: z.string().max(1000).optional(),
});

const usernameParam = z.object({ username: z.string().min(1).max(30) });

const restoreBody = z.object({
  targetType: z.enum(["discussion", "reply"]),
  targetId: z.number().int().positive(),
  reason: z.string().max(1000).optional(),
});

const listActionsQuery = z.object({
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** 注册治理模块路由 + outbox 副作用（user.banned → 通知+邮件）。 */
export function registerModerationModule(app: FastifyInstance, container: Container): void {
  const { moderationService, db, events, mailer } = container;

  container.dispatcher.on("user.banned", async ({ payload }) => {
    const { userId, reason, bannedUntil } = payload as { userId: number; reason: string | null; bannedUntil: string | null };
    const user = await db.db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) return;
    const suffix = bannedUntil ? `（至 ${new Date(bannedUntil).toISOString()}）` : "";
    await mailer.send({
      to: user.email,
      subject: "Samryetha 账号封禁通知",
      text: `你的账号已被封禁${suffix}${reason ? `。原因：${reason}` : ""}`,
    });
    events.publish({ type: "user.banned", data: { userId } });
  });

  app.route({
    method: "POST",
    url: "/api/moderation/reports",
    schema: { body: createReportBody },
    handler: async (request: FastifyRequest<{ Body: z.infer<typeof createReportBody> }>) => {
      const session = requireActiveUser(request);
      return moderationService.createReport(session, request.body);
    },
  });

  app.route({
    method: "GET",
    url: "/api/moderation/reports",
    schema: { querystring: listReportsQuery },
    handler: async (request: FastifyRequest<{ Querystring: z.infer<typeof listReportsQuery> }>) => {
      const session = requireActiveUser(request);
      return moderationService.listReports(session, {
        status: request.query.status,
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
    },
  });

  app.route({
    method: "PATCH",
    url: "/api/moderation/reports/:id",
    schema: { params: reportIdParam, body: resolveReportBody },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof reportIdParam>; Body: z.infer<typeof resolveReportBody> }>) => {
      const session = requireActiveUser(request);
      return moderationService.resolveReport(session, request.params.id, request.body);
    },
  });

  app.route({
    method: "POST",
    url: "/api/moderation/bans",
    schema: { body: banUserBody },
    handler: async (request: FastifyRequest<{ Body: z.infer<typeof banUserBody> }>) => {
      const session = requireActiveUser(request);
      await moderationService.banUser(session, request.body);
      return { ok: true };
    },
  });

  app.route({
    method: "DELETE",
    url: "/api/moderation/bans/:username",
    schema: { params: usernameParam, body: unbanUserBody },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof usernameParam>; Body: z.infer<typeof unbanUserBody> }>) => {
      const session = requireActiveUser(request);
      await moderationService.unbanUser(session, { username: request.params.username, reason: request.body.reason });
      return { ok: true };
    },
  });

  app.route({
    method: "GET",
    url: "/api/moderation/actions",
    schema: { querystring: listActionsQuery },
    handler: async (request: FastifyRequest<{ Querystring: z.infer<typeof listActionsQuery> }>) => {
      const session = requireActiveUser(request);
      return moderationService.listActions(session, { cursor: request.query.cursor, limit: request.query.limit });
    },
  });

  app.route({
    method: "POST",
    url: "/api/moderation/restore",
    schema: { body: restoreBody },
    handler: async (request: FastifyRequest<{ Body: z.infer<typeof restoreBody> }>) => {
      const session = requireActiveUser(request);
      await moderationService.restoreContent(session, request.body);
      return { ok: true };
    },
  });
}
