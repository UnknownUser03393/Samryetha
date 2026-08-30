import type { DomainEvent, EventBus } from "./types.js";

export class MemoryEventBus implements EventBus {
  private handlers = new Map<string, Set<(event: DomainEvent) => void>>();

  publish(event: DomainEvent): void {
    const set = this.handlers.get(event.type);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(event);
      } catch (err) {
        // 订阅者出错不应影响其他订阅者或主流程
        console.error("[eventbus] handler error", event.type, err);
      }
    }
  }

  subscribe(eventType: string, handler: (event: DomainEvent) => void): () => void {
    let set = this.handlers.get(eventType);
    if (!set) {
      set = new Set();
      this.handlers.set(eventType, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(eventType);
    };
  }
}
