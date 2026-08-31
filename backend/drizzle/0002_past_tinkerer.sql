ALTER TABLE `users` ADD `discriminator` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `users_discriminator_unique` ON `users` (`discriminator`);