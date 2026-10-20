-- AlterTable
ALTER TABLE `asset_units` ADD COLUMN `currentAssignmentHistoryId` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `asset_units` ADD CONSTRAINT `asset_units_currentAssignmentHistoryId_fkey` FOREIGN KEY (`currentAssignmentHistoryId`) REFERENCES `assignment_history`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
