import { and, count, desc, eq, gt, inArray, isNotNull, isNull, like, lt, or, type SQL } from "drizzle-orm";
import type { DbProvider } from "../infrastructure/db/client.js";
import { assertCan, type Actor, Abilities, type AuthzCtx } from "../authz/can.js";
import { conflict, notFound } from "../app/error.js";
import {
  bans,
  boards,
  discussions,
  moderationActions,
  replies,
  reports,
  sessions,
  users,
  type UserRole,
  type UserStatus,
} from "../infrastructure/db/schema.js";
import type { PresenceStore } from "../infrastructure/presence/types.js";
import { makeHandle } from "../users/service.js";

export type AdminUserDTO = {
  id: number;
  username: string;
  handle: string;
  displayName: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  banActive: boolean;
  reportCount: number;
};

export type AdminStats = {
  users: { total: number; pending: number; active: number; banned: number; deactivated: number };
  content: { discussions: number; replies: number; boards: number };
  moderation: { openReports: number; activeBans: number };
  activity: {
    activeToday: number;
    newUsersToday: number;
    newDiscussionsToday: number;
    newRepliesToday: number;
    onlineNow: number;
  };
};

export type DeletedDiscussion = {
  id: number;
  boardSlug: string;
  title: string;
  preview: string;
  deletedBy: { id: number; username: string; handle: string; displayName: string } | null;
  deletedAt: number;
  reason: string | null;
};

export type DeletedReply = {
  id: number;
  discussionId: number;
  discussionTitle: string;
  preview: string;
  deletedBy: { id: number; username: string; handle: string; displayName: string } | null;
  deletedAt: number;
  reason: string | null;
};

export type DeletedContentResult = {
  discussions: DeletedDiscussion[];
  replies: DeletedReply[];
  nextDiscussionCursor: number | null;
  nextReplyCursor: number | null;
};

