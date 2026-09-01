import { z } from "zod/v4";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import { requireActiveUser } from "../app/auth-hook.js";

const listUsersQuery = z.object({
  q: z.string().max(100).optional(),
  status: z.enum(["pending", "active", "banned", "deactivated"]).optional(),
  role: z.enum(["student", "moderator", "admin"]).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const userIdParam = z.object({ id: z.coerce.number().int().positive() });

const changeRoleBody = z.object({
  role: z.enum(["student", "moderator", "admin"]),
  reason: z.string().max(1000).optional(),
});

const changeStatusBody = z.object({
  status: z.enum(["active", "deactivated"]),
  reason: z.string().max(1000).optional(),
});

const listDeletedQuery = z.object({
  discussionCursor: z.coerce.number().int().positive().optional(),
  replyCursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** 注册管理后台路由：全站统计 / 用户管理 / 删除内容清单。鉴权在 service 层。 */
export function registerAdminModule(app: FastifyInstance, container: Container): void {
  const { adminService } = container;

  app.route({
    method: "GET",
    url: "/api/admin/stats",
    handler: async (request: FastifyRequest) => {
      const session = requireActiveUser(request);
      return adminService.stats(session);
    },
  });

  app.route({
    method: "GET",
    url: "/api/admin/users",
    schema: { querystring: listUsersQuery },
    handler: async (request: FastifyRequest<{ Querystring: z.infer<typeof listUsersQuery> }>) => {
      const session = requireActiveUser(request);
      return adminService.listUsers(session, {
        q: request.query.q,
        status: request.query.status,
        role: request.query.role,
        cursor: request.query.cursor,
        limit: request.query.limit,
      });
    },
  });

  app.route({
    method: "DELETE",
    url: "/api/admin/users/:id",
    schema: { params: userIdParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof userIdParam> }>) => {
      const session = requireActiveUser(request);
      await adminService.deleteUser(session, request.params.id);
      return { ok: true };
    },
  });

  app.route({
    method: "PATCH",
    url: "/api/admin/users/:id/role",
    schema: { params: userIdParam, body: changeRoleBody },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof userIdParam>; Body: z.infer<typeof changeRoleBody> }>) => {
      const session = requireActiveUser(request);
      return adminService.changeRole(session, request.params.id, request.body);
    },
  });

  app.route({
    method: "PATCH",
    url: "/api/admin/users/:id/status",
    schema: { params: userIdParam, body: changeStatusBody },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof userIdParam>; Body: z.infer<typeof changeStatusBody> }>) => {
      const session = requireActiveUser(request);
      return adminService.changeStatus(session, request.params.id, request.body);
    },
  });

  app.route({
    method: "POST",
    url: "/api/admin/users/:id/verify",
    schema: { params: userIdParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof userIdParam> }>) => {
      const session = requireActiveUser(request);
      return adminService.verifyUser(session, request.params.id);
    },
  });

  app.route({
    method: "GET",
    url: "/api/admin/moderation/deleted",
    schema: { querystring: listDeletedQuery },
    handler: async (request: FastifyRequest<{ Querystring: z.infer<typeof listDeletedQuery> }>) => {
      const session = requireActiveUser(request);
      return adminService.listDeletedContent(session, {
        discussionCursor: request.query.discussionCursor,
        replyCursor: request.query.replyCursor,
        limit: request.query.limit,
      });
    },
  });
}
