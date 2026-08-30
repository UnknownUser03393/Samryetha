import { z } from "zod/v4";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import { requireUser } from "../app/auth-hook.js";
import { SESSION_COOKIE } from "./session.js";
import { passwordResetEmail, verificationEmail } from "../infrastructure/email/templates.js";

const registerBody = z.object({
  email: z.string().trim().email(),
  username: z.string().trim().min(3).max(30).regex(/^[a-z0-9_]+$/i, "Only letters, numbers, underscore"),
  displayName: z.string().trim().min(1).max(50),
  password: z.string().min(8).max(200),
});

const emailOnly = z.object({ email: z.string().trim().email() });

const verifyBody = z.object({ email: z.string().trim().email(), code: z.string().trim().regex(/^\d{6}$/) });

const loginBody = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const resetBody = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(8).max(200),
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

/** 注册 auth 路由 + outbox 邮件 handler。 */
export function registerAuthModule(app: FastifyInstance, container: Container): void {
  const { auth } = container;

  // --- outbox side effects ---
  container.dispatcher.on("user.registered", async ({ payload }) => {
    const { email, displayName, code } = payload as { email: string; displayName: string; code: string };
    const mail = verificationEmail({ code, displayName });
    await container.mailer.send({ to: email, ...mail });
  });
  container.dispatcher.on("user.password_reset_requested", async ({ payload }) => {
    const { email, displayName, link } = payload as { email: string; displayName: string; link: string };
    const mail = passwordResetEmail({ link, displayName });
    await container.mailer.send({ to: email, ...mail });
  });

  // --- routes ---
  app.route({
    method: "POST",
    url: "/api/auth/register",
    schema: { body: registerBody },
    handler: async (request: BodyRequest<typeof registerBody>, reply) => {
      const { userId } = await auth.register(request.body);
      return reply.code(201).send({ userId, message: "verification_sent" });
    },
  });

  app.route({
    method: "POST",
    url: "/api/auth/verify-email",
    schema: { body: verifyBody },
    handler: async (request: BodyRequest<typeof verifyBody>, reply) => {
      const result = await auth.verifyEmail(request.body.email, request.body.code);
      reply.setCookie(SESSION_COOKIE, result.token, cookieOptions(container));
      return reply.send({ ok: true, user: result.user });
    },
  });

  app.route({
    method: "POST",
    url: "/api/auth/resend-verification",
    schema: { body: emailOnly },
    handler: async (request: BodyRequest<typeof emailOnly>) => {
      await auth.resendVerification(request.body.email);
      return { ok: true };
    },
  });

  app.route({
    method: "POST",
    url: "/api/auth/login",
    schema: { body: loginBody },
    handler: async (request: BodyRequest<typeof loginBody>, reply) => {
      const result = await auth.login(request.body.email, request.body.password, {
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
    url: "/api/auth/forgot-password",
    schema: { body: emailOnly },
    handler: async (request: BodyRequest<typeof emailOnly>) => {
      await auth.forgotPassword(request.body.email);
      return { ok: true };
    },
  });

  app.route({
    method: "POST",
    url: "/api/auth/reset-password",
    schema: { body: resetBody },
    handler: async (request: BodyRequest<typeof resetBody>) => {
      await auth.resetPassword(request.body.token, request.body.newPassword);
      return { ok: true };
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
