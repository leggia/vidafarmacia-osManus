import { eq, desc, and, sql, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  branches,
  products,
  purchases,
  purchaseItems,
  transfers,
  transferItems,
  taskQueue,
  operationHistory,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ─── User helpers ───
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot upsert user: database not available"); return; }
  try {
    const values: InsertUser = { openId: user.openId };
    const updateSet: Record<string, unknown> = {};
    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];
    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };
    textFields.forEach(assignNullable);
    if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
    if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
    else if (user.openId === ENV.ownerOpenId) { values.role = "admin"; updateSet.role = "admin"; }
    if (!values.lastSignedIn) values.lastSignedIn = new Date();
    if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
    await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
  } catch (error) { console.error("[Database] Failed to upsert user:", error); throw error; }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) { console.warn("[Database] Cannot get user: database not available"); return undefined; }
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// ─── Branches ───
export async function listBranches() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(branches).orderBy(desc(branches.isMain));
}

export async function getBranchById(id: number) {
  const db = await getDb();
  if (!db) return null;
  const result = await db.select().from(branches).where(eq(branches.id, id)).limit(1);
  return result[0] || null;
}

// ─── Purchases ───
export async function listPurchases(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: purchases.id,
      receiptNumber: purchases.receiptNumber,
      supplier: purchases.supplier,
      status: purchases.status,
      totalAmount: purchases.totalAmount,
      imageUrl: purchases.imageUrl,
      createdAt: purchases.createdAt,
      branchId: purchases.branchId,
      branchName: branches.name,
      syncError: purchases.syncError,
      syncAttempts: purchases.syncAttempts,
    })
    .from(purchases)
    .leftJoin(branches, eq(purchases.branchId, branches.id))
    .where(eq(purchases.userId, userId))
    .orderBy(desc(purchases.createdAt));
  return rows;
}

export async function createPurchase(data: {
  userId: number;
  branchId: number;
  receiptNumber?: string;
  receiptType?: string;
  supplier?: string;
  totalAmount?: number;
  imageUrl?: string | null;
  imageKey?: string | null;
  extractedData?: any;
  status?: string;
  items: Array<{ productName: string; quantity: number; unitCost: number; subtotal: number; expiryDate?: string | null }>;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const finalStatus = data.status || "draft";

  const [purchaseResult] = await db.insert(purchases).values({
    userId: data.userId,
    branchId: data.branchId,
    receiptNumber: data.receiptNumber || null,
    receiptType: data.receiptType || "BOLETA",
    supplier: data.supplier || null,
    totalAmount: String(data.totalAmount || 0),
    imageUrl: data.imageUrl || null,
    imageKey: data.imageKey || null,
    extractedData: data.extractedData || null,
    status: finalStatus as any,
  });

  const purchaseId = purchaseResult.insertId;

  if (data.items.length > 0) {
    await db.insert(purchaseItems).values(
      data.items.map((item) => ({
        purchaseId,
        productName: item.productName,
        quantity: item.quantity,
        unitCost: String(item.unitCost),
        subtotal: String(item.subtotal),
        expiryDate: item.expiryDate || null,
      }))
    );
  }

  // Log operation
  const actionLabel = finalStatus === "completed" ? "Compra confirmada" : "Compra creada (borrador)";
  await db.insert(operationHistory).values({
    userId: data.userId,
    type: "purchase",
    referenceId: purchaseId,
    action: actionLabel,
    status: "success",
    details: `${data.items.length} productos, total: ${data.totalAmount || 0} BS`,
  });

  // Only create task queue entry if not confirmed directly
  if (finalStatus === "draft") {
    await db.insert(taskQueue).values({
      type: "purchase_sync",
      referenceId: purchaseId,
      status: "pending",
      payload: JSON.stringify({ purchaseId, items: data.items }),
    });
  }

  return { id: purchaseId };
}

export async function confirmPurchase(purchaseId: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(purchases)
    .set({ status: "completed" as any })
    .where(and(eq(purchases.id, purchaseId), eq(purchases.userId, userId)));

  // Remove from task queue if exists
  await db
    .delete(taskQueue)
    .where(and(eq(taskQueue.referenceId, purchaseId), eq(taskQueue.type, "purchase_sync")));

  // Log operation
  await db.insert(operationHistory).values({
    userId,
    type: "purchase",
    referenceId: purchaseId,
    action: "Compra confirmada",
    status: "success",
    details: "Compra confirmada manualmente por el usuario",
  });

  return { success: true };
}

// ─── Transfers ───
export async function listTransfers(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: transfers.id,
      referenceNumber: transfers.referenceNumber,
      status: transfers.status,
      imageUrl: transfers.imageUrl,
      notes: transfers.notes,
      createdAt: transfers.createdAt,
      fromBranchId: transfers.fromBranchId,
      toBranchId: transfers.toBranchId,
    })
    .from(transfers)
    .where(eq(transfers.userId, userId))
    .orderBy(desc(transfers.createdAt));

  // Get branch names
  const branchIds = Array.from(new Set(rows.flatMap((r) => [r.fromBranchId, r.toBranchId])));
  if (branchIds.length === 0) return [];
  const branchRows = await db.select().from(branches).where(inArray(branches.id, branchIds));
  const branchMap = Object.fromEntries(branchRows.map((b) => [b.id, b.name]));

  return rows.map((r) => ({
    ...r,
    fromBranchName: branchMap[r.fromBranchId] || "Desconocida",
    toBranchName: branchMap[r.toBranchId] || "Desconocida",
  }));
}

