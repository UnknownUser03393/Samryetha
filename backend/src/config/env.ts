import "dotenv/config";
import { z } from "zod";

const boolFromString = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3001),
  APP_ORIGIN: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().default("./data/app.db"),
  COOKIE_SECURE: boolFromString,
  SESSION_TTL_MS: z.coerce.number().default(30 * 24 * 3600 * 1000),
  ALLOWED_EMAIL_DOMAINS: z.string().default("example.edu.cn"),
  STORAGE_SECRET: z.string().default("dev-storage-secret-change-me"),
  UPLOAD_DIR: z.string().default("./uploads"),
  /** 内置账号密码：启动时自动创建 admin/dev（不存在则建）。生产务必覆盖默认值。 */
  ADMIN_PASSWORD: z.string().default("SamryethaAdmin@NeatAvocado2026!"),
  DEV_PASSWORD: z.string().default("NeatAvocadoOnTop2026"),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default("Samryetha <no-reply@samryetha.local>"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.flatten();
    throw new Error(`Invalid environment configuration:\n${JSON.stringify(detail, null, 2)}`);
  }
  return parsed.data;
}

/** 邮箱域名 allowlist，来自 ALLOWED_EMAIL_DOMAINS（逗号分隔，全小写）。 */
export function allowedEmailDomains(env: Env): string[] {
  return env.ALLOWED_EMAIL_DOMAINS.split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}
