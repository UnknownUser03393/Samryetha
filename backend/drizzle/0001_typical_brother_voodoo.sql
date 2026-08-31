CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feedback_api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`role` text DEFAULT 'read' NOT NULL,
	`project_ids` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_api_keys_key_hash_unique` ON `feedback_api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `feedback_api_keys_created_idx` ON `feedback_api_keys` (`created_at`);--> statement-breakpoint
CREATE TABLE `feedback_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`author_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`title` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`urgency` text DEFAULT 'normal' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`closed_at` integer,
	`edited_at` integer,
	`deleted_at` integer,
	`deleted_by` integer,
	`deletion_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `feedback_projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feedback_items_project_seq_unique` ON `feedback_items` (`project_id`,`seq`);--> statement-breakpoint
CREATE INDEX `feedback_items_project_status_idx` ON `feedback_items` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `feedback_items_author_idx` ON `feedback_items` (`author_id`);--> statement-breakpoint
CREATE TABLE `feedback_project_members` (
	`project_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`is_programmer` integer DEFAULT 0 NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`),
	FOREIGN KEY (`project_id`) REFERENCES `feedback_projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `feedback_project_members_user_idx` ON `feedback_project_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `feedback_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_by_user_id` integer,
	`deleted_at` integer,
	`deleted_by` integer,
	`deletion_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `feedback_projects_created_idx` ON `feedback_projects` (`created_at`);