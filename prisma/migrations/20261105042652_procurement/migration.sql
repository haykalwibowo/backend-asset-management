-- AlterTable
ALTER TABLE `purchase_request_items` ADD COLUMN `finalPrice` DECIMAL(15, 2) NULL,
    ADD COLUMN `poNumber` VARCHAR(191) NULL,
    ADD COLUMN `purchaseLink` TEXT NULL,
    ADD COLUMN `purchaseMethod` VARCHAR(191) NULL,
    ADD COLUMN `referenceLink` TEXT NULL,
    ADD COLUMN `vendorContact` VARCHAR(191) NULL,
    ADD COLUMN `vendorName` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `purchase_requests` ADD COLUMN `estimatedArrival` DATE NULL,
    ADD COLUMN `priceVarianceNote` TEXT NULL,
    ADD COLUMN `procuredAt` DATETIME(3) NULL,
    ADD COLUMN `quotationName` VARCHAR(191) NULL,
    ADD COLUMN `quotationPath` VARCHAR(191) NULL,
    ADD COLUMN `totalFinal` DECIMAL(15, 2) NULL;
