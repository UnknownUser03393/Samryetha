import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { StorageProvider } from "./types.js";

const ALLOWED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif",
  ".pdf", ".txt", ".md", ".csv",
  ".zip", ".rar", ".7z",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".mp4", ".mov", ".mp3", ".wav",
]);

// 扩展名 → 服务端 Content-Type：附件回源时一律按扩展名推导，绝不信任客户端声明的 mimeType（防存储型 XSS）
// Extension → server-side Content-Type: derive on serve, never trust the client-declared mimeType (prevents stored XSS)
const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

// 允许客户端在 presign 时声明的 Content-Type 白名单（不含 text/html 等可执行类型）
// Allowlist of Content-Types the client may declare at presign (excludes executable types like text/html)
export const ALLOWED_MIME_TYPES = new Set<string>(Object.values(MIME_BY_EXTENSION));

// 按 objectKey 的扩展名推导安全 Content-Type
// Derive a safe Content-Type from the objectKey extension
export function contentTypeForObjectKey(objectKey: string): string {
  const ext = path.extname(objectKey).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

function sanitizeFilename(name: string): string {
  // 去掉路径分隔符和非法字符，限制长度，保留扩展名
  const base = name.replace(/[\\/:\*\?"<>\|]/g, "_").replace(/\s+/g, "_").slice(0, 80);
  return base || "file";
}

/**
 * 本地磁盘存储：文件落在 <root>/<uuid>/<filename>，
 * 上传/下载 URL 用 HMAC 签名，语义对齐 S3 presigned URL。
 */
export class LocalDiskStorage implements StorageProvider {
  constructor(
    private readonly rootDir: string,
    private readonly secret: string,
  ) {}

  private sign(method: string, pathname: string, expires: string): string {
    return createHmac("sha256", this.secret).update(`${method}|${pathname}|${expires}`).digest("hex");
  }

  async createUploadSession(input: {
    uploaderId: number;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<{ objectKey: string; id: number }> {
    const ext = path.extname(input.originalFilename).toLowerCase();
    if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
      throw new Error(`File extension not allowed: ${ext}`);
    }
    const objectKey = `${randomUUID()}/${sanitizeFilename(input.originalFilename)}`;
    await mkdir(path.join(this.rootDir, path.dirname(objectKey)), { recursive: true });
    return { objectKey, id: input.uploaderId }; // id 占位，真实 id 由 attachments 表生成
  }

  async generateUploadUrl(
    objectKey: string,
    opts: { contentType: string; maxSizeBytes: number; expiresInSec?: number },
  ): Promise<{ url: string; method: "PUT"; headers: Record<string, string> }> {
    const expires = String(Math.floor(Date.now() / 1000) + (opts.expiresInSec ?? 900));
    const pathname = `/api/attachments/upload/${objectKey}`;
    const sig = this.sign("PUT", pathname, expires);
    return {
      url: `${pathname}?expires=${expires}&sig=${sig}`,
      method: "PUT",
      headers: { "content-type": opts.contentType },
    };
  }

  async generateDownloadUrl(objectKey: string, opts?: { expiresInSec?: number }): Promise<string> {
    const expires = String(Math.floor(Date.now() / 1000) + (opts?.expiresInSec ?? 3600));
    const pathname = `/api/attachments/serve/${objectKey}`;
    const sig = this.sign("GET", pathname, expires);
    return `${pathname}?expires=${expires}&sig=${sig}`;
  }

  async deleteObject(objectKey: string): Promise<void> {
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(path.join(this.rootDir, objectKey));
    } catch {
      // 文件不存在视为已删除
    }
  }

  verifySignature(method: string, pathname: string, expires: string, sig: string): boolean {
    if (!/^\d+$/.test(expires) || Number(expires) < Math.floor(Date.now() / 1000)) return false;
    const expected = this.sign(method, pathname, expires);
    try {
      return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
    } catch {
      return false;
    }
  }
}
