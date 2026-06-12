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
  "descuentoGlobal": descuento_total_de_la_factura_si_existe_sino_0,
  "descuentoGlobalPct": porcentaje_descuento_global_total_sino_0,
  "items": [
    {
      "productName": "nombre comercial del medicamento SIN códigos numéricos del proveedor",
      "quantity": número_entero_de_unidades_TOTALES,
      "unitCost": costo_unitario_decimal_por_unidad,
      "descuento": descuento_de_esta_linea_si_existe_sino_0,
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

DESCUENTOS (LEER CON MUCHÍSIMA ATENCIÓN — los laboratorios aplican VARIOS descuentos en cascada):
Los laboratorios farmacéuticos bolivianos (Bagó, Inti, etc.) suelen aplicar HASTA TRES niveles de descuento:

  NIVEL 1 — DESCUENTO COMERCIAL POR PRODUCTO (por línea):
  - Columna "DESCUENTO", "Dscto", "Desc.", "%Dto" en cada fila. Es específico de cada producto.
  - A veces es ALTO en algunos productos (ej. 20%, 30%) y bajo o cero en otros.
  - Va en el campo "descuento" de cada item (el subtotal de la línea ya debe reflejarlo).

  NIVEL 2 — DESCUENTO POR VOLUMEN (global, ~2%):
  - Se aplica al SUBTOTAL después de los descuentos por línea. Suele rondar el 2%.
  - Búscalo al pie de la factura (ej. "Desc. volumen 2%", "Dcto adicional").

  NIVEL 3 — DESCUENTO POR PAGO EFECTIVO/CONTADO (global, ~3%):
  - Se aplica si el pago es al contado. Suele rondar el 3%.
  - Búscalo al pie (ej. "Desc. contado 3%", "Pago efectivo").

CÓMO REPORTARLO:
- "descuento" por línea: el descuento comercial de cada producto (NIVEL 1).
- "descuentoGlobal": la SUMA en Bs de los descuentos globales (NIVEL 2 + NIVEL 3) sobre el subtotal.
- "descuentoGlobalPct": el porcentaje total global aplicado (ej. si hay 2% volumen + 3% efectivo ≈ 5%).

PROCEDIMIENTO OBLIGATORIO PARA QUE TODO CUADRE CON EL TOTAL PAGADO:
  1. Para cada producto: subtotal_linea = (precio_lista × cantidad) − descuento_comercial_linea.
  2. SUBTOTAL = suma de todos los subtotales de línea.
  3. Aplica descuentos globales en cascada sobre el SUBTOTAL: primero volumen, luego efectivo.
     - subtotal_tras_volumen = SUBTOTAL × (1 − %volumen)
     - total_final = subtotal_tras_volumen × (1 − %efectivo)
     - descuentoGlobal (Bs) = SUBTOTAL − total_final
  4. VERIFICA: total_final debe ser ≈ TOTAL PAGADO impreso en la factura. Si NO cuadra:
     - Revisa si algún descuento es monto fijo en vez de porcentaje.
     - Revisa si el volumen/efectivo se aplican sobre subtotal o sobre otra base.
     - Ajusta hasta que cuadre EXACTAMENTE con el total pagado.
- "totalFactura" = el TOTAL FINAL PAGADO impreso (después de TODOS los descuentos).
- Si la factura no tiene descuentos globales, descuentoGlobal = 0 y descuentoGlobalPct = 0.
- Ejemplo Bagó: 10 productos suman 2000 (ya con desc. comercial), volumen 2% → 1960, efectivo 3% → 1901.20. descuentoGlobal=98.80, descuentoGlobalPct≈4.94, totalFactura=1901.20.

INSTRUCCIONES PARA NOMBRE DEL PRODUCTO:
- Extrae SOLO el nombre comercial. Si la fila tiene un código numérico al inicio (ej: "400180 QUETOROL 20 TAB"), extrae SOLO "QUETOROL 20 TAB" sin el código.
- Ignora códigos internos del proveedor, códigos de barras o referencias numéricas al inicio del nombre.
- Si el nombre incluye la fecha de vencimiento (ej: "PARACETAMOL 500 FV:2027/08/31"), QUITA esa parte del nombre (queda "PARACETAMOL 500") y pon la fecha en expiryDate.

INSTRUCCIONES PARA FECHA DE VENCIMIENTO:
- Busca columnas llamadas "VCTO", "Venc.", "Vencimiento", "Fecha Venc.", "Exp.", "Expiry", "F.Venc"
- El formato más común en Bolivia es MM/YYYY (ej: 06/2027) o MM/AAAA
- IMPORTANTE: En facturas de Bagó y similares, la columna "VCTO" contiene la fecha de vencimiento de cada producto
- IMPORTANTE: A veces la fecha viene DENTRO del nombre/descripción del producto, con prefijos como "FV:", "VToOFV", "Venc:", "F.V.", "Vto:" seguido de la fecha (ej: "PARACETAMOL 500 FV:2027/08/31" → la fecha es 2027/08/31). Extrae esa fecha al campo expiryDate y déjala en el formato que aparezca.
- Extrae la fecha de vencimiento para CADA producto individualmente
- Si la fecha aparece como "06/2027" extráela exactamente así; si aparece como "2027/08/31" déjala así
- Si un producto no tiene fecha de vencimiento visible, usa null
- NO inventes fechas — si no está en la fila ni en el nombre del producto, usa null

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

      let extracted: any = {
        supplier: "",
        receiptNumber: "",
        items: [],
      };

      // Reintentar hasta 3 veces si falla el parsing o el LLM (cubre error 400 por tokens)
      const llmMessages = [
        {
          role: "system" as const,
          content:
            "Eres un asistente experto en lectura de facturas farmacéuticas bolivianas. Tienes amplio conocimiento de presentaciones de medicamentos (comprimidos, cápsulas, jarabes, gotas, inyectables). Cuando una factura muestra cajas con presentación (ej: x10 comp, x30 caps), SIEMPRE multiplicas cajas por unidades para obtener el total real. Extraes datos con alta precisión. Responde SOLO en JSON válido y completo.",
        },
        { role: "user" as const, content: userContent },
      ];
      let extraccionExitosa = false;
      for (let intento = 0; intento < 3; intento++) {
        try {
          if (intento > 0) {
            console.log(`[LLM] Reintento ${intento} de extracción...`);
            await new Promise(r => setTimeout(r, 1000 * intento));
          }
          const resultToUse = await invokeLLM({
            messages: llmMessages,
            response_format: { type: "json_object" },
          });
          const rawContent = resultToUse.choices[0]?.message?.content;
          console.log(`[LLM] Respuesta raw (intento ${intento + 1}):`, String(rawContent || "").substring(0, 200));
          if (typeof rawContent === "string" && rawContent.trim()) {
            const clean = rawContent.replace(/```json|```/g, "").trim();
            extracted = JSON.parse(clean);
            extraccionExitosa = true;
            break;
          }
        } catch (e: any) {
          console.error(`[LLM] Error intento ${intento + 1}:`, e?.message || e);
        }
      }

      if (!extraccionExitosa) {
        throw new Error("No se pudo extraer la factura. Puede tener demasiados productos o baja calidad de imagen. Intenta de nuevo o usa una foto más clara.");
      }

      console.log("[LLM] Extracción completada:", JSON.stringify(extracted, null, 2).substring(0, 500));
      // Log de fechas extraídas para diagnóstico
      console.log("[Fecha] Fechas extraídas por el LLM:", JSON.stringify((extracted.items || []).map((it: any) => ({ producto: it.productName, expiryDate: it.expiryDate }))));

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

      // Validar suma contra total de factura (considerando descuento global)
      const sumaSubtotales = itemsCorregidos.reduce((acc: number, it: any) => acc + it.subtotal, 0);
      const descuentoGlobal = Math.max(0, extracted.descuentoGlobal || 0);
      const totalFactura = extracted.totalFactura || 0;
      // El total esperado es la suma de subtotales menos el descuento global
      const totalCalculado = sumaSubtotales - descuentoGlobal;
      const descuadre = totalFactura > 0 && Math.abs(totalCalculado - totalFactura) > totalFactura * 0.05;
      if (descuadre) {
        console.warn(`[Precio] ⚠️ Suma (${sumaSubtotales.toFixed(2)}) − descuento global (${descuentoGlobal.toFixed(2)}) = ${totalCalculado.toFixed(2)} no coincide con total factura (${totalFactura}).`);
      } else if (descuentoGlobal > 0) {
        console.log(`[Precio] ✓ Descuento global detectado: ${descuentoGlobal.toFixed(2)} Bs. Total cuadra.`);
      }

      return {
        imageUrl,
        imageKey,
        supplier: extracted.supplier || "",
        receiptNumber: extracted.receiptNumber || "",
        totalFactura: totalFactura,
        descuentoGlobal: descuentoGlobal,
        avisoTotal: descuadre
          ? `La suma de productos (${sumaSubtotales.toFixed(2)})${descuentoGlobal > 0 ? ` menos descuento (${descuentoGlobal.toFixed(2)})` : ""} no coincide con el total de la factura (${totalFactura}). Revisa los precios.`
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
            nuevoPrecioVenta: z.number().nullable().optional(),
          })
        ),
        imageUrl: z.string().nullable().optional(),
        imageKey: z.string().nullable().optional(),
        confirmDirectly: z.boolean().optional(),
        borradorIdEliminar: z.number().nullable().optional(),
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

      // Si se completó y venía de un borrador, eliminar el borrador viejo para no duplicar
      if (input.confirmDirectly && input.borradorIdEliminar) {
        try {
          await db.deletePurchase(input.borradorIdEliminar, ctx.user.id);
        } catch (e) {
          console.warn("[Compras] No se pudo eliminar el borrador:", e);
        }
      }

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
              nuevoPrecioVenta: item.nuevoPrecioVenta ?? null,
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

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      return db.deletePurchase(input.id, ctx.user.id);
    }),

  // Obtener una compra con sus items (para continuar un borrador)
  getById: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      return db.getPurchaseById(input.id);
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
      await confirmacionesService.confirmar(input.proveedor, input.nombreFactura, {
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
      await confirmacionesService.invalidar(input.proveedor, input.nombreFactura);
      return { success: true };
    }),

  // Buscar confirmación guardada para un producto específico
  buscarConfirmacion: publicProcedure
    .input(z.object({ proveedor: z.string(), nombreFactura: z.string() }))
    .query(async ({ input }) => {
      const { confirmacionesService } = await import("./confirmaciones");
      return await confirmacionesService.buscar(input.proveedor, input.nombreFactura);
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

  // Listar categorías del sistema
  listarCategorias: publicProcedure.query(async () => {
    const { inventarios365 } = await import("./inventarios365");
    return inventarios365.listarCategorias();
  }),

  // Buscar proveedores del sistema (para selección/emparejamiento manual)
  listarProveedores: publicProcedure
    .input(z.object({ filtro: z.string() }))
    .query(async ({ input }) => {
      const { inventarios365 } = await import("./inventarios365");
      return inventarios365.listarProveedores(input.filtro);
    }),

  // Buscar el proveedor del sistema aprendido para un nombre de factura
  buscarProveedorConfirmado: publicProcedure
    .input(z.object({ nombreFactura: z.string() }))
    .query(async ({ input }) => {
      const { confirmacionesProveedoresService } = await import("./confirmaciones-proveedores");
      return confirmacionesProveedoresService.buscar(input.nombreFactura);
    }),

  // Confirmar (aprender) el emparejamiento de un proveedor
  confirmarProveedor: publicProcedure
    .input(z.object({ nombreFactura: z.string(), proveedorId: z.string(), proveedorNombre: z.string() }))
    .mutation(async ({ input }) => {
      const { confirmacionesProveedoresService } = await import("./confirmaciones-proveedores");
      await confirmacionesProveedoresService.confirmar(input.nombreFactura, input.proveedorId, input.proveedorNombre);
      return { success: true };
    }),

  // Analizar el costo de un producto vs su historial de compras
  analizarPrecio: publicProcedure
    .input(z.object({ articuloId: z.number(), costoActual: z.number() }))
    .query(async ({ input }) => {
      const { historialPreciosService } = await import("./historial-precios");
      return historialPreciosService.analizar(input.articuloId, input.costoActual);
    }),

  // Historial completo de precios de un producto (consultas)
  historialPrecios: publicProcedure
    .input(z.object({ articuloId: z.number() }))
    .query(async ({ input }) => {
      const { historialPreciosService } = await import("./historial-precios");
      return historialPreciosService.historialDe(input.articuloId);
    }),

  // Sugerir categoría para un producto usando IA
  sugerirCategoria: publicProcedure
    .input(z.object({ nombreProducto: z.string() }))
    .query(async ({ input }) => {
      const { inventarios365 } = await import("./inventarios365");
      const categorias = await inventarios365.listarCategorias();
      if (categorias.length === 0) return { idcategoria: null, nombre: null, categorias: [] };

      // Pedir a la IA que elija la categoría más adecuada de la lista existente
      try {
        const lista = categorias.map((c) => `${c.id}: ${c.nombre}`).join("\n");
        const result = await invokeLLM({
          messages: [
            {
              role: "system",
              content: "Eres un experto en clasificación de productos farmacéuticos. Dada una lista de categorías y un producto, respondes SOLO con el número de ID de la categoría más adecuada. Si ninguna encaja bien, responde con el ID de la categoría más genérica. Responde SOLO el número, nada más.",
            },
            {
              role: "user",
              content: `Categorías disponibles:\n${lista}\n\nProducto: "${input.nombreProducto}"\n\nResponde SOLO el ID numérico de la categoría más adecuada:`,
            },
          ],
        });
        const raw = result.choices[0]?.message?.content || "";
        const idSugerido = parseInt(String(raw).match(/\d+/)?.[0] || "");
        const encontrada = categorias.find((c) => c.id === idSugerido);
        if (encontrada) {
          return { idcategoria: encontrada.id, nombre: encontrada.nombre, categorias };
        }
      } catch (e) {
        console.error("[sugerirCategoria] Error IA:", e);
      }
      // Fallback: primera categoría
      return { idcategoria: categorias[0].id, nombre: categorias[0].nombre, categorias };
    }),

  // Crear un producto nuevo en el sistema
  crearProducto: publicProcedure
    .input(z.object({
      nombre: z.string(),
      codigo: z.string().optional(),
      descripcion: z.string().optional(),
      costoUnitario: z.number(),
      precioVenta: z.number(),
      idcategoria: z.number(),
      nombreProveedor: z.string().optional(),
      stockMinimo: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const { inventarios365 } = await import("./inventarios365");

      // Resolver idproveedor desde el nombre si se proporciona
      let idproveedor = 0;
      if (input.nombreProveedor) {
        const prov = await inventarios365.buscarProveedor(input.nombreProveedor);
        if (prov) idproveedor = prov.id;
      }

      // Generar código si no se da (timestamp corto)
      const codigo = input.codigo || `AUTO${Date.now().toString().slice(-8)}`;

      return inventarios365.crearProducto({
        nombre: input.nombre,
        codigo,
        descripcion: input.descripcion || (input.nombreProveedor ? `Proveedor: ${input.nombreProveedor}` : ""),
        costoUnitario: input.costoUnitario,
        precioVenta: input.precioVenta,
        idcategoria: input.idcategoria,
        idproveedor,
        stockMinimo: input.stockMinimo ?? 10,
      });
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

// ─── Inventario Router ───────────────────────────────────────────────────────
const inventarioRouter = router({
  // Listar productos para conteo, por proveedor (vacío = todos)
  listar: publicProcedure
    .input(z.object({ idAlmacen: z.number(), idProveedor: z.string().optional() }))
    .query(async ({ input }) => {
      const { inventarios365 } = await import("./inventarios365");
      const productos = await inventarios365.listarParaInventario(input.idAlmacen, input.idProveedor || "");
      // Criterio ABC: usar valor de stock (stock×costo) si hay costo; si no, usar cantidad de stock
      const hayCosto = productos.some((p) => p.costoUnit > 0);
      const criterio = (p: any) => hayCosto ? p.valorStock : p.stock;
      const ordenados = [...productos].sort((a, b) => criterio(b) - criterio(a));
      const valorTotal = ordenados.reduce((acc, p) => acc + criterio(p), 0);
      let acumulado = 0;
      const conClase = ordenados.map((p) => {
        acumulado += criterio(p);
        const pctAcumulado = valorTotal > 0 ? (acumulado / valorTotal) * 100 : 0;
        const clase = pctAcumulado <= 80 ? "A" : pctAcumulado <= 95 ? "B" : "C";
        return { ...p, clase };
      });
      return {
        productos: conClase,
        resumen: {
          total: conClase.length,
          valorTotal: Math.round(productos.reduce((acc, p) => acc + p.valorStock, 0) * 100) / 100,
          claseA: conClase.filter((p) => p.clase === "A").length,
          claseB: conClase.filter((p) => p.clase === "B").length,
          claseC: conClase.filter((p) => p.clase === "C").length,
          criterioABC: hayCosto ? "valor" : "cantidad",
        },
      };
    }),

  // Crear una nueva sesión de inventario
  crearSesion: publicProcedure
    .input(z.object({
      nombre: z.string(),
      tipo: z.enum(["anual", "ciclico_abc"]),
      almacenId: z.number(),
      almacenNombre: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { inventarioSesiones } = await import("../drizzle/schema");
      const { inventarios365 } = await import("./inventarios365");
      const db = await getDb();
      if (!db) throw new Error("Sin base de datos");
      // Contar el total de proveedores del sistema (para el progreso global)
      let totalProv = 0;
      try {
        const r = await inventarios365.contarProveedores();
        totalProv = r.total;
      } catch {}
      const [res] = await db.insert(inventarioSesiones).values({
        nombre: input.nombre,
        tipo: input.tipo,
        almacenId: input.almacenId,
        almacenNombre: input.almacenNombre || null,
        totalProveedores: totalProv,
        estado: "en_progreso",
      });
      const id = res.insertId;
      return { success: true, id, totalProveedores: totalProv };
    }),

  // Listar sesiones (en progreso y completadas)
  listarSesiones: publicProcedure.query(async () => {
    const { getDb } = await import("./db");
    const { inventarioSesiones, inventarioProveedores } = await import("../drizzle/schema");
    const { desc } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return [];
    const sesiones = await db.select().from(inventarioSesiones).orderBy(desc(inventarioSesiones.creadoEn));
    if (sesiones.length === 0) return [];

    // Traer TODOS los proveedores de una vez (evita N+1) y agrupar en memoria
    const todosProvs = await db.select().from(inventarioProveedores);
    const porSesion = new Map<number, any[]>();
    for (const p of todosProvs) {
      const arr = porSesion.get(p.sesionId) || [];
      arr.push(p);
      porSesion.set(p.sesionId, arr);
    }

    return sesiones.map((s: any) => {
      const provs = porSesion.get(s.id) || [];
      const completados = provs.filter((p: any) => p.estado === "completado").length;
      return {
        ...s,
        proveedoresInventariados: provs.length,
        proveedoresCompletados: completados,
        proveedores: provs.map((p: any) => ({
          id: p.id, proveedorId: p.proveedorId, proveedorNombre: p.proveedorNombre, estado: p.estado,
          productosContados: p.productosContados, totalProductos: p.totalProductos,
          conDiferencia: p.conDiferencia,
        })),
      };
    });
  }),

  // Detalle de una sesión con sus proveedores y conteos
  detalleSesion: publicProcedure
    .input(z.object({ sesionId: z.number() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { inventarioSesiones, inventarioProveedores } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return null;
      const sesion = (await db.select().from(inventarioSesiones).where(eq(inventarioSesiones.id, input.sesionId)))[0];
      if (!sesion) return null;
      const provs = await db.select().from(inventarioProveedores).where(eq(inventarioProveedores.sesionId, input.sesionId));
      return { sesion, proveedores: provs };
    }),

  // Guardar/actualizar el conteo de un proveedor dentro de una sesión
  guardarConteoProveedor: publicProcedure
    .input(z.object({
      sesionId: z.number(),
      proveedorId: z.string().optional(),
      proveedorNombre: z.string(),
      totalProductos: z.number(),
      completar: z.boolean().optional(),
      ajustarStock: z.boolean().optional(), // si true y completar, ajusta el stock real en inventarios365
      conteos: z.array(z.object({
        articuloId: z.number(),
        nombre: z.string(),
        stockSistema: z.number(),
        stockFisico: z.number(),
        diferencia: z.number(),
        fechaVencimiento: z.string().nullable().optional(),
        inventarioId: z.number().nullable().optional(),
      })),
    }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { inventarioProveedores, inventarioSesiones } = await import("../drizzle/schema");
      const { eq, and } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin base de datos");

      const conDif = input.conteos.filter((c) => c.diferencia !== 0).length;
      const estado = input.completar ? "completado" : "en_progreso";

      // ¿Ya existe el registro de este proveedor en esta sesión?
      const existente = (await db.select().from(inventarioProveedores)
        .where(and(
          eq(inventarioProveedores.sesionId, input.sesionId),
          eq(inventarioProveedores.proveedorNombre, input.proveedorNombre)
        )))[0];

      if (existente) {
        await db.update(inventarioProveedores).set({
          totalProductos: input.totalProductos,
          productosContados: input.conteos.length,
          conDiferencia: conDif,
          conteos: input.conteos,
          estado,
          completadoEn: input.completar ? new Date() : null,
        }).where(eq(inventarioProveedores.id, existente.id));
      } else {
        await db.insert(inventarioProveedores).values({
          sesionId: input.sesionId,
          proveedorId: input.proveedorId || null,
          proveedorNombre: input.proveedorNombre,
          totalProductos: input.totalProductos,
          productosContados: input.conteos.length,
          conDiferencia: conDif,
          conteos: input.conteos,
          estado,
          completadoEn: input.completar ? new Date() : null,
        });
      }

      // Si se completa Y se pidió ajustar, aplicar el ajuste real en inventarios365
      let ajusteResultado: { ok: boolean; ajustados: number; mensaje: string } | null = null;
      if (input.completar && input.ajustarStock && conDif > 0) {
        const sesion = (await db.select().from(inventarioSesiones).where(eq(inventarioSesiones.id, input.sesionId)))[0];
        if (sesion) {
          const { inventarios365 } = await import("./inventarios365");
          ajusteResultado = await inventarios365.ajustarInventario({
            almacenId: sesion.almacenId,
            motivoId: 2, // "Ajuste periodico"
            ajustes: input.conteos
              .filter(c => c.diferencia !== 0)
              .map(c => ({
                productoId: c.articuloId,
                inventarioId: c.inventarioId ?? null,
                stockAnterior: c.stockSistema,
                stockReal: c.stockFisico,
                fechaVencimiento: c.fechaVencimiento || null,
              })),
          });
        }
      }

      return { success: true, conDiferencia: conDif, contados: input.conteos.length, ajuste: ajusteResultado };
    }),

  // Marcar sesión como completada
  completarSesion: publicProcedure
    .input(z.object({ sesionId: z.number() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { inventarioSesiones } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin base de datos");
      await db.update(inventarioSesiones).set({ estado: "completado" }).where(eq(inventarioSesiones.id, input.sesionId));
      return { success: true };
    }),
});

// ─── App Router ──────────────────────────────────────────────────────────────
// ─── Asistencia del Personal ──────────────────────────────────────────────────
const asistenciaRouter = router({
  // Listar todos los trabajadores
  listarTrabajadores: publicProcedure.query(async () => {
    const { getDb } = await import("./db");
    const { trabajadores } = await import("../drizzle/schema");
    const db = await getDb();
    if (!db) return [];
    return db.select().from(trabajadores).orderBy(trabajadores.nombre);
  }),

  // Crear o actualizar un trabajador
  guardarTrabajador: publicProcedure
    .input(z.object({
      id: z.number().optional(),
      nombre: z.string().min(1),
      usuarioSistemaId: z.string().nullable().optional(),
      usuarioSistemaNombre: z.string().nullable().optional(),
      horaIngreso: z.string(),
      horasDia: z.number(),
      diasMes: z.number(),
      diasSemana: z.string().optional(),
      tipoTrabajador: z.enum(["fijo_mensual", "por_dia", "fijo_horas", "fijo_turnos"]).optional(),
      horasMesFijas: z.number().optional(),
      montoPorDia: z.number().optional(),
      sueldoMensual: z.number(),
      tipoDescuento: z.enum(["proporcional", "fijo"]),
      montoDescuentoFijo: z.number(),
      toleranciaMin: z.number(),
    }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { trabajadores } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin base de datos");
      const valores = {
        nombre: input.nombre,
        usuarioSistemaId: input.usuarioSistemaId || null,
        usuarioSistemaNombre: input.usuarioSistemaNombre || null,
        horaIngreso: input.horaIngreso,
        horasDia: String(input.horasDia),
        diasMes: input.diasMes,
        diasSemana: input.diasSemana || "1,2,3,4,5,6",
        tipoTrabajador: input.tipoTrabajador || "fijo_mensual",
        horasMesFijas: input.horasMesFijas ?? 192,
        montoPorDia: String(input.montoPorDia ?? 0),
        sueldoMensual: String(input.sueldoMensual),
        tipoDescuento: input.tipoDescuento,
        montoDescuentoFijo: String(input.montoDescuentoFijo),
        toleranciaMin: input.toleranciaMin,
      };
      if (input.id) {
        await db.update(trabajadores).set(valores).where(eq(trabajadores.id, input.id));
        return { success: true, id: input.id };
      }
      const [res] = await db.insert(trabajadores).values(valores);
      return { success: true, id: res.insertId };
    }),

  // Desactivar (no borrar, para conservar historial)
  desactivarTrabajador: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { trabajadores } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin base de datos");
      await db.update(trabajadores).set({ activo: 0 }).where(eq(trabajadores.id, input.id));
      return { success: true };
    }),

  // Listar usuarios de inventarios365 (para vincular trabajador ↔ usuario del sistema)
  listarUsuariosSistema: publicProcedure.query(async () => {
    const { inventarios365 } = await import("./inventarios365");
    return inventarios365.listarUsuarios();
  }),

  // Agregar campo usuario al guardar trabajador (ya manejado por guardarTrabajador abajo)

  // Resumen mensual de un trabajador: lee las aperturas de caja de inventarios365
  resumenMensual: publicProcedure
    .input(z.object({ trabajadorId: z.number(), anioMes: z.string() })) // anioMes = "2026-06"
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { trabajadores } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const { inventarios365 } = await import("./inventarios365");
      const { calcularResumenMensual } = await import("./domain/sueldos");
      const db = await getDb();
      if (!db) return null;
      const [trab] = await db.select().from(trabajadores).where(eq(trabajadores.id, input.trabajadorId));
      if (!trab) return null;

      // Leer aperturas de caja del usuario en el mes desde inventarios365
      const aperturas = await inventarios365.aperturasCajaDelMes(
        trab.usuarioSistemaId || "", input.anioMes
      );

      // Cálculo con lógica de dominio pura (testeable, sin IO)
      const resumen = calcularResumenMensual(aperturas, {
        tipoTrabajador: (trab.tipoTrabajador || "fijo_mensual") as any,
        horaIngreso: trab.horaIngreso,
        horasDia: parseFloat(String(trab.horasDia)) || 8,
        diasMes: trab.diasMes || 26,
        diasSemana: (trab.diasSemana || "").split(",").map(Number).filter((n: number) => !isNaN(n)),
        horasMesFijas: trab.horasMesFijas ?? 192,
        montoPorDia: parseFloat(String(trab.montoPorDia)) || 0,
        sueldoMensual: parseFloat(String(trab.sueldoMensual)) || 0,
        tipoDescuento: trab.tipoDescuento as "proporcional" | "fijo",
        montoDescuentoFijo: parseFloat(String(trab.montoDescuentoFijo)) || 0,
        toleranciaMin: trab.toleranciaMin ?? 5,
      }, input.anioMes);

      return {
        trabajador: {
          id: trab.id, nombre: trab.nombre, horaIngreso: trab.horaIngreso,
          sueldoMensual: parseFloat(String(trab.sueldoMensual)) || 0,
          tipoDescuento: trab.tipoDescuento, usuarioSistemaNombre: trab.usuarioSistemaNombre,
        },
        ...resumen,
      };
    }),
});

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
  inventario: inventarioRouter,
  asistencia: asistenciaRouter,
});

export type AppRouter = typeof appRouter;
