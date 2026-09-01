import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
  check,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------- helpers

/** Epoch 毫秒时间戳（PG 迁移到 timestamptz）。drizzle 中该列 JS 值为 Date。 */
export const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

export const nowMs = () => Date.now();
export const nowDate = () => new Date();

export type SoftDelete = {
  deleted_at: number | null;
  deleted_by: number | null;
  deletion_reason: string | null;
};

export const softDeleteColumns = {
  deleted_at: timestamp("deleted_at"),
  deleted_by: integer("deleted_by"),
  deletion_reason: text("deletion_reason"),
} as const;

// ---------------------------------------------------------------- users

export const USER_ROLES = ["student", "moderator", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["pending", "active", "banned", "deactivated"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username").notNull(),
    email: text("email").notNull(),
    display_name: text("display_name").notNull(),
    bio: text("bio").notNull().default(""),
    password_hash: text("password_hash").notNull(),
    role: text("role", { enum: USER_ROLES }).notNull().default("student"),
    status: text("status", { enum: USER_STATUSES }).notNull().default("pending"),
    /** 随机 4 位身份号：handle = username#discriminator（内测期无邮箱，靠这个区分） */
    discriminator: integer("discriminator"),
    email_domain: text("email_domain"),
    email_verified_at: timestamp("email_verified_at"),
    avatar_object_key: text("avatar_object_key"),
    last_seen_at: timestamp("last_seen_at"),
    settings: text("settings", { mode: "json" })
      .$type<{
        show_online_status?: boolean;
        notif_replies?: boolean;
        notif_follows?: boolean;
        notif_mentions?: boolean;
        weekly_digest?: boolean;
        public_profile?: boolean;
        direct_messages?: boolean;
        reduce_motion?: boolean;
        compact_lists?: boolean;
      }>()
      .notNull()
      .default({}),
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
    updated_at: timestamp("updated_at").notNull().$defaultFn(nowDate),
    deleted_at: timestamp("deleted_at"),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email),
    uniqueIndex("users_username_unique").on(t.username),
    uniqueIndex("users_discriminator_unique").on(t.discriminator),
    index("users_status_idx").on(t.status),
    index("users_deleted_at_idx").on(t.deleted_at),
  ],
);

// ---------------------------------------------------------------- schools

export const schools = sqliteTable("schools", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email_domain: text("email_domain").notNull().unique(),
  is_active: integer("is_active").notNull().default(1),
  created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
});

// ---------------------------------------------------------------- boards

export const BOARD_VISIBILITY = ["public", "members", "private"] as const;
export type BoardVisibility = (typeof BOARD_VISIBILITY)[number];

export const POSTING_POLICY = ["everyone", "members", "moderators"] as const;
export type PostingPolicy = (typeof POSTING_POLICY)[number];

export const boards = sqliteTable(
  "boards",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    visibility: text("visibility", { enum: BOARD_VISIBILITY }).notNull().default("public"),
    posting_policy: text("posting_policy", { enum: POSTING_POLICY }).notNull().default("members"),
    created_by_user_id: integer("created_by_user_id"),
    ...softDeleteColumns,
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
    updated_at: timestamp("updated_at").notNull().$defaultFn(nowDate),
  },
  (t) => [uniqueIndex("boards_slug_unique").on(t.slug)],
);

export const BOARD_MEMBER_ROLES = ["member", "moderator"] as const;
export type BoardMemberRole = (typeof BOARD_MEMBER_ROLES)[number];

export const boardMembers = sqliteTable(
  "board_members",
  {
    board_id: integer("board_id")
      .notNull()
      .references(() => boards.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: BOARD_MEMBER_ROLES }).notNull().default("member"),
    joined_at: timestamp("joined_at").notNull().$defaultFn(nowDate),
  },
  (t) => [
    primaryKey({ columns: [t.board_id, t.user_id] }),
    index("board_members_user_idx").on(t.user_id),
  ],
);

// ---------------------------------------------------------------- discussions

export const DISCUSSIONS_STATUS = ["open", "locked"] as const;
export type DiscussionStatus = (typeof DISCUSSIONS_STATUS)[number];