export async function createTransfer(data: {
  userId: number;
  fromBranchId: number;
  toBranchId: number;
  referenceNumber?: string;
  notes?: string;
  imageUrl?: string | null;
  imageKey?: string | null;
  extractedData?: any;
  status?: string;
  items: Array<{ productName: string; quantity: number }>;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const finalStatus = data.status || "draft";

  const [transferResult] = await db.insert(transfers).values({
    userId: data.userId,
    fromBranchId: data.fromBranchId,
    toBranchId: data.toBranchId,
    referenceNumber: data.referenceNumber || null,
    notes: data.notes || null,
    imageUrl: data.imageUrl || null,
    imageKey: data.imageKey || null,
    extractedData: data.extractedData || null,
    status: finalStatus as any,
  });

  const transferId = transferResult.insertId;

  if (data.items.length > 0) {
    await db.insert(transferItems).values(
      data.items.map((item) => ({
        transferId,
        productName: item.productName,
        quantity: item.quantity,
      }))
    );
  }

  const actionLabel = finalStatus === "completed" ? "Transferencia confirmada" : "Transferencia creada (borrador)";
  await db.insert(operationHistory).values({
    userId: data.userId,
    type: "transfer",
    referenceId: transferId,
    action: actionLabel,
    status: "success",
    details: `${data.items.length} productos`,
  });

  if (finalStatus === "draft") {
    await db.insert(taskQueue).values({
      type: "transfer_sync",
      referenceId: transferId,
      status: "pending",
      payload: JSON.stringify({ transferId, items: data.items }),
    });
  }

  return { id: transferId };
}

export async function confirmTransfer(transferId: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(transfers)
    .set({ status: "completed" as any })
    .where(and(eq(transfers.id, transferId), eq(transfers.userId, userId)));

  await db
    .delete(taskQueue)
    .where(and(eq(taskQueue.referenceId, transferId), eq(taskQueue.type, "transfer_sync")));

  await db.insert(operationHistory).values({
    userId,
    type: "transfer",
    referenceId: transferId,
    action: "Transferencia confirmada",
    status: "success",
    details: "Transferencia confirmada manualmente por el usuario",
  });

  return { success: true };
}

// ─── Task Queue ───
export async function listTaskQueue() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(taskQueue).orderBy(desc(taskQueue.createdAt));
}

