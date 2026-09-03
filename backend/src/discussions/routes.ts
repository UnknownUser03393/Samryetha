import { z } from "zod/v4";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import { requireActiveUser } from "../app/auth-hook.js";

const feedQuery = z.object({
  feed: z.enum(["latest", "followed"]).default("latest"),
  board: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const discussionParam = z.object({ id: z.coerce.number().int().positive() });

const replyParam = z.object({ id: z.coerce.number().int().positive() });

const createDiscussionBody = z.object({
  boardSlug: z.string().min(1).max(50),
  title: z.string().min(3).max(100),
  bodyMarkdown: z.string().min(1).max(40000),
  attachmentIds: z.array(z.number().int().positive()).max(10).optional(),
});

const updateDiscussionBody = z
  .object({
    title: z.string().min(3).max(100).optional(),
    bodyMarkdown: z.string().min(1).max(40000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

const deleteDiscussionBody = z.object({ reason: z.string().max(500).optional() });

const createReplyBody = z.object({
  bodyMarkdown: z.string().min(1).max(5000),
  parentReplyId: z.number().int().positive().nullable().optional(),
});

const updateReplyBody = z.object({ bodyMarkdown: z.string().min(1).max(5000) });

export function registerDiscussionRoutes(app: FastifyInstance, container: Container): void {
  const { discussionService } = container;

  app.route({
    method: "GET",
    url: "/api/discussions",
    schema: { querystring: feedQuery },
    handler: async (request: FastifyRequest<{ Querystring: z.infer<typeof feedQuery> }>) => {
      return discussionService.listDiscussions(request.currentUser ?? null, {
        feed: request.query.feed,
        boardSlug: request.query.board,
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
    },
  });

  app.route({
    method: "POST",
    url: "/api/discussions",
    schema: { body: createDiscussionBody },
    handler: async (request: FastifyRequest<{ Body: z.infer<typeof createDiscussionBody> }>, reply) => {
      const session = requireActiveUser(request);
      const discussion = await discussionService.createDiscussion(session, request.body);
      return reply.code(201).send(discussion);
    },
  });

  app.route({
    method: "GET",
    url: "/api/discussions/:id",
    schema: { params: discussionParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof discussionParam> }>) => {
      return discussionService.getDiscussion(request.currentUser ?? null, request.params.id);
    },
  });

  app.route({
    method: "PATCH",
    url: "/api/discussions/:id",
    schema: { params: discussionParam, body: updateDiscussionBody },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof discussionParam>; Body: z.infer<typeof updateDiscussionBody> }>) => {
      const session = requireActiveUser(request);
      return discussionService.updateDiscussion(session, request.params.id, request.body);
    },
  });

  app.route({
    method: "DELETE",
    url: "/api/discussions/:id",
    schema: { params: discussionParam, body: deleteDiscussionBody },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof discussionParam>; Body: z.infer<typeof deleteDiscussionBody> }>) => {
      const session = requireActiveUser(request);
      await discussionService.deleteDiscussion(session, request.params.id, request.body.reason);
      return { ok: true };
    },
  });

  app.route({
    method: "POST",
    url: "/api/discussions/:id/replies",
    schema: { params: discussionParam, body: createReplyBody },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof discussionParam>; Body: z.infer<typeof createReplyBody> }>, reply) => {
      const session = requireActiveUser(request);
      const item = await discussionService.createReply(session, request.params.id, request.body);
      return reply.code(201).send(item);
    },
  });

  app.route({
    method: "GET",
    url: "/api/discussions/:id/replies",
    schema: { params: discussionParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof discussionParam> }>) => {
      return discussionService.listReplies(request.currentUser ?? null, request.params.id);
    },
  });

  app.route({
    method: "PATCH",
    url: "/api/replies/:id",
    schema: { params: replyParam, body: updateReplyBody },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof replyParam>; Body: z.infer<typeof updateReplyBody> }>) => {
      const session = requireActiveUser(request);
      return discussionService.updateReply(session, request.params.id, request.body.bodyMarkdown);
    },
  });

  app.route({
    method: "DELETE",
    url: "/api/replies/:id",
    schema: { params: replyParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof replyParam> }>) => {
      const session = requireActiveUser(request);
      await discussionService.deleteReply(session, request.params.id);
      return { ok: true };
    },
  });

  app.route({
    method: "POST",
    url: "/api/discussions/:id/save",
    schema: { params: discussionParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof discussionParam> }>) => {
      const session = requireActiveUser(request);
      await discussionService.save(session, request.params.id);
      return { saved: true };
    },
  });

  app.route({
    method: "DELETE",
    url: "/api/discussions/:id/save",
    schema: { params: discussionParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof discussionParam> }>) => {
      const session = requireActiveUser(request);
      await discussionService.unsave(session, request.params.id);
      return { saved: false };
    },
  });

  app.route({
    method: "POST",
    url: "/api/discussions/:id/follow",
    schema: { params: discussionParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof discussionParam> }>) => {
      const session = requireActiveUser(request);
      await discussionService.follow(session, request.params.id);
      return { following: true };
    },
  });

  app.route({
    method: "DELETE",
    url: "/api/discussions/:id/follow",
    schema: { params: discussionParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof discussionParam> }>) => {
      const session = requireActiveUser(request);
      await discussionService.unfollow(session, request.params.id);
      return { following: false };
    },
  });

  app.route({
    method: "POST",
    url: "/api/discussions/:id/pin",
    schema: { params: discussionParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof discussionParam> }>) => {
      const session = requireActiveUser(request);
      await discussionService.pin(session, request.params.id);
      return { pinned: true };
    },
  });

  app.route({
    method: "POST",
    url: "/api/discussions/:id/lock",
    schema: { params: discussionParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof discussionParam> }>) => {
      const session = requireActiveUser(request);
      await discussionService.lock(session, request.params.id);
      return { locked: true };
    },
  });
}
