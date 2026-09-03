import { z } from "zod/v4";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import { requireActiveUser } from "../app/auth-hook.js";

const usernameParam = z.object({ username: z.string().min(1).max(30) });

export function registerFollowRoutes(app: FastifyInstance, container: Container): void {
  const { followService, userService } = container;

  app.route({
    method: "POST",
    url: "/api/users/:username/follow",
    schema: { params: usernameParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof usernameParam> }>) => {
      const session = requireActiveUser(request);
      const target = await userService.getByUsername(request.params.username);
      if (!target) throw new Error("User not found");
      await followService.followUser(session, target.id);
      return { following: true };
    },
  });

  app.route({
    method: "DELETE",
    url: "/api/users/:username/follow",
    schema: { params: usernameParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof usernameParam> }>) => {
      const session = requireActiveUser(request);
      const target = await userService.getByUsername(request.params.username);
      if (!target) throw new Error("User not found");
      await followService.unfollowUser(session, target.id);
      return { following: false };
    },
  });
}
