CREATE TABLE `branches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`address` text,
	`phone` varchar(50),
	`isMain` int NOT NULL DEFAULT 0,
	`isActive` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `branches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `operation_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`type` enum('purchase','transfer') NOT NULL,
	`referenceId` int NOT NULL,
	`action` varchar(100) NOT NULL,
	`status` enum('success','error','info') NOT NULL DEFAULT 'info',
	`details` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `operation_history_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` int AUTO_INCREMENT NOT NULL,
	`externalCode` varchar(50),
	`name` varchar(500) NOT NULL,
	`genericName` varchar(500),
	`supplier` varchar(255),
	`unitCost` decimal(12,4) DEFAULT '0',
	`salePrice` decimal(12,4) DEFAULT '0',
	`category` varchar(255),
	`isActive` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `products_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`purchaseId` int NOT NULL,
	`productId` int,
	`productName` varchar(500) NOT NULL,
	`quantity` int NOT NULL DEFAULT 1,
	`unitCost` decimal(12,4) DEFAULT '0',
	`subtotal` decimal(12,2) DEFAULT '0',
	`matched` int DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `purchase_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchases` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`branchId` int NOT NULL,
	`receiptNumber` varchar(100),
	`receiptType` varchar(50) DEFAULT 'BOLETA',
	`supplier` varchar(255),
	`totalAmount` decimal(12,2) DEFAULT '0',
	`status` enum('draft','pending_sync','synced','error') NOT NULL DEFAULT 'draft',
	`imageUrl` text,
	`imageKey` varchar(500),
	`extractedData` json,
	`syncError` text,
	`syncAttempts` int DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `purchases_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `task_queue` (
	`id` int AUTO_INCREMENT NOT NULL,
	`type` enum('purchase_sync','transfer_sync') NOT NULL,
	`referenceId` int NOT NULL,
	`status` enum('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
	`attempts` int DEFAULT 0,
	`maxAttempts` int DEFAULT 3,
	`lastError` text,
	`payload` json,
	`scheduledAt` timestamp NOT NULL DEFAULT (now()),
	`processedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `task_queue_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `transfer_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`transferId` int NOT NULL,
	`productId` int,
	`productName` varchar(500) NOT NULL,
	`quantity` int NOT NULL DEFAULT 1,
	`matched` int DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `transfer_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `transfers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`fromBranchId` int NOT NULL,
	`toBranchId` int NOT NULL,
	`referenceNumber` varchar(100),
	`status` enum('draft','pending_sync','synced','error') NOT NULL DEFAULT 'draft',
	`imageUrl` text,
	`imageKey` varchar(500),
	`extractedData` json,
	`syncError` text,
	`syncAttempts` int DEFAULT 0,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `transfers_id` PRIMARY KEY(`id`)
);
