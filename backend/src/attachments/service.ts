import { eq } from "drizzle-orm";
import type { Container } from "../app/container.js";
import { Abilities, assertCan, type Actor } from "../authz/can.js";
import { attachments } from "../infrastructure/db/schema.js";
import { notFound } from "../app/error.js";
import { toMs } from "../lib/time.js";

export interface PresignInput {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AttachmentDTO {
  id: number;
  objectKey: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  state: string;
  downloadUrl: string;
  createdAt: number;
}

export interface AttachmentService {
  presign(actor: Actor, input: PresignInput): Promise<{ attachmentId: number; objectKey: string; uploadUrl: string; uploadMethod: string; uploadHeaders: Record<string, string> }>;
  getById(actor: Actor, id: number): Promise<AttachmentDTO>;
  delete(actor: Actor, id: number): Promise<void>;
}

export function createAttachmentService(c: Container): AttachmentService {
  return {
    async presign(actor, input) {
      if (!actor) throw new Error("presign requires actor");
      await assertCan(actor, Abilities.attachmentCreate, null, c);
      const { objectKey } = await c.storage.createUploadSession({
        uploaderId: actor.id,
        originalFilename: input.filename,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
      });
      const [row] = await c.db.db
        .insert(attachments)
        .values({
          uploader_id: actor.id,
          object_key: objectKey,
          original_filename: input.filename,
          mime_type: input.mimeType,
          size_bytes: input.sizeBytes,
        })
        .returning({ id: attachments.id });
      const upload = await c.storage.generateUploadUrl(objectKey, {
        contentType: input.mimeType,
        maxSizeBytes: input.sizeBytes,
      });
      return {
        attachmentId: row.id,
        objectKey,
        uploadUrl: upload.url,
        uploadMethod: upload.method,
        uploadHeaders: upload.headers,
      };
    },

    async getById(actor, id) {
      const row = await c.db.db.select().from(attachments).where(eq(attachments.id, id)).get();
      if (!row) throw notFound("Attachment not found");
      const downloadUrl = await c.storage.generateDownloadUrl(row.object_key);
      return {
        id: row.id,
        objectKey: row.object_key,
        originalFilename: row.original_filename,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        state: row.state,
        downloadUrl,
        createdAt: toMs(row.created_at) ?? 0,
      };
    },

    async delete(actor, id) {
      const row = await c.db.db.select().from(attachments).where(eq(attachments.id, id)).get();
      if (!row) throw notFound("Attachment not found");
      await assertCan(actor, Abilities.attachmentDelete, { type: "attachment", id, uploaderId: row.uploader_id }, c);
      await c.db.db.delete(attachments).where(eq(attachments.id, id));
      await c.storage.deleteObject(row.object_key);
    },
  };
}
