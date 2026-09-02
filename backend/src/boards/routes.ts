import { z } from "zod/v4";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import { requireActiveUser } from "../app/auth-hook.js";
import { Abilities, assertCan } from "../authz/can.js";
import type { BoardService } from "./service.js";

const slugParam = z.object({ slug: z.string().min(1).max(50) });

const boardBody = z.object({
  name: z.string().min(1).max(60),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, "lowercase letters, numbers, dashes"),
  description: z.string().max(500).optional(),
  visibility: z.enum(["public", "members", "private"]).optional(),
  postingPolicy: z.enum(["everyone", "members", "moderators"]).optional(),
});

const boardPatch = z.object({
  name: z.string().min(1).max(60).optional(),
  description: z.string().max(500).optional(),
  visibility: z.enum(["public", "members", "private"]).optional(),
  postingPolicy: z.enum(["everyone", "members", "moderators"]).optional(),
});

const deleteBoardBody = z.object({ reason: z.string().max(500).optional() });

const memberRoleBody = z.object({ role: z.enum(["member", "moderator"]) });

const memberParam = z.object({ slug: z.string().min(1), userId: z.coerce.number().int().positive() });

const feedQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function registerBoardRoutes(app: FastifyInstance, container: Container): void {
  const { boardService, discussionService } = container;

  app.route({
    method: "GET",
    url: "/api/boards",
    handler: async (request) => {
      return { items: await boardService.listBoards(request.currentUser?.id ?? null) };
    },
  });

  app.route({
    method: "GET",
    url: "/api/boards/:slug",
    schema: { params: slugParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof slugParam> }>) => {
      return boardService.getBoard(request.currentUser?.id ?? null, request.params.slug);
    },
  });

  app.route({
    method: "POST",
    url: "/api/boards",
    schema: { body: boardBody },
    handler: async (request: FastifyRequest<{ Body: z.infer<typeof boardBody> }>, reply) => {
      const session = requireActiveUser(request);
      await assertCan(session, Abilities.boardCreate, null, container);
      const board = await boardService.createBoard(session.id, request.body);
      return reply.code(201).send(board);
    },
  });

  app.route({
    method: "PATCH",
    url: "/api/boards/:slug",
    schema: { params: slugParam, body: boardPatch },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof slugParam>; Body: z.infer<typeof boardPatch> }>) => {
      const session = requireActiveUser(request);
      const board = await boardService.getBoardForAuthz(request.params.slug);
      if (!board) throw new Error("Board not found");
      await assertCan(session, Abilities.boardUpdate, { type: "board", ...board }, container);
      return boardService.updateBoard(session.id, request.params.slug, request.body);
    },
  });

  app.route({
    method: "DELETE",
    url: "/api/boards/:slug",
    schema: { params: slugParam, body: deleteBoardBody },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof slugParam>; Body: z.infer<typeof deleteBoardBody> }>) => {
      const session = requireActiveUser(request);
      const board = await boardService.getBoardForAuthz(request.params.slug);
      if (!board) throw new Error("Board not found");
      await assertCan(session, Abilities.boardDelete, { type: "board", ...board }, container);
      await boardService.deleteBoard(session.id, request.params.slug, request.body.reason);
      return { ok: true };
    },
  });

  app.route({
    method: "GET",
    url: "/api/boards/:slug/discussions",
    schema: { params: slugParam, querystring: feedQuery },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof slugParam>; Querystring: z.infer<typeof feedQuery> }>) => {
      return discussionService.listDiscussions(request.currentUser ?? null, {
        feed: "board",
        boardSlug: request.params.slug,
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
    },
  });

  app.route({
    method: "POST",
    url: "/api/boards/:slug/join",
    schema: { params: slugParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof slugParam> }>) => {
      const session = requireActiveUser(request);
      const board = await boardService.getBoardForAuthz(request.params.slug);
      if (!board) throw new Error("Board not found");
      await assertCan(session, Abilities.boardJoin, { type: "board", ...board }, container);
      await boardService.joinBoard(session.id, request.params.slug);
      return { member: true };
    },
  });

  app.route({
    method: "DELETE",
    url: "/api/boards/:slug/leave",
    schema: { params: slugParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof slugParam> }>) => {
      const session = requireActiveUser(request);
      await boardService.leaveBoard(session.id, request.params.slug);
      return { member: false };
    },
  });

  app.route({
    method: "GET",
    url: "/api/boards/:slug/members",
    schema: { params: slugParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof slugParam> }>) => {
      return { items: await boardService.listMembers(request.params.slug) };
    },
  });

  app.route({
    method: "PATCH",
    url: "/api/boards/:slug/members/:userId",
    schema: { params: memberParam, body: memberRoleBody },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof memberParam>; Body: z.infer<typeof memberRoleBody> }>) => {
      const session = requireActiveUser(request);
      const board = await boardService.getBoardForAuthz(request.params.slug);
      if (!board) throw new Error("Board not found");
      await assertCan(session, Abilities.boardManageMembers, { type: "board", ...board }, container);
      await boardService.updateMemberRole(session.id, request.params.slug, request.params.userId, request.body.role);
      return { ok: true };
    },
  });
}