export interface AdminService {
  stats(actor: Actor): Promise<AdminStats>;
  listUsers(
    actor: Actor,
    opts: { q?: string; status?: UserStatus; role?: UserRole; cursor?: number; limit?: number },
  ): Promise<{ items: AdminUserDTO[]; nextCursor: number | null }>;
  changeRole(actor: Actor, targetId: number, input: { role: UserRole; reason?: string }): Promise<AdminUserDTO>;
  changeStatus(
    actor: Actor,
    targetId: number,
    input: { status: "active" | "deactivated"; reason?: string },
  ): Promise<AdminUserDTO>;
  verifyUser(actor: Actor, targetId: number): Promise<AdminUserDTO>;
  listDeletedContent(
    actor: Actor,
    opts: { discussionCursor?: number; replyCursor?: number; limit?: number },
  ): Promise<DeletedContentResult>;
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function preview(md: string): string {
  const flat = md.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

function toMs(v: Date | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.getTime() : v;
}

function toAdminUserDTO(
  row: typeof users.$inferSelect,
  banActive: boolean,
  reportCount: number,
): AdminUserDTO {
  return {
    id: row.id,
    username: row.username,
    handle: makeHandle(row.username, row.discriminator),
    displayName: row.display_name,
    email: row.email,
    role: row.role,
    status: row.status,
    emailVerified: row.email_verified_at !== null,
    createdAt: toMs(row.created_at) ?? 0,
    lastSeenAt: toMs(row.last_seen_at),
    banActive,
    reportCount,
  };
}

type AuthorRef = { id: number; username: string; handle: string; displayName: string };

function toAuthor(row: { id: number; username: string; display_name: string; discriminator: number | null }): AuthorRef {
  return { id: row.id, username: row.username, handle: makeHandle(row.username, row.discriminator), displayName: row.display_name };
}

export function createAdminService(db: DbProvider, c: AuthzCtx, opts: { presence: PresenceStore }): AdminService {
  const { presence } = opts;

  async function loadAdminUser(userId: number): Promise<AdminUserDTO | null> {
    const row = await db.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) return null;
    const [banRow, reportRow] = await Promise.all([
      db.db.select().from(bans).where(and(eq(bans.user_id, userId), eq(bans.is_active, 1))).get(),
      db.db
        .select({ c: count() })
        .from(reports)
        .where(and(eq(reports.reportable_type, "user"), eq(reports.reportable_id, userId)))
        .get(),
    ]);
    return toAdminUserDTO(row, banRow !== undefined, reportRow?.c ?? 0);
  }

  return {
    async stats(actor) {
      await assertCan(actor, Abilities.adminView, null, c);
      const today = startOfToday();
      const [
        statusRows,
        discTotalRow,
        replyTotalRow,
        boardTotalRow,
        reportRow,
        banRow,
        newUsersRow,
        newDiscussionsRow,
        newRepliesRow,
        discAuthors,
        replyAuthors,
      ] = await Promise.all([
        db.db.select({ status: users.status, c: count() }).from(users).groupBy(users.status),
        db.db.select({ c: count() }).from(discussions).where(isNull(discussions.deleted_at)).get(),
        db.db.select({ c: count() }).from(replies).where(isNull(replies.deleted_at)).get(),
        db.db.select({ c: count() }).from(boards).where(isNull(boards.deleted_at)).get(),
        db.db
          .select({ c: count() })
          .from(reports)
          .where(inArray(reports.status, ["open", "in_progress"]))
          .get(),
        db.db.select({ c: count() }).from(bans).where(eq(bans.is_active, 1)).get(),
        db.db.select({ c: count() }).from(users).where(gt(users.created_at, today)).get(),
        db.db
          .select({ c: count() })
          .from(discussions)
          .where(and(gt(discussions.created_at, today), isNull(discussions.deleted_at)))
          .get(),
        db.db
          .select({ c: count() })
          .from(replies)
          .where(and(gt(replies.created_at, today), isNull(replies.deleted_at)))
          .get(),
        db.db
          .select({ id: discussions.author_id })
          .from(discussions)
          .where(and(gt(discussions.created_at, today), isNull(discussions.deleted_at))),
        db.db
          .select({ id: replies.author_id })
          .from(replies)
          .where(and(gt(replies.created_at, today), isNull(replies.deleted_at))),
      ]);

      const usersDist = { total: 0, pending: 0, active: 0, banned: 0, deactivated: 0 };
      for (const row of statusRows) {
        usersDist[row.status] = row.c;
        usersDist.total += row.c;
      }

      const activeSet = new Set<number>();
      for (const a of discAuthors) activeSet.add(a.id);
      for (const a of replyAuthors) activeSet.add(a.id);

      return {
        users: usersDist,
        content: {
          discussions: discTotalRow?.c ?? 0,
          replies: replyTotalRow?.c ?? 0,
          boards: boardTotalRow?.c ?? 0,
        },
        moderation: { openReports: reportRow?.c ?? 0, activeBans: banRow?.c ?? 0 },
        activity: {
          activeToday: activeSet.size,
          newUsersToday: newUsersRow?.c ?? 0,
          newDiscussionsToday: newDiscussionsRow?.c ?? 0,
          newRepliesToday: newRepliesRow?.c ?? 0,
          onlineNow: await presence.onlineCount(),
        },
      };
    },

    async listUsers(actor, opts) {
      await assertCan(actor, Abilities.adminView, null, c);
      const limit = Math.min(opts.limit ?? 20, 50);
      const conds: SQL[] = [];
      if (opts.q && opts.q.trim()) {
        const q = escapeLike(opts.q.trim().slice(0, 100));
        conds.push(
          or(like(users.username, `%${q}%`), like(users.display_name, `%${q}%`), like(users.email, `%${q}%`))!,
        );
      }
      if (opts.status) conds.push(eq(users.status, opts.status));
      if (opts.role) conds.push(eq(users.role, opts.role));
      if (opts.cursor) conds.push(lt(users.id, opts.cursor));

      const rows = await db.db
        .select()
        .from(users)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(users.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const ids = page.map((r) => r.id);

      const [banRows, reportRows] = await Promise.all([
        ids.length
          ? db.db
              .select({ user_id: bans.user_id })
              .from(bans)
              .where(and(inArray(bans.user_id, ids), eq(bans.is_active, 1)))
          : Promise.resolve([]),
        ids.length
          ? db.db
              .select({ reportable_id: reports.reportable_id, c: count() })
              .from(reports)
              .where(and(eq(reports.reportable_type, "user"), inArray(reports.reportable_id, ids)))
              .groupBy(reports.reportable_id)
          : Promise.resolve([]),
      ]);
      const banSet = new Set(banRows.map((r) => r.user_id));
      const reportMap = new Map(reportRows.map((r) => [r.reportable_id, r.c]));

      const items = page.map((r) => toAdminUserDTO(r, banSet.has(r.id), reportMap.get(r.id) ?? 0));
      return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
    },

    async changeRole(actor, targetId, input) {
      await assertCan(actor, Abilities.adminUserRoleUpdate, null, c);
      const target = await db.db.select().from(users).where(eq(users.id, targetId)).get();
      if (!target) throw notFound("User not found");
      if (target.id === actor?.id) throw conflict("Cannot change your own role");
      if (target.role === input.role) throw conflict("Role is already set");
      if (target.role === "admin" && input.role !== "admin") {
        const adminCount = await db.db.select({ c: count() }).from(users).where(eq(users.role, "admin")).get();
        if ((adminCount?.c ?? 0) <= 1) throw conflict("Cannot demote the last admin");
      }
      await db.tx(async (tx) => {
        await tx.update(users).set({ role: input.role, updated_at: new Date() }).where(eq(users.id, targetId));
        await tx.insert(moderationActions).values({
          actor_user_id: actor!.id,
          action: "user.role.change",
          target_type: "user",
          target_id: targetId,
          reason: input.reason ?? `${target.role}->${input.role}`,
        });
      });
      const fresh = await loadAdminUser(targetId);
      return fresh!;
    },

    async changeStatus(actor, targetId, input) {
      await assertCan(actor, Abilities.adminUserStatusUpdate, null, c);
      const target = await db.db.select().from(users).where(eq(users.id, targetId)).get();
      if (!target) throw notFound("User not found");
      if (target.status === "banned") throw conflict("Banned users must be unbanned first");
      if (target.id === actor?.id) throw conflict("Cannot change your own status");
      if (target.status === input.status) throw conflict("Status is already set");
      await db.tx(async (tx) => {
        await tx.update(users).set({ status: input.status, updated_at: new Date() }).where(eq(users.id, targetId));
        await tx.insert(moderationActions).values({
          actor_user_id: actor!.id,
          action: input.status === "deactivated" ? "user.deactivate" : "user.reactivate",
          target_type: "user",
          target_id: targetId,
          reason: input.reason ?? null,
        });
        if (input.status === "deactivated") {
          await tx.delete(sessions).where(eq(sessions.user_id, targetId));
        }
      });
      const fresh = await loadAdminUser(targetId);
      return fresh!;
    },

    async verifyUser(actor, targetId) {
      await assertCan(actor, Abilities.adminUserStatusUpdate, null, c);
      const target = await db.db.select().from(users).where(eq(users.id, targetId)).get();
      if (!target) throw notFound("User not found");
      if (target.status === "banned") throw conflict("Banned users must be unbanned first");
      if (target.status === "active" && target.email_verified_at !== null) {
        throw conflict("User already verified");
      }
      const now = new Date();
      await db.tx(async (tx) => {
        await tx
          .update(users)
          .set({ status: "active", email_verified_at: target.email_verified_at ?? now, updated_at: now })
          .where(eq(users.id, targetId));
        await tx.insert(moderationActions).values({
          actor_user_id: actor!.id,
          action: "user.verify",
          target_type: "user",
          target_id: targetId,
          reason: null,
        });
      });
      const fresh = await loadAdminUser(targetId);
      return fresh!;
    },

    async listDeletedContent(actor, opts) {
      await assertCan(actor, Abilities.adminView, null, c);
      const limit = Math.min(opts.limit ?? 20, 50);

      const discConds: SQL[] = [isNotNull(discussions.deleted_at)];
      if (opts.discussionCursor) discConds.push(lt(discussions.id, opts.discussionCursor));
      const replyConds: SQL[] = [isNotNull(replies.deleted_at)];
      if (opts.replyCursor) replyConds.push(lt(replies.id, opts.replyCursor));

      const [discRows, replyRows] = await Promise.all([
        db.db
          .select()
          .from(discussions)
          .where(and(...discConds))
          .orderBy(desc(discussions.id))
          .limit(limit + 1),
        db.db
          .select()
          .from(replies)
          .where(and(...replyConds))
          .orderBy(desc(replies.id))
          .limit(limit + 1),
      ]);

      const discHasMore = discRows.length > limit;
      const replyHasMore = replyRows.length > limit;
      const discPage = discHasMore ? discRows.slice(0, limit) : discRows;
      const replyPage = replyHasMore ? replyRows.slice(0, limit) : replyRows;

      const discDeleterIds = [...new Set(discPage.map((r) => r.deleted_by).filter((v): v is number => v !== null))];
      const replyDeleterIds = [...new Set(replyPage.map((r) => r.deleted_by).filter((v): v is number => v !== null))];
      const boardIds = [...new Set(discPage.map((r) => r.board_id))];
      const discussionIds = [...new Set(replyPage.map((r) => r.discussion_id))];

      const [boardRows, discDeleters, discParentRows, replyDeleters] = await Promise.all([
        boardIds.length ? db.db.select({ id: boards.id, slug: boards.slug }).from(boards).where(inArray(boards.id, boardIds)) : Promise.resolve([]),
        discDeleterIds.length ? db.db.select().from(users).where(inArray(users.id, discDeleterIds)) : Promise.resolve([]),
        discussionIds.length ? db.db.select({ id: discussions.id, title: discussions.title }).from(discussions).where(inArray(discussions.id, discussionIds)) : Promise.resolve([]),
        replyDeleterIds.length ? db.db.select().from(users).where(inArray(users.id, replyDeleterIds)) : Promise.resolve([]),
      ]);

      const boardMap = new Map(boardRows.map((b) => [b.id, b.slug]));
      const discDeleterMap = new Map(discDeleters.map((u) => [u.id, u]));
      const parentMap = new Map(discParentRows.map((d) => [d.id, d.title]));
      const replyDeleterMap = new Map(replyDeleters.map((u) => [u.id, u]));

      const discussionsOut: DeletedDiscussion[] = discPage.map((r) => ({
        id: r.id,
        boardSlug: boardMap.get(r.board_id) ?? "",
        title: r.title,
        preview: preview(r.body_md),
        deletedBy: r.deleted_by ? toAuthor(discDeleterMap.get(r.deleted_by)!) : null,
        deletedAt: toMs(r.deleted_at) ?? 0,
        reason: r.deletion_reason,
      }));

      const repliesOut: DeletedReply[] = replyPage.map((r) => ({
        id: r.id,
        discussionId: r.discussion_id,
        discussionTitle: parentMap.get(r.discussion_id) ?? "",
        preview: preview(r.body_md),
        deletedBy: r.deleted_by ? toAuthor(replyDeleterMap.get(r.deleted_by)!) : null,
        deletedAt: toMs(r.deleted_at) ?? 0,
        reason: r.deletion_reason,
      }));

      return {
        discussions: discussionsOut,
        replies: repliesOut,
        nextDiscussionCursor: discHasMore ? discussionsOut[discussionsOut.length - 1].id : null,
        nextReplyCursor: replyHasMore ? repliesOut[repliesOut.length - 1].id : null,
      };
    },
  };
}
