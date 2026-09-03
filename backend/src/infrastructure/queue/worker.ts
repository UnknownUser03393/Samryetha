import { and, eq, inArray, lte } from "drizzle-orm";
import { outboxEvents } from "../db/schema.js";
import type { DbProvider } from "../db/client.js";
import type { OutboxDispatcher, OutboxHandler, OutboxWorker } from "./types.js";

export class OutboxDispatcherImpl implements OutboxDispatcher {
  private handlers = new Map<string, OutboxHandler[]>();

  on(eventType: string, handler: OutboxHandler): void {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
  }

  handlersFor(eventType: string): OutboxHandler[] {
    return this.handlers.get(eventType) ?? [];
  }
}

export interface OutboxWorkerOptions {
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
}

/**
 * 单 worker 轮询消费 outbox：原子 claim（事务内标记 processing）→
 * 顺序执行 handler → 成功置 done / 失败指数退避，超限转 failed。
 * 与业务请求共用同一连接（避免多连接争锁）。
 */
export function createOutboxWorker(
  provider: DbProvider,
  dispatcher: OutboxDispatcher,
  options: OutboxWorkerOptions = {},
): OutboxWorker {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const batchSize = options.batchSize ?? 50;
  const maxAttempts = options.maxAttempts ?? 10;
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  function safeParse(raw: string): Record<string, unknown> {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async function handleFailure(
    row: { id: number; event_type: string; attempts: number },
    err: unknown,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    if (attempts >= maxAttempts) {
      await provider.db
        .update(outboxEvents)
        .set({ status: "failed", attempts })
        .where(eq(outboxEvents.id, row.id));
    } else {
      const backoffMs = Math.min(30_000, 1000 * 2 ** attempts);
      await provider.db
        .update(outboxEvents)
        .set({ status: "pending", attempts, available_at: new Date(Date.now() + backoffMs) })
        .where(eq(outboxEvents.id, row.id));
    }
    console.error(`[outbox] handler failed for ${row.event_type} (attempt ${attempts})`, err);
  }

  async function pollOnce(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const now = new Date();
      const candidates = await provider.tx(async (tx) => {
        const rows = await tx
          .select()
          .from(outboxEvents)
          .where(and(eq(outboxEvents.status, "pending"), lte(outboxEvents.available_at, now)))
          .orderBy(outboxEvents.id)
          .limit(batchSize);
        if (rows.length === 0) return [];
        await tx
          .update(outboxEvents)
          .set({ status: "processing" })
          .where(inArray(outboxEvents.id, rows.map((r) => r.id)));
        return rows;
      });

      for (const row of candidates) {
        const handlers = dispatcher.handlersFor(row.event_type);
        try {
          if (handlers.length > 0) {
            for (const handler of handlers) {
              await handler({
                type: row.event_type,
                aggregate: row.aggregate_type
                  ? { type: row.aggregate_type, id: row.aggregate_id ?? "" }
                  : undefined,
                payload: safeParse(row.payload),
                attempts: row.attempts,
              });
            }
          }
          await provider.db
            .update(outboxEvents)
            .set({ status: "done", processed_at: new Date() })
            .where(eq(outboxEvents.id, row.id));
        } catch (err) {
          await handleFailure(row, err);
        }
      }
    } finally {
      polling = false;
    }
  }

  return {
    start() {
      if (timer) return;
      pollOnce().catch((err) => console.error("[outbox] poll error", err));
      timer = setInterval(() => {
        pollOnce().catch((err) => console.error("[outbox] poll error", err));
      }, pollIntervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
