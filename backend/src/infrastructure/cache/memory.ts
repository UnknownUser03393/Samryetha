import type { CacheProvider, RateLimiter, RateLimitResult } from "./types.js";

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class MemoryCache implements CacheProvider {
  private store = new Map<string, Entry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: { cleanupIntervalMs?: number }) {
    const interval = opts?.cleanupIntervalMs ?? 60_000;
    if (interval > 0) {
      this.cleanupTimer = setInterval(() => this.sweep(), interval);
      this.cleanupTimer.unref?.();
    }
  }

  private isExpired(e: Entry): boolean {
    return e.expiresAt !== null && e.expiresAt <= Date.now();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.store.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.store.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incr(key: string): Promise<number> {
    const current = Number((await this.get(key)) ?? "0");
    const next = current + 1;
    await this.set(key, String(next));
    return next;
  }

  async expire(key: string, ttlMs: number): Promise<void> {
    const entry = this.store.get(key);
    if (entry) entry.expiresAt = Date.now() + ttlMs;
  }

  async ttl(key: string): Promise<number | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt === null) return null;
    const remaining = entry.expiresAt - Date.now();
    if (remaining <= 0) {
      this.store.delete(key);
      return null;
    }
    return remaining;
  }

  close(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}

/** 固定窗口计数器，建在 CacheProvider 之上。 */
export class MemoryRateLimiter implements RateLimiter {
  constructor(private readonly cache: CacheProvider) {}

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const count = await this.cache.incr(key);
    if (count === 1) {
      await this.cache.expire(key, windowMs);
    }
    if (count <= limit) {
      return { allowed: true, remaining: limit - count, retryAfterMs: 0 };
    }
    const retryAfterMs = (await this.cache.ttl(key)) ?? windowMs;
    return { allowed: false, remaining: 0, retryAfterMs };
  }
}
