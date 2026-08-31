import { and, eq, inArray, isNull, max } from "drizzle-orm";
import type { DbProvider, Tx } from "../infrastructure/db/client.js";
import {
  feedbackItems,
  feedbackProjectMembers,
  feedbackProjects,
  users,
  type FeedbackType,
  type FeedbackUrgency,
  type FeedbackStatus,
} from "../infrastructure/db/schema.js";
import { notFound } from "../app/error.js";
import { makeHandle } from "../users/service.js";

/** 反馈作者引用，与讨论模块的 AuthorRef 同形。 */
export interface FeedbackAuthor {
  id: number;
  username: string;
  handle: string;
  displayName: string;
}

export interface FeedbackItemDTO {
  id: number;
  seq: number;
  projectId: number;
  author: FeedbackAuthor;
  title: string;
  detail: string;
  type: FeedbackType;
  urgency: FeedbackUrgency;
  status: FeedbackStatus;
  closedAt: number | null;
  editedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface FeedbackProjectSummary {
  id: number;
  name: string;
  description: string;
  memberCount: number;
  isProgrammer: boolean;
  createdAt: number;
}

export interface FeedbackProjectMember {
  userId: number;
  username: string;
  handle: string;
  displayName: string;
  isProgrammer: boolean;
  joinedAt: number;
}

export interface FeedbackProjectAdmin {
  id: number;
  name: string;
  description: string;
  members: FeedbackProjectMember[];
  createdAt: number;
}

export interface FeedbackProjectInput {
  name: string;
  description?: string;
}

export interface MemberInput {
  userId: number;
  isProgrammer: boolean;
}

type ItemRow = typeof feedbackItems.$inferSelect;
type UserRow = typeof users.$inferSelect;

export interface FeedbackService {
  listMyProjects(viewerId: number, isAdmin: boolean): Promise<FeedbackProjectSummary[]>;
  listProjectsForAdmin(): Promise<FeedbackProjectAdmin[]>;
  getProjectForAuthz(id: number): Promise<{ id: number } | undefined>;
  createProject(actorId: number, input: FeedbackProjectInput): Promise<FeedbackProjectAdmin>;
  updateProject(id: number, patch: { name?: string; description?: string }): Promise<void>;
  deleteProject(actorId: number, id: number): Promise<void>;
  setProjectMembers(id: number, members: MemberInput[]): Promise<void>;
  listFeedback(viewerId: number, isAdmin: boolean, projectId: number): Promise<{ items: FeedbackItemDTO[]; canManage: boolean }>;
  createFeedback(
    actorId: number,
    input: { projectId: number; title: string; detail?: string; type: FeedbackType; urgency?: FeedbackUrgency },
  ): Promise<FeedbackItemDTO>;
  updateFeedback(
    id: number,
    patch: { title?: string; detail?: string; type?: FeedbackType; urgency?: FeedbackUrgency },
  ): Promise<FeedbackItemDTO>;
  deleteFeedback(actorId: number, id: number): Promise<void>;
  setFeedbackStatus(id: number, status: FeedbackStatus): Promise<FeedbackItemDTO>;
  getItemForAuthz(id: number): Promise<{ id: number; projectId: number; authorId: number; deletedAt: Date | null } | undefined>;
  /** Agent API 专用：不校验会话权限，由调用方保证 api-key 已鉴权。 */
  listFeedbackForAgent(projectId?: number): Promise<FeedbackItemDTO[]>;
  getFeedbackForAgent(id: number): Promise<FeedbackItemDTO | undefined>;
}

export function createFeedbackService(db: DbProvider): FeedbackService {
  function toDTO(it: ItemRow, author: UserRow | undefined): FeedbackItemDTO {
    return {
      id: it.id,
      seq: it.seq,
      projectId: it.project_id,
      author: { id: it.author_id, username: author?.username ?? "", handle: author ? makeHandle(author.username, author.discriminator) : "", displayName: author?.display_name ?? "" },
      title: it.title,
      detail: it.detail,
      type: it.type,
      urgency: it.urgency,
      status: it.status,
      closedAt: it.closed_at ? it.closed_at.getTime() : null,
      editedAt: it.edited_at ? it.edited_at.getTime() : null,
      createdAt: it.created_at.getTime(),
      updatedAt: it.updated_at.getTime(),
    };
  }

  /** 补作者：先查条目主体列，再按 author_id 批量查用户——避免双表联表时重名列错位。 */
  async function withAuthors(items: ItemRow[]): Promise<FeedbackItemDTO[]> {
    if (!items.length) return [];
    const authorIds = [...new Set(items.map((i) => i.author_id))];
    const authorRows = await db.db.select().from(users).where(inArray(users.id, authorIds));
    const userMap = new Map(authorRows.map((u) => [u.id, u]));
    return items.map((it) => toDTO(it, userMap.get(it.author_id)));
  }

  async function itemById(id: number): Promise<FeedbackItemDTO | undefined> {
    const it = await db.db
      .select()
      .from(feedbackItems)
      .where(and(eq(feedbackItems.id, id), isNull(feedbackItems.deleted_at)))
      .get();
    if (!it) return undefined;
    const author = await db.db.select().from(users).where(eq(users.id, it.author_id)).get();
    return toDTO(it, author);
  }

  async function listItems(projectId?: number): Promise<FeedbackItemDTO[]> {
    const rows = await db.db
      .select()
      .from(feedbackItems)
      .where(
        and(
          isNull(feedbackItems.deleted_at),
          projectId ? eq(feedbackItems.project_id, projectId) : undefined,
        ),
      )
      .orderBy(feedbackItems.created_at);
    return withAuthors(rows);
  }

  async function projectById(id: number) {
    return db.db
      .select()
      .from(feedbackProjects)
      .where(and(eq(feedbackProjects.id, id), isNull(feedbackProjects.deleted_at)))
      .get();
  }

  async function membersOf(projectId: number): Promise<FeedbackProjectMember[]> {
    const rows = await db.db
      .select({
        userId: feedbackProjectMembers.user_id,
        username: users.username,
        discriminator: users.discriminator,
        displayName: users.display_name,
        isProgrammer: feedbackProjectMembers.is_programmer,
        joinedAt: feedbackProjectMembers.joined_at,
      })
      .from(feedbackProjectMembers)
      .innerJoin(users, eq(users.id, feedbackProjectMembers.user_id))
      .where(eq(feedbackProjectMembers.project_id, projectId));
    return rows.map((r) => ({ ...r, handle: makeHandle(r.username, r.discriminator), isProgrammer: Boolean(r.isProgrammer), joinedAt: r.joinedAt.getTime() }));
  }

  /** 项目内下一个序号：max(seq)+1，靠 (project_id, seq) 唯一索引兜底并发。 */
  async function nextSeq(tx: Tx, projectId: number): Promise<number> {
    const row = await tx
      .select({ m: max(feedbackItems.seq) })
      .from(feedbackItems)
      .where(eq(feedbackItems.project_id, projectId))
      .get();
    return (row?.m ?? 0) + 1;
  }

  return {
    async listMyProjects(viewerId, isAdmin) {
      const projects = await db.db
        .select()
        .from(feedbackProjects)
        .where(isNull(feedbackProjects.deleted_at))
        .orderBy(feedbackProjects.name);
      const result: FeedbackProjectSummary[] = [];
      for (const p of projects) {
        const memberRows = await membersOf(p.id);
        const mine = memberRows.find((m) => m.userId === viewerId);
        if (!mine && !isAdmin) continue;
        result.push({
          id: p.id,
          name: p.name,
          description: p.description,
          memberCount: memberRows.length,
          isProgrammer: isAdmin || Boolean(mine?.isProgrammer),
          createdAt: p.created_at.getTime(),
        });
      }
      return result;
    },

    async listProjectsForAdmin() {
      const projects = await db.db
        .select()
        .from(feedbackProjects)
        .where(isNull(feedbackProjects.deleted_at))
        .orderBy(feedbackProjects.created_at);
      const result: FeedbackProjectAdmin[] = [];
      for (const p of projects) {
        result.push({
          id: p.id,
          name: p.name,
          description: p.description,
          members: await membersOf(p.id),
          createdAt: p.created_at.getTime(),
        });
      }
      return result;
    },

    async getProjectForAuthz(id) {
      const p = await projectById(id);
      return p ? { id: p.id } : undefined;
    },

    async createProject(actorId, input) {
      const id = await db.tx(async (tx) => {
        const [row] = await tx
          .insert(feedbackProjects)
          .values({ name: input.name, description: input.description ?? "", created_by_user_id: actorId })
          .returning({ id: feedbackProjects.id });
        return row.id;
      });
      const created = await projectById(id);
      if (!created) throw notFound("Project not found");
      return {
        id: created.id,
        name: created.name,
        description: created.description,
        members: await membersOf(created.id),
        createdAt: created.created_at.getTime(),
      };
    },

    async updateProject(id, patch) {
      const project = await projectById(id);
      if (!project) throw notFound("Project not found");
      await db.db
        .update(feedbackProjects)
        .set({
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.description !== undefined && { description: patch.description }),
          updated_at: new Date(),
        })
        .where(eq(feedbackProjects.id, id));
    },

    async deleteProject(actorId, id) {
      const project = await projectById(id);
      if (!project) throw notFound("Project not found");
      await db.tx(async (tx) => {
        await tx
          .update(feedbackProjects)
          .set({ deleted_at: new Date(), deleted_by: actorId, updated_at: new Date() })
          .where(eq(feedbackProjects.id, id));
        await tx
          .update(feedbackItems)
          .set({ deleted_at: new Date(), deleted_by: actorId, updated_at: new Date() })
          .where(eq(feedbackItems.project_id, id));
      });
    },

    async setProjectMembers(id, members) {
      const project = await projectById(id);
      if (!project) throw notFound("Project not found");
      await db.tx(async (tx) => {
        await tx.delete(feedbackProjectMembers).where(eq(feedbackProjectMembers.project_id, id));
        if (members.length) {
          await tx.insert(feedbackProjectMembers).values(
            members.map((m) => ({ project_id: id, user_id: m.userId, is_programmer: m.isProgrammer ? 1 : 0 })),
          );
        }
      });
    },

    async listFeedback(viewerId, isAdmin, projectId) {
      const items = await listItems(projectId);
      const member = await db.db
        .select()
        .from(feedbackProjectMembers)
        .where(and(eq(feedbackProjectMembers.project_id, projectId), eq(feedbackProjectMembers.user_id, viewerId)))
        .get();
      return { items, canManage: isAdmin || Boolean(member?.is_programmer) };
    },

    async createFeedback(actorId, input) {
      const id = await db.tx(async (tx) => {
        const s = await nextSeq(tx, input.projectId);
        const [row] = await tx
          .insert(feedbackItems)
          .values({
            project_id: input.projectId,
            author_id: actorId,
            seq: s,
            title: input.title,
            detail: input.detail ?? "",
            type: input.type,
            urgency: input.urgency ?? "normal",
          })
          .returning({ id: feedbackItems.id });
        return row.id;
      });
      const created = await itemById(id);
      if (!created) throw notFound("Feedback item not found");
      return created;
    },

    async updateFeedback(id, patch) {
      const row = await itemById(id);
      if (!row) throw notFound("Feedback item not found");
      const now = new Date();
      await db.db
        .update(feedbackItems)
        .set({
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.detail !== undefined && { detail: patch.detail }),
          ...(patch.type !== undefined && { type: patch.type }),
          ...(patch.urgency !== undefined && { urgency: patch.urgency }),
          edited_at: now,
          updated_at: now,
        })
        .where(eq(feedbackItems.id, id));
      const updated = await itemById(id);
      return updated!;
    },

    async deleteFeedback(actorId, id) {
      const row = await itemById(id);
      if (!row) throw notFound("Feedback item not found");
      await db.db
        .update(feedbackItems)
        .set({ deleted_at: new Date(), deleted_by: actorId, updated_at: new Date() })
        .where(eq(feedbackItems.id, id));
    },

    async setFeedbackStatus(id, status) {
      const row = await itemById(id);
      if (!row) throw notFound("Feedback item not found");
      const now = new Date();
      await db.db
        .update(feedbackItems)
        .set({
          status,
          closed_at: status === "open" ? null : now,
          updated_at: now,
        })
        .where(eq(feedbackItems.id, id));
      const updated = await itemById(id);
      return updated!;
    },

    async getItemForAuthz(id) {
      const row = await db.db
        .select({
          id: feedbackItems.id,
          projectId: feedbackItems.project_id,
          authorId: feedbackItems.author_id,
          deletedAt: feedbackItems.deleted_at,
        })
        .from(feedbackItems)
        .where(eq(feedbackItems.id, id))
        .get();
      return row ?? undefined;
    },

    async listFeedbackForAgent(projectId) {
      return listItems(projectId);
    },

    async getFeedbackForAgent(id) {
      return itemById(id);
    },
  };
}
