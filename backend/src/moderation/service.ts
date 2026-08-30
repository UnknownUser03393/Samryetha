import { and, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import type { DbProvider } from "../infrastructure/db/client.js";
import { emitEvent } from "../infrastructure/db/client.js";
import { assertCan, type Actor, Abilities, type AuthzCtx } from "../authz/can.js";
import { notFound, conflict } from "../app/error.js";
import {
  bans,
  boards,
  discussions,
  moderationActions,
  replies,
  reports,
  sessions,
  users,
  type ReportStatus,
} from "../infrastructure/db/schema.js";

export interface ReportTargetDTO {
  type: "discussion" | "reply" | "user";
  id: number;
  title?: string;
  boardSlug?: string;
  username?: string;
  displayName?: string;
  discussionId?: number;
}

export interface ReportDTO {
  id: number;
  reporter: { id: number; username: string; displayName: string };
  reportableType: string;
  reportableId: number;
  target?: ReportTargetDTO;
  reason: string | null;
  status: ReportStatus;
  createdAt: number;
}

export interface ModerationActionDTO {
  id: number;
  actor: { id: number; username: string; displayName: string };
  action: string;
  targetType: string;
  targetId: number;
  reason: string | null;
  createdAt: number;
}

export interface ModerationService {
  createReport(actor: Actor, input: { reportableType: string; reportableId: number; reason?: string }): Promise<ReportDTO>;
  listReports(actor: Actor, opts: { status?: string; cursor?: number; limit?: number }): Promise<{ items: ReportDTO[]; nextCursor: number | null }>;
  resolveReport(actor: Actor, reportId: number, input: { status: string; action?: string; reason?: string }): Promise<ReportDTO>;
  banUser(actor: Actor, input: { username: string; reason?: string; durationHours?: number }): Promise<void>;
  unbanUser(actor: Actor, input: { username: string; reason?: string }): Promise<void>;
  listActions(actor: Actor, opts: { cursor?: number; limit?: number }): Promise<{ items: ModerationActionDTO[]; nextCursor: number | null }>;
  restoreContent(actor: Actor, input: { targetType: string; targetId: number; reason?: string }): Promise<void>;
}

function toReportDTO(row: typeof reports.$inferSelect & { reporterUsername: string; reporterDisplayName: string }): ReportDTO {
  return {
    id: row.id,
    reporter: { id: row.reporter_user_id, username: row.reporterUsername, displayName: row.reporterDisplayName },
    reportableType: row.reportable_type,
    reportableId: row.reportable_id,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at.getTime(),
  };
}

function toMs(v: Date | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.getTime() : v;
}

/** 批量 enrich 报告的被举报对象（discussion→标题+板块；reply→所属讨论；user→身份）。 */
async function buildTargetMap(db: DbProvider, page: typeof reports.$inferSelect[]): Promise<Map<string, ReportTargetDTO>> {
  const byType: { discussion: number[]; reply: number[]; user: number[] } = { discussion: [], reply: [], user: [] };
  for (const r of page) {
    if (r.reportable_type === "discussion") byType.discussion.push(r.reportable_id);
    else if (r.reportable_type === "reply") byType.reply.push(r.reportable_id);
    else if (r.reportable_type === "user") byType.user.push(r.reportable_id);
  }

  const discRows = byType.discussion.length
    ? await db.db.select().from(discussions).where(inArray(discussions.id, byType.discussion))
    : [];
  const boardIds = [...new Set(discRows.map((d) => d.board_id))];
  const [boardRows, replyRows, userRows] = await Promise.all([
    boardIds.length ? db.db.select({ id: boards.id, slug: boards.slug }).from(boards).where(inArray(boards.id, boardIds)) : Promise.resolve([]),
    byType.reply.length ? db.db.select().from(replies).where(inArray(replies.id, byType.reply)) : Promise.resolve([]),
    byType.user.length ? db.db.select().from(users).where(inArray(users.id, byType.user)) : Promise.resolve([]),
  ]);

  const boardMap = new Map(boardRows.map((b) => [b.id, b.slug]));
  const map = new Map<string, ReportTargetDTO>();
  for (const d of discRows) {
    map.set(`discussion:${d.id}`, { type: "discussion", id: d.id, title: d.title, boardSlug: boardMap.get(d.board_id) ?? "" });
  }
  for (const r of replyRows) {
    map.set(`reply:${r.id}`, { type: "reply", id: r.id, discussionId: r.discussion_id });
  }
  for (const u of userRows) {
    map.set(`user:${u.id}`, { type: "user", id: u.id, username: u.username, displayName: u.display_name });
  }
  return map;
}

export function createModerationService(db: DbProvider, c: AuthzCtx): ModerationService {
  return {
    async createReport(actor, input) {
      await assertCan(actor, Abilities.reportCreate, null, c);
      const id = await db.tx(async (tx) => {
        const [row] = await tx
          .insert(reports)
          .values({
            reporter_user_id: actor!.id,
            reportable_type: input.reportableType as never,
            reportable_id: input.reportableId,
            reason: input.reason ?? null,
            status: "open",
          })
          .returning();
        return row.id;
      });
      const row = await db.db.select().from(reports).where(eq(reports.id, id)).get();
      const reporter = await db.db.select().from(users).where(eq(users.id, row!.reporter_user_id)).get();
      return toReportDTO({ ...row!, reporterUsername: reporter?.username ?? "", reporterDisplayName: reporter?.display_name ?? "" });
    },

    async listReports(actor, opts) {
      await assertCan(actor, Abilities.moderationView, null, c);
      const limit = Math.min(opts.limit ?? 20, 50);
      const conds: SQL[] = [];
      if (opts.status) conds.push(eq(reports.status, opts.status as never));
      if (opts.cursor) conds.push(lt(reports.id, opts.cursor));
      const rows = await db.db
        .select({
          id: reports.id,
          reporter_user_id: reports.reporter_user_id,
          reportable_type: reports.reportable_type,
          reportable_id: reports.reportable_id,
          reason: reports.reason,
          status: reports.status,
          created_at: reports.created_at,
        })
        .from(reports)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(reports.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const reporterIds = [...new Set(page.map((r) => r.reporter_user_id))];
      const reporters = reporterIds.length ? await db.db.select().from(users).where(inArray(users.id, reporterIds)) : [];
      const reporterMap = new Map(reporters.map((u) => [u.id, u]));
      const targetMap = await buildTargetMap(db, page);
      const items = page.map((r) => {
        const dto = toReportDTO({
          ...r,
          reporterUsername: reporterMap.get(r.reporter_user_id)?.username ?? "",
          reporterDisplayName: reporterMap.get(r.reporter_user_id)?.display_name ?? "",
        });
        const target = targetMap.get(`${r.reportable_type}:${r.reportable_id}`);
        return target ? { ...dto, target } : dto;
      });
      return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
    },

    async resolveReport(actor, reportId, input) {
      await assertCan(actor, Abilities.moderationResolve, null, c);
      const existing = await db.db.select().from(reports).where(eq(reports.id, reportId)).get();
      if (!existing) throw notFound("Report not found");
      await db.tx(async (tx) => {
        await tx.update(reports).set({ status: input.status as ReportStatus }).where(eq(reports.id, reportId));
        await tx.insert(moderationActions).values({
          actor_user_id: actor!.id,
          action: input.action ?? `report.${input.status}`,
          target_type: "report",
          target_id: reportId,
          reason: input.reason ?? null,
        });
      });
      const row = await db.db.select().from(reports).where(eq(reports.id, reportId)).get();
      const reporter = await db.db.select().from(users).where(eq(users.id, row!.reporter_user_id)).get();
      return toReportDTO({ ...row!, reporterUsername: reporter?.username ?? "", reporterDisplayName: reporter?.display_name ?? "" });
    },

    async banUser(actor, input) {
      await assertCan(actor, Abilities.userBan, null, c);
      const target = await db.db.select().from(users).where(eq(users.username, input.username)).get();
      if (!target) throw notFound("User not found");
      if (target.id === actor?.id) throw conflict("Cannot ban yourself");
      if (target.role === "admin") throw conflict("Cannot ban an admin");
      await db.tx(async (tx) => {
        const bannedUntil = input.durationHours ? new Date(Date.now() + input.durationHours * 3600_000) : null;
        await tx.insert(bans).values({
          user_id: target.id,
          banned_by_user_id: actor!.id,
          reason: input.reason ?? null,
          banned_until: bannedUntil,
          is_active: 1,
        });
        await tx.update(users).set({ status: "banned" }).where(eq(users.id, target.id));
        await tx.delete(sessions).where(eq(sessions.user_id, target.id));
        await tx.insert(moderationActions).values({
          actor_user_id: actor!.id,
          action: "user.ban",
          target_type: "user",
          target_id: target.id,
          reason: input.reason ?? null,
        });
        await emitEvent({
          type: "user.banned",
          aggregate: { type: "user", id: String(target.id) },
          payload: { userId: target.id, bannedByUserId: actor!.id, reason: input.reason ?? null, bannedUntil: bannedUntil?.toISOString() ?? null },
        });
      });
    },

    async unbanUser(actor, input) {
      await assertCan(actor, Abilities.moderationUnban, null, c);
      const target = await db.db.select().from(users).where(eq(users.username, input.username)).get();
      if (!target) throw notFound("User not found");
      await db.tx(async (tx) => {
        await tx.update(bans).set({ is_active: 0 }).where(and(eq(bans.user_id, target.id), eq(bans.is_active, 1)));
        await tx.update(users).set({ status: "active" }).where(eq(users.id, target.id));
        await tx.insert(moderationActions).values({
          actor_user_id: actor!.id,
          action: "user.unban",
          target_type: "user",
          target_id: target.id,
          reason: input.reason ?? null,
        });
      });
    },

    async listActions(actor, opts) {
      await assertCan(actor, Abilities.moderationView, null, c);
      const limit = Math.min(opts.limit ?? 20, 50);
      const conds = opts.cursor ? lt(moderationActions.id, opts.cursor) : undefined;
      const rows = await db.db
        .select({
          id: moderationActions.id,
          actor_user_id: moderationActions.actor_user_id,
          action: moderationActions.action,
          target_type: moderationActions.target_type,
          target_id: moderationActions.target_id,
          reason: moderationActions.reason,
          created_at: moderationActions.created_at,
        })
        .from(moderationActions)
        .where(conds)
        .orderBy(desc(moderationActions.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const actorIds = [...new Set(page.map((r) => r.actor_user_id))];
      const actors = actorIds.length ? await db.db.select().from(users).where(inArray(users.id, actorIds)) : [];
      const actorMap = new Map(actors.map((u) => [u.id, u]));
      const items: ModerationActionDTO[] = page.map((r) => ({
        id: r.id,
        actor: { id: r.actor_user_id, username: actorMap.get(r.actor_user_id)?.username ?? "", displayName: actorMap.get(r.actor_user_id)?.display_name ?? "" },
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        reason: r.reason,
        createdAt: toMs(r.created_at) ?? 0,
      }));
      return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
    },

    async restoreContent(actor, input) {
      await assertCan(actor, Abilities.moderationResolve, null, c);
      const at = new Date();
      await db.tx(async (tx) => {
        if (input.targetType === "discussion") {
          const d = await tx.select().from(discussions).where(eq(discussions.id, input.targetId)).get();
          if (!d) throw notFound("Discussion not found");
          await tx.update(discussions).set({ deleted_at: null, deleted_by: null, deletion_reason: null, updated_at: at }).where(eq(discussions.id, input.targetId));
        } else if (input.targetType === "reply") {
          const r = await tx.select().from(replies).where(eq(replies.id, input.targetId)).get();
          if (!r) throw notFound("Reply not found");
          await tx.update(replies).set({ deleted_at: null, deleted_by: null, deletion_reason: null, updated_at: at }).where(eq(replies.id, input.targetId));
        } else {
          throw conflict("Unsupported target type");
        }
        await tx.insert(moderationActions).values({
          actor_user_id: actor!.id,
          action: "content.restore",
          target_type: input.targetType,
          target_id: input.targetId,
          reason: input.reason ?? null,
        });
      });
    },
  };
}
