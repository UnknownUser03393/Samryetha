import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Container } from "../app/container.js";
import { requireActiveUser, requireUser } from "../app/auth-hook.js";
import { badRequest, forbidden } from "../app/error.js";
import { attachments } from "../infrastructure/db/schema.js";

const presignBody = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive().max(50 * 1024 * 1024),
});

const attachmentIdParam = z.object({ id: z.coerce.number().int().positive() });

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const OBJECT_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]{1,255}$/;

export function registerAttachmentRoutes(app: FastifyInstance, container: Container): void {
  const { attachments: attachmentService, storage } = container;

  // 附件直传是任意二进制 content-type，fastify 默认 parser 不认：
  // 注册通配流式 parser（具体类型如 application/json 仍走内置 parser）。
  app.addContentTypeParser("*", (request, payload, done) => {
    done(null, payload);
  });

  app.route({
    method: "POST",
    url: "/api/attachments/presign",
    schema: { body: presignBody },
    handler: async (request: FastifyRequest<{ Body: z.infer<typeof presignBody> }>) => {
      const session = requireActiveUser(request);
      return attachmentService.presign(session, request.body);
    },
  });

  app.route({
    method: "GET",
    url: "/api/attachments/:id",
    schema: { params: attachmentIdParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof attachmentIdParam> }>) => {
      const session = requireUser(request);
      return attachmentService.getById(session, request.params.id);
    },
  });

  app.route({
    method: "DELETE",
    url: "/api/attachments/:id",
    schema: { params: attachmentIdParam },
    handler: async (request: FastifyRequest<{ Params: z.infer<typeof attachmentIdParam> }>) => {
      const session = requireUser(request);
      await attachmentService.delete(session, request.params.id);
      return { ok: true };
    },
  });

  // --- 本地磁盘实现专用：带签名直传/直下，对齐 S3 presigned 语义 ---
  app.route({
    method: "PUT",
    url: "/api/attachments/upload/*",
    handler: async (request, reply) => {
      const objectKey = (request.params as Record<string, string>)["*"] ?? "";
      const { expires, sig } = request.query as { expires?: string; sig?: string };
      if (!OBJECT_KEY_RE.test(objectKey) || !expires || !sig) throw badRequest("Invalid upload URL");
      if (!storage.verifySignature?.("PUT", `/api/attachments/upload/${objectKey}`, expires, sig)) {
        throw forbidden("Invalid or expired upload signature");
      }
      const declared = Number(request.headers["content-length"] ?? 0);
      if (declared > MAX_UPLOAD_BYTES) throw badRequest("File too large");

      // 按 presign 时声明的 size_bytes 收紧上限，防止客户端绕过声明体积上传超大文件
      // Enforce the size declared at presign time to prevent uploading larger than declared
      const row = await container.db.db.select().from(attachments).where(eq(attachments.object_key, objectKey)).get();
      if (row && declared > row.size_bytes) throw badRequest("File too large");

      const full = path.join(container.env.UPLOAD_DIR, objectKey);
      if (!path.resolve(full).startsWith(path.resolve(container.env.UPLOAD_DIR))) {
        throw forbidden("Invalid object key");
      }
      const ws = createWriteStream(full);
      try {
        await pipeline(request.body as Readable, ws);
      } catch {
        ws.destroy();
        throw badRequest("Upload failed");
      }
      return reply.code(204).send();
    },
  });

  app.route({
    method: "GET",
    url: "/api/attachments/serve/*",
    handler: async (request, reply) => {
      const objectKey = (request.params as Record<string, string>)["*"] ?? "";
      const { expires, sig } = request.query as { expires?: string; sig?: string };
      if (!OBJECT_KEY_RE.test(objectKey) || !expires || !sig) throw badRequest("Invalid download URL");
      if (!storage.verifySignature?.("GET", `/api/attachments/serve/${objectKey}`, expires, sig)) {
        throw forbidden("Invalid or expired download signature");
      }
      const meta = await container.db.db.select().from(attachments).where(eq(attachments.object_key, objectKey)).get();
      const mime = meta?.mime_type ?? "application/octet-stream";
      const full = path.join(container.env.UPLOAD_DIR, objectKey);
      if (!path.resolve(full).startsWith(path.resolve(container.env.UPLOAD_DIR))) {
        throw forbidden("Invalid object key");
      }
      reply.header("content-type", mime);
      reply.header("x-content-type-options", "nosniff");
      reply.header("content-disposition", `inline; filename="${path.basename(objectKey)}"`);
      reply.hijack();
      await pipeline(createReadStream(full), reply.raw);
      return reply;
    },
  });
}
