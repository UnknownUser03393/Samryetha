import { and, count, desc, eq, inArray, lt } from "drizzle-orm";
import type { DbProvider } from "../infrastructure/db/client.js";
import { notifications, users, type NotificationType } from "../infrastructure/db/schema.js";
import { notFound } from "../app/error.js";
import { makeHandle } from "../users/service.js";
import { toMs } from "../lib/time.js";

export interface CreateNotificationInput {
  userId: number;
  actorUserId?: number | null;
  type: NotificationType;
  discussionId?: number | null;
  replyId?: number | null;
  body?: string | null;
}

export interface NotificationDTO {
  id: number;
  type: NotificationType;
  actor: { id: number; username: string; handle: string; displayName: string } | null;
  body: string | null;
  discussionId: number | null;
  replyId: number | null;
  isRead: boolean;
  createdAt: number;
}

export interface NotificationService {
  create(input: CreateNotificationInput): Promise<void>;
  list(userId: number, opts: { cursor?: string; limit?: number; unreadOnly?: boolean }): Promise<{ items: NotificationDTO[]; unreadCount: number; nextCursor: string | null }>;
  unreadCount(userId: number): Promise<number>;
  markRead(userId: number, id: number): Promise<void>;
  markAllRead(userId: number): Promise<void>;
}

export function createNotificationService(db: DbProvider): NotificationService {
  return {
    async create(input) {
      await db.db.insert(notifications).values({
        user_id: input.userId,
        actor_user_id: input.actorUserId ?? null,
        type: input.type,
        discussion_id: input.discussionId ?? null,
        reply_id: input.replyId ?? null,
        body: input.body ?? null,
      });
    },

    async list(userId, opts) {
      const limit = Math.min(opts.limit ?? 20, 50);
      const conds = [eq(notifications.user_id, userId)];
      if (opts.unreadOnly) conds.push(eq(notifications.is_read, 0));
      if (opts.cursor) {
        const cursor = Number(opts.cursor);
        if (!Number.isNaN(cursor)) conds.push(lt(notifications.id, cursor));
      }

      const rows = await db.db
        .select({
          id: notifications.id,
          type: notifications.type,
          actor_user_id: notifications.actor_user_id,
          body: notifications.body,
          discussion_id: notifications.discussion_id,
          reply_id: notifications.reply_id,
          is_read: notifications.is_read,
          created_at: notifications.created_at,
        })
        .from(notifications)
        .where(and(...conds))
        .orderBy(desc(notifications.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const actorIds = [...new Set(page.map((r) => r.actor_user_id).filter(Boolean) as number[])];
      const actorRows = actorIds.length ? await db.db.select().from(users).where(inArray(users.id, actorIds)) : [];
      const actorMap = new Map(actorRows.map((u) => [u.id, u]));

      const items: NotificationDTO[] = page.map((r) => {
        const actor = r.actor_user_id ? actorMap.get(r.actor_user_id) : undefined;
        return {
          id: r.id,
          type: r.type,
          actor: actor ? { id: actor.id, username: actor.username, handle: makeHandle(actor.username, actor.discriminator), displayName: actor.display_name } : null,
          body: r.body,
          discussionId: r.discussion_id,
          replyId: r.reply_id,
          isRead: r.is_read === 1,
          createdAt: toMs(r.created_at) ?? 0,
        };
      });
      const unreadCount = await this.unreadCount(userId);
      const nextCursor = hasMore && items.length > 0 ? String(items[items.length - 1].id) : null;
      return { items, unreadCount, nextCursor };
    },

    async unreadCount(userId) {
      const row = await db.db
        .select({ c: count() })
        .from(notifications)
        .where(and(eq(notifications.user_id, userId), eq(notifications.is_read, 0)))
        .get();
      return row?.c ?? 0;
    },

    async markRead(userId, id) {
      const row = await db.db.select().from(notifications).where(and(eq(notifications.id, id), eq(notifications.user_id, userId))).get();
      if (!row) throw notFound("Notification not found");
      await db.db.update(notifications).set({ is_read: 1, read_at: new Date() }).where(eq(notifications.id, id));
    },

    async markAllRead(userId) {
      await db.db.update(notifications).set({ is_read: 1, read_at: new Date() }).where(eq(notifications.user_id, userId));
    },
  };
}
