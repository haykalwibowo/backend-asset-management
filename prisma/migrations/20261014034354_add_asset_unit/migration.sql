-- CreateTable
CREATE TABLE `asset_units` (
    `id` VARCHAR(191) NOT NULL,
    `assetId` VARCHAR(191) NOT NULL,
    `idNumber` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'available',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `asset_units_idNumber_key`(`idNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `asset_units` ADD CONSTRAINT `asset_units_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `assets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
