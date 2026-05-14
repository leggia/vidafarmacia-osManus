import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { invokeLLM } from "./_core/llm";
import { storagePut } from "./storage";

import { nanoid } from "nanoid";
import * as db from "./db";
import { inventarios365 } from "./inventarios365";

// ─── Branches Router ─────────────────────────────────────────────────────────
const branchesRouter = router({
  list: protectedProcedure.query(async () => {
    return db.listBranches();
  }),
});

// ─── Purchases Router ────────────────────────────────────────────────────────
const purchasesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db.listPurchases(ctx.user.id);
  }),

  uploadAndExtract: protectedProcedure
    .input(
      z.object({
        fileBase64: z.string(),
        fileName: z.string(),
        mimeType: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      // 1. Upload to S3
      const buffer = Buffer.from(input.fileBase64, "base64");
      const ext = input.fileName.split(".").pop() || "jpg";
      const fileKey = `purchases/${nanoid()}.${ext}`;
      const { url: imageUrl, key: imageKey } = await storagePut(
        fileKey,
        buffer,
        input.mimeType
      );

      // 2. Use LLM vision to extract data
      const isImage = input.mimeType.startsWith("image/");
      const isPdf = input.mimeType === "application/pdf";

      const userContent: any[] = [
        {
          type: "text",
          text: `Analiza esta ${isImage ? "imagen" : "documento"} de una factura de compra de medicamentos farmacéuticos de Bolivia.
Extrae la siguiente información en formato JSON:
{
  "supplier": "nombre del proveedor si es visible",
  "receiptNumber": "número de comprobante/factura si es visible",
  "items": [
    {
      "productName": "nombre exacto del producto/medicamento",
      "quantity": número_entero_de_unidades_TOTALES,
      "unitCost": costo_unitario_decimal_por_unidad,
      "subtotal": subtotal_decimal
    }
  ]
}

INSTRUCCIONES CRÍTICAS PARA CANTIDADES FARMACÉUTICAS:
- La "quantity" debe ser el NÚMERO TOTAL DE UNIDADES INDIVIDUALES (comprimidos, cápsulas, ampollas, frascos, etc.)
- Si la factura dice "4" cajas y el producto indica "x10 comp" o "x10 caps" o "x10 cpr", la cantidad es 4 × 10 = 40 unidades
- Si dice "x30 comp", multiplica: cajas × 30
- Si dice "x20 caps", multiplica: cajas × 20
- Presentaciones comunes: "comp" = comprimidos, "caps" = cápsulas, "cpr" = comprimidos, "tab" = tabletas, "grag" = grageas
- Para jarabes (jbe), gotas, cremas, inyectables: cada frasco/ampolla/tubo cuenta como 1 unidad (NO multiplicar)
- Si la factura muestra una columna de "cantidad" y otra de "presentación" (ej: x10), SIEMPRE multiplica ambas
- Si solo ves un número sin indicación de presentación, úsalo directamente como cantidad
- El "unitCost" debe ser el costo POR UNIDAD INDIVIDUAL, no por caja. Si el precio es por caja, divide: precio_caja / unidades_por_caja

INSTRUCCIONES GENERALES:
- Extrae TODOS los productos visibles en la factura
- Si no puedes leer el costo unitario, coloca 0
- Si no puedes leer el subtotal, calcula quantity * unitCost
- El nombre del producto debe ser lo más exacto posible, incluyendo la presentación (comp, jbe, gotas, etc.)
- Si hay abreviaturas farmacéuticas, mantenlas tal cual
- Responde SOLO con el JSON, sin texto adicional`,
        },
      ];

      if (isImage) {
        userContent.push({
          type: "image_url",
          image_url: { url: imageUrl, detail: "high" },
        });
      } else if (isPdf) {
        userContent.push({
          type: "file_url",
          file_url: { url: imageUrl, mime_type: "application/pdf" },
        });
      }

      const llmResult = await invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "Eres un asistente experto en lectura de facturas farmacéuticas bolivianas. Tienes amplio conocimiento de presentaciones de medicamentos (comprimidos, cápsulas, jarabes, gotas, inyectables). Cuando una factura muestra cajas con presentación (ej: x10 comp, x30 caps), SIEMPRE multiplicas cajas por unidades para obtener el total real. Extraes datos con alta precisión. Responde SOLO en JSON válido.",
          },
          { role: "user", content: userContent },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "invoice_extraction",
            strict: true,
            schema: {
              type: "object",
              properties: {
                supplier: {
                  type: "string",
                  description: "Nombre del proveedor",
                },
                receiptNumber: {
                  type: "string",
                  description: "Número de comprobante",
                },
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      productName: { type: "string" },
                      quantity: { type: "number" },
                      unitCost: { type: "number" },
                      subtotal: { type: "number" },
                    },
                    required: [
                      "productName",
                      "quantity",
                      "unitCost",
                      "subtotal",
                    ],
                    additionalProperties: false,
                  },
                },
              },
              required: ["supplier", "receiptNumber", "items"],
              additionalProperties: false,
            },
          },
        },
      });

      let extracted: any = {
        supplier: "",
        receiptNumber: "",
        items: [],
      };
      try {
        const content = llmResult.choices[0]?.message?.content;
        if (typeof content === "string") {
          extracted = JSON.parse(content);
        }
      } catch (e) {
        console.error("[LLM] Failed to parse extraction result:", e);
      }

      return {
        imageUrl,
        imageKey,
        supplier: extracted.supplier || "",
        receiptNumber: extracted.receiptNumber || "",
        items: (extracted.items || []).map((item: any) => ({
          productName: item.productName || "",
          quantity: Math.max(1, Math.round(item.quantity || 1)),
          unitCost: Math.max(0, item.unitCost || 0),
          subtotal: Math.max(
            0,
            item.subtotal || (item.quantity || 1) * (item.unitCost || 0)
          ),
        })),
      };
    }),

  create: protectedProcedure
    .input(
      z.object({
        branchId: z.number(),
        receiptNumber: z.string().optional(),
        receiptType: z.enum(["BOLETA", "FACTURA"]).optional(),
        supplier: z.string().optional(),
        almacenNombre: z.string().optional(),
        totalAmount: z.number().optional(),
        items: z.array(
          z.object({
            productName: z.string(),
            quantity: z.number(),
            unitCost: z.number(),
            subtotal: z.number(),
            expiryDate: z.string().nullable().optional(),
          })
        ),
        imageUrl: z.string().nullable().optional(),
        imageKey: z.string().nullable().optional(),
        confirmDirectly: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const status = input.confirmDirectly ? "completed" : "draft";
      const result = await db.createPurchase({
        userId: ctx.user.id,
        branchId: input.branchId,
        receiptNumber: input.receiptNumber,
        receiptType: input.receiptType || "BOLETA",
        supplier: input.supplier,
        totalAmount: input.totalAmount,
        items: input.items,
        imageUrl: input.imageUrl,
        imageKey: input.imageKey,
        status,
      });

      // Sincronizar con inventarios365.com DIRECTAMENTE (await) — Cloud Run cancela setImmediate
      let syncSuccess = false;
      let syncMessage = "";
      let syncIngresoId: number | undefined;
      if (input.confirmDirectly) {
        const purchaseId = result.id;
        try {
          console.log(`[Sync] Iniciando sincronización directa para compra #${purchaseId}`);
          const syncResult = await inventarios365.registrarCompra({
            proveedor: input.supplier || "",
            tipoComprobante: input.receiptType || "BOLETA",
            numComprobante: input.receiptNumber || String(purchaseId),
            almacenNombre: input.almacenNombre || "principal",
            items: input.items.map((item) => ({
              nombre: item.productName,
              cantidad: item.quantity,
              precio: item.unitCost,
              fechaVencimiento: item.expiryDate || null,
            })),
            total: input.totalAmount || 0,
          });
          console.log(`[Sync] Resultado compra #${purchaseId}:`, syncResult);
          if (syncResult.success) {
            syncSuccess = true;
            syncMessage = `Compra registrada en inventarios365.com (Ingreso ID: ${syncResult.ingresoId})`;
            syncIngresoId = syncResult.ingresoId;
            await db.updatePurchaseSyncStatus(purchaseId, "completed");
          } else {
            syncSuccess = false;
            syncMessage = syncResult.message;
            await db.updatePurchaseSyncError(purchaseId, syncResult.message);
          }
        } catch (syncError: any) {
          const errMsg = syncError?.message || "Error desconocido";
          syncSuccess = false;
          syncMessage = errMsg;
          console.error(`[Sync] Error sincronizando compra #${purchaseId}:`, errMsg);
          await db.updatePurchaseSyncError(purchaseId, errMsg).catch(() => {});
        }
      }

      return {
        ...result,
        syncSuccess,
        syncMessage,
        syncIngresoId,
      };
    }),

  confirm: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      // 1. Confirmar la compra en BD inmediatamente
      const purchase = await db.getPurchaseById(input.id);
      const result = await db.confirmPurchase(input.id, ctx.user.id);

      // 2. Sincronizar con inventarios365.com DIRECTAMENTE (await) — Cloud Run cancela setImmediate
      let syncSuccess2 = false;
      let syncMessage2 = "No se pudo obtener los datos de la compra";
      let syncIngresoId2: number | undefined;
      if (purchase) {
        const purchaseId = input.id;
        try {
          const items = (purchase.items || []).map((item: any) => ({
            nombre: item.productName || item.product_name || "",
            cantidad: Number(item.quantity) || 1,
            precio: parseFloat(String(item.unitCost || item.unit_cost || 0)),
            fechaVencimiento: item.expiryDate || null,
          }));
          console.log(`[Sync] Iniciando sincronización directa para compra #${purchaseId}`);
          const syncResult = await inventarios365.registrarCompra({
            proveedor: purchase.supplier || "",
            tipoComprobante: purchase.receiptType || "BOLETA",
            numComprobante: purchase.receiptNumber || String(purchaseId),
            almacenNombre: "principal",
            items,
            total: parseFloat(String(purchase.totalAmount || 0)),
          });
          console.log(`[Sync] Resultado compra #${purchaseId}:`, syncResult);
          if (syncResult.success) {
            syncSuccess2 = true;
            syncMessage2 = `Compra registrada en inventarios365.com (Ingreso ID: ${syncResult.ingresoId})`;
            syncIngresoId2 = syncResult.ingresoId;
            await db.updatePurchaseSyncStatus(purchaseId, "completed");
          } else {
            syncSuccess2 = false;
            syncMessage2 = syncResult.message;
            await db.updatePurchaseSyncError(purchaseId, syncResult.message);
          }
        } catch (syncError: any) {
          const errMsg = syncError?.message || "Error desconocido";
          syncSuccess2 = false;
          syncMessage2 = errMsg;
          console.error(`[Sync] Error sincronizando compra #${purchaseId}:`, errMsg);
          await db.updatePurchaseSyncError(purchaseId, errMsg).catch(() => {});
        }
      }
      // 3. Responder al usuario con el resultado real de la sincronización
      return {
        ...result,
        syncSuccess: syncSuccess2,
        syncMessage: syncMessage2,
        syncIngresoId: syncIngresoId2,
      };
    }),
});

