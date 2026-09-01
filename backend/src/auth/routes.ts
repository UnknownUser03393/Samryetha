import { z } from "zod/v4";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import { requireUser } from "../app/auth-hook.js";
import { SESSION_COOKIE } from "./session.js";

const registerBody = z.object({
  username: z.string().trim().min(3).max(30).regex(/^[a-z0-9_]+$/i, "Only letters, numbers, underscore"),
  password: z.string().min(8).max(200),
});

const loginBody = z.object({
  username: z.string().trim().min(1).max(30),
  password: z.string().min(1),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

type BodyRequest<S extends z.ZodTypeAny> = FastifyRequest<{ Body: z.infer<S> }>;

function cookieOptions(container: Container) {
  const { env } = container;
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: env.COOKIE_SECURE,
    maxAge: Math.floor(env.SESSION_TTL_MS / 1000),
  };
}

/** 注册 auth 路由。内测期：无邮箱，注册即提交申请（pending），管理员审核通过后登录。 */
export function registerAuthModule(app: FastifyInstance, container: Container): void {
  const { auth } = container;

  // 登录/注册限流：生产/开发收紧（防暴力破解/批量注册），测试环境放宽以免拖慢测试套件
  // Auth rate limit: strict in prod/dev (anti brute-force / mass-registration), relaxed in tests to avoid slowing the suite
  const authRateLimit = container.env.NODE_ENV === "test"
    ? { max: 1_000_000, timeWindow: "1 minute" }
    : { max: 10, timeWindow: "1 minute" };

  app.route({
    method: "POST",
    url: "/api/auth/register",
    schema: { body: registerBody },
    config: { rateLimit: authRateLimit },
    handler: async (request: BodyRequest<typeof registerBody>, reply) => {
      const { userId } = await auth.register(request.body);
      return reply.code(201).send({ userId, message: "pending" });
    },
  });

  app.route({
    method: "POST",
    url: "/api/auth/login",
    schema: { body: loginBody },
    config: { rateLimit: authRateLimit },
    handler: async (request: BodyRequest<typeof loginBody>, reply) => {
      const result = await auth.login(request.body.username, request.body.password, {
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
      reply.setCookie(SESSION_COOKIE, result.token, cookieOptions(container));
      return reply.send({ user: result.user, sessionExpiresAt: result.expiresAt });
    },
  });

  app.route({
    method: "POST",
    url: "/api/auth/logout",
    handler: async (request, reply) => {
      const token = request.cookies?.[SESSION_COOKIE];
      if (token) await auth.logout(token);
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(204).send();
    },
  });

  app.route({
    method: "GET",
    url: "/api/auth/me",
    handler: async (request) => {
      const session = requireUser(request);
      const user = await container.userService.getById(session.id);
      if (!user) throw new Error("Session user vanished");
      return { user: container.userService.toDTO(user) };
    },
  });

  app.route({
    method: "POST",
    url: "/api/auth/change-password",
    schema: { body: changePasswordBody },
    handler: async (request: BodyRequest<typeof changePasswordBody>) => {
      const session = requireUser(request);
      await auth.changePassword(session.id, request.body.currentPassword, request.body.newPassword);
      return { ok: true };
    },
  });
}
