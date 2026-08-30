/**
 * Redis 的抽象。业务代码只依赖此接口；dev 用内存实现，
 * 未来换真 Redis（ioredis）只改 container 里的实现，不动业务。
 */
export interface CacheProvider {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** 原子自增，返回新值。 */
  incr(key: string): Promise<number>;
  expire(key: string, ttlMs: number): Promise<void>;
  /** 剩余 TTL 毫秒；无过期或不存在返回 null。 */
  ttl(key: string): Promise<number | null>;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}
