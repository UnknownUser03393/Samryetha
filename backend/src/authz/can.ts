import { and, eq } from "drizzle-orm";
import type { SessionUser } from "../app/auth-hook.js";
import type { DbProvider } from "../infrastructure/db/client.js";
import { forbidden } from "../app/error.js";
import { boardMembers, feedbackProjectMembers } from "../infrastructure/db/schema.js";
import type { BoardVisibility, PostingPolicy } from "../infrastructure/db/schema.js";

/** 授权查询所需的最小上下文。 */
export interface AuthzCtx {
  db: DbProvider;
}

/** 能力常量：全站授权唯一入口，业务代码禁止散落 `user.role ===` 判断。 */
export const Abilities = {
  boardCreate: "board.create",
  boardUpdate: "board.update",
  boardDelete: "board.delete",
  boardManageMembers: "board.manage_members",
  boardJoin: "board.join",
  discussionCreate: "discussion.create",
  discussionRead: "discussion.read",
  discussionUpdate: "discussion.update",
  discussionDelete: "discussion.delete",
  discussionPin: "discussion.pin",
  discussionLock: "discussion.lock",
  replyCreate: "reply.create",
  replyUpdate: "reply.update",
  replyDelete: "reply.delete",
  userUpdateSelf: "user.update.self",
  userFollow: "user.follow",
  reportCreate: "report.create",
  attachmentCreate: "attachment.create",
  attachmentDelete: "attachment.delete",
  presenceHeartbeat: "presence.heartbeat",
  moderationView: "moderation.view",
  moderationResolve: "moderation.resolve",
  userBan: "user.ban",
  moderationUnban: "moderation.unban",
  adminView: "admin.view",
  adminUserRoleUpdate: "admin.user.role.update",
  adminUserStatusUpdate: "admin.user.status.update",
  feedbackView: "feedback.view",
  feedbackCreate: "feedback.create",
  feedbackUpdate: "feedback.update",
  feedbackDelete: "feedback.delete",
  feedbackManage: "feedback.manage",
  feedbackProjectManage: "feedback.project.manage",
} as const;

export type Ability = (typeof Abilities)[keyof typeof Abilities];

export type Actor = SessionUser | null;

export type Resource =
  | { type: "board"; id: number; visibility: BoardVisibility; postingPolicy: PostingPolicy }
  | { type: "discussion"; id: number; authorId: number; boardId: number; isLocked: number; deletedAt: Date | null }
  | { type: "reply"; id: number; authorId: number; discussionId: number }
  | { type: "user"; id: number }
  | { type: "attachment"; id: number; uploaderId: number }
  | { type: "feedbackProject"; id: number }
  | { type: "feedbackItem"; id: number; projectId: number; authorId: number; deletedAt: Date | null }
  | null;

function isActive(actor: SessionUser | null): boolean {
  return actor !== null && actor.status === "active";
}

function isGlobalMod(actor: SessionUser | null): boolean {
  return actor?.role === "admin" || actor?.role === "moderator";
}

function isBoardMember(actor: SessionUser | null, boardId: number, c: AuthzCtx): Promise<boolean> {
  if (!actor) return Promise.resolve(false);
  return c.db.db
    .select()
    .from(boardMembers)
    .where(and(eq(boardMembers.board_id, boardId), eq(boardMembers.user_id, actor.id)))
    .get()
    .then(Boolean);
}

function isBoardMod(actor: SessionUser | null, boardId: number, c: AuthzCtx): Promise<boolean> {
  if (!actor) return Promise.resolve(false);
  return c.db.db
    .select()
    .from(boardMembers)
    .where(
      and(eq(boardMembers.board_id, boardId), eq(boardMembers.user_id, actor.id), eq(boardMembers.role, "moderator")),
    )
    .get()
    .then(Boolean);
}

function isProjectMember(actor: SessionUser | null, projectId: number, c: AuthzCtx): Promise<boolean> {
  if (!actor) return Promise.resolve(false);
  return c.db.db
    .select()
    .from(feedbackProjectMembers)
    .where(
      and(eq(feedbackProjectMembers.project_id, projectId), eq(feedbackProjectMembers.user_id, actor.id)),
    )
    .get()
    .then(Boolean);
}

function isProjectProgrammer(actor: SessionUser | null, projectId: number, c: AuthzCtx): Promise<boolean> {
  if (!actor) return Promise.resolve(false);
  return c.db.db
    .select()
    .from(feedbackProjectMembers)
    .where(
      and(
        eq(feedbackProjectMembers.project_id, projectId),
        eq(feedbackProjectMembers.user_id, actor.id),
        eq(feedbackProjectMembers.is_programmer, 1),
      ),
    )
    .get()
    .then(Boolean);
}

