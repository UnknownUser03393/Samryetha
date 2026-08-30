import type { PresenceStore } from "./types.js";

interface Entry {
  lastSeen: number;
  expiresAt: number;
}

export class MemoryPresenceStore implements PresenceStore {
  private store = new Map<number, Entry>();

  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(id);
    }
  }

  async heartbeat(userId: number, ttlMs: number): Promise<void> {
    this.store.set(userId, { lastSeen: Date.now(), expiresAt: Date.now() + ttlMs });
  }

  async onlineCount(): Promise<number> {
    this.prune();
    return this.store.size;
  }

  async onlineUserIds(): Promise<number[]> {
    this.prune();
    return [...this.store.keys()];
  }

  async lastSeen(userId: number): Promise<number | null> {
    const entry = this.store.get(userId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(userId);
      return null;
    }
    return entry.lastSeen;
  }
}
