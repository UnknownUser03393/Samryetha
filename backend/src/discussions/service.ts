import { and, desc, eq, gt, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { DbProvider } from "../infrastructure/db/client.js";
import { emitEvent } from "../infrastructure/db/client.js";
import {
  attachments,
  boardMembers,
  boards,
  discussionFollows,
  discussionSaves,
  discussions,
  replies,
  userFollows,
  users,
  type BoardVisibility,
  type PostingPolicy,
} from "../infrastructure/db/schema.js";
import { Abilities, assertCan, can, type Actor, type AuthzCtx } from "../authz/can.js";
import { forbidden, notFound } from "../app/error.js";
import { renderMarkdown } from "../infrastructure/markdown.js";
import { makeHandle } from "../users/service.js";
import { toMs } from "../lib/time.js";
import type { BoardService } from "../boards/service.js";

const activityExpr = sql<number>`coalesce(${discussions.last_reply_at}, ${discussions.created_at})`;

export interface BoardRef {
  id: number;
  slug: string;
  name: string;
}

export interface AuthorRef {
  id: number;
  username: string;
  /** 展示用 handle，如 sora#1482 */
  handle: string;
  displayName: string;
}

export interface ThreadSummary {
  id: number;
  title: string;
  preview: string;
  board: BoardRef;
  author: AuthorRef;
  replyCount: number;
  isPinned: boolean;
  isLocked: boolean;
  createdAt: number;
  lastActivityAt: number;
}

export interface ReplyDTO {
  id: number;
  discussionId: number;
  parentReplyId: number | null;
  author: AuthorRef;
  bodyMarkdown: string;
  bodyHtml: string | null;
  isDeleted: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ReplyFeedItem extends ReplyDTO {
  discussionTitle: string;
}

export interface DiscussionDetail extends ThreadSummary {
  bodyMarkdown: string;
  bodyHtml: string | null;
  saveCount: number;
  isSaved: boolean;
  isFollowing: boolean;
  can: { update: boolean; delete: boolean };
}

export interface CreateDiscussionInput {
  boardSlug: string;
  title: string;
  bodyMarkdown: string;
  attachmentIds?: number[];
}

export interface DiscussionService {
  listDiscussions(viewer: Actor, opts: { feed?: "latest" | "followed" | "board"; boardSlug?: string; cursor?: string; limit?: number }): Promise<{ items: ThreadSummary[]; nextCursor: string | null }>;
  getDiscussion(viewer: Actor, id: number): Promise<DiscussionDetail>;
  createDiscussion(actor: Actor, input: CreateDiscussionInput): Promise<DiscussionDetail>;
  updateDiscussion(actor: Actor, id: number, patch: { title?: string; bodyMarkdown?: string }): Promise<DiscussionDetail>;
  deleteDiscussion(actor: Actor, id: number, reason?: string): Promise<void>;
  createReply(actor: Actor, discussionId: number, input: { bodyMarkdown: string; parentReplyId?: number | null }): Promise<ReplyDTO>;
  listReplies(viewer: Actor, discussionId: number): Promise<{ items: ReplyDTO[] }>;
  updateReply(actor: Actor, replyId: number, bodyMarkdown: string): Promise<ReplyDTO>;
  deleteReply(actor: Actor, replyId: number, reason?: string): Promise<void>;
  save(actor: Actor, discussionId: number): Promise<void>;
  unsave(actor: Actor, discussionId: number): Promise<void>;
  follow(actor: Actor, discussionId: number): Promise<void>;
  unfollow(actor: Actor, discussionId: number): Promise<void>;
  pin(actor: Actor, discussionId: number): Promise<void>;
  lock(actor: Actor, discussionId: number): Promise<void>;
  listByAuthor(viewer: Actor, authorId: number, opts: { cursor?: string; limit?: number }): Promise<{ items: ThreadSummary[]; nextCursor: string | null }>;
  listSaved(viewer: Actor, ownerId: number, opts: { cursor?: string; limit?: number }): Promise<{ items: ThreadSummary[]; nextCursor: string | null }>;
  listRepliesByAuthor(viewer: Actor, authorId: number, opts: { cursor?: string; limit?: number }): Promise<{ items: ReplyFeedItem[]; nextCursor: string | null }>;
}

function preview(md: string): string {
  const flat = md.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

function toAuthor(row: { id: number; username: string; display_name: string; discriminator: number | null }): AuthorRef {
  return { id: row.id, username: row.username, handle: makeHandle(row.username, row.discriminator), displayName: row.display_name };
}

export function createDiscussionService(db: DbProvider, boardService: BoardService, c: AuthzCtx): DiscussionService {
  async function visibleBoardIds(viewer: Actor): Promise<number[]> {
    const all = await db.db
      .select({ id: boards.id, visibility: boards.visibility })
      .from(boards)
      .where(isNull(boards.deleted_at));
    if (viewer && (viewer.role === "admin" || viewer.role === "moderator")) {
      return all.map((b) => b.id);
    }
    let memberBoardIds = new Set<number>();
    if (viewer) {
      const rows = await db.db.select().from(boardMembers).where(eq(boardMembers.user_id, viewer.id));
      memberBoardIds = new Set(rows.map((r) => r.board_id));
    }
    return all.filter((b) => b.visibility === "public" || memberBoardIds.has(b.id)).map((b) => b.id);
  }

  async function loadDetail(viewer: Actor, discussion: typeof discussions.$inferSelect): Promise<DiscussionDetail> {
    const [board, author, saved, following] = await Promise.all([
      db.db.select().from(boards).where(eq(boards.id, discussion.board_id)).get(),
      db.db.select().from(users).where(eq(users.id, discussion.author_id)).get(),
      viewer ? db.db.select().from(discussionSaves).where(and(eq(discussionSaves.user_id, viewer.id), eq(discussionSaves.discussion_id, discussion.id))).get() : Promise.resolve(undefined),
      viewer ? db.db.select().from(discussionFollows).where(and(eq(discussionFollows.user_id, viewer.id), eq(discussionFollows.discussion_id, discussion.id))).get() : Promise.resolve(undefined),
    ]);
    const boardRes: BoardRef = { id: board!.id, slug: board!.slug, name: board!.name };
    const boardAuthz = { type: "board" as const, id: board!.id, visibility: board!.visibility as BoardVisibility, postingPolicy: board!.posting_policy as PostingPolicy };
    const canUpdate = await can(viewer, Abilities.discussionUpdate, { type: "discussion", id: discussion.id, authorId: discussion.author_id, boardId: discussion.board_id, isLocked: discussion.is_locked, deletedAt: discussion.deleted_at }, c);
    const canDelete = await can(viewer, Abilities.discussionDelete, { type: "discussion", id: discussion.id, authorId: discussion.author_id, boardId: discussion.board_id, isLocked: discussion.is_locked, deletedAt: discussion.deleted_at }, c);
    void boardAuthz;
    const activity = discussion.last_reply_at ?? discussion.created_at;
    return {
      id: discussion.id,
      title: discussion.title,
      preview: preview(discussion.body_md),
      board: boardRes,
      author: toAuthor(author!),
      replyCount: discussion.reply_count,
      saveCount: discussion.save_count,
      isPinned: discussion.is_pinned === 1,
      isLocked: discussion.is_locked === 1,
      bodyMarkdown: discussion.body_md,
      bodyHtml: discussion.body_html,
      isSaved: !!saved,
      isFollowing: !!following,
      can: { update: canUpdate, delete: canDelete },
      createdAt: toMs(discussion.created_at) ?? 0,
      lastActivityAt: toMs(activity) ?? 0,
    };
  }

  async function getDiscussionRow(id: number) {
    const row = await db.db.select().from(discussions).where(eq(discussions.id, id)).get();
    return row;
  }

  // 把 discussions 行 hydrate 成 ThreadSummary（复用 listDiscussions 的构造逻辑）
  async function toThreadItems(
    rows: {
      id: number;
      title: string;
      body_md: string;
      reply_count: number;
      is_pinned: number;
      is_locked: number;
      created_at: Date;
      last_reply_at: Date | null;
      board_id: number;
      author_id: number;
    }[],
  ): Promise<ThreadSummary[]> {
    const boardIds = [...new Set(rows.map((r) => r.board_id))];
    const authorIds = [...new Set(rows.map((r) => r.author_id))];
    const [boardRows, authorRows] = await Promise.all([
      boardIds.length ? db.db.select().from(boards).where(inArray(boards.id, boardIds)) : Promise.resolve([]),
      authorIds.length ? db.db.select().from(users).where(inArray(users.id, authorIds)) : Promise.resolve([]),
    ]);
    const boardMap = new Map(boardRows.map((b) => [b.id, b]));
    const userMap = new Map(authorRows.map((u) => [u.id, u]));
    return rows.map((r) => {
      const activity = r.last_reply_at ?? r.created_at;
      const board = boardMap.get(r.board_id);
      const author = userMap.get(r.author_id);
      return {
        id: r.id,
        title: r.title,
        preview: preview(r.body_md),
        board: { id: r.board_id, slug: board?.slug ?? "", name: board?.name ?? "" },
        author: { id: r.author_id, username: author?.username ?? "", handle: author ? makeHandle(author.username, author.discriminator) : "", displayName: author?.display_name ?? "" },
        replyCount: r.reply_count,
        isPinned: r.is_pinned === 1,
        isLocked: r.is_locked === 1,
        createdAt: toMs(r.created_at) ?? 0,
        lastActivityAt: toMs(activity) ?? 0,
      } satisfies ThreadSummary;
    });
  }

  return {
    async listDiscussions(viewer, opts) {
      const limit = Math.min(opts.limit ?? 20, 50);
      const visible = await visibleBoardIds(viewer);
      const conds = [isNull(discussions.deleted_at), inArray(discussions.board_id, visible)];
      if (opts.boardSlug) {
        const board = await boardService.getBoardForAuthz(opts.boardSlug);
        if (!board) throw notFound("Board not found");
        conds.push(eq(discussions.board_id, board.id));
      }
      if (opts.cursor) {
        const [at, id] = opts.cursor.split("_").map(Number);
        conds.push(or(lt(activityExpr, at), and(eq(activityExpr, at), lt(discussions.id, id)))!);
      }
      // followed feed：我关注的用户发的帖 + 我关注的讨论
      if (opts.feed === "followed") {
        if (!viewer) return { items: [], nextCursor: null };
        const followingIds = (await db.db.select().from(userFollows).where(eq(userFollows.follower_id, viewer.id))).map((r) => r.followee_id);
        const followedDiscIds = (await db.db.select().from(discussionFollows).where(eq(discussionFollows.user_id, viewer.id))).map((r) => r.discussion_id);
        // 没有任何关注 → 空 feed（绝不能退化成全量）
        if (followingIds.length === 0 && followedDiscIds.length === 0) {
          return { items: [], nextCursor: null };
        }
        const followedCond = or(
          inArray(discussions.author_id, followingIds),
          inArray(discussions.id, followedDiscIds),
        );
        conds.push(followedCond!);
      }
      const rows = await db.db
        .select({
          id: discussions.id,
          title: discussions.title,
          body_md: discussions.body_md,
          reply_count: discussions.reply_count,
          is_pinned: discussions.is_pinned,
          is_locked: discussions.is_locked,
          created_at: discussions.created_at,
          last_reply_at: discussions.last_reply_at,
          board_id: discussions.board_id,
          author_id: discussions.author_id,
        })
        .from(discussions)
        .where(and(...conds))
        .orderBy(desc(activityExpr), desc(discussions.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const boardIds = [...new Set(page.map((r) => r.board_id))];
      const authorIds = [...new Set(page.map((r) => r.author_id))];
      const [boardRows, authorRows] = await Promise.all([
        boardIds.length ? db.db.select().from(boards).where(inArray(boards.id, boardIds)) : Promise.resolve([]),
        authorIds.length ? db.db.select().from(users).where(inArray(users.id, authorIds)) : Promise.resolve([]),
      ]);
      const boardMap = new Map(boardRows.map((b) => [b.id, b]));
      const userMap = new Map(authorRows.map((u) => [u.id, u]));
      const items = page.map((r) => {
        const activity = r.last_reply_at ?? r.created_at;
        const board = boardMap.get(r.board_id);
        const author = userMap.get(r.author_id);
        return {
          id: r.id,
          title: r.title,
          preview: preview(r.body_md),
          board: { id: r.board_id, slug: board?.slug ?? "", name: board?.name ?? "" },
          author: { id: r.author_id, username: author?.username ?? "", handle: author ? makeHandle(author.username, author.discriminator) : "", displayName: author?.display_name ?? "" },
          replyCount: r.reply_count,
          isPinned: r.is_pinned === 1,
          isLocked: r.is_locked === 1,
          createdAt: toMs(r.created_at) ?? 0,
          lastActivityAt: toMs(activity) ?? 0,
        } satisfies ThreadSummary;
      });
      const nextCursor = hasMore && items.length > 0 ? `${items[items.length - 1].lastActivityAt}_${items[items.length - 1].id}` : null;
      return { items, nextCursor };
    },

    async getDiscussion(viewer, id) {
      const discussion = await getDiscussionRow(id);
      if (!discussion || discussion.deleted_at) throw notFound("Discussion not found");
      const board = await db.db.select().from(boards).where(eq(boards.id, discussion.board_id)).get();
      if (!board) throw notFound("Board not found");
      await assertCan(viewer, Abilities.discussionRead, { type: "board", id: board.id, visibility: board.visibility, postingPolicy: board.posting_policy }, c);
      return loadDetail(viewer, discussion);
    },

    async createDiscussion(actor, input) {
      if (!actor) throw new Error("createDiscussion requires actor");
      const board = await boardService.getBoardForAuthz(input.boardSlug);
      if (!board) throw notFound("Board not found");
      await assertCan(actor, Abilities.discussionCreate, { type: "board", ...board }, c);
      const bodyHtml = renderMarkdown(input.bodyMarkdown);
      const id = await db.tx(async (tx) => {
        const [row] = await tx
          .insert(discussions)
          .values({
            board_id: board.id,
            author_id: actor.id,
            title: input.title,
            body_md: input.bodyMarkdown,
            body_html: bodyHtml,
          })
          .returning({ id: discussions.id });
        if (input.attachmentIds?.length) {
          await tx
            .update(attachments)
            .set({ discussion_id: row.id, state: "attached" })
            .where(and(inArray(attachments.id, input.attachmentIds), eq(attachments.uploader_id, actor.id)));
        }
        await emitEvent({
          type: "discussion.created",
          aggregate: { type: "discussion", id: String(row.id) },
          payload: { discussionId: row.id, boardId: board.id, authorId: actor.id, title: input.title },
        });
        return row.id;
      });
      return this.getDiscussion(actor, id);
    },

    async updateDiscussion(actor, id, patch) {
      const discussion = await getDiscussionRow(id);
      if (!discussion) throw notFound("Discussion not found");
      await assertCan(actor, Abilities.discussionUpdate, { type: "discussion", id, authorId: discussion.author_id, boardId: discussion.board_id, isLocked: discussion.is_locked, deletedAt: discussion.deleted_at }, c);
      const bodyHtml = patch.bodyMarkdown !== undefined ? renderMarkdown(patch.bodyMarkdown) : undefined;
      await db.db
        .update(discussions)
        .set({
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.bodyMarkdown !== undefined && { body_md: patch.bodyMarkdown, body_html: bodyHtml }),
          updated_at: new Date(),
        })
        .where(eq(discussions.id, id));
      return this.getDiscussion(actor, id);
    },

    async deleteDiscussion(actor, id, reason) {
      const discussion = await getDiscussionRow(id);
      if (!discussion) throw notFound("Discussion not found");
      await assertCan(actor, Abilities.discussionDelete, { type: "discussion", id, authorId: discussion.author_id, boardId: discussion.board_id, isLocked: discussion.is_locked, deletedAt: discussion.deleted_at }, c);
      await db.db
        .update(discussions)
        .set({ deleted_at: new Date(), deleted_by: actor?.id ?? null, deletion_reason: reason ?? null, updated_at: new Date() })
        .where(eq(discussions.id, id));
    },

    async createReply(actor, discussionId, input) {
      if (!actor) throw new Error("createReply requires actor");
      const discussion = await getDiscussionRow(discussionId);
      if (!discussion) throw notFound("Discussion not found");
      await assertCan(actor, Abilities.replyCreate, { type: "discussion", id: discussionId, authorId: discussion.author_id, boardId: discussion.board_id, isLocked: discussion.is_locked, deletedAt: discussion.deleted_at }, c);
      const bodyHtml = renderMarkdown(input.bodyMarkdown);
      const replyId = await db.tx(async (tx) => {
        const [row] = await tx
          .insert(replies)
          .values({
            discussion_id: discussionId,
            author_id: actor.id,
            parent_reply_id: input.parentReplyId ?? null,
            body_md: input.bodyMarkdown,
            body_html: bodyHtml,
          })
          .returning({ id: replies.id });
        await tx
          .update(discussions)
          .set({ reply_count: discussion.reply_count + 1, last_reply_at: new Date(), updated_at: new Date() })
          .where(eq(discussions.id, discussionId));
        await emitEvent({
          type: "reply.created",
          aggregate: { type: "discussion", id: String(discussionId) },
          payload: { discussionId, replyId: row.id, authorId: actor.id, parentReplyId: input.parentReplyId ?? null, title: discussion.title },
        });
        return row.id;
      });
      const row = await db.db.select().from(replies).where(eq(replies.id, replyId)).get();
      const author = await db.db.select().from(users).where(eq(users.id, actor.id)).get();
      return {
        id: row!.id,
        discussionId,
        parentReplyId: row!.parent_reply_id,
        author: toAuthor(author!),
        bodyMarkdown: row!.body_md,
        bodyHtml: row!.body_html,
        isDeleted: false,
        createdAt: toMs(row!.created_at) ?? 0,
        updatedAt: toMs(row!.updated_at) ?? 0,
      } satisfies ReplyDTO;
    },

    async listReplies(viewer, discussionId) {
      const discussion = await getDiscussionRow(discussionId);
      if (!discussion) throw notFound("Discussion not found");
      const board = await db.db.select().from(boards).where(eq(boards.id, discussion.board_id)).get();
      if (!board) throw notFound("Board not found");
      await assertCan(viewer, Abilities.discussionRead, { type: "board", id: board.id, visibility: board.visibility, postingPolicy: board.posting_policy }, c);
      const rows = await db.db
        .select({
          id: replies.id,
          parent_reply_id: replies.parent_reply_id,
          body_md: replies.body_md,
          body_html: replies.body_html,
          deleted_at: replies.deleted_at,
          created_at: replies.created_at,
          updated_at: replies.updated_at,
          author_id: replies.author_id,
        })
        .from(replies)
        .where(eq(replies.discussion_id, discussionId))
        .orderBy(replies.created_at);
      const authorIds = [...new Set(rows.map((r) => r.author_id))];
      const authorRows = authorIds.length ? await db.db.select().from(users).where(inArray(users.id, authorIds)) : [];
      const userMap = new Map(authorRows.map((u) => [u.id, u]));
      const items = rows.map((r) => {
        const author = userMap.get(r.author_id);
        return {
          id: r.id,
          discussionId,
          parentReplyId: r.parent_reply_id,
          author: { id: r.author_id, username: author?.username ?? "", handle: author ? makeHandle(author.username, author.discriminator) : "", displayName: author?.display_name ?? "" },
          bodyMarkdown: r.deleted_at ? "" : r.body_md,
          bodyHtml: r.deleted_at ? null : r.body_html,
          isDeleted: r.deleted_at !== null,
          createdAt: toMs(r.created_at) ?? 0,
          updatedAt: toMs(r.updated_at) ?? 0,
        };
      });
      return { items };
    },

    async updateReply(actor, replyId, bodyMarkdown) {
      const row = await db.db.select().from(replies).where(eq(replies.id, replyId)).get();
      if (!row) throw notFound("Reply not found");
      await assertCan(actor, Abilities.replyUpdate, { type: "reply", id: replyId, authorId: row.author_id, discussionId: row.discussion_id }, c);
      await db.db.update(replies).set({ body_md: bodyMarkdown, body_html: renderMarkdown(bodyMarkdown), updated_at: new Date() }).where(eq(replies.id, replyId));
      const updated = await db.db.select().from(replies).where(eq(replies.id, replyId)).get();
      const author = await db.db.select().from(users).where(eq(users.id, updated!.author_id)).get();
      return {
        id: updated!.id,
        discussionId: updated!.discussion_id,
        parentReplyId: updated!.parent_reply_id,
        author: toAuthor(author!),
        bodyMarkdown: updated!.body_md,
        bodyHtml: updated!.body_html,
        isDeleted: false,
        createdAt: toMs(updated!.created_at) ?? 0,
        updatedAt: toMs(updated!.updated_at) ?? 0,
      };
    },

    async deleteReply(actor, replyId, reason) {
      const row = await db.db.select().from(replies).where(eq(replies.id, replyId)).get();
      if (!row) throw notFound("Reply not found");
      await assertCan(actor, Abilities.replyDelete, { type: "reply", id: replyId, authorId: row.author_id, discussionId: row.discussion_id }, c);
      await db.db
        .update(replies)
        .set({ deleted_at: new Date(), deleted_by: actor?.id ?? null, deletion_reason: reason ?? null, updated_at: new Date() })
        .where(eq(replies.id, replyId));
      await db.db.update(discussions).set({ reply_count: sql`${discussions.reply_count} - 1` }).where(eq(discussions.id, row.discussion_id));
    },

    async save(actor, discussionId) {
      if (!actor) throw new Error("requires actor");
      const existing = await db.db.select().from(discussionSaves).where(and(eq(discussionSaves.user_id, actor.id), eq(discussionSaves.discussion_id, discussionId))).get();
      if (existing) return;
      await db.tx(async (tx) => {
        await tx.insert(discussionSaves).values({ user_id: actor.id, discussion_id: discussionId });
        await tx.update(discussions).set({ save_count: sql`${discussions.save_count} + 1` }).where(eq(discussions.id, discussionId));
        await emitEvent({ type: "discussion.saved", aggregate: { type: "discussion", id: String(discussionId) }, payload: { discussionId, userId: actor.id } });
      });
    },

    async unsave(actor, discussionId) {
      if (!actor) throw new Error("requires actor");
      const existing = await db.db.select().from(discussionSaves).where(and(eq(discussionSaves.user_id, actor.id), eq(discussionSaves.discussion_id, discussionId))).get();
      if (!existing) return;
      await db.tx(async (tx) => {
        await tx.delete(discussionSaves).where(and(eq(discussionSaves.user_id, actor.id), eq(discussionSaves.discussion_id, discussionId)));
        await tx.update(discussions).set({ save_count: sql`max(${discussions.save_count} - 1, 0)` }).where(eq(discussions.id, discussionId));
      });
    },

    async follow(actor, discussionId) {
      if (!actor) throw new Error("requires actor");
      const existing = await db.db.select().from(discussionFollows).where(and(eq(discussionFollows.user_id, actor.id), eq(discussionFollows.discussion_id, discussionId))).get();
      if (existing) return;
      await db.tx(async (tx) => {
        await tx.insert(discussionFollows).values({ user_id: actor.id, discussion_id: discussionId });
        await emitEvent({ type: "discussion.followed", aggregate: { type: "discussion", id: String(discussionId) }, payload: { discussionId, userId: actor.id } });
      });
    },

    async unfollow(actor, discussionId) {
      if (!actor) throw new Error("requires actor");
      await db.db.delete(discussionFollows).where(and(eq(discussionFollows.user_id, actor.id), eq(discussionFollows.discussion_id, discussionId)));
    },

    async pin(actor, discussionId) {
      const discussion = await getDiscussionRow(discussionId);
      if (!discussion) throw notFound("Discussion not found");
      await assertCan(actor, Abilities.discussionPin, { type: "discussion", id: discussionId, authorId: discussion.author_id, boardId: discussion.board_id, isLocked: discussion.is_locked, deletedAt: discussion.deleted_at }, c);
      await db.db.update(discussions).set({ is_pinned: discussion.is_pinned === 1 ? 0 : 1 }).where(eq(discussions.id, discussionId));
    },

    async lock(actor, discussionId) {
      const discussion = await getDiscussionRow(discussionId);
      if (!discussion) throw notFound("Discussion not found");
      await assertCan(actor, Abilities.discussionLock, { type: "discussion", id: discussionId, authorId: discussion.author_id, boardId: discussion.board_id, isLocked: discussion.is_locked, deletedAt: discussion.deleted_at }, c);
      await db.db.update(discussions).set({ is_locked: discussion.is_locked === 1 ? 0 : 1 }).where(eq(discussions.id, discussionId));
    },

    // 某用户发的帖子 feed（可见性/软删过滤，游标分页）
    async listByAuthor(viewer, authorId, opts) {
      const limit = Math.min(opts.limit ?? 20, 50);
      const visible = await visibleBoardIds(viewer);
      const conds: SQL[] = [
        isNull(discussions.deleted_at),
        inArray(discussions.board_id, visible),
        eq(discussions.author_id, authorId),
      ];
      if (opts.cursor) {
        const [at, id] = opts.cursor.split("_").map(Number);
        conds.push(or(lt(activityExpr, at), and(eq(activityExpr, at), lt(discussions.id, id)))!);
      }
      const rows = await db.db
        .select({
          id: discussions.id,
          title: discussions.title,
          body_md: discussions.body_md,
          reply_count: discussions.reply_count,
          is_pinned: discussions.is_pinned,
          is_locked: discussions.is_locked,
          created_at: discussions.created_at,
          last_reply_at: discussions.last_reply_at,
          board_id: discussions.board_id,
          author_id: discussions.author_id,
        })
        .from(discussions)
        .where(and(...conds))
        .orderBy(desc(activityExpr), desc(discussions.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const items = await toThreadItems(page);
      const nextCursor = hasMore && items.length > 0 ? `${items[items.length - 1].lastActivityAt}_${items[items.length - 1].id}` : null;
      return { items, nextCursor };
    },

    // 某用户的收藏 feed（仅本人可见，他人 403）
    async listSaved(viewer, ownerId, opts) {
      if (!viewer || viewer.id !== ownerId) throw forbidden("Saved discussions are private");
      const limit = Math.min(opts.limit ?? 20, 50);
      const saveRows = await db.db.select({ discussion_id: discussionSaves.discussion_id }).from(discussionSaves).where(eq(discussionSaves.user_id, ownerId));
      const ids = saveRows.map((r) => r.discussion_id);
      if (ids.length === 0) return { items: [], nextCursor: null };
      const visible = await visibleBoardIds(viewer);
      const conds: SQL[] = [isNull(discussions.deleted_at), inArray(discussions.id, ids), inArray(discussions.board_id, visible)];
      if (opts.cursor) {
        const [at, id] = opts.cursor.split("_").map(Number);
        conds.push(or(lt(activityExpr, at), and(eq(activityExpr, at), lt(discussions.id, id)))!);
      }
      const rows = await db.db
        .select({
          id: discussions.id,
          title: discussions.title,
          body_md: discussions.body_md,
          reply_count: discussions.reply_count,
          is_pinned: discussions.is_pinned,
          is_locked: discussions.is_locked,
          created_at: discussions.created_at,
          last_reply_at: discussions.last_reply_at,
          board_id: discussions.board_id,
          author_id: discussions.author_id,
        })
        .from(discussions)
        .where(and(...conds))
        .orderBy(desc(activityExpr), desc(discussions.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const items = await toThreadItems(page);
      const nextCursor = hasMore && items.length > 0 ? `${items[items.length - 1].lastActivityAt}_${items[items.length - 1].id}` : null;
      return { items, nextCursor };
    },

    // 某用户的回复 feed（带所在讨论标题，仅可见讨论内的回复）
    async listRepliesByAuthor(viewer, authorId, opts) {
      const limit = Math.min(opts.limit ?? 20, 50);
      const visible = await visibleBoardIds(viewer);
      const discRows = await db.db.select({ id: discussions.id }).from(discussions).where(and(isNull(discussions.deleted_at), inArray(discussions.board_id, visible)));
      const discIds = discRows.map((r) => r.id);
      if (discIds.length === 0) return { items: [], nextCursor: null };
      const conds: SQL[] = [eq(replies.author_id, authorId), isNull(replies.deleted_at), inArray(replies.discussion_id, discIds)];
      if (opts.cursor) {
        const id = Number(opts.cursor);
        if (!Number.isNaN(id)) conds.push(lt(replies.id, id));
      }
      const rows = await db.db
        .select({
          id: replies.id,
          discussion_id: replies.discussion_id,
          parent_reply_id: replies.parent_reply_id,
          body_md: replies.body_md,
          body_html: replies.body_html,
          created_at: replies.created_at,
          updated_at: replies.updated_at,
          author_id: replies.author_id,
        })
        .from(replies)
        .where(and(...conds))
        .orderBy(desc(replies.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const dIds = [...new Set(page.map((r) => r.discussion_id))];
      const aIds = [...new Set(page.map((r) => r.author_id))];
      const [dRows, aRows] = await Promise.all([
        dIds.length ? db.db.select().from(discussions).where(inArray(discussions.id, dIds)) : Promise.resolve([]),
        aIds.length ? db.db.select().from(users).where(inArray(users.id, aIds)) : Promise.resolve([]),
      ]);
      const dMap = new Map(dRows.map((d) => [d.id, d]));
      const aMap = new Map(aRows.map((u) => [u.id, u]));
      const items: ReplyFeedItem[] = page.map((r) => {
        const author = aMap.get(r.author_id);
        return {
          id: r.id,
          discussionId: r.discussion_id,
          parentReplyId: r.parent_reply_id,
          author: { id: r.author_id, username: author?.username ?? "", handle: author ? makeHandle(author.username, author.discriminator) : "", displayName: author?.display_name ?? "" },
          bodyMarkdown: r.body_md,
          bodyHtml: r.body_html,
          isDeleted: false,
          createdAt: toMs(r.created_at) ?? 0,
          updatedAt: toMs(r.updated_at) ?? 0,
          discussionTitle: dMap.get(r.discussion_id)?.title ?? "",
        };
      });
      const nextCursor = hasMore && items.length > 0 ? String(items[items.length - 1].id) : null;
      return { items, nextCursor };
    },
  };
}
