-- AlterTable
ALTER TABLE `assets` ADD COLUMN `quantity` INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE `assignment_history` ADD COLUMN `quantity` INTEGER NOT NULL DEFAULT 1;