export const discussions = sqliteTable(
  "discussions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    board_id: integer("board_id")
      .notNull()
      .references(() => boards.id),
    author_id: integer("author_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    body_md: text("body_md").notNull(),
    body_html: text("body_html"),
    reply_count: integer("reply_count").notNull().default(0),
    save_count: integer("save_count").notNull().default(0),
    is_pinned: integer("is_pinned").notNull().default(0),
    is_locked: integer("is_locked").notNull().default(0),
    status: text("status", { enum: DISCUSSIONS_STATUS }).notNull().default("open"),
    last_reply_at: timestamp("last_reply_at"),
    ...softDeleteColumns,
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
    updated_at: timestamp("updated_at").notNull().$defaultFn(nowDate),
  },
  (t) => [
    index("discussions_board_activity_idx").on(t.board_id, t.last_reply_at),
    index("discussions_board_created_idx").on(t.board_id, t.created_at),
    index("discussions_author_created_idx").on(t.author_id, t.created_at),
    index("discussions_pinned_activity_idx").on(t.is_pinned, t.last_reply_at),
  ],
);

// ---------------------------------------------------------------- replies

export const replies = sqliteTable(
  "replies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    discussion_id: integer("discussion_id")
      .notNull()
      .references(() => discussions.id),
    author_id: integer("author_id")
      .notNull()
      .references(() => users.id),
    parent_reply_id: integer("parent_reply_id"),
    body_md: text("body_md").notNull(),
    body_html: text("body_html"),
    ...softDeleteColumns,
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
    updated_at: timestamp("updated_at").notNull().$defaultFn(nowDate),
  },
  (t) => [
    index("replies_discussion_created_idx").on(t.discussion_id, t.created_at),
    index("replies_author_idx").on(t.author_id),
    index("replies_parent_idx").on(t.parent_reply_id),
    // 自引用外键：必须在表级声明以避免 TS 循环类型
    foreignKey({ columns: [t.parent_reply_id], foreignColumns: [t.id] }),
  ],
);

// ---------------------------------------------------------------- saves / follows

export const discussionSaves = sqliteTable(
  "discussion_saves",
  {
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id),
    discussion_id: integer("discussion_id")
      .notNull()
      .references(() => discussions.id),
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.discussion_id] }),
    index("discussion_saves_discussion_idx").on(t.discussion_id),
  ],
);

export const discussionFollows = sqliteTable(
  "discussion_follows",
  {
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id),
    discussion_id: integer("discussion_id")
      .notNull()
      .references(() => discussions.id),
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.discussion_id] }),
    index("discussion_follows_discussion_idx").on(t.discussion_id),
  ],
);

export const userFollows = sqliteTable(
  "user_follows",
  {
    follower_id: integer("follower_id")
      .notNull()
      .references(() => users.id),
    followee_id: integer("followee_id")
      .notNull()
      .references(() => users.id),
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
  },
  (t) => [
    primaryKey({ columns: [t.follower_id, t.followee_id] }),
    check("user_follows_no_self", sql`${t.follower_id} <> ${t.followee_id}`),
    index("user_follows_followee_idx").on(t.followee_id),
  ],
);

// ---------------------------------------------------------------- notifications

export const NOTIFICATION_TYPES = [
  "reply",
  "mention",
  "follow",
  "system",
  "moderation",
  "ban",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const notifications = sqliteTable(
  "notifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id),
    actor_user_id: integer("actor_user_id").references(() => users.id),
    type: text("type", { enum: NOTIFICATION_TYPES }).notNull(),
    discussion_id: integer("discussion_id").references(() => discussions.id),
    reply_id: integer("reply_id").references(() => replies.id),
    body: text("body"),
    is_read: integer("is_read").notNull().default(0),
    read_at: timestamp("read_at"),
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
  },
  (t) => [
    index("notifications_user_read_created_idx").on(t.user_id, t.is_read, t.created_at),
    index("notifications_user_created_idx").on(t.user_id, t.created_at),
  ],
);

