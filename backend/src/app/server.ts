import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { fastifySSE } from "@fastify/sse";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { sql } from "drizzle-orm";
import { ZodError } from "zod";
import type { Container } from "./container.js";
import { buildContainer } from "./container.js";
import { AppError, ErrorCodes } from "./error.js";
import { loadEnv } from "../config/env.js";
import { registerAuthHook } from "./auth-hook.js";
import { registerAuthModule } from "../auth/routes.js";
import { registerUserRoutes } from "../users/routes.js";
import { registerBoardRoutes } from "../boards/routes.js";
import { registerDiscussionRoutes } from "../discussions/routes.js";
import { registerAttachmentRoutes } from "../attachments/routes.js";
import { registerFollowRoutes } from "../follows/routes.js";
import { registerNotificationModule } from "../notifications/routes.js";
import { registerSearchRoutes } from "../search/routes.js";
import { registerPresenceRoutes } from "../presence/routes.js";
import { registerRealtimeRoutes } from "../realtime/routes.js";
import { registerModerationModule } from "../moderation/routes.js";
import { registerAdminModule } from "../admin/routes.js";

export async function buildApp(container: Container): Promise<FastifyInstance> {
  const { env } = container;

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug",
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss" } }
          : undefined,
    },
    genReqId: () => `req_${randomUUID().slice(0, 8)}`,
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  // zod 校验/序列化编译器（fastify-type-provider-zod v7）
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // CORS —— 只信任自己的前端来源
  await app.register(cors, {
    origin: env.APP_ORIGIN,
    credentials: true,
  });

  await app.register(cookie);

  // 全局基础限频；敏感端点单独收紧
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  await app.register(swagger, {
    transform: jsonSchemaTransform,
    openapi: {
      info: { title: "Samryetha API", version: "0.1.0" },
      servers: [{ url: `http://localhost:${env.PORT}` }],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  await app.register(fastifySSE);

  // CSRF：对非安全方法，若带 Origin 必须同源（SameSite=Lax 兜底）
  app.addHook("onRequest", async (request) => {
    const method = request.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    const origin = request.headers.origin;
    if (origin && origin !== env.APP_ORIGIN) {
      throw new AppError(ErrorCodes.FORBIDDEN, "Cross-origin request rejected", 403);
    }
  });

  // 统一错误序列化
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (error instanceof AppError) {
      return reply.code(error.status).send({
        error: { code: error.code, message: error.message, requestId, details: error.details },
      });
    }

    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      }));
      return reply.code(422).send({
        error: { code: ErrorCodes.VALIDATION_ERROR, message: "Validation failed", requestId, details },
      });
    }

    // 声明 json 但 body 为空 → 客户端错误，400 而非 500
    const fastifyCode = (error as { code?: string }).code;
    if (fastifyCode === "FST_ERR_CTP_EMPTY_JSON_BODY") {
      return reply.code(400).send({
        error: { code: ErrorCodes.BAD_REQUEST, message: "Request body must not be empty", requestId },
      });
    }

    // fastify/Ajv schema 校验错误 → 统一 422
    if ((error as { validation?: unknown[] }).validation) {
      const details = ((error as { validation?: { instancePath?: string; keyword?: string; message?: string }[] }).validation ?? []).map((v) => ({
        field: (v.instancePath ?? "").replace(/^\//, "") || "body",
        message: v.message ?? "Invalid value",
        code: v.keyword ?? "validation",
      }));
      return reply.code(422).send({
        error: { code: ErrorCodes.VALIDATION_ERROR, message: "Validation failed", requestId, details },
      });
    }

    const fastifyError = error as { statusCode?: number; headers?: Record<string, unknown> };
    if (fastifyError.statusCode === 429) {
      const retryAfter = Number(fastifyError.headers?.["retry-after"] ?? 1);
      return reply.code(429).send({
        error: {
          code: ErrorCodes.RATE_LIMITED,
          message: "Too many requests",
          requestId,
          details: { retryAfterMs: retryAfter * 1000 },
        },
      });
    }

    request.log.error({ err: error, reqId: requestId });
    return reply.code(500).send({
      error: { code: ErrorCodes.INTERNAL_ERROR, message: "Internal server error", requestId },
    });
  });

  registerHealthRoute(app, container);

  // 会话注入 + 业务模块路由
  registerAuthHook(app, container.db);
  registerAuthModule(app, container);
  registerUserRoutes(app, container);
  registerBoardRoutes(app, container);
  registerDiscussionRoutes(app, container);
  registerAttachmentRoutes(app, container);
  registerFollowRoutes(app, container);
  registerNotificationModule(app, container);
  registerSearchRoutes(app, container);
  registerPresenceRoutes(app, container);
  registerRealtimeRoutes(app, container);
  registerModerationModule(app, container);
  registerAdminModule(app, container);

  return app;
}

function registerHealthRoute(app: FastifyInstance, container: Container): void {
  app.get("/api/health", async () => {
    let dbStatus = "ok";
    try {
      await container.db.db.run(sql`SELECT 1`);
    } catch {
      dbStatus = "error";
    }
    return { status: "ok", uptime: Math.round(process.uptime()), db: dbStatus };
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  const container = await buildContainer(env, { runMigrations: true });
  const app = await buildApp(container);

  container.outboxWorker.start();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await container.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    app.log.info(`Samryetha backend ready at http://localhost:${env.PORT} (docs: /docs)`);
  } catch (err) {
    app.log.error(err);
    await container.close();
    process.exit(1);
  }
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  void main();
}
