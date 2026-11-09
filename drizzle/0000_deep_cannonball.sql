CREATE TABLE `auth_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`password_salt` text NOT NULL,
	`password_hash` text NOT NULL,
	`recovery_hash` text NOT NULL,
	`auth_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_accounts_username_unique` ON `auth_accounts` (`username`);--> statement-breakpoint
CREATE TABLE `auth_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`window_started` integer NOT NULL,
	`attempts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_rate_limits_window` ON `auth_rate_limits` (`window_started`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`auth_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `auth_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_account` ON `auth_sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `auth_sessions_expiry` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`author_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comments_post_time` ON `comments` (`post_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `comments_author_time` ON `comments` (`author_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `friendships` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_id` text NOT NULL,
	`receiver_id` text NOT NULL,
	`pair_a` text NOT NULL,
	`pair_b` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`receiver_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pair_a`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pair_b`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "friendships_status_check" CHECK("friendships"."status" IN ('pending','accepted')),
	CONSTRAINT "friendships_distinct_users" CHECK("friendships"."sender_id" <> "friendships"."receiver_id")
);
--> statement-breakpoint
CREATE INDEX `friendships_sender` ON `friendships` (`sender_id`,`status`);--> statement-breakpoint
CREATE INDEX `friendships_receiver` ON `friendships` (`receiver_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `friendships_pair_unique` ON `friendships` (`pair_a`,`pair_b`);--> statement-breakpoint
CREATE TABLE `map_states` (
	`user_id` text PRIMARY KEY NOT NULL,
	`state_json` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`city` text NOT NULL,
	`author_id` text NOT NULL,
	`text` text NOT NULL,
	`photo_key` text,
	`photo_type` text,
	`visibility` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "posts_visibility_check" CHECK("posts"."visibility" IN ('public','friends'))
);
--> statement-breakpoint
CREATE INDEX `posts_city_time` ON `posts` (`city`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `posts_author_time` ON `posts` (`author_id`,"created_at" DESC);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_code_unique` ON `users` (`code`);