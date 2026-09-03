import { eq } from "drizzle-orm";
import type { DbProvider } from "../infrastructure/db/client.js";
import { schools } from "../infrastructure/db/schema.js";
import { allowedEmailDomains, type Env } from "../config/env.js";
import { AppError, ErrorCodes } from "../app/error.js";

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return "";
  return email.slice(at + 1).toLowerCase();
}

/** 注册时校验邮箱域名是否在 allowlist 内。 */
export function assertEmailDomainAllowed(env: Env, email: string): void {
  const domain = emailDomain(email);
  const allowed = allowedEmailDomains(env);
  if (!allowed.includes(domain)) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Email domain "${domain || "(missing)"}" is not allowed`,
      422,
      { field: "email", code: "EMAIL_DOMAIN_NOT_ALLOWED" },
    );
  }
}

export interface SchoolService {
  listActive(): Promise<{ id: number; name: string; emailDomain: string }[]>;
  upsert(input: { name: string; emailDomain: string }): Promise<void>;
}

export function createSchoolService(db: DbProvider): SchoolService {
  return {
    async listActive() {
      const rows = await db.db.select().from(schools).where(eq(schools.is_active, 1));
      return rows.map((r) => ({ id: r.id, name: r.name, emailDomain: r.email_domain }));
    },
    async upsert(input) {
      const existing = await db.db.select().from(schools).where(eq(schools.email_domain, input.emailDomain)).get();
      if (existing) {
        await db.db.update(schools).set({ name: input.name }).where(eq(schools.id, existing.id));
      } else {
        await db.db.insert(schools).values({ name: input.name, email_domain: input.emailDomain });
      }
    },
  };
}