// ---------------------------------------------------------------- attachments

export const ATTACHMENT_STATES = ["pending", "attached", "orphaned"] as const;
export type AttachmentState = (typeof ATTACHMENT_STATES)[number];

export const attachments = sqliteTable(
  "attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    uploader_id: integer("uploader_id")
      .notNull()
      .references(() => users.id),
    discussion_id: integer("discussion_id").references(() => discussions.id),
    object_key: text("object_key").notNull().unique(),
    original_filename: text("original_filename").notNull(),
    mime_type: text("mime_type").notNull(),
    size_bytes: integer("size_bytes").notNull(),
    sha256: text("sha256"),
    state: text("state", { enum: ATTACHMENT_STATES }).notNull().default("pending"),
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
  },
  (t) => [
    index("attachments_uploader_created_idx").on(t.uploader_id, t.created_at),
    index("attachments_discussion_idx").on(t.discussion_id),
    index("attachments_state_idx").on(t.state),
  ],
);

// ---------------------------------------------------------------- moderation

export const REPORT_STATUSES = ["open", "in_progress", "resolved", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORTABLE_TYPES = ["discussion", "reply", "user"] as const;
export type ReportableType = (typeof REPORTABLE_TYPES)[number];

export const reports = sqliteTable(
  "reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    reporter_user_id: integer("reporter_user_id")
      .notNull()
      .references(() => users.id),
    reportable_type: text("reportable_type", { enum: REPORTABLE_TYPES }).notNull(),
    reportable_id: integer("reportable_id").notNull(),
    reason: text("reason"),
    status: text("status", { enum: REPORT_STATUSES }).notNull().default("open"),
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
  },
  (t) => [
    index("reports_status_created_idx").on(t.status, t.created_at),
    index("reports_reportable_idx").on(t.reportable_type, t.reportable_id),
  ],
);

export const moderationActions = sqliteTable(
  "moderation_actions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actor_user_id: integer("actor_user_id")
      .notNull()
      .references(() => users.id),
    action: text("action").notNull(),
    target_type: text("target_type").notNull(),
    target_id: integer("target_id").notNull(),
    reason: text("reason"),
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
  },
  (t) => [
    index("moderation_actions_target_idx").on(t.target_type, t.target_id),
    index("moderation_actions_actor_created_idx").on(t.actor_user_id, t.created_at),
  ],
);

export const bans = sqliteTable(
  "bans",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id),
    banned_by_user_id: integer("banned_by_user_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason"),
    banned_until: timestamp("banned_until"),
    is_active: integer("is_active").notNull().default(1),
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
  },
  (t) => [index("bans_user_active_idx").on(t.user_id, t.is_active)],
);

// ---------------------------------------------------------------- sessions

export const sessions = sqliteTable(
  "sessions",
  {
    token_hash: text("token_hash").primaryKey(),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id),
    expires_at: timestamp("expires_at").notNull(),
    ip: text("ip"),
    user_agent: text("user_agent"),
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
    last_seen_at: timestamp("last_seen_at").notNull().$defaultFn(nowDate),
  },
  (t) => [
    index("sessions_user_idx").on(t.user_id),
    index("sessions_expires_idx").on(t.expires_at),
  ],
);

// ---------------------------------------------------------------- tokens

export const emailVerificationTokens = sqliteTable("email_verification_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  user_id: integer("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  token_hash: text("token_hash").notNull().unique(),
  expires_at: timestamp("expires_at").notNull(),
  created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
});

export const passwordResetTokens = sqliteTable(
  "password_reset_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id),
    token_hash: text("token_hash").notNull().unique(),
    expires_at: timestamp("expires_at").notNull(),
    used_at: timestamp("used_at"),
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
  },
  (t) => [index("password_reset_tokens_user_idx").on(t.user_id)],
);

// ---------------------------------------------------------------- outbox

