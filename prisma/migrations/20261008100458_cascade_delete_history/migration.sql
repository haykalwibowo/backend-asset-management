-- DropForeignKey
ALTER TABLE `assignment_history` DROP FOREIGN KEY `assignment_history_assetId_fkey`;

-- DropIndex
DROP INDEX `assignment_history_assetId_fkey` ON `assignment_history`;

-- AddForeignKey
ALTER TABLE `assignment_history` ADD CONSTRAINT `assignment_history_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `assets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
