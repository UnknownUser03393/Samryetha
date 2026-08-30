import { and, eq } from "drizzle-orm";
import type { DbProvider } from "../infrastructure/db/client.js";
import { emitEvent } from "../infrastructure/db/client.js";
import { userFollows, users } from "../infrastructure/db/schema.js";
import { Abilities, assertCan, type Actor } from "../authz/can.js";
import { notFound } from "../app/error.js";

export interface FollowService {
  followUser(actor: Actor, followeeId: number): Promise<void>;
  unfollowUser(actor: Actor, followeeId: number): Promise<void>;
  isFollowing(followerId: number, followeeId: number): Promise<boolean>;
}

export function createFollowService(db: DbProvider): FollowService {
  return {
    async followUser(actor, followeeId) {
      if (!actor) throw new Error("requires actor");
      await assertCan(actor, Abilities.userFollow, { type: "user", id: followeeId }, { db });
      const followee = await db.db.select().from(users).where(eq(users.id, followeeId)).get();
      if (!followee) throw notFound("User not found");
      const existing = await db.db
        .select()
        .from(userFollows)
        .where(and(eq(userFollows.follower_id, actor.id), eq(userFollows.followee_id, followeeId)))
        .get();
      if (existing) return;
      await db.tx(async (tx) => {
        await tx.insert(userFollows).values({ follower_id: actor.id, followee_id: followeeId });
        await emitEvent({
          type: "user.followed",
          aggregate: { type: "user", id: String(followeeId) },
          payload: { followerId: actor.id, followeeId },
        });
      });
    },

    async unfollowUser(actor, followeeId) {
      if (!actor) throw new Error("requires actor");
      await db.db
        .delete(userFollows)
        .where(and(eq(userFollows.follower_id, actor.id), eq(userFollows.followee_id, followeeId)));
    },

    async isFollowing(followerId, followeeId) {
      const row = await db.db
        .select()
        .from(userFollows)
        .where(and(eq(userFollows.follower_id, followerId), eq(userFollows.followee_id, followeeId)))
        .get();
      return row !== undefined;
    },
  };
}
