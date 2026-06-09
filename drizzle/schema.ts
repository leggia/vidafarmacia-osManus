import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, decimal, json } from "drizzle-orm/mysql-core";

// ─── Users ───────────────────────────────────────────────────────────────────
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Branches (Sucursales) ───────────────────────────────────────────────────
export const branches = mysqlTable("branches", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  address: text("address"),
  phone: varchar("phone", { length: 50 }),
  isMain: int("isMain").default(0).notNull(), // 1 = central/main branch
  isActive: int("isActive").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Branch = typeof branches.$inferSelect;
export type InsertBranch = typeof branches.$inferInsert;

// ─── Products (Productos) ────────────────────────────────────────────────────
export const products = mysqlTable("products", {
  id: int("id").autoincrement().primaryKey(),
  externalCode: varchar("externalCode", { length: 50 }), // code in inventarios365
  name: varchar("name", { length: 500 }).notNull(),
  genericName: varchar("genericName", { length: 500 }),
  supplier: varchar("supplier", { length: 255 }),
  unitCost: decimal("unitCost", { precision: 12, scale: 4 }).default("0"),
  salePrice: decimal("salePrice", { precision: 12, scale: 4 }).default("0"),
  category: varchar("category", { length: 255 }),
  isActive: int("isActive").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

// ─── Purchases (Compras) ────────────────────────────────────────────────────
export const purchases = mysqlTable("purchases", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  branchId: int("branchId").notNull(),
  receiptNumber: varchar("receiptNumber", { length: 100 }),
  receiptType: varchar("receiptType", { length: 50 }).default("BOLETA"),
  supplier: varchar("supplier", { length: 255 }),
  totalAmount: decimal("totalAmount", { precision: 12, scale: 2 }).default("0"),
  status: mysqlEnum("status", ["draft", "pending_sync", "synced", "error", "completed"]).default("draft").notNull(),
  imageUrl: text("imageUrl"), // S3 URL of the uploaded invoice image/PDF
  imageKey: varchar("imageKey", { length: 500 }),
  extractedData: json("extractedData"), // Raw AI extraction result
  syncError: text("syncError"),
  syncAttempts: int("syncAttempts").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Purchase = typeof purchases.$inferSelect;
export type InsertPurchase = typeof purchases.$inferInsert;

// ─── Purchase Items ──────────────────────────────────────────────────────────
export const purchaseItems = mysqlTable("purchase_items", {
  id: int("id").autoincrement().primaryKey(),
  purchaseId: int("purchaseId").notNull(),
  productId: int("productId"),
  productName: varchar("productName", { length: 500 }).notNull(),
  quantity: int("quantity").default(1).notNull(),
  unitCost: decimal("unitCost", { precision: 12, scale: 4 }).default("0"),
  subtotal: decimal("subtotal", { precision: 12, scale: 2 }).default("0"),
  matched: int("matched").default(0), // 1 = matched to local product
  expiryDate: varchar("expiryDate", { length: 20 }), // Fecha de vencimiento YYYY-MM-DD
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type PurchaseItem = typeof purchaseItems.$inferSelect;
export type InsertPurchaseItem = typeof purchaseItems.$inferInsert;

// ─── Transfers (Transferencias entre Sucursales) ─────────────────────────────
export const transfers = mysqlTable("transfers", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  fromBranchId: int("fromBranchId").notNull(),
  toBranchId: int("toBranchId").notNull(),
  referenceNumber: varchar("referenceNumber", { length: 100 }),
  status: mysqlEnum("status", ["draft", "pending_sync", "synced", "error", "completed"]).default("draft").notNull(),
  imageUrl: text("imageUrl"),
  imageKey: varchar("imageKey", { length: 500 }),
  extractedData: json("extractedData"),
  syncError: text("syncError"),
  syncAttempts: int("syncAttempts").default(0),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Transfer = typeof transfers.$inferSelect;
export type InsertTransfer = typeof transfers.$inferInsert;

// ─── Transfer Items ──────────────────────────────────────────────────────────
export const transferItems = mysqlTable("transfer_items", {
  id: int("id").autoincrement().primaryKey(),
  transferId: int("transferId").notNull(),
  productId: int("productId"),
  productName: varchar("productName", { length: 500 }).notNull(),
  quantity: int("quantity").default(1).notNull(),
  matched: int("matched").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type TransferItem = typeof transferItems.$inferSelect;
export type InsertTransferItem = typeof transferItems.$inferInsert;

// ─── Task Queue (Cola de Tareas Pendientes) ──────────────────────────────────
export const taskQueue = mysqlTable("task_queue", {
  id: int("id").autoincrement().primaryKey(),
  type: mysqlEnum("type", ["purchase_sync", "transfer_sync"]).notNull(),
  referenceId: int("referenceId").notNull(), // purchaseId or transferId
  status: mysqlEnum("status", ["pending", "processing", "completed", "failed"]).default("pending").notNull(),
  attempts: int("attempts").default(0),
  maxAttempts: int("maxAttempts").default(3),
  lastError: text("lastError"),
  payload: json("payload"),
  scheduledAt: timestamp("scheduledAt").defaultNow().notNull(),
  processedAt: timestamp("processedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type TaskQueueItem = typeof taskQueue.$inferSelect;
export type InsertTaskQueueItem = typeof taskQueue.$inferInsert;

// ─── Operation History (Historial de Operaciones) ────────────────────────────
export const operationHistory = mysqlTable("operation_history", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  type: mysqlEnum("type", ["purchase", "transfer"]).notNull(),
  referenceId: int("referenceId").notNull(),
  action: varchar("action", { length: 100 }).notNull(), // e.g. "created", "ai_extracted", "synced", "sync_failed"
  status: mysqlEnum("status", ["success", "error", "info"]).default("info").notNull(),
  details: text("details"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type OperationHistoryItem = typeof operationHistory.$inferSelect;
export type InsertOperationHistoryItem = typeof operationHistory.$inferInsert;

// ─── Confirmaciones (Emparejamientos aprendidos) ─────────────────────────────
export const confirmaciones = mysqlTable("confirmaciones", {
  id: int("id").autoincrement().primaryKey(),
  proveedor: varchar("proveedor", { length: 255 }).notNull(),
  nombreFactura: varchar("nombreFactura", { length: 500 }).notNull(),
  articuloId: int("articuloId").notNull(),
  articuloNombre: varchar("articuloNombre", { length: 500 }).notNull(),
  articuloCodigo: varchar("articuloCodigo", { length: 100 }),
  valido: int("valido").default(1).notNull(),
  confirmadoEn: timestamp("confirmadoEn").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Confirmacion = typeof confirmaciones.$inferSelect;
export type InsertConfirmacion = typeof confirmaciones.$inferInsert;

// ─── Historial de Precios de Compra ──────────────────────────────────────────
// Registra el costo de cada producto en cada compra, para alertas y consultas
export const historialPrecios = mysqlTable("historial_precios", {
  id: int("id").autoincrement().primaryKey(),
  articuloId: int("articuloId").notNull(),
  articuloNombre: varchar("articuloNombre", { length: 500 }).notNull(),
  proveedor: varchar("proveedor", { length: 255 }),
  costoUnitario: decimal("costoUnitario", { precision: 12, scale: 4 }).notNull(),
  precioVenta: decimal("precioVenta", { precision: 12, scale: 4 }),
  numComprobante: varchar("numComprobante", { length: 100 }),
  registradoEn: timestamp("registradoEn").defaultNow().notNull(),
});

export type HistorialPrecio = typeof historialPrecios.$inferSelect;
export type InsertHistorialPrecio = typeof historialPrecios.$inferInsert;

// ─── Sesiones de Inventario ──────────────────────────────────────────────────
// Una sesión = un inventario con nombre, sucursal, que se hace por proveedor
export const inventarioSesiones = mysqlTable("inventario_sesiones", {
  id: int("id").autoincrement().primaryKey(),
  nombre: varchar("nombre", { length: 255 }).notNull(), // "Inventario MAYO Suc 1"
  tipo: varchar("tipo", { length: 30 }).notNull().default("anual"), // anual | ciclico_abc
  almacenId: int("almacenId").notNull(), // sucursal/almacén de inventarios365
  almacenNombre: varchar("almacenNombre", { length: 255 }),
  totalProveedores: int("totalProveedores").notNull().default(0),
  estado: varchar("estado", { length: 20 }).notNull().default("en_progreso"), // en_progreso | completado
  creadoEn: timestamp("creadoEn").defaultNow().notNull(),
  actualizadoEn: timestamp("actualizadoEn").defaultNow().onUpdateNow().notNull(),
});

export type InventarioSesion = typeof inventarioSesiones.$inferSelect;
export type InsertInventarioSesion = typeof inventarioSesiones.$inferInsert;

// Avance por proveedor dentro de una sesión, con los conteos guardados
export const inventarioProveedores = mysqlTable("inventario_proveedores", {
  id: int("id").autoincrement().primaryKey(),
  sesionId: int("sesionId").notNull(),
  proveedorId: varchar("proveedorId", { length: 50 }),
  proveedorNombre: varchar("proveedorNombre", { length: 255 }).notNull(),
  totalProductos: int("totalProductos").notNull().default(0),
  productosContados: int("productosContados").notNull().default(0),
  conDiferencia: int("conDiferencia").notNull().default(0),
  conteos: json("conteos"), // array de {articuloId, nombre, stockSistema, stockFisico, diferencia}
  estado: varchar("estado", { length: 20 }).notNull().default("en_progreso"),
  completadoEn: timestamp("completadoEn"),
  actualizadoEn: timestamp("actualizadoEn").defaultNow().onUpdateNow().notNull(),
});

export type InventarioProveedor = typeof inventarioProveedores.$inferSelect;
export type InsertInventarioProveedor = typeof inventarioProveedores.$inferInsert;

// ─── Confirmaciones de Proveedores ───────────────────────────────────────────
// Aprende: nombre de proveedor en factura → proveedor del sistema (como productos)
export const confirmacionesProveedores = mysqlTable("confirmaciones_proveedores", {
  id: int("id").autoincrement().primaryKey(),
  nombreFactura: varchar("nombreFactura", { length: 500 }).notNull(),
  proveedorId: varchar("proveedorId", { length: 50 }).notNull(),
  proveedorNombre: varchar("proveedorNombre", { length: 255 }).notNull(),
  valido: int("valido").default(1).notNull(),
  confirmadoEn: timestamp("confirmadoEn").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ConfirmacionProveedor = typeof confirmacionesProveedores.$inferSelect;
export type InsertConfirmacionProveedor = typeof confirmacionesProveedores.$inferInsert;

// ─── Productos Cache (Cache de artículos de inventarios365) ──────────────────
export const productosCache = mysqlTable("productos_cache", {
  id: int("id").autoincrement().primaryKey(),
  articuloId: int("articuloId").notNull().unique(),
  nombre: varchar("nombre", { length: 500 }).notNull(),
  codigo: varchar("codigo", { length: 100 }),
  idProveedor: int("idProveedor"),
  nombreProveedor: varchar("nombreProveedor", { length: 255 }),
  precioCostoUnid: decimal("precioCostoUnid", { precision: 12, scale: 4 }).default("0"),
  precioCostoPaq: decimal("precioCostoPaq", { precision: 12, scale: 4 }).default("0"),
  precioUno: decimal("precioUno", { precision: 12, scale: 4 }).default("0"),
  unidadEnvase: int("unidadEnvase").default(1),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ProductoCache = typeof productosCache.$inferSelect;
export type InsertProductoCache = typeof productosCache.$inferInsert;


// ─── Inventarios365 Products (Productos de inventarios365.com) ────────────────
export const inventarios365Products = mysqlTable("inventarios365_products", {
  id: int("id").autoincrement().primaryKey(),
  idarticulo: int("idarticulo").notNull().unique(), // ID del artículo en inventarios365
  codigo: varchar("codigo", { length: 100 }).notNull(),
  nombre: varchar("nombre", { length: 500 }).notNull(),
  precio_costo: decimal("precio_costo", { precision: 12, scale: 4 }).default("0"),
  precio_venta: decimal("precio_venta", { precision: 12, scale: 4 }).default("0"),
  stock: int("stock").default(0),
  lastSyncedAt: timestamp("lastSyncedAt").defaultNow().onUpdateNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Inventarios365Product = typeof inventarios365Products.$inferSelect;
export type InsertInventarios365Product = typeof inventarios365Products.$inferInsert;

// ─── Asistencia del Personal ──────────────────────────────────────────────────
// Trabajadores: vinculados a su usuario de inventarios365 (la apertura de caja = entrada)
export const trabajadores = mysqlTable("trabajadores", {
  id: int("id").autoincrement().primaryKey(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  // Usuario de inventarios365 con el que abre caja (para cruzar las aperturas)
  usuarioSistemaId: varchar("usuarioSistemaId", { length: 50 }), // id del usuario en inventarios365
  usuarioSistemaNombre: varchar("usuarioSistemaNombre", { length: 255 }), // nombre/login en el sistema
  horaIngreso: varchar("horaIngreso", { length: 5 }).notNull().default("08:00"), // HH:MM esperada
  horasDia: decimal("horasDia", { precision: 4, scale: 2 }).notNull().default("8"), // horas diarias
  diasMes: int("diasMes").notNull().default(26), // días laborales al mes (para valor hora)
  sueldoMensual: decimal("sueldoMensual", { precision: 12, scale: 2 }).notNull().default("0"),
  // Regla de descuento por retraso: "proporcional" (valor hora × tiempo) o "fijo" (monto por retraso)
  tipoDescuento: varchar("tipoDescuento", { length: 20 }).notNull().default("proporcional"),
  montoDescuentoFijo: decimal("montoDescuentoFijo", { precision: 10, scale: 2 }).notNull().default("0"),
  toleranciaMin: int("toleranciaMin").notNull().default(5), // minutos de tolerancia antes de contar retraso
  activo: int("activo").notNull().default(1),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Trabajador = typeof trabajadores.$inferSelect;
export type InsertTrabajador = typeof trabajadores.$inferInsert;

// Aperturas de caja leídas de inventarios365 (caché para el resumen mensual)
export const marcaciones = mysqlTable("marcaciones", {
  id: int("id").autoincrement().primaryKey(),
  trabajadorId: int("trabajadorId").notNull(),
  fecha: varchar("fecha", { length: 10 }).notNull(), // YYYY-MM-DD
  horaEntrada: varchar("horaEntrada", { length: 8 }), // HH:MM:SS de apertura de caja
  horaSalida: varchar("horaSalida", { length: 8 }), // HH:MM:SS de cierre de caja (si existe)
  minutosRetraso: int("minutosRetraso").notNull().default(0),
  horasTrabajadas: decimal("horasTrabajadas", { precision: 5, scale: 2 }).default("0"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Marcacion = typeof marcaciones.$inferSelect;
export type InsertMarcacion = typeof marcaciones.$inferInsert;
