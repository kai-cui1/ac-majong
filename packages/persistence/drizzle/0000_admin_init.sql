CREATE TABLE `admin_audit_logs` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`admin_id` bigint,
	`admin_username` varchar(32),
	`action` varchar(48) NOT NULL,
	`target_type` varchar(32),
	`target_id` varchar(64),
	`before_json` json,
	`after_json` json,
	`ip` varchar(64),
	`result` enum('success','fail') NOT NULL DEFAULT 'success',
	`at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `admin_audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `admins` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`username` varchar(32) NOT NULL,
	`pass_hash` varchar(255) NOT NULL,
	`role` enum('super','operator','viewer') NOT NULL,
	`status` enum('active','disabled') NOT NULL DEFAULT 'active',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`last_login_at` datetime(3),
	CONSTRAINT `admins_id` PRIMARY KEY(`id`),
	CONSTRAINT `admins_username_unique` UNIQUE(`username`)
);
--> statement-breakpoint
CREATE TABLE `arbitrations` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`game_id` varchar(24) NOT NULL,
	`admin_id` bigint NOT NULL,
	`status` enum('pending','accepted','rejected','resolved') NOT NULL DEFAULT 'pending',
	`verdict` varchar(32),
	`note` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `arbitrations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_admin_time` ON `admin_audit_logs` (`admin_id`,`at`);--> statement-breakpoint
CREATE INDEX `idx_action` ON `admin_audit_logs` (`action`);--> statement-breakpoint
CREATE INDEX `idx_at` ON `admin_audit_logs` (`at`);--> statement-breakpoint
CREATE INDEX `idx_game` ON `arbitrations` (`game_id`);--> statement-breakpoint
CREATE INDEX `idx_admin` ON `arbitrations` (`admin_id`);