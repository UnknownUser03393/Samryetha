/**
 * Presence（在线状态）抽象。dev 用内存实现，未来换 Redis
 * 用 sorted set / TTL，只改实现。
 */
export interface PresenceStore {
  heartbeat(userId: number, ttlMs: number): Promise<void>;
  onlineCount(): Promise<number>;
  onlineUserIds(): Promise<number[]>;
  lastSeen(userId: number): Promise<number | null>;
}
