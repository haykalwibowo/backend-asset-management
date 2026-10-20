-- AlterTable
ALTER TABLE `asset_units` ADD COLUMN `condition` VARCHAR(191) NOT NULL DEFAULT 'good',
    ADD COLUMN `conditionNote` VARCHAR(191) NULL;
