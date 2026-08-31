import { and, count, desc, eq, inArray, isNull, like, or } from "drizzle-orm";
import type { DbProvider } from "../infrastructure/db/client.js";
import { boardMembers, boards, discussions, users } from "../infrastructure/db/schema.js";
import type { Actor } from "../authz/can.js";
import { makeHandle } from "../users/service.js";

export interface SearchResultItem {
  id: number;
  title: string;
  preview: string;
  board: { id: number; slug: string; name: string };
  author: { id: number; username: string; handle: string; displayName: string };
  replyCount: number;
  isPinned: boolean;
  isLocked: boolean;
  createdAt: number;
  lastActivityAt: number;
}

export interface SearchService {
  searchDiscussions(viewer: Actor, opts: { q: string; boardSlug?: string; limit?: number }): Promise<{ items: SearchResultItem[]; total: number }>;
}

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

export function createSearchService(db: DbProvider): SearchService {
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

  return {
    async searchDiscussions(viewer, opts) {
      const q = escapeLike(opts.q.trim().slice(0, 100));
      const limit = Math.min(opts.limit ?? 20, 50);
      const visible = await visibleBoardIds(viewer);
      // SQLite 无 FTS5 → LIKE 子串匹配（中文逐字符命中）
      const match = or(like(discussions.title, `%${q}%`), like(discussions.body_md, `%${q}%`))!;
      const conds = [isNull(discussions.deleted_at), inArray(discussions.board_id, visible), match];
      if (opts.boardSlug) {
        const board = await db.db.select().from(boards).where(eq(boards.slug, opts.boardSlug)).get();
        if (board) conds.push(eq(discussions.board_id, board.id));
      }

      const totalRow = await db.db
        .select({ c: count() })
        .from(discussions)
        .where(and(...conds))
        .get();
      const total = totalRow?.c ?? 0;

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
        .orderBy(desc(discussions.last_reply_at), desc(discussions.created_at), desc(discussions.id))
        .limit(limit);

      const boardIds = [...new Set(rows.map((r) => r.board_id))];
      const authorIds = [...new Set(rows.map((r) => r.author_id))];
      const [boardRows, authorRows] = await Promise.all([
        boardIds.length ? db.db.select().from(boards).where(inArray(boards.id, boardIds)) : Promise.resolve([]),
        authorIds.length ? db.db.select().from(users).where(inArray(users.id, authorIds)) : Promise.resolve([]),
      ]);
      const boardMap = new Map(boardRows.map((b) => [b.id, b]));
      const userMap = new Map(authorRows.map((u) => [u.id, u]));

      const items: SearchResultItem[] = rows.map((r) => {
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
          lastActivityAt: toMs(r.last_reply_at ?? r.created_at) ?? 0,
        };
      });
      return { items, total };
    },
  };
}