/**
 * 授权判定。`resource` 是目标领域对象；不依赖资源的操作（如发帖）可传 null。
 * 所有模块一律经此入口。
 */
export async function can(actor: Actor, ability: Ability, resource: Resource, c: AuthzCtx): Promise<boolean> {
  if (actor && actor.status === "banned") return false;

  // 不依赖 resource 的能力
  switch (ability) {
    case Abilities.boardCreate:
      return actor?.role === "admin";
    case Abilities.boardDelete:
      return actor?.role === "admin";
    case Abilities.attachmentCreate:
    case Abilities.presenceHeartbeat:
    case Abilities.reportCreate:
      return isActive(actor);
    case Abilities.moderationView:
    case Abilities.moderationResolve:
    case Abilities.userBan:
      return isGlobalMod(actor);
    case Abilities.moderationUnban:
      return actor?.role === "admin";
    case Abilities.adminView:
    case Abilities.adminUserRoleUpdate:
    case Abilities.adminUserStatusUpdate:
    case Abilities.feedbackProjectManage:
      return actor?.role === "admin";
  }

  if (!resource) return false;

  switch (ability) {
    case Abilities.boardUpdate:
    case Abilities.boardManageMembers:
      return resource.type === "board" && (actor?.role === "admin" || (await isBoardMod(actor, resource.id, c)));

    case Abilities.boardJoin:
      return isActive(actor) && resource.type === "board" && resource.visibility !== "public";

    case Abilities.discussionCreate: {
      if (!isActive(actor)) return false;
      const board = resource as Extract<Resource, { type: "board" }>;
      if (board.postingPolicy === "everyone") return true;
      if (board.postingPolicy === "moderators") return isGlobalMod(actor) || (await isBoardMod(actor, board.id, c));
      return isGlobalMod(actor) || (await isBoardMember(actor, board.id, c));
    }

    case Abilities.discussionRead: {
      const board = resource as Extract<Resource, { type: "board" }>;
      if (board.visibility === "public") return true;
      if (!actor) return false;
      if (isGlobalMod(actor)) return true;
      return isBoardMember(actor, board.id, c);
    }

    case Abilities.discussionUpdate:
    case Abilities.discussionDelete: {
      const d = resource as Extract<Resource, { type: "discussion" }>;
      if (isGlobalMod(actor)) return true;
      if (!actor) return false;
      if (d.authorId !== actor.id) return false;
      if (d.deletedAt && ability === Abilities.discussionUpdate) return false;
      return true;
    }

    case Abilities.discussionPin:
    case Abilities.discussionLock: {
      if (isGlobalMod(actor)) return true;
      const d = resource as Extract<Resource, { type: "discussion" }>;
      return actor !== null && (await isBoardMod(actor, d.boardId, c));
    }

    case Abilities.replyCreate: {
      if (!isActive(actor)) return false;
      const d = resource as Extract<Resource, { type: "discussion" }>;
      return !d.isLocked && d.deletedAt === null;
    }

    case Abilities.replyUpdate:
    case Abilities.replyDelete: {
      const r = resource as Extract<Resource, { type: "reply" }>;
      if (isGlobalMod(actor)) return true;
      return actor !== null && r.authorId === actor.id;
    }

    case Abilities.userUpdateSelf:
      return actor !== null && resource.type === "user" && resource.id === actor.id;

    case Abilities.userFollow:
      return actor !== null && isActive(actor) && resource.type === "user" && resource.id !== actor.id;

    case Abilities.attachmentDelete:
      return actor !== null && resource.type === "attachment" && resource.uploaderId === actor.id;

    case Abilities.feedbackView:
    case Abilities.feedbackCreate: {
      if (!actor || actor.status !== "active") return false;
      const p = resource as Extract<Resource, { type: "feedbackProject" }>;
      if (actor.role === "admin") return true;
      return isProjectMember(actor, p.id, c);
    }

    case Abilities.feedbackUpdate:
    case Abilities.feedbackDelete: {
      const f = resource as Extract<Resource, { type: "feedbackItem" }>;
      if (actor?.role === "admin") return true;
      if (!actor || actor.status !== "active") return false;
      if (f.authorId === actor.id) {
        if (ability === Abilities.feedbackDelete) return true;
        return f.deletedAt === null;
      }
      return isProjectProgrammer(actor, f.projectId, c);
    }

    case Abilities.feedbackManage: {
      const f = resource as Extract<Resource, { type: "feedbackItem" }>;
      if (actor?.role === "admin") return true;
      return actor !== null && actor.status === "active" && isProjectProgrammer(actor, f.projectId, c);
    }

    default:
      return false;
  }
}

export async function assertCan(actor: Actor, ability: Ability, resource: Resource, c: AuthzCtx): Promise<void> {
  if (!(await can(actor, ability, resource, c))) throw forbidden();
}
