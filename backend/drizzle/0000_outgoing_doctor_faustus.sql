CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uploader_id` integer NOT NULL,
	`discussion_id` integer,
	`object_key` text NOT NULL,
	`original_filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`uploader_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_object_key_unique` ON `attachments` (`object_key`);--> statement-breakpoint
CREATE INDEX `attachments_uploader_created_idx` ON `attachments` (`uploader_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `attachments_discussion_idx` ON `attachments` (`discussion_id`);--> statement-breakpoint
CREATE INDEX `attachments_state_idx` ON `attachments` (`state`);--> statement-breakpoint
CREATE TABLE `bans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`banned_by_user_id` integer NOT NULL,
	`reason` text,
	`banned_until` integer,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`banned_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bans_user_active_idx` ON `bans` (`user_id`,`is_active`);--> statement-breakpoint
CREATE TABLE `board_members` (
	`board_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`board_id`, `user_id`),
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `board_members_user_idx` ON `board_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `boards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`visibility` text DEFAULT 'public' NOT NULL,
	`posting_policy` text DEFAULT 'members' NOT NULL,
	`created_by_user_id` integer,
	`deleted_at` integer,
	`deleted_by` integer,
	`deletion_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `boards_slug_unique` ON `boards` (`slug`);--> statement-breakpoint
CREATE TABLE `discussion_follows` (
	`user_id` integer NOT NULL,
	`discussion_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `discussion_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `discussion_follows_discussion_idx` ON `discussion_follows` (`discussion_id`);--> statement-breakpoint
CREATE TABLE `discussion_saves` (
	`user_id` integer NOT NULL,
	`discussion_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `discussion_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `discussion_saves_discussion_idx` ON `discussion_saves` (`discussion_id`);--> statement-breakpoint
CREATE TABLE `discussions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`board_id` integer NOT NULL,
	`author_id` integer NOT NULL,
	`title` text NOT NULL,
	`body_md` text NOT NULL,
	`body_html` text,
	`reply_count` integer DEFAULT 0 NOT NULL,
	`save_count` integer DEFAULT 0 NOT NULL,
	`is_pinned` integer DEFAULT 0 NOT NULL,
	`is_locked` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`last_reply_at` integer,
	`deleted_at` integer,
	`deleted_by` integer,
	`deletion_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `discussions_board_activity_idx` ON `discussions` (`board_id`,`last_reply_at`);--> statement-breakpoint
CREATE INDEX `discussions_board_created_idx` ON `discussions` (`board_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `discussions_author_created_idx` ON `discussions` (`author_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `discussions_pinned_activity_idx` ON `discussions` (`is_pinned`,`last_reply_at`);--> statement-breakpoint
CREATE TABLE `email_verification_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_verification_tokens_user_id_unique` ON `email_verification_tokens` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_verification_tokens_token_hash_unique` ON `email_verification_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `moderation_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_user_id` integer NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` integer NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `moderation_actions_target_idx` ON `moderation_actions` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `moderation_actions_actor_created_idx` ON `moderation_actions` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`actor_user_id` integer,
	`type` text NOT NULL,
	`discussion_id` integer,
	`reply_id` integer,
	`body` text,
	`is_read` integer DEFAULT 0 NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_id`) REFERENCES `replies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_user_read_created_idx` ON `notifications` (`user_id`,`is_read`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_user_created_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`aggregate_type` text,
	`aggregate_id` text,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE INDEX `outbox_status_available_idx` ON `outbox_events` (`status`,`available_at`,`id`);--> statement-breakpoint
CREATE TABLE `password_reset_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `password_reset_tokens_token_hash_unique` ON `password_reset_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `password_reset_tokens_user_idx` ON `password_reset_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `replies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`discussion_id` integer NOT NULL,
	`author_id` integer NOT NULL,
	`parent_reply_id` integer,
	`body_md` text NOT NULL,
	`body_html` text,
	`deleted_at` integer,
	`deleted_by` integer,
	`deletion_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`discussion_id`) REFERENCES `discussions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_reply_id`) REFERENCES `replies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `replies_discussion_created_idx` ON `replies` (`discussion_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `replies_author_idx` ON `replies` (`author_id`);--> statement-breakpoint
CREATE INDEX `replies_parent_idx` ON `replies` (`parent_reply_id`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reporter_user_id` integer NOT NULL,
	`reportable_type` text NOT NULL,
	`reportable_id` integer NOT NULL,
	`reason` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`reporter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reports_status_created_idx` ON `reports` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `reports_reportable_idx` ON `reports` (`reportable_type`,`reportable_id`);--> statement-breakpoint
CREATE TABLE `schools` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email_domain` text NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schools_email_domain_unique` ON `schools` (`email_domain`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `user_follows` (
	`follower_id` integer NOT NULL,
	`followee_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`follower_id`, `followee_id`),
	FOREIGN KEY (`follower_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`followee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_follows_no_self" CHECK("user_follows"."follower_id" <> "user_follows"."followee_id")
);
--> statement-breakpoint
CREATE INDEX `user_follows_followee_idx` ON `user_follows` (`followee_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`bio` text DEFAULT '' NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'student' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`email_domain` text,
	`email_verified_at` integer,
	`avatar_object_key` text,
	`last_seen_at` integer,
	`settings` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);