import { and, count, eq, isNull, ne } from "drizzle-orm";
import type { DbProvider } from "../infrastructure/db/client.js";
import {
  users,
  discussions,
  replies,
  userFollows,
  type UserRole,
  type UserStatus,
} from "../infrastructure/db/schema.js";
import { conflict, notFound } from "../app/error.js";
import { toMs } from "../lib/time.js";

export type UserRow = typeof users.$inferSelect;

export interface UserDTO {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  bio: string;
  emailVerified: boolean;
  avatarObjectKey: string | null;
  settings: Record<string, unknown>;
  createdAt: number;
  lastSeenAt: number | null;
}

export interface PublicProfileDTO {
  id: number;
  username: string;
  displayName: string;
  bio: string;
  avatarObjectKey: string | null;
  joinedAt: number;
  lastSeenAt: number | null;
  stats: { discussions: number; replies: number; followers: number; following: number };
  isFollowing: boolean;
}

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase().replace(/^@/, "");
}

export interface UserService {
  getById(id: number): Promise<UserRow | undefined>;
  getByEmail(email: string): Promise<UserRow | undefined>;
  getByUsername(username: string): Promise<UserRow | undefined>;
  updateProfile(
    userId: number,
    patch: { displayName?: string; username?: string; bio?: string; avatarObjectKey?: string | null; settings?: Record<string, unknown> },
  ): Promise<UserDTO>;
  getPublicProfile(viewerId: number | null, username: string): Promise<PublicProfileDTO>;
  toDTO(row: UserRow): UserDTO;
}

export function createUserService(db: DbProvider): UserService {
  async function getById(id: number) {
    return db.db.select().from(users).where(eq(users.id, id)).get();
  }
  async function getByEmail(email: string) {
    return db.db.select().from(users).where(eq(users.email, email.toLowerCase())).get();
  }
  async function getByUsername(username: string) {
    return db.db.select().from(users).where(eq(users.username, normalizeUsername(username))).get();
  }

  function toDTO(row: UserRow): UserDTO {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      status: row.status,
      bio: row.bio,
      emailVerified: row.email_verified_at !== null,
      avatarObjectKey: row.avatar_object_key,
      settings: row.settings,
      createdAt: toMs(row.created_at) ?? 0,
      lastSeenAt: toMs(row.last_seen_at),
    };
  }

  return {
    getById,
    getByEmail,
    getByUsername,

    async updateProfile(userId, patch) {
      if (patch.username !== undefined) {
        const wanted = normalizeUsername(patch.username);
        const dup = await db.db
          .select()
          .from(users)
          .where(and(eq(users.username, wanted), ne(users.id, userId)))
          .get();
        if (dup) throw conflict("That username is already taken");
        patch = { ...patch, username: wanted };
      }
      const updates: Partial<typeof users.$inferInsert> = {
        updated_at: new Date(),
        ...(patch.displayName !== undefined && { display_name: patch.displayName }),
        ...(patch.username !== undefined && { username: patch.username }),
        ...(patch.bio !== undefined && { bio: patch.bio }),
        ...(patch.avatarObjectKey !== undefined && { avatar_object_key: patch.avatarObjectKey }),
      };
      if (patch.settings) {
        const current = await getById(userId);
        updates.settings = { ...(current?.settings ?? {}), ...patch.settings };
      }
      await db.db.update(users).set(updates).where(eq(users.id, userId));
      const row = await getById(userId);
      if (!row) throw notFound("User not found");
      return toDTO(row);
    },

    async getPublicProfile(viewerId, username) {
      const row = await getByUsername(username);
      if (!row) throw notFound("User not found");
      const [dCount, rCount, followerCount, followingCount] = await Promise.all([
        db.db.select({ c: count() }).from(discussions).where(and(eq(discussions.author_id, row.id), isNull(discussions.deleted_at))).get(),
        db.db.select({ c: count() }).from(replies).where(and(eq(replies.author_id, row.id), isNull(replies.deleted_at))).get(),
        db.db.select({ c: count() }).from(userFollows).where(eq(userFollows.followee_id, row.id)).get(),
        db.db.select({ c: count() }).from(userFollows).where(eq(userFollows.follower_id, row.id)).get(),
      ]);
      const isFollowing =
        viewerId !== null
          ? (await db.db
              .select()
              .from(userFollows)
              .where(and(eq(userFollows.follower_id, viewerId), eq(userFollows.followee_id, row.id)))
              .get()) !== undefined
          : false;
      return {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        bio: row.bio,
        avatarObjectKey: row.avatar_object_key,
        joinedAt: toMs(row.created_at) ?? 0,
        lastSeenAt: toMs(row.last_seen_at),
        stats: {
          discussions: dCount?.c ?? 0,
          replies: rCount?.c ?? 0,
          followers: followerCount?.c ?? 0,
          following: followingCount?.c ?? 0,
        },
        isFollowing,
      };
    },

    toDTO,
  };
}
