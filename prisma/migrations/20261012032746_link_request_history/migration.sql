/*
  Warnings:

  - A unique constraint covering the columns `[assignmentHistoryId]` on the table `asset_requests` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE `asset_requests` ADD COLUMN `assignmentHistoryId` VARCHAR(191) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `asset_requests_assignmentHistoryId_key` ON `asset_requests`(`assignmentHistoryId`);

-- AddForeignKey
ALTER TABLE `asset_requests` ADD CONSTRAINT `asset_requests_assignmentHistoryId_fkey` FOREIGN KEY (`assignmentHistoryId`) REFERENCES `assignment_history`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
