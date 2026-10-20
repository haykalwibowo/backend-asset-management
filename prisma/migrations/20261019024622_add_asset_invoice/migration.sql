-- AlterTable
ALTER TABLE `assets` ADD COLUMN `invoiceNumber` VARCHAR(191) NULL,
    ADD COLUMN `invoicePath` VARCHAR(191) NULL,
    ADD COLUMN `vendorName` VARCHAR(191) NULL;