export const OUTBOX_STATUSES = ["pending", "processing", "done", "failed"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    event_type: text("event_type").notNull(),
    aggregate_type: text("aggregate_type"),
    aggregate_id: text("aggregate_id"),
    payload: text("payload").notNull(), // JSON 字符串
    status: text("status", { enum: OUTBOX_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    available_at: timestamp("available_at").notNull().$defaultFn(nowDate),
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
    processed_at: timestamp("processed_at"),
  },
  (t) => [index("outbox_status_available_idx").on(t.status, t.available_at, t.id)],
);

// ---------------------------------------------------------------- feedback

export const FEEDBACK_TYPES = ["bug", "suggestion"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export const FEEDBACK_URGENCIES = ["urgent", "normal"] as const;
export type FeedbackUrgency = (typeof FEEDBACK_URGENCIES)[number];

export const FEEDBACK_STATUSES = ["open", "done", "expired"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const feedbackProjects = sqliteTable(
  "feedback_projects",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    created_by_user_id: integer("created_by_user_id").references(() => users.id),
    ...softDeleteColumns,
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
    updated_at: timestamp("updated_at").notNull().$defaultFn(nowDate),
  },
  (t) => [index("feedback_projects_created_idx").on(t.created_at)],
);

export const feedbackProjectMembers = sqliteTable(
  "feedback_project_members",
  {
    project_id: integer("project_id")
      .notNull()
      .references(() => feedbackProjects.id),
    user_id: integer("user_id")
      .notNull()
      .references(() => users.id),
    is_programmer: integer("is_programmer").notNull().default(0),
    joined_at: timestamp("joined_at").notNull().$defaultFn(nowDate),
  },
  (t) => [
    primaryKey({ columns: [t.project_id, t.user_id] }),
    index("feedback_project_members_user_idx").on(t.user_id),
  ],
);

export const feedbackItems = sqliteTable(
  "feedback_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    project_id: integer("project_id")
      .notNull()
      .references(() => feedbackProjects.id),
    author_id: integer("author_id")
      .notNull()
      .references(() => users.id),
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    type: text("type", { enum: FEEDBACK_TYPES }).notNull(),
    urgency: text("urgency", { enum: FEEDBACK_URGENCIES }).notNull().default("normal"),
    status: text("status", { enum: FEEDBACK_STATUSES }).notNull().default("open"),
    closed_at: timestamp("closed_at"),
    edited_at: timestamp("edited_at"),
    ...softDeleteColumns,
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
    updated_at: timestamp("updated_at").notNull().$defaultFn(nowDate),
  },
  (t) => [
    uniqueIndex("feedback_items_project_seq_unique").on(t.project_id, t.seq),
    index("feedback_items_project_status_idx").on(t.project_id, t.status),
    index("feedback_items_author_idx").on(t.author_id),
  ],
);

export const FEEDBACK_KEY_ROLES = ["read", "write"] as const;
export type FeedbackKeyRole = (typeof FEEDBACK_KEY_ROLES)[number];

export const feedbackApiKeys = sqliteTable(
  "feedback_api_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    key_hash: text("key_hash").notNull().unique(),
    key_prefix: text("key_prefix").notNull(),
    role: text("role", { enum: FEEDBACK_KEY_ROLES }).notNull().default("read"),
    project_ids: text("project_ids", { mode: "json" })
      .$type<number[]>()
      .notNull()
      .default([]),
    enabled: integer("enabled").notNull().default(1),
    last_used_at: timestamp("last_used_at"),
    created_at: timestamp("created_at").notNull().$defaultFn(nowDate),
  },
  (t) => [index("feedback_api_keys_created_idx").on(t.created_at)],
);

// ---------------------------------------------------------------- app settings

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
});

/** drizzle 实例的完整 schema 聚合。 */
export const DbSchema = {
  users,
  schools,
  boards,
  boardMembers,
  discussions,
  replies,
  discussionSaves,
  discussionFollows,
  userFollows,
  notifications,
  attachments,
  reports,
  moderationActions,
  bans,
  sessions,
  emailVerificationTokens,
  passwordResetTokens,
  outboxEvents,
  feedbackProjects,
  feedbackProjectMembers,
  feedbackItems,
  feedbackApiKeys,
  appSettings,
} as const;

export type DbSchema = typeof DbSchema;
