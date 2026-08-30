/**
 * 附件存储抽象（S3-compatible 语义）。API Server 不中转大文件：
 * 客户端先拿 presigned 上传 URL，直传对象存储，再回 POST 元数据。
 * dev 用本地磁盘实现同样的 presigned 语义（带签名的专用路由）。
 */
export interface StorageProvider {
  createUploadSession(input: {
    uploaderId: number;
    originalFilename: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<{ objectKey: string; id: number }>;

  generateUploadUrl(
    objectKey: string,
    opts: { contentType: string; maxSizeBytes: number; expiresInSec?: number },
  ): Promise<{ url: string; method: "PUT"; headers: Record<string, string> }>;

  generateDownloadUrl(objectKey: string, opts?: { expiresInSec?: number }): Promise<string>;

  deleteObject(objectKey: string): Promise<void>;

  /** 校验带签名 URL 的签名（本地实现；S3 实现不需要）。 */
  verifySignature?(method: string, pathname: string, expires: string, sig: string): boolean;
}