export async function retryTask(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .update(taskQueue)
    .set({ status: "pending", attempts: 0 })
    .where(eq(taskQueue.id, id));
  return { success: true };
}

// ─── Operation History ───
export async function listOperationHistory(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(operationHistory)
    .where(eq(operationHistory.userId, userId))
    .orderBy(desc(operationHistory.createdAt))
    .limit(100);
}

// ─── Dashboard Stats ───
export async function getDashboardStats(userId: number) {
  const db = await getDb();
  if (!db) return { totalPurchases: 0, totalTransfers: 0, pendingTasks: 0, errorTasks: 0, recentPurchases: [], recentTransfers: [] };

  const [purchaseCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(purchases)
    .where(eq(purchases.userId, userId));

  const [transferCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(transfers)
    .where(eq(transfers.userId, userId));

  const [pendingCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(taskQueue)
    .where(eq(taskQueue.status, "pending"));

  const [errorCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(taskQueue)
    .where(eq(taskQueue.status, "failed"));

  const recentPurchases = await db
    .select({
      id: purchases.id,
      receiptNumber: purchases.receiptNumber,
      supplier: purchases.supplier,
      status: purchases.status,
      totalAmount: purchases.totalAmount,
      createdAt: purchases.createdAt,
    })
    .from(purchases)
    .where(eq(purchases.userId, userId))
    .orderBy(desc(purchases.createdAt))
    .limit(5);

  const recentTransferRows = await db
    .select({
      id: transfers.id,
      referenceNumber: transfers.referenceNumber,
      status: transfers.status,
      createdAt: transfers.createdAt,
      fromBranchId: transfers.fromBranchId,
      toBranchId: transfers.toBranchId,
    })
    .from(transfers)
    .where(eq(transfers.userId, userId))
    .orderBy(desc(transfers.createdAt))
    .limit(5);

  const branchIds = Array.from(new Set(recentTransferRows.flatMap((r) => [r.fromBranchId, r.toBranchId])));
  let branchMap: Record<number, string> = {};
  if (branchIds.length > 0) {
    const branchRows = await db.select().from(branches).where(inArray(branches.id, branchIds));
    branchMap = Object.fromEntries(branchRows.map((b) => [b.id, b.name]));
  }

  const recentTransfers = recentTransferRows.map((r) => ({
    ...r,
    fromBranchName: branchMap[r.fromBranchId] || "Desconocida",
    toBranchName: branchMap[r.toBranchId] || "Desconocida",
  }));

  return {
    totalPurchases: purchaseCount.count,
    totalTransfers: transferCount.count,
    pendingTasks: pendingCount.count,
    errorTasks: errorCount.count,
    recentPurchases,
    recentTransfers,
  };
}

// ─── Get Purchase With Items (for sync) ───
export async function getPurchaseWithItems(purchaseId: number) {
  const db = await getDb();
  if (!db) return null;

  const [purchase] = await db
    .select()
    .from(purchases)
    .where(eq(purchases.id, purchaseId))
    .limit(1);

  if (!purchase) return null;

  const items = await db
    .select()
    .from(purchaseItems)
    .where(eq(purchaseItems.purchaseId, purchaseId));

  return { ...purchase, items };
}

// ─── Update Purchase Sync Status ───
export async function updatePurchaseSyncStatus(
  purchaseId: number,
  status: "completed" | "sync_error",
  errorMsg?: string
) {
  const db = await getDb();
  if (!db) return;

  await db
    .update(purchases)
    .set({
      status: status as any,
      syncError: errorMsg || null,
    })
    .where(eq(purchases.id, purchaseId));
}

// ─── Get Purchase By Id (alias) ───
export async function getPurchaseById(purchaseId: number) {
  return getPurchaseWithItems(purchaseId);
}

// ─── Update Purchase Sync Error ───
export async function updatePurchaseSyncError(purchaseId: number, errorMsg: string) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(purchases)
    .set({ syncError: errorMsg, syncAttempts: sql`syncAttempts + 1` })
    .where(eq(purchases.id, purchaseId));
}
