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
import { inventarios365Router } from "./inventarios365-router";

// Helper: leer archivo local y convertir a base64 para Groq (DEPRECADO - usar imageToBase64)
async function fileToBase64DataUrl(fileKey: string, mimeType: string): Promise<string> {
  const pathMod = (await import("path")).default;
  const fsMod = (await import("fs")).default;
  const filePath = pathMod.join(process.cwd(), "uploads", fileKey);
  const buffer = fsMod.readFileSync(filePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

// Importar procesador de PDFs
import { pdfToBase64Png, imageToBase64, extractTextFromPdf } from "./pdf-processor";


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
  "totalFactura": total_general_de_la_factura_decimal,
  "items": [
    {
      "productName": "nombre comercial del medicamento SIN códigos numéricos del proveedor",
      "quantity": número_entero_de_unidades_TOTALES,
      "unitCost": costo_unitario_decimal_por_unidad,
      "subtotal": subtotal_de_la_linea_CON_descuento_aplicado,
      "expiryDate": "fecha de vencimiento en formato MM/YYYY o DD/MM/YYYY si aparece, sino null"
    }
  ]
}

INSTRUCCIONES CRÍTICAS PARA PRECIOS (MUY IMPORTANTE):
- Cada línea de la factura tiene: CANTIDAD, PRECIO UNITARIO, y un IMPORTE/SUBTOTAL de esa línea
- El "subtotal" es el IMPORTE TOTAL de esa línea (lo que aparece en la columna derecha de cada fila)
- El "unitCost" SIEMPRE debe ser: subtotal_de_la_linea ÷ quantity
- NUNCA pongas el subtotal/importe como unitCost. Si una línea dice cantidad 20 e importe 400, entonces unitCost = 400/20 = 20
- Si hay columna de DESCUENTO o "Dscto", el subtotal debe ser DESPUÉS del descuento (el importe neto que realmente se paga)
- Ejemplo descuento: si precio lista 31, cantidad 6, importe con descuento 150 → unitCost = 150/6 = 25
- VERIFICACIÓN: la suma de todos los "subtotal" debe ser aproximadamente igual al "totalFactura". Si no cuadra, revisa los precios

INSTRUCCIONES PARA NOMBRE DEL PRODUCTO:
- Extrae SOLO el nombre comercial. Si la fila tiene un código numérico al inicio (ej: "400180 QUETOROL 20 TAB"), extrae SOLO "QUETOROL 20 TAB" sin el código.
- Ignora códigos internos del proveedor, códigos de barras o referencias numéricas al inicio del nombre.

INSTRUCCIONES PARA FECHA DE VENCIMIENTO:
- Busca columnas llamadas "VCTO", "Venc.", "Vencimiento", "Fecha Venc.", "Exp.", "Expiry", "F.Venc"
- El formato más común en Bolivia es MM/YYYY (ej: 06/2027) o MM/AAAA
- IMPORTANTE: En facturas de Bagó y similares, la columna "VCTO" contiene la fecha de vencimiento de cada producto
- Extrae la fecha de vencimiento para CADA producto individualmente
- Si la fecha aparece como "06/2027" extráela exactamente así
- Si un producto no tiene fecha de vencimiento visible, usa null
- NO inventes fechas — si no está en la fila del producto, usa null

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

      // Convertir archivo a base64 para Groq
      let dataUrl: string | null = null;
      try {
        if (isImage) {
          dataUrl = await imageToBase64(fileKey);
        } else if (isPdf) {
          dataUrl = await pdfToBase64Png(fileKey);
          if (!dataUrl) {
            const pdfText = await extractTextFromPdf(fileKey);
            if (pdfText.trim()) {
              userContent.push({
                type: "text",
                text: `TEXTO EXTRAIDO DEL PDF:\n${pdfText}\n\n`,
              });
              dataUrl = null;
            } else {
              throw new Error("No se pudo procesar PDF");
            }
          }
        }
        
        if (dataUrl) {
          userContent.push({
            type: "image_url",
            image_url: { url: dataUrl, detail: "high" },
          });
        }
      } catch (fileError: any) {
        throw new Error(`No se pudo procesar archivo: ${fileError.message}`);
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
          type: "json_object",
        },
      });

      let extracted: any = {
        supplier: "",
        receiptNumber: "",
        items: [],
      };

      // Reintentar hasta 3 veces si falla el parsing
      const llmMessages = [
        {
          role: "system" as const,
          content:
            "Eres un asistente experto en lectura de facturas farmacéuticas bolivianas. Tienes amplio conocimiento de presentaciones de medicamentos (comprimidos, cápsulas, jarabes, gotas, inyectables). Cuando una factura muestra cajas con presentación (ej: x10 comp, x30 caps), SIEMPRE multiplicas cajas por unidades para obtener el total real. Extraes datos con alta precisión. Responde SOLO en JSON válido.",
        },
        { role: "user" as const, content: userContent },
      ];
      for (let intento = 0; intento < 3; intento++) {
        try {
          let resultToUse = llmResult;
          if (intento > 0) {
            console.log(`[LLM] Reintento ${intento} de extracción...`);
            await new Promise(r => setTimeout(r, 1000 * intento));
            resultToUse = await invokeLLM({
              messages: llmMessages,
              response_format: { type: "json_object" },
            });
          }
          const rawContent = resultToUse.choices[0]?.message?.content;
          console.log(`[LLM] Respuesta raw (intento ${intento + 1}):`, String(rawContent || "").substring(0, 200));
          if (typeof rawContent === "string" && rawContent.trim()) {
            // Limpiar posibles bloques markdown
            const clean = rawContent.replace(/```json|```/g, "").trim();
            extracted = JSON.parse(clean);
            break; // Éxito
          }
        } catch (e) {
          console.error(`[LLM] Error parsing intento ${intento + 1}:`, e);
          if (intento === 2) {
            console.error("[LLM] Todos los intentos fallaron, usando extracción vacía");
          }
        }
      }

      console.log("[LLM] Extracción completada:", JSON.stringify(extracted, null, 2).substring(0, 500));

      // Validación y corrección de precios usando subtotal de cada línea
      const itemsCorregidos = (extracted.items || []).map((item: any) => {
        const cantidad = Math.max(1, Math.round(item.quantity || 1));
        const subtotal = Math.max(0, item.subtotal || 0);
        let unitCost = Math.max(0, item.unitCost || 0);

        // Si tenemos subtotal y cantidad, el precio unitario REAL es subtotal/cantidad
        // Esto corrige el caso donde el LLM confunde subtotal con unitCost
        if (subtotal > 0 && cantidad > 0) {
          const unitCostCalculado = subtotal / cantidad;
          // Si el unitCost difiere mucho del calculado, usar el calculado
          // (el subtotal es más confiable porque incluye descuentos)
          if (Math.abs(unitCost - unitCostCalculado) > 0.01) {
            console.log(`[Precio] "${item.productName}": unitCost ${unitCost} → ${unitCostCalculado.toFixed(4)} (subtotal ${subtotal}/${cantidad})`);
            unitCost = unitCostCalculado;
          }
        }

        return {
          productName: item.productName || "",
          productNameFactura: item.productName || "",
          quantity: cantidad,
          unitCost: Number(unitCost.toFixed(4)),
          subtotal: subtotal > 0 ? subtotal : Number((cantidad * unitCost).toFixed(2)),
          expiryDate: item.expiryDate || null,
        };
      });

      // Validar suma contra total de factura
      const sumaSubtotales = itemsCorregidos.reduce((acc: number, it: any) => acc + it.subtotal, 0);
      const totalFactura = extracted.totalFactura || 0;
      if (totalFactura > 0 && Math.abs(sumaSubtotales - totalFactura) > totalFactura * 0.05) {
        console.warn(`[Precio] ⚠️ Suma de subtotales (${sumaSubtotales.toFixed(2)}) no coincide con total factura (${totalFactura}). Revisar precios.`);
      }

      return {
        imageUrl,
        imageKey,
        supplier: extracted.supplier || "",
        receiptNumber: extracted.receiptNumber || "",
        totalFactura: totalFactura,
        avisoTotal: (totalFactura > 0 && Math.abs(sumaSubtotales - totalFactura) > totalFactura * 0.05)
          ? `La suma de productos (${sumaSubtotales.toFixed(2)}) no coincide con el total de la factura (${totalFactura}). Revisa los precios.`
          : null,
        items: itemsCorregidos,
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
      let syncResultData: any = null;
      if (input.confirmDirectly) {
        const purchaseId = result.id;
        try {
          console.log(`[Sync] Iniciando sincronización directa para compra #${purchaseId}`);
          // Timeout de 25s para evitar corte de conexión Railway (30s limit)
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
          syncResultData = syncResult;
          if (syncResult.success) {
            syncSuccess = true;
            syncMessage = `Compra registrada en inventarios365.com (Ingreso ID: ${syncResult.ingresoId})`;
            syncIngresoId = syncResult.ingresoId;
            await db.updatePurchaseSyncStatus(purchaseId, "completed");
            if (syncResult.productosNoEncontrados && syncResult.productosNoEncontrados.length > 0) {
              syncMessage += ` | Productos no encontrados: ${syncResult.productosNoEncontrados.map((p: any) => p.nombre).join(", ")}`;
            }
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
        productosNoEncontrados: syncResultData?.productosNoEncontrados || [],
        productosEmparejados: syncResultData?.productosEmparejados || [],
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

      // Convertir archivo a base64 para Groq
      let dataUrl: string | null = null;
      const isPdf = input.mimeType === "application/pdf";
      try {
        if (isImage) {
          dataUrl = await imageToBase64(fileKey);
        } else if (isPdf) {
          dataUrl = await pdfToBase64Png(fileKey);
          if (!dataUrl) {
            const pdfText = await extractTextFromPdf(fileKey);
            if (pdfText.trim()) {
              userContent.push({
                type: "text",
                text: `TEXTO EXTRAIDO DEL PDF:\n${pdfText}\n\n`,
              });
              dataUrl = null;
            } else {
              throw new Error("No se pudo procesar PDF");
            }
          }
        }
        
        if (dataUrl) {
          userContent.push({
            type: "image_url",
            image_url: { url: dataUrl, detail: "high" },
          });
        }
      } catch (fileError: any) {
        throw new Error(`No se pudo procesar archivo: ${fileError.message}`);
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
          type: "json_object",
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

// ─── Confirmaciones Router ───────────────────────────────────────────────────
const confirmacionesRouter = router({
  // Estadísticas del sistema de confirmaciones
  estadisticas: publicProcedure.query(async () => {
    const { confirmacionesService } = await import("./confirmaciones");
    return confirmacionesService.estadisticas();
  }),

  // Confirmar emparejamiento: nombre en factura → artículo en sistema
  confirmar: publicProcedure
    .input(z.object({
      proveedor: z.string(),
      nombreFactura: z.string(),
      articuloId: z.number(),
      articuloNombre: z.string(),
      articuloCodigo: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const { confirmacionesService } = await import("./confirmaciones");
      confirmacionesService.confirmar(input.proveedor, input.nombreFactura, {
        id: input.articuloId,
        nombre: input.articuloNombre,
        codigo: input.articuloCodigo || "",
      } as any);
      return { success: true };
    }),

  // Invalidar una confirmación
  invalidar: publicProcedure
    .input(z.object({ proveedor: z.string(), nombreFactura: z.string() }))
    .mutation(async ({ input }) => {
      const { confirmacionesService } = await import("./confirmaciones");
      confirmacionesService.invalidar(input.proveedor, input.nombreFactura);
      return { success: true };
    }),

  // Buscar artículo en sistema para confirmar manualmente
  buscarArticulo: publicProcedure
    .input(z.object({ termino: z.string(), idProveedor: z.number().optional(), nombreProveedor: z.string().optional() }))
    .query(async ({ input }) => {
      const { inventarios365 } = await import("./inventarios365");
      let idProveedorFinal = input.idProveedor;

      // Si no tenemos idProveedor pero sí nombre, buscarlo
      if (!idProveedorFinal && input.nombreProveedor) {
        const prov = await inventarios365.buscarProveedor(input.nombreProveedor);
        if (prov) idProveedorFinal = prov.id;
      }

      // Separar término de búsqueda — puede contener nombre del proveedor
      // Ej: "fluco sanat" → buscar "fluco" filtrado por proveedor Sanat
      let terminoBusqueda = input.termino.trim();
      
      // Si hay palabras múltiples, intentar separar producto de proveedor
      const palabras = terminoBusqueda.split(/\s+/);
      if (palabras.length > 1 && !idProveedorFinal) {
        // Intentar encontrar proveedor en las últimas palabras
        for (let i = palabras.length - 1; i >= 1; i--) {
          const posibleProveedor = palabras.slice(i).join(" ");
          const prov = await inventarios365.buscarProveedor(posibleProveedor);
          if (prov) {
            idProveedorFinal = prov.id;
            terminoBusqueda = palabras.slice(0, i).join(" ");
            console.log(`[Buscar] Separado: producto="${terminoBusqueda}" proveedor="${prov.nombre}" (ID:${prov.id})`);
            break;
          }
        }
      }

      const articulos = await inventarios365.listarArticulos(
        terminoBusqueda,
        idProveedorFinal ? String(idProveedorFinal) : ""
      );
      return articulos.slice(0, 15);
    }),

  // Verificar validez de todos los IDs guardados
  verificar: publicProcedure.mutation(async () => {
    const { confirmacionesService } = await import("./confirmaciones");
    return confirmacionesService.verificar();
  }),

  // Listar todas las confirmaciones
  todos: publicProcedure.query(async () => {
    const { confirmacionesService } = await import("./confirmaciones");
    return confirmacionesService.todos();
  }),
});

// ─── Cache Router ─────────────────────────────────────────────────────────────
const cacheRouter = router({
  estadisticas: publicProcedure.query(async () => {
    const { productosCache } = await import("./productos-cache");
    return productosCache.estadisticas();
  }),
  actualizar: publicProcedure.mutation(async () => {
    const { productosCache } = await import("./productos-cache");
    await productosCache.actualizar(true);
    return { success: true, message: "Cache actualizado exitosamente" };
  }),
  listar: publicProcedure.query(async () => {
    const { productosCache } = await import("./productos-cache");
    return productosCache.obtenerTodos();
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
  cache: cacheRouter,
  confirmaciones: confirmacionesRouter,
  inventarios365: inventarios365Router,
});

export type AppRouter = typeof appRouter;
