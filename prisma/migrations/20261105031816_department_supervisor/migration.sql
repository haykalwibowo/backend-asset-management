-- Departemen dipindah dari kolom teks `employees.department` ke tabel `departments`.
-- Data lama dipindahkan dulu sebelum kolomnya dihapus.

-- CreateTable
CREATE TABLE `departments` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `headId` VARCHAR(191) NULL,

    UNIQUE INDEX `departments_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable: kolom baru (kolom lama `department` masih ada)
ALTER TABLE `employees`
    ADD COLUMN `departmentId` VARCHAR(191) NULL,
    ADD COLUMN `phone` VARCHAR(191) NULL,
    ADD COLUMN `position` VARCHAR(191) NULL,
    ADD COLUMN `supervisorId` VARCHAR(191) NULL;

-- Data migration: satu baris departments per nama departemen unik
INSERT INTO `departments` (`id`, `name`)
SELECT UUID(), d.name
FROM (
    SELECT DISTINCT TRIM(`department`) AS name
    FROM `employees`
    WHERE `department` IS NOT NULL AND TRIM(`department`) <> ''
) AS d;

UPDATE `employees` e
JOIN `departments` d ON d.`name` = TRIM(e.`department`)
SET e.`departmentId` = d.`id`;

-- Baru hapus kolom lama setelah datanya dipindah
ALTER TABLE `employees` DROP COLUMN `department`;

-- AddForeignKey
ALTER TABLE `departments` ADD CONSTRAINT `departments_headId_fkey` FOREIGN KEY (`headId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_departmentId_fkey` FOREIGN KEY (`departmentId`) REFERENCES `departments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_supervisorId_fkey` FOREIGN KEY (`supervisorId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
