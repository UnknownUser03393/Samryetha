import { and, count, eq, gte, inArray, isNull } from "drizzle-orm";
import type { DbProvider } from "../infrastructure/db/client.js";
import {
  boardMembers,
  boards,
  discussions,
  users,
  type BoardVisibility,
  type PostingPolicy,
} from "../infrastructure/db/schema.js";
import { conflict, notFound } from "../app/error.js";
import { makeHandle } from "../users/service.js";

export interface BoardSummary {
  id: number;
  slug: string;
  name: string;
  description: string;
  visibility: BoardVisibility;
  postingPolicy: PostingPolicy;
  memberCount: number;
  todayActivity: number;
  currentUserRole: "member" | "moderator" | null;
}

export type BoardRow = typeof boards.$inferSelect;

export interface BoardInput {
  name: string;
  slug: string;
  description?: string;
  visibility?: BoardVisibility;
  postingPolicy?: PostingPolicy;
}

/** 板块可见性判定所需的最小 viewer 信息 */
// Minimal viewer info required for board visibility checks
export interface BoardViewer {
  id: number;
  role: string;
}

export interface BoardService {
  listBoards(viewer: BoardViewer | null): Promise<BoardSummary[]>;
  getBoard(viewer: BoardViewer | null, slug: string): Promise<BoardSummary>;
  getBoardForAuthz(slug: string): Promise<{ id: number; visibility: BoardVisibility; postingPolicy: PostingPolicy } | undefined>;
  createBoard(actorId: number, input: BoardInput): Promise<BoardSummary>;
  updateBoard(actorId: number, slug: string, patch: Partial<BoardInput>): Promise<BoardSummary>;
  deleteBoard(actorId: number, slug: string, reason?: string): Promise<void>;
  joinBoard(userId: number, slug: string): Promise<void>;
  leaveBoard(userId: number, slug: string): Promise<void>;
  listMembers(viewer: BoardViewer | null, slug: string): Promise<{ id: number; username: string; handle: string; displayName: string; role: string }[]>;
  updateMemberRole(actorId: number, slug: string, userId: number, role: "member" | "moderator"): Promise<void>;
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

export function createBoardService(db: DbProvider): BoardService {
  async function loadSummary(board: BoardRow, viewerId: number | null): Promise<BoardSummary> {
    const [memberRow, activityRow, roleRow] = await Promise.all([
      db.db.select({ c: count() }).from(boardMembers).where(eq(boardMembers.board_id, board.id)).get(),
      db.db
        .select({ c: count() })
        .from(discussions)
        .where(and(eq(discussions.board_id, board.id), gte(discussions.created_at, startOfToday()), isNull(discussions.deleted_at)))
        .get(),
      viewerId
        ? db.db
            .select()
            .from(boardMembers)
            .where(and(eq(boardMembers.board_id, board.id), eq(boardMembers.user_id, viewerId)))
            .get()
        : Promise.resolve(undefined),
    ]);
    return {
      id: board.id,
      slug: board.slug,
      name: board.name,
      description: board.description,
      visibility: board.visibility,
      postingPolicy: board.posting_policy,
      memberCount: memberRow?.c ?? 0,
      todayActivity: activityRow?.c ?? 0,
      currentUserRole: roleRow ? roleRow.role : null,
    };
  }

  async function getBySlug(slug: string) {
    return db.db.select().from(boards).where(and(eq(boards.slug, slug), isNull(boards.deleted_at))).get();
  }

  // 按 viewer 过滤可见板块：全局 mod/admin 全见，其余仅 public 或本人加入的板块
  // Filter boards by viewer: global mod/admin see all, others see public boards plus boards they joined
  async function visibleBoardRows(viewer: BoardViewer | null): Promise<BoardRow[]> {
    const rows = await db.db.select().from(boards).where(isNull(boards.deleted_at));
    if (viewer && (viewer.role === "admin" || viewer.role === "moderator")) return rows;
    let memberIds = new Set<number>();
    if (viewer) {
      const memberRows = await db.db.select().from(boardMembers).where(eq(boardMembers.user_id, viewer.id));
      memberIds = new Set(memberRows.map((m) => m.board_id));
    }
    return rows.filter((b) => b.visibility === "public" || memberIds.has(b.id));
  }

  return {
    async listBoards(viewer) {
      const rows = await visibleBoardRows(viewer);
      return Promise.all(rows.map((b) => loadSummary(b, viewer?.id ?? null)));
    },

    async getBoard(viewer, slug) {
      const board = await getBySlug(slug);
      if (!board) throw notFound("Board not found");
      const visible = await visibleBoardRows(viewer);
      if (!visible.some((b) => b.id === board.id)) throw notFound("Board not found");
      return loadSummary(board, viewer?.id ?? null);
    },

    async getBoardForAuthz(slug) {
      const board = await getBySlug(slug);
      return board ? { id: board.id, visibility: board.visibility, postingPolicy: board.posting_policy } : undefined;
    },

    async createBoard(actorId, input) {
      const slug = input.slug.trim().toLowerCase().replace(/\s+/g, "-");
      const dup = await getBySlug(slug);
      if (dup) throw conflict("Board slug already exists");
      const boardId = await db.tx(async (tx) => {
        const [row] = await tx
          .insert(boards)
          .values({
            slug,
            name: input.name,
            description: input.description ?? "",
            visibility: input.visibility ?? "public",
            posting_policy: input.postingPolicy ?? "members",
            created_by_user_id: actorId,
          })
          .returning({ id: boards.id });
        await tx.insert(boardMembers).values({ board_id: row.id, user_id: actorId, role: "moderator" });
        return row.id;
      });
      const created = await getBySlug(slug);
      return loadSummary(created!, null);
    },

    async updateBoard(actorId, slug, patch) {
      const board = await getBySlug(slug);
      if (!board) throw notFound("Board not found");
      await db.db
        .update(boards)
        .set({
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.visibility !== undefined && { visibility: patch.visibility }),
          ...(patch.postingPolicy !== undefined && { posting_policy: patch.postingPolicy }),
          updated_at: new Date(),
        })
        .where(eq(boards.id, board.id));
      const updated = await getBySlug(slug);
      return loadSummary(updated!, null);
    },

    async deleteBoard(actorId, slug, reason) {
      const board = await getBySlug(slug);
      if (!board) throw notFound("Board not found");
      await db.db
        .update(boards)
        .set({ deleted_at: new Date(), deleted_by: actorId, deletion_reason: reason ?? null, updated_at: new Date() })
        .where(eq(boards.id, board.id));
    },

    async joinBoard(userId, slug) {
      const board = await getBySlug(slug);
      if (!board) throw notFound("Board not found");
      const existing = await db.db
        .select()
        .from(boardMembers)
        .where(and(eq(boardMembers.board_id, board.id), eq(boardMembers.user_id, userId)))
        .get();
      if (existing) throw conflict("Already a member");
      await db.db.insert(boardMembers).values({ board_id: board.id, user_id: userId, role: "member" });
    },

    async leaveBoard(userId, slug) {
      const board = await getBySlug(slug);
      if (!board) throw notFound("Board not found");
      await db.db
        .delete(boardMembers)
        .where(and(eq(boardMembers.board_id, board.id), eq(boardMembers.user_id, userId)));
    },

    async listMembers(viewer, slug) {
      const board = await getBySlug(slug);
      if (!board) throw notFound("Board not found");
      const visible = await visibleBoardRows(viewer);
      if (!visible.some((b) => b.id === board.id)) throw notFound("Board not found");
      const rows = await db.db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.display_name,
          discriminator: users.discriminator,
          role: boardMembers.role,
        })
        .from(boardMembers)
        .innerJoin(users, eq(boardMembers.user_id, users.id))
        .where(eq(boardMembers.board_id, board.id));
      return rows.map((r) => ({ id: r.id, username: r.username, handle: makeHandle(r.username, r.discriminator), displayName: r.displayName, role: r.role }));
    },

    async updateMemberRole(actorId, slug, userId, role) {
      const board = await getBySlug(slug);
      if (!board) throw notFound("Board not found");
      const existing = await db.db
        .select()
        .from(boardMembers)
        .where(and(eq(boardMembers.board_id, board.id), eq(boardMembers.user_id, userId)))
        .get();
      if (!existing) throw notFound("User is not a member of this board");
      await db.db
        .update(boardMembers)
        .set({ role })
        .where(and(eq(boardMembers.board_id, board.id), eq(boardMembers.user_id, userId)));
    },
  };
}
