import { z } from "zod/v4";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import { requireActiveUser } from "../app/auth-hook.js";
import { notFound } from "../app/error.js";

const usernameParam = z.object({ username: z.string().min(1).max(30) });

const feedQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const profileBody = z
  .object({
    displayName: z.string().trim().min(1).max(50).optional(),
    username: z.string().trim().min(3).max(30).regex(/^[a-z0-9_]+$/i).optional(),
    bio: z.string().max(500).optional(),
    avatarObjectKey: z.string().nullable().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "No fields to update");

export function registerUserRoutes(app: FastifyInstance, container: Container): void {
  const { userService, discussionService } = container;

  app.route({
    method: "GET",
    url: "/api/users/:username",
    schema: { params: usernameParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof usernameParam> }>) => {
      const viewerId = request.currentUser?.id ?? null;
      return userService.getPublicProfile(viewerId, request.params.username);
    },
  });

  // 用户主页三 feed：帖子 / 回复 / 收藏（收藏仅本人）
  const userFeedHandlers = (kind: "posts" | "replies" | "saved") =>
    async (request: FastifyRequest<{ Params: z.infer<typeof usernameParam>; Querystring: z.infer<typeof feedQuery> }>) => {
      const user = await userService.getByUsername(request.params.username);
      if (!user) throw notFound("User not found");
      const viewer = request.currentUser ?? null;
      const opts = { cursor: request.query.cursor, limit: request.query.limit };
      if (kind === "posts") return discussionService.listByAuthor(viewer, user.id, opts);
      if (kind === "replies") return discussionService.listRepliesByAuthor(viewer, user.id, opts);
      return discussionService.listSaved(viewer, user.id, opts);
    };

  app.route({ method: "GET", url: "/api/users/:username/posts", schema: { params: usernameParam, querystring: feedQuery }, handler: userFeedHandlers("posts") });
  app.route({ method: "GET", url: "/api/users/:username/replies", schema: { params: usernameParam, querystring: feedQuery }, handler: userFeedHandlers("replies") });
  app.route({ method: "GET", url: "/api/users/:username/saved", schema: { params: usernameParam, querystring: feedQuery }, handler: userFeedHandlers("saved") });

  app.route({
    method: "PATCH",
    url: "/api/me/profile",
    schema: { body: profileBody },
    handler: async (request: FastifyRequest<{ Body: z.infer<typeof profileBody> }>) => {
      const session = requireActiveUser(request);
      const user = await userService.updateProfile(session.id, request.body);
      return { user };
    },
  });
}
