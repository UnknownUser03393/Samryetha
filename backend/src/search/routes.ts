import { z } from "zod/v4";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";

const searchQuery = z.object({
  q: z.string().min(1).max(100),
  board: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function registerSearchRoutes(app: FastifyInstance, container: Container): void {
  app.route({
    method: "GET",
    url: "/api/search",
    schema: { querystring: searchQuery },
    handler: async (request: FastifyRequest<{ Querystring: z.infer<typeof searchQuery> }>) => {
      return container.searchService.searchDiscussions(request.currentUser ?? null, {
        q: request.query.q,
        boardSlug: request.query.board,
        limit: request.query.limit,
      });
    },
  });
}
