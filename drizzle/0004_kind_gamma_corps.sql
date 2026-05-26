CREATE TABLE `confirmaciones` (
	`id` int AUTO_INCREMENT NOT NULL,
	`proveedor` varchar(255) NOT NULL,
	`nombreFactura` varchar(500) NOT NULL,
	`articuloId` int NOT NULL,
	`articuloNombre` varchar(500) NOT NULL,
	`articuloCodigo` varchar(100),
	`valido` int NOT NULL DEFAULT 1,
	`confirmadoEn` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `confirmaciones_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inventarios365_products` (
	`id` int AUTO_INCREMENT NOT NULL,
	`idarticulo` int NOT NULL,
	`codigo` varchar(100) NOT NULL,
	`nombre` varchar(500) NOT NULL,
	`precio_costo` decimal(12,4) DEFAULT '0',
	`precio_venta` decimal(12,4) DEFAULT '0',
	`stock` int DEFAULT 0,
	`lastSyncedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `inventarios365_products_id` PRIMARY KEY(`id`),
	CONSTRAINT `inventarios365_products_idarticulo_unique` UNIQUE(`idarticulo`)
);
--> statement-breakpoint
CREATE TABLE `productos_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`articuloId` int NOT NULL,
	`nombre` varchar(500) NOT NULL,
	`codigo` varchar(100),
	`idProveedor` int,
	`nombreProveedor` varchar(255),
	`precioCostoUnid` decimal(12,4) DEFAULT '0',
	`precioCostoPaq` decimal(12,4) DEFAULT '0',
	`precioUno` decimal(12,4) DEFAULT '0',
	`unidadEnvase` int DEFAULT 1,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `productos_cache_id` PRIMARY KEY(`id`),
	CONSTRAINT `productos_cache_articuloId_unique` UNIQUE(`articuloId`)
);
