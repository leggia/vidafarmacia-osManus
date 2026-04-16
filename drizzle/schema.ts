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
