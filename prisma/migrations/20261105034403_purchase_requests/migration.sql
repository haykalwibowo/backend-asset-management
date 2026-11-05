-- CreateTable
CREATE TABLE `purchase_requests` (
    `id` VARCHAR(191) NOT NULL,
    `seq` INTEGER NOT NULL AUTO_INCREMENT,
    `docNumber` VARCHAR(191) NULL,
    `requesterId` VARCHAR(191) NOT NULL,
    `requesterName` VARCHAR(191) NOT NULL,
    `requesterPosition` VARCHAR(191) NULL,
    `requesterDepartment` VARCHAR(191) NULL,
    `requesterEmail` VARCHAR(191) NULL,
    `requesterPhone` VARCHAR(191) NULL,
    `requirementType` VARCHAR(191) NOT NULL,
    `requirementAction` VARCHAR(191) NOT NULL,
    `requirementScope` VARCHAR(191) NOT NULL,
    `purpose` TEXT NOT NULL,
    `dueDate` DATE NOT NULL,
    `note` TEXT NULL,
    `attachmentPath` VARCHAR(191) NULL,
    `attachmentName` VARCHAR(191) NULL,
    `totalEstimate` DECIMAL(15, 2) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `supervisorApproverId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `purchase_requests_seq_key`(`seq`),
    UNIQUE INDEX `purchase_requests_docNumber_key`(`docNumber`),
    INDEX `purchase_requests_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_request_items` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `lineNo` INTEGER NOT NULL,
    `description` TEXT NOT NULL,
    `quantity` INTEGER NOT NULL,
    `estimatedPrice` DECIMAL(15, 2) NOT NULL,

    INDEX `purchase_request_items_requestId_idx`(`requestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_request_logs` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `step` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `actorUserId` VARCHAR(191) NULL,
    `actorName` VARCHAR(191) NULL,
    `actorPosition` VARCHAR(191) NULL,
    `onBehalfOfUserId` VARCHAR(191) NULL,
    `onBehalfOfName` VARCHAR(191) NULL,
    `onBehalfOfPosition` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `purchase_request_logs_requestId_idx`(`requestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_delegations` (
    `id` VARCHAR(191) NOT NULL,
    `delegatorId` VARCHAR(191) NOT NULL,
    `delegateId` VARCHAR(191) NOT NULL,
    `startDate` DATE NOT NULL,
    `endDate` DATE NOT NULL,
    `note` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `approval_delegations_delegateId_idx`(`delegateId`),
    INDEX `approval_delegations_delegatorId_idx`(`delegatorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `purchase_requests` ADD CONSTRAINT `purchase_requests_requesterId_fkey` FOREIGN KEY (`requesterId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_requests` ADD CONSTRAINT `purchase_requests_supervisorApproverId_fkey` FOREIGN KEY (`supervisorApproverId`) REFERENCES `employees`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_request_items` ADD CONSTRAINT `purchase_request_items_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `purchase_requests`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_request_logs` ADD CONSTRAINT `purchase_request_logs_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `purchase_requests`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_request_logs` ADD CONSTRAINT `purchase_request_logs_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_request_logs` ADD CONSTRAINT `purchase_request_logs_onBehalfOfUserId_fkey` FOREIGN KEY (`onBehalfOfUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_delegations` ADD CONSTRAINT `approval_delegations_delegatorId_fkey` FOREIGN KEY (`delegatorId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_delegations` ADD CONSTRAINT `approval_delegations_delegateId_fkey` FOREIGN KEY (`delegateId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_delegations` ADD CONSTRAINT `approval_delegations_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