// ─── Transfers Router ────────────────────────────────────────────────────────
const transfersRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db.listTransfers(ctx.user.id);
  }),

  uploadAndExtract: protectedProcedure
    .input(
      z.object({
        fileBase64: z.string(),
        fileName: z.string(),
        mimeType: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const buffer = Buffer.from(input.fileBase64, "base64");
      const ext = input.fileName.split(".").pop() || "jpg";
      const fileKey = `transfers/${nanoid()}.${ext}`;
      const { url: imageUrl, key: imageKey } = await storagePut(
        fileKey,
        buffer,
        input.mimeType
      );

      const isImage = input.mimeType.startsWith("image/");

      const userContent: any[] = [
        {
          type: "text",
          text: `Analiza esta ${isImage ? "imagen" : "documento"} que muestra medicamentos para transferir entre sucursales de una farmacia.
Extrae la lista de medicamentos en formato JSON:
{
  "items": [
    {
      "productName": "nombre exacto del medicamento",
      "quantity": número_entero_de_unidades
    }
  ]
}

INSTRUCCIONES IMPORTANTES:
- Extrae TODOS los medicamentos visibles
- Si ves cajas o envases, cuenta cada uno como 1 unidad a menos que se indique otra cantidad
- El nombre del producto debe ser lo más exacto posible, incluyendo la presentación (comp, jbe, gotas, etc.)
- Si hay texto escrito a mano, intenta leerlo con la mayor precisión posible
- Responde SOLO con el JSON, sin texto adicional`,
        },
      ];

      if (isImage) {
        userContent.push({
          type: "image_url",
          image_url: { url: imageUrl, detail: "high" },
        });
      } else {
        userContent.push({
          type: "file_url",
          file_url: { url: imageUrl, mime_type: "application/pdf" },
        });
      }

      const llmResult = await invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "Eres un asistente experto en identificación de medicamentos farmacéuticos. Identificas productos con alta precisión a partir de fotos. Responde SOLO en JSON válido.",
          },
          { role: "user", content: userContent },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "transfer_extraction",
            strict: true,
            schema: {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      productName: { type: "string" },
                      quantity: { type: "number" },
                    },
                    required: ["productName", "quantity"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["items"],
              additionalProperties: false,
            },
          },
        },
      });

      let extracted: any = { items: [] };
      try {
        const content = llmResult.choices[0]?.message?.content;
        if (typeof content === "string") {
          extracted = JSON.parse(content);
        }
      } catch (e) {
        console.error("[LLM] Failed to parse transfer extraction:", e);
      }

      return {
        imageUrl,
        imageKey,
        items: (extracted.items || []).map((item: any) => ({
          productName: item.productName || "",
          quantity: Math.max(1, Math.round(item.quantity || 1)),
        })),
      };
    }),

  create: protectedProcedure
    .input(
      z.object({
        fromBranchId: z.number(),
        toBranchId: z.number(),
        referenceNumber: z.string().optional(),
        notes: z.string().optional(),
        items: z.array(
          z.object({
            productName: z.string(),
            quantity: z.number(),
          })
        ),
        imageUrl: z.string().nullable().optional(),
        imageKey: z.string().nullable().optional(),
        confirmDirectly: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const status = input.confirmDirectly ? "completed" : "draft";
      const result = await db.createTransfer({
        userId: ctx.user.id,
        fromBranchId: input.fromBranchId,
        toBranchId: input.toBranchId,
        referenceNumber: input.referenceNumber,
        notes: input.notes,
        items: input.items,
        imageUrl: input.imageUrl,
        imageKey: input.imageKey,
        status,
      });

      return result;
    }),

  confirm: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.confirmTransfer(input.id, ctx.user.id);
      return result;
    }),
});

// ─── Task Queue Router ───────────────────────────────────────────────────────
const taskQueueRouter = router({
  list: protectedProcedure.query(async () => {
    return db.listTaskQueue();
  }),

  retry: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      return db.retryTask(input.id);
    }),
});

// ─── Operation History Router ────────────────────────────────────────────────
const operationHistoryRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return db.listOperationHistory(ctx.user.id);
  }),
});

// ─── Dashboard Router ────────────────────────────────────────────────────────
const dashboardRouter = router({
  stats: protectedProcedure.query(async ({ ctx }) => {
    return db.getDashboardStats(ctx.user.id);
  }),
});

// ─── App Router ──────────────────────────────────────────────────────────────
export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  dashboard: dashboardRouter,
  branches: branchesRouter,
  purchases: purchasesRouter,
  transfers: transfersRouter,
  taskQueue: taskQueueRouter,
  operationHistory: operationHistoryRouter,
});

export type AppRouter = typeof appRouter;
