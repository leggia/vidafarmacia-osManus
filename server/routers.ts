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
            productName: z.string().nullable().optional(),
            nombreFactura: z.string().nullable().optional(),
            quantity: z.number().nullable().optional(),
            unitCost: z.number().nullable().optional(),
            subtotal: z.number().nullable().optional(),
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
      // Sanitizar items: dar defaults seguros a valores inválidos para que un
      // producto creado a medias no rompa la operación.
      const itemsLimpios = (input.items || []).map((it) => ({
        productName: (it.productName && String(it.productName).trim()) || "Producto sin nombre",
        nombreFactura: it.nombreFactura ?? null,
        quantity: Number(it.quantity) || 0,
        unitCost: Number(it.unitCost) || 0,
        subtotal: Number(it.subtotal) || (Number(it.quantity) || 0) * (Number(it.unitCost) || 0),
        expiryDate: it.expiryDate ?? null,
        nuevoPrecioVenta: it.nuevoPrecioVenta ?? null,
      }));
      let result: any;
      try {
        result = await db.createPurchase({
          userId: ctx.user.id,
        branchId: input.branchId,
        receiptNumber: input.receiptNumber,
        receiptType: input.receiptType || "BOLETA",
        supplier: input.supplier,
        totalAmount: input.totalAmount,
        items: itemsLimpios,
        imageUrl: input.imageUrl,
        imageKey: input.imageKey,
        status,
      });
      } catch (createError: any) {
        console.error("[Compras] Error creando compra:", createError?.message, createError?.stack);
        throw new Error(`No se pudo guardar la compra: ${createError?.message || "error desconocido"}`);
      }

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
            items: itemsLimpios.map((item) => ({
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

  // Diagnóstico temporal: revisar un borrador y detectar items problemáticos
  diagBorrador: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const compra: any = await db.getPurchaseById(input.id);
      if (!compra) return { error: "No existe la compra" };
      const items = compra.items || [];
      const problemas: any[] = [];
      for (const it of items) {
        const issues: string[] = [];
        if (!it.productName || String(it.productName).trim() === "") issues.push("sin nombre");
        if (it.quantity == null || isNaN(Number(it.quantity))) issues.push(`quantity inválido (${it.quantity})`);
        if (it.unitCost == null || isNaN(Number(it.unitCost))) issues.push(`unitCost inválido (${it.unitCost})`);
        if (it.subtotal == null || isNaN(Number(it.subtotal))) issues.push(`subtotal inválido (${it.subtotal})`);
        problemas.push({
          id: it.id,
          productName: it.productName,
          nombreFactura: it.nombreFactura,
          quantity: it.quantity,
          unitCost: it.unitCost,
          subtotal: it.subtotal,
          expiryDate: it.expiryDate,
          issues: issues.length ? issues : ["OK"],
        });
      }
      return {
        compraId: compra.id,
        receiptNumber: compra.receiptNumber,
        supplier: compra.supplier,
        status: compra.status,
        totalItems: items.length,
        items: problemas,
      };
    }),

  // Verifica si ya existe una compra COMPLETADA con el mismo número de factura
  // (para alertar de posible duplicado). Ignora borradores.
  verificarFacturaDuplicada: protectedProcedure
    .input(z.object({ receiptNumber: z.string(), supplier: z.string().optional() }))
    .query(async ({ input }) => {
      if (!input.receiptNumber || input.receiptNumber.trim() === "") return { duplicada: false };
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const dbc = await getDb();
      if (!dbc) return { duplicada: false };
      const esc = (v: string) => `'${String(v).replace(/'/g, "''")}'`;
      try {
        const filtroSup = input.supplier ? ` AND supplier = ${esc(input.supplier)}` : "";
        const r: any = await dbc.execute(sql.raw(
          `SELECT id, supplier, createdAt FROM purchases
           WHERE receiptNumber = ${esc(input.receiptNumber)} AND status = 'completed'${filtroSup}
           ORDER BY createdAt DESC LIMIT 1`
        ));
        const rows = Array.isArray(r) ? r[0] : r?.rows ?? r;
        const existe = Array.isArray(rows) && rows.length > 0;
        return { duplicada: existe, compra: existe ? rows[0] : null };
      } catch {
        return { duplicada: false };
      }
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

      // Generar código si no se da: letra "A" + número (timestamp corto)
      const codigo = input.codigo || `A${Date.now().toString().slice(-8)}`;

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
      sucursalFija: z.string().nullable().optional(),
      usuarioSistemaNombre: z.string().nullable().optional(),
      horaIngreso: z.string(),
      horaSalida: z.string().optional(),
      horasDia: z.number(),
      diasMes: z.number(),
      diasSemana: z.string().optional(),
      tipoTrabajador: z.enum(["fijo_mensual", "por_dia", "fijo_horas", "fijo_turnos"]).optional(),
      horasMesFijas: z.number().optional(),
      diasPorTurno: z.number().optional(),
      montoPorDia: z.number().optional(),
      montoTurnoExtra: z.number().optional(),
      toleranciaSalidaMin: z.number().optional(),
      sueldoMensual: z.number(),
      tipoDescuento: z.enum(["proporcional", "fijo"]),
      montoDescuentoFijo: z.number(),
      toleranciaMin: z.number(),
    }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { trabajadores } = await import("../drizzle/schema");
      const { eq, sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin base de datos");
      // Garantizar que la columna sucursalFija exista (idempotente). Evita que el
      // guardado falle o ignore el campo si la migración en background no corrió.
      try { await db.execute(sql.raw("ALTER TABLE trabajadores ADD COLUMN sucursalFija VARCHAR(150)")); } catch { /* ya existe */ }
      const valores = {
        nombre: input.nombre,
        usuarioSistemaId: input.usuarioSistemaId || null,
        sucursalFija: input.sucursalFija || null,
        usuarioSistemaNombre: input.usuarioSistemaNombre || null,
        horaIngreso: input.horaIngreso,
        horaSalida: input.horaSalida || "00:00",
        horasDia: String(input.horasDia),
        diasMes: input.diasMes,
        diasSemana: input.diasSemana || "1,2,3,4,5,6",
        tipoTrabajador: input.tipoTrabajador || "fijo_mensual",
        horasMesFijas: input.horasMesFijas ?? 192,
        diasPorTurno: input.diasPorTurno ?? 3,
        montoPorDia: String(input.montoPorDia ?? 0),
        montoTurnoExtra: String(input.montoTurnoExtra ?? 0),
        toleranciaSalidaMin: input.toleranciaSalidaMin ?? 10,
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
      const { trabajadores, ajustesDia, pagosSueldo } = await import("../drizzle/schema");
      const { eq, and, like } = await import("drizzle-orm");
      const { inventarios365 } = await import("./inventarios365");
      const { calcularResumenMensual } = await import("./domain/sueldos");
      const db = await getDb();
      if (!db) return null;
      const [trab] = await db.select().from(trabajadores).where(eq(trabajadores.id, input.trabajadorId));
      if (!trab) return null;

      const aperturas = await inventarios365.aperturasCajaDelMes(
        trab.usuarioSistemaId || "", input.anioMes
      );

      // Ajustes del mes (justificaciones, hora manual, turnos extra)
      const ajustesRows = await db.select().from(ajustesDia)
        .where(and(eq(ajustesDia.trabajadorId, input.trabajadorId), like(ajustesDia.fecha, `${input.anioMes}%`)));
      const ajustes = ajustesRows.map((a: any) => ({
        fecha: a.fecha,
        justificado: a.justificado === 1,
        horaIngresoManual: a.horaIngresoManual || undefined,
        esTurnoExtra: a.esTurnoExtra === 1,
        motivo: a.motivo || undefined,
      }));

      const [pago] = await db.select().from(pagosSueldo)
        .where(and(eq(pagosSueldo.trabajadorId, input.trabajadorId), eq(pagosSueldo.anioMes, input.anioMes)));

      const resumen = calcularResumenMensual(aperturas, {
        tipoTrabajador: (trab.tipoTrabajador || "fijo_mensual") as any,
        horaIngreso: trab.horaIngreso,
        horaSalida: trab.horaSalida && trab.horaSalida !== "00:00" ? trab.horaSalida : undefined,
        horasDia: parseFloat(String(trab.horasDia)) || 8,
        diasMes: trab.diasMes || 26,
        diasSemana: (trab.diasSemana || "").split(",").map(Number).filter((n: number) => !isNaN(n)),
        horasMesFijas: trab.horasMesFijas ?? 192,
        montoPorDia: parseFloat(String(trab.montoPorDia)) || 0,
        montoTurnoExtra: parseFloat(String(trab.montoTurnoExtra)) || 0,
        sueldoMensual: parseFloat(String(trab.sueldoMensual)) || 0,
        tipoDescuento: trab.tipoDescuento as "proporcional" | "fijo",
        montoDescuentoFijo: parseFloat(String(trab.montoDescuentoFijo)) || 0,
        toleranciaMin: trab.toleranciaMin ?? 5,
        toleranciaSalidaMin: trab.toleranciaSalidaMin ?? 10,        diasPorTurno: (trab as any).diasPorTurno ?? 3,
      }, input.anioMes, ajustes);

      return {
        trabajador: {
          id: trab.id, nombre: trab.nombre, horaIngreso: trab.horaIngreso,
          sueldoMensual: parseFloat(String(trab.sueldoMensual)) || 0,
          tipoTrabajador: trab.tipoTrabajador, usuarioSistemaNombre: trab.usuarioSistemaNombre,
        },
        pagado: pago?.pagado === 1,
        fechaPago: pago?.fechaPago || null,
        ...resumen,
      };
    }),

  guardarAjusteDia: publicProcedure
    .input(z.object({
      trabajadorId: z.number(), fecha: z.string(),
      justificado: z.boolean().optional(),
      horaIngresoManual: z.string().nullable().optional(),
      esTurnoExtra: z.boolean().optional(),
      motivo: z.string().nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { ajustesDia } = await import("../drizzle/schema");
      const { eq, and } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin base de datos");
      const existente = await db.select().from(ajustesDia)
        .where(and(eq(ajustesDia.trabajadorId, input.trabajadorId), eq(ajustesDia.fecha, input.fecha)));
      const valores = {
        justificado: input.justificado ? 1 : 0,
        horaIngresoManual: input.horaIngresoManual || null,
        esTurnoExtra: input.esTurnoExtra ? 1 : 0,
        motivo: input.motivo || null,
      };
      if (existente[0]) {
        await db.update(ajustesDia).set(valores).where(eq(ajustesDia.id, existente[0].id));
      } else {
        await db.insert(ajustesDia).values({ trabajadorId: input.trabajadorId, fecha: input.fecha, ...valores });
      }
      return { success: true };
    }),

  marcarPagado: publicProcedure
    .input(z.object({ trabajadorId: z.number(), anioMes: z.string(), montoPagado: z.number(), pagado: z.boolean() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { pagosSueldo } = await import("../drizzle/schema");
      const { eq, and } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin base de datos");
      const existente = await db.select().from(pagosSueldo)
        .where(and(eq(pagosSueldo.trabajadorId, input.trabajadorId), eq(pagosSueldo.anioMes, input.anioMes)));
      if (existente[0]) {
        await db.update(pagosSueldo).set({ pagado: input.pagado ? 1 : 0, montoPagado: String(input.montoPagado) })
          .where(eq(pagosSueldo.id, existente[0].id));
      } else {
        await db.insert(pagosSueldo).values({
          trabajadorId: input.trabajadorId, anioMes: input.anioMes,
          montoPagado: String(input.montoPagado), pagado: input.pagado ? 1 : 0,
        });
      }
      return { success: true };
    }),

  pagosDelMes: publicProcedure
    .input(z.object({ anioMes: z.string() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { pagosSueldo } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return [];
      return db.select().from(pagosSueldo).where(eq(pagosSueldo.anioMes, input.anioMes));
    }),

  // Dashboard de pagos: resumen de TODOS los trabajadores activos para un mes
  dashboardPagos: publicProcedure
    .input(z.object({ anioMes: z.string() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { trabajadores, ajustesDia, pagosSueldo } = await import("../drizzle/schema");
      const { eq, and, like } = await import("drizzle-orm");
      const { inventarios365 } = await import("./inventarios365");
      const { calcularResumenMensual } = await import("./domain/sueldos");
      const db = await getDb();
      if (!db) return { trabajadores: [], totales: null };

      const lista = await db.select().from(trabajadores).where(eq(trabajadores.activo, 1));
      const pagos = await db.select().from(pagosSueldo).where(eq(pagosSueldo.anioMes, input.anioMes));
      const pagoPorTrab = new Map(pagos.map((p: any) => [p.trabajadorId, p]));

      // Alerta de pendientes: activa después del día 15 del mes en curso
      const hoy = new Date();
      const [anioActual, mesActual] = [hoy.getFullYear(), hoy.getMonth() + 1];
      const mesConsultado = input.anioMes;
      const esMesActual = mesConsultado === `${anioActual}-${String(mesActual).padStart(2, "0")}`;
      const pasoDia15 = hoy.getDate() >= 15;
      const alertaActiva = esMesActual ? pasoDia15 : true; // meses pasados siempre alertan

      const resultado = [];
      for (const trab of lista) {
        let sueldoFinal = 0, pagoTurnosExtra = 0;
        try {
          if (trab.usuarioSistemaId) {
            const aperturas = await inventarios365.aperturasCajaDelMes(trab.usuarioSistemaId, input.anioMes);
            const ajustesRows = await db.select().from(ajustesDia)
              .where(and(eq(ajustesDia.trabajadorId, trab.id), like(ajustesDia.fecha, `${input.anioMes}%`)));
            const ajustes = ajustesRows.map((a: any) => ({
              fecha: a.fecha, justificado: a.justificado === 1,
              horaIngresoManual: a.horaIngresoManual || undefined,
              esTurnoExtra: a.esTurnoExtra === 1, motivo: a.motivo || undefined,
            }));
            const r = calcularResumenMensual(aperturas, {
              tipoTrabajador: (trab.tipoTrabajador || "fijo_mensual") as any,
              horaIngreso: trab.horaIngreso,
              horaSalida: trab.horaSalida && trab.horaSalida !== "00:00" ? trab.horaSalida : undefined,
              horasDia: parseFloat(String(trab.horasDia)) || 8,
              diasMes: trab.diasMes || 26,
              diasSemana: (trab.diasSemana || "").split(",").map(Number).filter((n: number) => !isNaN(n)),
              horasMesFijas: trab.horasMesFijas ?? 192,
              montoPorDia: parseFloat(String(trab.montoPorDia)) || 0,
              montoTurnoExtra: parseFloat(String(trab.montoTurnoExtra)) || 0,
              sueldoMensual: parseFloat(String(trab.sueldoMensual)) || 0,
              tipoDescuento: trab.tipoDescuento as any,
              montoDescuentoFijo: parseFloat(String(trab.montoDescuentoFijo)) || 0,
              toleranciaMin: trab.toleranciaMin ?? 5,
              toleranciaSalidaMin: trab.toleranciaSalidaMin ?? 10,              diasPorTurno: (trab as any).diasPorTurno ?? 3,
            }, input.anioMes, ajustes);
            sueldoFinal = r.sueldoFinal;
            pagoTurnosExtra = r.pagoTurnosExtra;
          }
        } catch (e) {
          console.warn(`[dashboardPagos] Error con ${trab.nombre}:`, e);
        }

        const pago = pagoPorTrab.get(trab.id);
        const pagado = pago?.pagado === 1;
        resultado.push({
          trabajadorId: trab.id,
          nombre: trab.nombre,
          tipoTrabajador: trab.tipoTrabajador,
          sueldoFinal,
          pagoTurnosExtra,
          pagado,
          montoPagado: pago ? parseFloat(String(pago.montoPagado)) : 0,
          fechaPago: pago?.fechaPago || null,
        });
      }

      // Totales
      const totalPagado = resultado.filter((r) => r.pagado).reduce((s, r) => s + r.montoPagado, 0);
      const totalPendiente = resultado.filter((r) => !r.pagado).reduce((s, r) => s + r.sueldoFinal, 0);
      const pendientes = resultado.filter((r) => !r.pagado);

      return {
        trabajadores: resultado,
        totales: {
          cantidad: resultado.length,
          pagados: resultado.filter((r) => r.pagado).length,
          pendientes: pendientes.length,
          totalPagado: Math.round(totalPagado * 100) / 100,
          totalPendiente: Math.round(totalPendiente * 100) / 100,
          alertaActiva: alertaActiva && pendientes.length > 0,
          nombresPendientes: pendientes.map((p) => p.nombre),
        },
      };
    }),
});

// ─── Consulta (solo lectura: precio + stock, para contingencias) ──────────────
const consultaRouter = router({
  buscarProductos: publicProcedure
    .input(z.object({ buscar: z.string() }))
    .query(async ({ input }) => {
      if (!input.buscar || input.buscar.trim().length < 2) return [];
      const { inventarios365 } = await import("./inventarios365");
      return inventarios365.consultarProductos(input.buscar.trim());
    }),
});

// ─── Ventas (sincronización bajo demanda + reportes) ──────────────────────────
// Caché en memoria del reporte de rentabilidad por sucursal (TTL 10 min).
// La primera carga lo calcula (hace llamadas a inventarios365); las siguientes
// son instantáneas hasta que expira o se fuerza recálculo.
const cacheRentabilidadSucursal = new Map<string, { data: any; expira: number }>();
const RENTABILIDAD_TTL = 10 * 60 * 1000;

const ventasRouter = router({
  // Botón: sincronizar ventas ahora (incremental, conservador)
  sincronizar: publicProcedure.mutation(async () => {
    const { getDb } = await import("./db");
    const { sql } = await import("drizzle-orm");
    const db = await getDb();
    // Si hay un punto de partida viejo pero 0 ventas guardadas, limpiarlo para
    // que la sincronización capture bien desde las páginas recientes (evita el hueco).
    if (db) {
      try {
        const c: any = await db.execute(sql.raw("SELECT COUNT(*) as n FROM ventas"));
        const rows = Array.isArray(c) ? c[0] : c?.rows ?? c;
        const total = Number((Array.isArray(rows) ? rows[0]?.n : rows?.n) ?? 0);
        if (total === 0) {
          await db.execute(sql.raw("DELETE FROM sync_estado WHERE clave='ventas'"));
        }
      } catch { /* continuar */ }
    }
    // Sincronizar repetidamente hasta cerrar huecos (varios días acumulados)
    const { sincronizarVentasIncremental } = await import("./sync-ventas");
    let totalNuevas = 0;
    let ultimoId = 0;
    let primeraVez = false;
    let intentos = 0;
    let huboHueco = true;
    while (huboHueco && intentos < 8) {
      const r = await sincronizarVentasIncremental();
      totalNuevas += r.nuevas;
      ultimoId = r.ultimoId;
      primeraVez = !!r.primeraVez;
      huboHueco = !!r.huboHueco;
      intentos++;
      if (huboHueco) await new Promise((res) => setTimeout(res, 800));
    }
    return { nuevas: totalNuevas, ultimoId, primeraVez, huboHueco };
  }),

  // Botón: sincronizar clientes
  sincronizarClientes: publicProcedure.mutation(async () => {
    const { sincronizarClientes } = await import("./sync-ventas");
    return sincronizarClientes();
  }),

  // Rellenar huecos: recorre las ventas recientes por FECHA y guarda las que falten
  // (sin depender del ultimoId). Rescata días que quedaron sin sincronizar.
  rellenarHuecos: publicProcedure
    .input(z.object({ dias: z.number().optional() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const { inventarios365 } = await import("./inventarios365");
      const { guardarVentaPublica } = await import("./sync-ventas");
      const db = await getDb();
      if (!db) return { rescatadas: 0 };

      const diasAtras = input.dias || 7;
      const limite = new Date();
      limite.setDate(limite.getDate() - diasAtras);
      const fechaLimite = limite.toISOString().slice(0, 10);

      let rescatadas = 0;
      try {
        // Recorrer páginas recientes (hasta 80 = ~800 ventas, cubre varios días)
        for (let page = 1; page <= 80; page++) {
          const { ventas: lista } = await inventarios365.listarVentasPagina(page);
          if (lista.length === 0) break;
          let todasViejas = true;
          for (const v of lista) {
            const fecha = String(v.fecha_hora || "").slice(0, 10);
            if (fecha >= fechaLimite) {
              todasViejas = false;
              const g = await guardarVentaPublica(db, sql, v);
              if (g) rescatadas++;
            }
          }
          // Si toda la página ya es más vieja que el límite, terminamos
          if (todasViejas) break;
          await new Promise((r) => setTimeout(r, 80));
        }
      } catch (e: any) {
        return { rescatadas, error: e.message };
      }
      return { rescatadas };
    }),

  // Carga histórica del mes anterior, POR LOTES (se llama repetidamente)
  cargarHistoricoLote: publicProcedure
    .input(z.object({ desde: z.string(), hasta: z.string() }))
    .mutation(async ({ input }) => {
      const { cargarHistoricoLote } = await import("./sync-ventas");
      return cargarHistoricoLote(input.desde, input.hasta);
    }),

  // Reiniciar el progreso de la carga histórica
  reiniciarHistorico: publicProcedure.mutation(async () => {
    const { reiniciarProgresoHistorico } = await import("./sync-ventas");
    await reiniciarProgresoHistorico();
    return { success: true };
  }),

  // Estado de la sincronización
  estado: publicProcedure.query(async () => {
    const { getDb } = await import("./db");
    const { sql } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return null;
    try {
      const totalV: any = await db.execute(sql.raw("SELECT COUNT(*) as n FROM ventas"));
      const totalC: any = await db.execute(sql.raw("SELECT COUNT(*) as n FROM clientes"));
      const est: any = await db.execute(sql.raw("SELECT ultimoId, ultimaSync FROM sync_estado WHERE clave='ventas' LIMIT 1"));
      const num = (r: any) => { const rows = Array.isArray(r) ? r[0] : r?.rows ?? r; return Number((Array.isArray(rows) ? rows[0]?.n : rows?.n) ?? 0); };
      const estRow = Array.isArray(est) ? est[0] : est?.rows ?? est;
      const e = Array.isArray(estRow) ? estRow[0] : estRow;
      return { totalVentas: num(totalV), totalClientes: num(totalC), ultimoId: e?.ultimoId ?? 0, ultimaSync: e?.ultimaSync ?? null };
    } catch (err: any) {
      return { error: err.message, totalVentas: 0, totalClientes: 0, ultimoId: 0, ultimaSync: null };
    }
  }),

  // ── REPORTES (SQL directo, agrupado; índices ya creados en las tablas) ──
  reportes: publicProcedure
    .input(z.object({ desde: z.string(), hasta: z.string(), sucursal: z.string().optional() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return null;
      const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
      const esc = (v: string) => `'${String(v).replace(/'/g, "''")}'`;
      const rango = `fecha >= ${esc(input.desde)} AND fecha <= ${esc(input.hasta)}`;
      const filtroSuc = input.sucursal ? ` AND nombreSucursal = ${esc(input.sucursal)}` : "";
      // Excluir "ventas menores del día" de los reportes de productos: no es un
      // medicamento real, solo un registro para ventas mínimas olvidadas.
      const excluirMenores = ` AND articuloNombre NOT LIKE '%ventas menores%' AND articuloNombre NOT LIKE '%venta menor%'`;

      try {
        const [masVendidos, masVendidosValor, vendedores, sucursales, diasSemana, totales] = await Promise.all([
          // Productos más vendidos POR CANTIDAD
          db.execute(sql.raw(
            `SELECT articuloNombre, SUM(cantidad) as unidades, SUM(subtotal) as monto, COUNT(*) as veces
             FROM ventas_detalle WHERE ${rango}${filtroSuc}${excluirMenores}
             GROUP BY articuloNombre ORDER BY unidades DESC LIMIT 15`
          )),
          // Productos más vendidos POR VALOR (ingreso generado)
          db.execute(sql.raw(
            `SELECT articuloNombre, SUM(cantidad) as unidades, SUM(subtotal) as monto, COUNT(*) as veces
             FROM ventas_detalle WHERE ${rango}${filtroSuc}${excluirMenores}
             GROUP BY articuloNombre ORDER BY monto DESC LIMIT 15`
          )),
          // Mejores vendedores
          db.execute(sql.raw(
            `SELECT vendedor, SUM(total) as monto, COUNT(*) as ventas
             FROM ventas WHERE ${rango}${filtroSuc}
             GROUP BY vendedor ORDER BY monto DESC LIMIT 10`
          )),
          // Ventas por sucursal
          db.execute(sql.raw(
            `SELECT nombreSucursal, SUM(total) as monto, COUNT(*) as ventas
             FROM ventas WHERE ${rango}
             GROUP BY nombreSucursal ORDER BY monto DESC`
          )),
          // Mejores días de la semana
          db.execute(sql.raw(
            `SELECT diaSemana, SUM(total) as monto, COUNT(*) as ventas
             FROM ventas WHERE ${rango}${filtroSuc}
             GROUP BY diaSemana ORDER BY diaSemana`
          )),
          // Totales del periodo
          db.execute(sql.raw(
            `SELECT COUNT(*) as ventas, SUM(total) as monto, AVG(total) as promedio
             FROM ventas WHERE ${rango}${filtroSuc}`
          )),
        ]);
        return {
          masVendidos: rows(masVendidos),
          masVendidosValor: rows(masVendidosValor),
          vendedores: rows(vendedores),
          sucursales: rows(sucursales),
          diasSemana: rows(diasSemana),
          totales: rows(totales)[0] || { ventas: 0, monto: 0, promedio: 0 },
        };
      } catch (err: any) {
        return { error: err.message, masVendidos: [], vendedores: [], sucursales: [], diasSemana: [], totales: null };
      }
    }),

  // Lista de sucursales disponibles (para el filtro)
  // Diagnóstico temporal: ver qué gastos y sucursales hay (para depurar el reporte)
  sucursalesDisponibles: publicProcedure.query(async () => {
    const { getDb } = await import("./db");
    const { sql } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return [];
    try {
      const r: any = await db.execute(sql.raw("SELECT DISTINCT nombreSucursal FROM ventas WHERE nombreSucursal IS NOT NULL"));
      const rows = Array.isArray(r) ? r[0] : r?.rows ?? r;
      return (Array.isArray(rows) ? rows : []).map((x: any) => x.nombreSucursal).filter(Boolean);
    } catch { return []; }
  }),

  // Rentabilidad REAL por sucursal: ingresos − costo productos − sueldos − gastos.
  // Responde: ¿las ganancias de cada sucursal cubren sus gastos?
  // Resumen de compras realizadas en un mes (para el reporte)
  comprasDelMes: publicProcedure
    .input(z.object({ anioMes: z.string() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return { compras: [], total: 0, cantidad: 0 };
      const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
      const esc = (v: string) => `'${String(v).replace(/'/g, "''")}'`;
      const [anio, mes] = input.anioMes.split("-").map(Number);
      const desde = `${input.anioMes}-01 00:00:00`;
      const ultimoDia = new Date(anio, mes, 0).getDate();
      const hasta = `${input.anioMes}-${String(ultimoDia).padStart(2, "0")} 23:59:59`;
      try {
        // Compras completadas del mes (por fecha de creación), con nombre de sucursal
        const compras = rows(await db.execute(sql.raw(
          `SELECT p.id, p.receiptNumber, p.supplier, p.totalAmount, p.createdAt, p.status, b.name as branchName
           FROM purchases p LEFT JOIN branches b ON b.id = p.branchId
           WHERE p.status='completed' AND p.createdAt >= ${esc(desde)} AND p.createdAt <= ${esc(hasta)}
           ORDER BY CAST(p.totalAmount AS DECIMAL(12,2)) DESC`
        )));
        const total = compras.reduce((s: number, c: any) => s + Number(c.totalAmount || 0), 0);
        // Detectar posibles duplicados (mismo número de factura y mismo monto)
        const claveCount: Record<string, number> = {};
        for (const c of compras) {
          const clave = `${(c.receiptNumber || "").trim()}|${Number(c.totalAmount || 0).toFixed(2)}`;
          claveCount[clave] = (claveCount[clave] || 0) + 1;
        }
        for (const c of compras) {
          const clave = `${(c.receiptNumber || "").trim()}|${Number(c.totalAmount || 0).toFixed(2)}`;
          c.posibleDuplicado = c.receiptNumber && claveCount[clave] > 1;
        }
        // Total por proveedor
        const porProveedor: Record<string, number> = {};
        for (const c of compras) {
          const prov = c.supplier || "Sin proveedor";
          porProveedor[prov] = (porProveedor[prov] || 0) + Number(c.totalAmount || 0);
        }
        const proveedores = Object.entries(porProveedor)
          .map(([nombre, monto]) => ({ nombre, monto }))
          .sort((a, b) => b.monto - a.monto);
        return { compras, total, cantidad: compras.length, proveedores };
      } catch (e: any) {
        return { compras: [], total: 0, cantidad: 0, proveedores: [], error: e.message };
      }
    }),

  rentabilidadPorSucursal: publicProcedure
    .input(z.object({ anioMes: z.string(), forzar: z.boolean().optional() }))
    .query(async ({ input }) => {
      // Servir desde caché si está fresco (salvo que se fuerce recálculo)
      const cacheKey = input.anioMes;
      if (!input.forzar) {
        const cached = cacheRentabilidadSucursal.get(cacheKey);
        if (cached && cached.expira > Date.now()) return cached.data;
      }
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return { sucursales: [] };
      const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
      const esc = (v: string) => `'${String(v).replace(/'/g, "''")}'`;
      // El reporte es MENSUAL: calcular el rango del mes completo desde anioMes
      const [anio, mes] = input.anioMes.split("-").map(Number);
      const desde = `${input.anioMes}-01`;
      const ultimoDia = new Date(anio, mes, 0).getDate(); // último día del mes
      const hasta = `${input.anioMes}-${String(ultimoDia).padStart(2, "0")}`;
      const rango = `fecha >= ${esc(desde)} AND fecha <= ${esc(hasta)}`;
      const rangoD = `d.fecha >= ${esc(desde)} AND d.fecha <= ${esc(hasta)}`;
      const excl = ` AND d.articuloNombre NOT LIKE '%ventas menores%' AND d.articuloNombre NOT LIKE '%venta menor%'`;

      try {
        // 1. Ingresos por sucursal (incluye ventas menores: es dinero real)
        const ingresos = rows(await db.execute(sql.raw(
          `SELECT nombreSucursal, SUM(total) as ingreso, COUNT(*) as ventas
           FROM ventas WHERE ${rango} AND nombreSucursal IS NOT NULL
           GROUP BY nombreSucursal`
        )));

        // 2. Costo de productos vendidos por sucursal (solo productos con costo conocido)
        const costos = rows(await db.execute(sql.raw(
          `SELECT d.nombreSucursal, SUM(d.cantidad * c.precioCostoUnid) as costo
           FROM ventas_detalle d JOIN productos_cache c ON c.nombre = d.articuloNombre
           WHERE ${rangoD}${excl} AND c.precioCostoUnid > 0 AND d.nombreSucursal IS NOT NULL
           GROUP BY d.nombreSucursal`
        )));

        // 3. Gastos operativos por sucursal (del mes)
        const gastos = rows(await db.execute(sql.raw(
          `SELECT sucursal, SUM(monto) as gastos FROM gastos_registro
           WHERE anioMes=${esc(input.anioMes)} AND sucursal IS NOT NULL
           GROUP BY sucursal`
        )));
        // Gastos generales (sin sucursal asignada) se reparten aparte
        const gastosGenerales = rows(await db.execute(sql.raw(
          `SELECT SUM(monto) as total FROM gastos_registro
           WHERE anioMes=${esc(input.anioMes)} AND (sucursal IS NULL OR sucursal='')`
        )))[0]?.total || 0;

        // Mapear por nombre de sucursal
        const mapa: Record<string, any> = {};
        for (const i of ingresos) {
          const s = i.nombreSucursal;
          mapa[s] = { sucursal: s, ingreso: Number(i.ingreso) || 0, ventas: Number(i.ventas) || 0, costo: 0, gastos: 0, sueldos: 0 };
        }
        for (const c of costos) {
          if (mapa[c.nombreSucursal]) mapa[c.nombreSucursal].costo = Number(c.costo) || 0;
        }
        for (const g of gastos) {
          if (mapa[g.sucursal]) mapa[g.sucursal].gastos = Number(g.gastos) || 0;
          else mapa[g.sucursal] = { sucursal: g.sucursal, ingreso: 0, ventas: 0, costo: 0, gastos: Number(g.gastos) || 0, sueldos: 0 };
        }

        // 4. Sueldos por sucursal (infiere personal según dónde vendió)
        const { trabajadores, ajustesDia } = await import("../drizzle/schema");
        const { eq, like, and } = await import("drizzle-orm");
        const { inventarios365 } = await import("./inventarios365");
        const { calcularResumenMensual } = await import("./domain/sueldos");
        const lista = await db.select().from(trabajadores).where(eq(trabajadores.activo, 1));

        // Calcular el sueldo de cada trabajador UNA SOLA VEZ (optimización de velocidad).
        const norm = (x: any) => String(x || "").trim().toLowerCase().replace(/\s+/g, " ");
        const sueldoPorTrabajador: any[] = [];
        for (const trab of lista) {
          const sueldoMensualNum = parseFloat(String(trab.sueldoMensual)) || 0;
          const esTipoFijo = (trab.tipoTrabajador || "fijo_mensual") === "fijo_mensual" || trab.tipoTrabajador === "fijo_turnos" || trab.tipoTrabajador === "fijo_horas";
          let sueldoCalc = 0;
          let metodoCalc = "";
          try {
            if (!trab.usuarioSistemaId) {
              sueldoCalc = sueldoMensualNum;
              metodoCalc = "base (sin usuario)";
            } else {
              const aperturas = await inventarios365.aperturasCajaDelMes(trab.usuarioSistemaId, input.anioMes);
              const res = calcularResumenMensual(aperturas, {
                tipoTrabajador: (trab.tipoTrabajador || "fijo_mensual") as any,
                horaIngreso: trab.horaIngreso,
                horaSalida: trab.horaSalida && trab.horaSalida !== "00:00" ? trab.horaSalida : undefined,
                horasDia: parseFloat(String(trab.horasDia)) || 8,
                diasSemana: trab.diasSemana, diasMes: trab.diasMes,
                horasMesFijas: trab.horasMesFijas,
                montoPorDia: parseFloat(String(trab.montoPorDia)) || 0,
                montoTurnoExtra: parseFloat(String(trab.montoTurnoExtra)) || 0,
                toleranciaMin: (trab as any).toleranciaMin ?? 5,
                toleranciaSalidaMin: trab.toleranciaSalidaMin ?? 10,
                sueldoMensual: sueldoMensualNum,
                diasPorTurno: (trab as any).diasPorTurno ?? 3,
              } as any, input.anioMes);
              sueldoCalc = res.sueldoFinal;
              metodoCalc = `calculado (${aperturas.length} aperturas)`;
              if (esTipoFijo && (sueldoCalc === 0 || isNaN(sueldoCalc)) && sueldoMensualNum > 0) {
                sueldoCalc = sueldoMensualNum;
                metodoCalc = `fijo base (${aperturas.length} aperturas)`;
              }
            }
          } catch (e: any) {
            sueldoCalc = sueldoMensualNum;
            metodoCalc = "catch: " + (e?.message || "error");
          }
          if (isNaN(sueldoCalc)) sueldoCalc = sueldoMensualNum;
          sueldoPorTrabajador.push({ trab, sueldoCalc, metodoCalc, sueldoMensual: trab.sueldoMensual });
        }

        // Asignar cada sueldo a su sucursal
        for (const s of Object.keys(mapa)) {
          const vend = rows(await db.execute(sql.raw(
            `SELECT DISTINCT vendedor FROM ventas WHERE nombreSucursal=${esc(s)} AND vendedor IS NOT NULL`
          )));
          const usuarios = new Set(vend.map((v: any) => String(v.vendedor)));
          let sueldos = 0;
          for (const item of sueldoPorTrabajador) {
            const trab = item.trab;
            const sucFija = (trab as any).sucursalFija;
            const pertenece = sucFija
              ? norm(sucFija) === norm(s)
              : (trab.usuarioSistemaId && usuarios.has(trab.usuarioSistemaId));
            if (!pertenece) continue;
            sueldos += item.sueldoCalc;
          }
          mapa[s].sueldos = sueldos;
        }

        // Calcular ganancia neta por sucursal
        const resultado = Object.values(mapa).map((m: any) => {
          const gananciaProductos = m.ingreso - m.costo;
          const netaAntesGenerales = gananciaProductos - m.sueldos - m.gastos;
          return {
            ...m,
            gananciaProductos,
            netaAntesGenerales,
            cubreGastos: netaAntesGenerales >= 0,
          };
        }).sort((a: any, b: any) => b.netaAntesGenerales - a.netaAntesGenerales);

        const respuesta = {
          sucursales: resultado,
          gastosGenerales: Number(gastosGenerales) || 0,
          nota: "El costo de productos solo considera productos con costo conocido. Los gastos generales (sin sucursal) se muestran aparte.",
        };
        // Guardar en caché para que las próximas cargas sean instantáneas
        cacheRentabilidadSucursal.set(cacheKey, { data: respuesta, expira: Date.now() + RENTABILIDAD_TTL });
        return respuesta;
      } catch (err: any) {
        return { sucursales: [], error: err.message };
      }
    }),

  // Rentabilidad: une ventas con el costo (productos_cache por nombre).
  // Calcula ganancia = (precio - costo) * cantidad, y margen % = (precio-costo)/precio.
  rentabilidad: publicProcedure
    .input(z.object({ desde: z.string(), hasta: z.string(), sucursal: z.string().optional() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return null;
      const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
      const esc = (v: string) => `'${String(v).replace(/'/g, "''")}'`;
      const rango = `d.fecha >= ${esc(input.desde)} AND d.fecha <= ${esc(input.hasta)}`;
      const filtroSuc = input.sucursal ? ` AND d.nombreSucursal = ${esc(input.sucursal)}` : "";
      // Excluir "ventas menores del día" (no es un producto real)
      const excluirMenores = ` AND d.articuloNombre NOT LIKE '%ventas menores%' AND d.articuloNombre NOT LIKE '%venta menor%'`;

      try {
        // Productos que MÁS GANANCIA generaron (suma de ganancia por línea)
        const masGanancia = await db.execute(sql.raw(
          `SELECT d.articuloNombre,
                  SUM(d.cantidad) as unidades,
                  SUM(d.subtotal) as ingreso,
                  SUM(d.cantidad * c.precioCostoUnid) as costoTotal,
                  SUM(d.subtotal - (d.cantidad * c.precioCostoUnid)) as ganancia
           FROM ventas_detalle d
           JOIN productos_cache c ON c.nombre = d.articuloNombre
           WHERE ${rango}${filtroSuc}${excluirMenores} AND c.precioCostoUnid > 0
           GROUP BY d.articuloNombre
           HAVING ganancia IS NOT NULL
           ORDER BY ganancia DESC LIMIT 15`
        ));

        // Productos con MAYOR MARGEN % (promedio ponderado por línea)
        const mayorMargen = await db.execute(sql.raw(
          `SELECT d.articuloNombre,
                  SUM(d.cantidad) as unidades,
                  AVG((d.precio - c.precioCostoUnid) / d.precio * 100) as margenPct,
                  SUM(d.subtotal - (d.cantidad * c.precioCostoUnid)) as ganancia
           FROM ventas_detalle d
           JOIN productos_cache c ON c.nombre = d.articuloNombre
           WHERE ${rango}${filtroSuc}${excluirMenores} AND c.precioCostoUnid > 0 AND d.precio > 0
           GROUP BY d.articuloNombre
           HAVING margenPct IS NOT NULL
           ORDER BY margenPct DESC LIMIT 15`
        ));

        // Resumen: ganancia total estimada del periodo (solo productos con costo conocido)
        const resumen = await db.execute(sql.raw(
          `SELECT SUM(d.subtotal) as ingreso,
                  SUM(d.cantidad * c.precioCostoUnid) as costo,
                  SUM(d.subtotal - (d.cantidad * c.precioCostoUnid)) as ganancia,
                  COUNT(DISTINCT d.articuloNombre) as productosConCosto
           FROM ventas_detalle d
           JOIN productos_cache c ON c.nombre = d.articuloNombre
           WHERE ${rango}${filtroSuc} AND c.precioCostoUnid > 0`
        ));

        return {
          masGanancia: rows(masGanancia),
          mayorMargen: rows(mayorMargen),
          resumen: rows(resumen)[0] || null,
        };
      } catch (err: any) {
        return { error: err.message, masGanancia: [], mayorMargen: [], resumen: null };
      }
    }),
});

// ─── Gastos de la farmacia (fijos recurrentes + ocasionales) ──────────────────
const gastosRouter = router({
  // Listar plantilla de gastos fijos
  listarFijos: publicProcedure.query(async () => {
    const { getDb } = await import("./db");
    const { sql } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return [];
    try {
      const r: any = await db.execute(sql.raw("SELECT * FROM gastos_fijos WHERE activo=1 ORDER BY categoria, nombre"));
      const rows = Array.isArray(r) ? r[0] : r?.rows ?? r;
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }),

  // Crear un gasto fijo (plantilla)
  crearFijo: publicProcedure
    .input(z.object({ nombre: z.string(), categoria: z.string(), montoEstimado: z.number(), diaVencimiento: z.number().optional(), sucursal: z.string().optional(), esVariable: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin BD");
      const esc = (v: any) => v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
      await db.execute(sql.raw(
        `INSERT INTO gastos_fijos (nombre, categoria, montoEstimado, diaVencimiento, sucursal, esVariable)
         VALUES (${esc(input.nombre)}, ${esc(input.categoria)}, ${input.montoEstimado}, ${input.diaVencimiento ?? "NULL"}, ${esc(input.sucursal)}, ${input.esVariable ? 1 : 0})`
      ));
      return { success: true };
    }),

  // Eliminar (desactivar) un gasto fijo
  eliminarFijo: publicProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin BD");
      await db.execute(sql.raw(`UPDATE gastos_fijos SET activo=0 WHERE id=${input.id}`));
      return { success: true };
    }),

  // Obtener los gastos de un mes (genera los fijos si no existen aún + ocasionales)
  delMes: publicProcedure
    .input(z.object({ anioMes: z.string(), sucursal: z.string().optional() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return { gastos: [], totalPagado: 0, totalPendiente: 0 };
      const esc = (v: any) => v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
      const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };

      try {
        // Generar registros de gastos fijos para el mes si aún no existen.
        // Verificamos por gastoFijoId Y por nombre, para no duplicar gastos que
        // fueron movidos a este mes (y quedaron desvinculados de la plantilla).
        const fijos = rows(await db.execute(sql.raw("SELECT * FROM gastos_fijos WHERE activo=1")));
        const existentes = rows(await db.execute(sql.raw(`SELECT gastoFijoId, nombre FROM gastos_registro WHERE anioMes=${esc(input.anioMes)}`)));
        const idsExistentes = new Set(existentes.filter((e: any) => e.gastoFijoId != null).map((e: any) => e.gastoFijoId));
        const nombresExistentes = new Set(existentes.map((e: any) => String(e.nombre || "").trim().toLowerCase()));
        for (const f of fijos) {
          const yaExistePorId = idsExistentes.has(f.id);
          const yaExistePorNombre = nombresExistentes.has(String(f.nombre || "").trim().toLowerCase());
          if (!yaExistePorId && !yaExistePorNombre) {
            // Para gastos variables (luz, agua), el monto inicial es 0 (se ingresa al llegar la factura)
            const montoInicial = f.esVariable ? 0 : (Number(f.montoEstimado) || 0);
            await db.execute(sql.raw(
              `INSERT INTO gastos_registro (anioMes, gastoFijoId, nombre, categoria, monto, pagado, esOcasional, sucursal, esVariable)
               VALUES (${esc(input.anioMes)}, ${f.id}, ${esc(f.nombre)}, ${esc(f.categoria)}, ${montoInicial}, 0, 0, ${esc(f.sucursal)}, ${f.esVariable ? 1 : 0})`
            ));
          }
        }

        // Devolver gastos del mes (filtrados por sucursal si se indicó)
        const filtroSuc = input.sucursal ? ` AND sucursal=${esc(input.sucursal)}` : "";
        const gastos = rows(await db.execute(sql.raw(`SELECT * FROM gastos_registro WHERE anioMes=${esc(input.anioMes)}${filtroSuc} ORDER BY esOcasional, categoria, nombre`)));
        const totalPagado = gastos.filter((g: any) => g.pagado).reduce((s: number, g: any) => s + Number(g.monto), 0);
        const totalPendiente = gastos.filter((g: any) => !g.pagado).reduce((s: number, g: any) => s + Number(g.monto), 0);
        return { gastos, totalPagado, totalPendiente };
      } catch (err: any) {
        return { gastos: [], totalPagado: 0, totalPendiente: 0, error: err.message };
      }
    }),

  // Marcar pagado/no pagado un gasto + ajustar monto y fecha de pago
  marcarPago: publicProcedure
    .input(z.object({ id: z.number(), pagado: z.boolean(), monto: z.number().optional(), fechaPago: z.string().optional() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin BD");
      const hoy = new Date().toISOString().slice(0, 10);
      const fecha = input.fechaPago || hoy;
      const setMonto = input.monto != null ? `, monto=${input.monto}` : "";
      await db.execute(sql.raw(
        `UPDATE gastos_registro SET pagado=${input.pagado ? 1 : 0}, fechaPago=${input.pagado ? `'${fecha}'` : "NULL"}${setMonto} WHERE id=${input.id}`
      ));
      return { success: true };
    }),

  // Cambiar solo la fecha de pago de un gasto
  cambiarFechaPago: publicProcedure
    .input(z.object({ id: z.number(), fechaPago: z.string() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin BD");
      await db.execute(sql.raw(`UPDATE gastos_registro SET fechaPago='${input.fechaPago}' WHERE id=${input.id}`));
      return { success: true };
    }),

  // Registrar un gasto ocasional
  registrarOcasional: publicProcedure
    .input(z.object({ anioMes: z.string(), nombre: z.string(), categoria: z.string(), monto: z.number(), pagado: z.boolean(), sucursal: z.string().optional(), fechaPago: z.string().optional() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin BD");
      const esc = (v: any) => v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
      const hoy = new Date().toISOString().slice(0, 10);
      const fecha = input.pagado ? (input.fechaPago || hoy) : null;
      await db.execute(sql.raw(
        `INSERT INTO gastos_registro (anioMes, nombre, categoria, monto, pagado, fechaPago, esOcasional, sucursal)
         VALUES (${esc(input.anioMes)}, ${esc(input.nombre)}, ${esc(input.categoria)}, ${input.monto}, ${input.pagado ? 1 : 0}, ${esc(fecha)}, 1, ${esc(input.sucursal)})`
      ));
      return { success: true };
    }),

  // Eliminar un gasto del registro. Si es un fijo, opcionalmente elimina también
  // la plantilla (para que no se regenere el próximo mes).
  eliminar: publicProcedure
    .input(z.object({ id: z.number(), eliminarPlantilla: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin BD");
      const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };

      // Ver si el gasto viene de una plantilla fija
      const g = rows(await db.execute(sql.raw(`SELECT gastoFijoId FROM gastos_registro WHERE id=${input.id} LIMIT 1`)));
      const gastoFijoId = g[0]?.gastoFijoId;

      // Borrar el registro de este mes
      await db.execute(sql.raw(`DELETE FROM gastos_registro WHERE id=${input.id}`));

      // Si es fijo y se pide eliminar la plantilla, desactivarla (no se regenera más)
      if (gastoFijoId && input.eliminarPlantilla) {
        await db.execute(sql.raw(`UPDATE gastos_fijos SET activo=0 WHERE id=${gastoFijoId}`));
      }
      return { success: true, eraFijo: !!gastoFijoId };
    }),

  // Total de sueldos del mes (opcionalmente por sucursal, infiriendo del vendedor).
  sueldosDelMes: publicProcedure
    .input(z.object({ anioMes: z.string(), sucursal: z.string().optional() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { trabajadores, ajustesDia } = await import("../drizzle/schema");
      const { eq, like, and, sql } = await import("drizzle-orm");
      const { inventarios365 } = await import("./inventarios365");
      const { calcularResumenMensual } = await import("./domain/sueldos");
      const db = await getDb();
      if (!db) return { total: 0, detalle: [] };

      try {
        const lista = await db.select().from(trabajadores).where(eq(trabajadores.activo, 1));

        let usuariosDeSucursal: Set<string> | null = null;
        if (input.sucursal) {
          const esc = (v: string) => `'${String(v).replace(/'/g, "''")}'`;
          const r: any = await db.execute(sql.raw(
            `SELECT DISTINCT vendedor FROM ventas WHERE nombreSucursal=${esc(input.sucursal)} AND vendedor IS NOT NULL`
          ));
          const rows = Array.isArray(r) ? r[0] : r?.rows ?? r;
          usuariosDeSucursal = new Set((Array.isArray(rows) ? rows : []).map((x: any) => String(x.vendedor)));
        }

        let total = 0;
        const detalle: any[] = [];
        for (const trab of lista) {
          if (usuariosDeSucursal && trab.usuarioSistemaId && !usuariosDeSucursal.has(trab.usuarioSistemaId)) continue;
          if (usuariosDeSucursal && !trab.usuarioSistemaId) continue;

          let sueldoFinal = 0;
          try {
            if (trab.usuarioSistemaId) {
              const aperturas = await inventarios365.aperturasCajaDelMes(trab.usuarioSistemaId, input.anioMes);
              const ajustesRows = await db.select().from(ajustesDia)
                .where(and(eq(ajustesDia.trabajadorId, trab.id), like(ajustesDia.fecha, `${input.anioMes}%`)));
              const ajustes = ajustesRows.map((a: any) => ({
                fecha: a.fecha, justificado: a.justificado === 1,
                horaIngresoManual: a.horaIngresoManual || undefined,
                esTurnoExtra: a.esTurnoExtra === 1, motivo: a.motivo || undefined,
              }));
              const r = calcularResumenMensual(aperturas, {
                tipoTrabajador: (trab.tipoTrabajador || "fijo_mensual") as any,
                horaIngreso: trab.horaIngreso,
                horaSalida: trab.horaSalida && trab.horaSalida !== "00:00" ? trab.horaSalida : undefined,
                horasDia: parseFloat(String(trab.horasDia)) || 8,
                diasSemana: trab.diasSemana, diasMes: trab.diasMes,
                horasMesFijas: trab.horasMesFijas,
                montoPorDia: parseFloat(String(trab.montoPorDia)) || 0,
                montoTurnoExtra: parseFloat(String(trab.montoTurnoExtra)) || 0,
                toleranciaSalidaMin: trab.toleranciaSalidaMin,                diasPorTurno: (trab as any).diasPorTurno ?? 3,
                sueldoMensual: parseFloat(String(trab.sueldoMensual)) || 0,
              }, input.anioMes);
              sueldoFinal = r.sueldoFinal;
            } else {
              sueldoFinal = parseFloat(String(trab.sueldoMensual)) || 0;
            }
          } catch {
            sueldoFinal = parseFloat(String(trab.sueldoMensual)) || 0;
          }
          total += sueldoFinal;
          detalle.push({ nombre: trab.nombre, sueldo: sueldoFinal });
        }
        return { total, detalle };
      } catch (err: any) {
        return { total: 0, detalle: [], error: err.message };
      }
    }),

  // Editar un gasto del registro (nombre, categoría, monto, sucursal)
  editar: publicProcedure
    .input(z.object({ id: z.number(), nombre: z.string(), categoria: z.string(), monto: z.number(), sucursal: z.string().optional(), anioMes: z.string().optional() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin BD");
      const esc = (v: any) => v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
      const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };

      // Ver el mes actual y si viene de una plantilla fija
      const actual = rows(await db.execute(sql.raw(`SELECT anioMes, gastoFijoId, nombre FROM gastos_registro WHERE id=${input.id} LIMIT 1`)));
      const mesActual = actual[0]?.anioMes;
      const esFijo = actual[0]?.gastoFijoId != null;

      let setMes = "";
      if (input.anioMes && input.anioMes !== mesActual) {
        setMes = `, anioMes=${esc(input.anioMes)}`;
        // Si es un gasto fijo y se MUEVE a otro mes, eliminar en el mes destino
        // cualquier registro de la MISMA plantilla o mismo nombre (regenerado con
        // monto 0), para no duplicar. NO desvinculamos: delMes deduplica por nombre.
        if (esFijo) {
          const fijoId = actual[0].gastoFijoId;
          const nombreActual = String(actual[0].nombre || "").trim().toLowerCase();
          await db.execute(sql.raw(
            `DELETE FROM gastos_registro WHERE anioMes=${esc(input.anioMes)} AND id<>${input.id}
             AND (gastoFijoId=${fijoId} OR LOWER(TRIM(nombre))=${esc(nombreActual)})`
          ));
        }
      }

      await db.execute(sql.raw(
        `UPDATE gastos_registro SET nombre=${esc(input.nombre)}, categoria=${esc(input.categoria)}, monto=${input.monto}, sucursal=${esc(input.sucursal)}${setMes} WHERE id=${input.id}`
      ));
      return { success: true };
    }),
});

// ─────────────────────────────────────────────────────────
// Router del Asistente VidaFarma (Fase 1: solo consultas)
// ─────────────────────────────────────────────────────────
const MODELO_ASISTENTE = "llama-3.1-8b-instant"; // mucho más liviano que el 70B; evita saturar el límite gratuito de tokens

// Respaldo: detectar la intención de la pregunta por palabras clave y ejecutar
// la herramienta correspondiente (cuando el modelo falla al generar la función).
async function intentarHerramientaPorIntencion(pregunta: string): Promise<{ nombre: string; resultado: any } | null> {
  const q = pregunta.toLowerCase();
  const periodo = q.includes("hoy") ? "hoy" : q.includes("ayer") ? "ayer" : q.includes("semana") ? "semana"
    : (q.includes("mes anterior") || q.includes("mes pasado")) ? "mes anterior" : "mes";

  // Precio / cuánto cuesta un producto
  if (q.includes("precio") || q.includes("cuesta") || q.includes("costo") || q.includes("vale")) {
    // Extraer el nombre del producto (quitar palabras comunes)
    const limpio = q.replace(/(cu[aá]nto|cuesta|precio|de|del|la|el|los|las|vale|costo|es|\?|¿)/g, " ").replace(/\s+/g, " ").trim();
    if (limpio.length >= 2) {
      const { asistenteTools } = await import("./asistente");
      return { nombre: "infoProducto", resultado: await asistenteTools.infoProducto(limpio) };
    }
  }
  // Mejor vendedor
  if (q.includes("mejor vendedor") || q.includes("mejor vendedora") || q.includes("quién vende") || q.includes("quien vende")) {
    const { asistenteTools } = await import("./asistente");
    return { nombre: "mejoresVendedores", resultado: await asistenteTools.mejoresVendedores(periodo) };
  }
  // Cuánto vendí
  if (q.includes("vend") || q.includes("venta")) {
    const { asistenteTools } = await import("./asistente");
    return { nombre: "ventasPeriodo", resultado: await asistenteTools.ventasPeriodo(periodo) };
  }
  // Cuánto gané
  if (q.includes("gan")) {
    const { asistenteTools } = await import("./asistente");
    return { nombre: "gananciaPeriodo", resultado: await asistenteTools.gananciaPeriodo(periodo) };
  }
  return null;
}

// Ejecuta una herramienta del asistente por nombre con sus argumentos
async function ejecutarHerramienta(nombre: string, args: any): Promise<any> {
  const { asistenteTools } = await import("./asistente");
  try {
    switch (nombre) {
      case "ventasPeriodo": return await asistenteTools.ventasPeriodo(args.periodo, args.sucursal);
      case "comprasProveedor": return await asistenteTools.comprasProveedor(args.proveedor, args.periodo);
      case "productoMasVendido": return await asistenteTools.productoMasVendido(args.periodo, args.porValor);
      case "gananciaPeriodo": return await asistenteTools.gananciaPeriodo(args.periodo);
      case "infoProducto": return await asistenteTools.infoProducto(args.nombre);
      case "ventasCliente": return await asistenteTools.ventasCliente(args.cliente, args.periodo);
      case "trabajadoresSucursal": return await asistenteTools.trabajadoresSucursal(args.sucursal);
      case "mejoresVendedores": return await asistenteTools.mejoresVendedores(args.periodo, args.sucursal);
      case "listarSucursales": return await asistenteTools.listarSucursales();
      case "stockProducto": return await asistenteTools.stockProducto(args.nombre, args.almacen);
      default: return { error: "Herramienta desconocida" };
    }
  } catch (e: any) {
    return { error: e?.message || "Error ejecutando la consulta" };
  }
}

const asistenteRouter = router({
  // Diagnóstico temporal: verifica si la clave de DeepSeek está bien configurada
  diagConfig: protectedProcedure.query(async () => {
    const raw = process.env.DEEPSEEK_API_KEY;
    // Listar nombres de variables que contengan "DEEP" o "SEEK" (por si hay typo)
    const similares = Object.keys(process.env).filter(k => /deep|seek/i.test(k));
    return {
      existe: !!raw,
      longitud: raw ? raw.length : 0,
      empiezaConSk: raw ? raw.startsWith("sk-") : false,
      tieneEspacios: raw ? (raw !== raw.trim()) : false,
      primeros4: raw ? raw.substring(0, 4) : "",
      variablesSimilares: similares,
    };
  }),

  preguntar: protectedProcedure
    .input(z.object({
      pregunta: z.string(),
      historial: z.array(z.object({
        rol: z.enum(["user", "assistant"]),
        texto: z.string(),
      })).optional(),
    }))
    .mutation(async ({ input }) => {
      const { invokeDeepSeek, deepseekDisponible } = await import("./_core/deepseek");

      // Si DeepSeek no está configurado, avisar claramente
      if (!deepseekDisponible()) {
        return { respuesta: "El asistente aún no está configurado (falta la clave de DeepSeek). Avisa al administrador para activarlo.", error: true };
      }

      // PREFIJO ESTABLE (para caché de contexto de DeepSeek): system + tools
      // SIEMPRE idénticos y al inicio. El contenido variable (pregunta) va al final.
      const systemPrompt = `Asistente de VidaFarma (farmacia, Cochabamba, Bolivia). Responde en español, breve y profesional. NUNCA inventes datos: si no tienes una herramienta o no hay datos, di "No tengo esa información disponible". Solo lectura. Montos en Bs.`;

      const tools = [
        { type: "function" as const, function: { name: "ventasPeriodo", description: "Ventas en un período (hoy/ayer/semana/mes/YYYY-MM), opcional por sucursal.", parameters: { type: "object", properties: { periodo: { type: "string" }, sucursal: { type: "string" } }, required: ["periodo"] } } },
        { type: "function" as const, function: { name: "comprasProveedor", description: "Compras a un proveedor en un período.", parameters: { type: "object", properties: { proveedor: { type: "string" }, periodo: { type: "string" } }, required: ["proveedor", "periodo"] } } },
        { type: "function" as const, function: { name: "productoMasVendido", description: "Productos más vendidos en un período.", parameters: { type: "object", properties: { periodo: { type: "string" }, porValor: { type: "boolean" } }, required: ["periodo"] } } },
        { type: "function" as const, function: { name: "gananciaPeriodo", description: "Ganancia en un período.", parameters: { type: "object", properties: { periodo: { type: "string" } }, required: ["periodo"] } } },
        { type: "function" as const, function: { name: "infoProducto", description: "Precio/costo de un producto por su nombre.", parameters: { type: "object", properties: { nombre: { type: "string" } }, required: ["nombre"] } } },
        { type: "function" as const, function: { name: "ventasCliente", description: "Productos vendidos a un cliente.", parameters: { type: "object", properties: { cliente: { type: "string" }, periodo: { type: "string" } }, required: ["cliente"] } } },
        { type: "function" as const, function: { name: "trabajadoresSucursal", description: "Trabajadores de una sucursal.", parameters: { type: "object", properties: { sucursal: { type: "string" } }, required: ["sucursal"] } } },
        { type: "function" as const, function: { name: "mejoresVendedores", description: "Mejores vendedores en un período.", parameters: { type: "object", properties: { periodo: { type: "string" }, sucursal: { type: "string" } }, required: ["periodo"] } } },
        { type: "function" as const, function: { name: "listarSucursales", description: "Lista las sucursales.", parameters: { type: "object", properties: {} } } },
        { type: "function" as const, function: { name: "stockProducto", description: "Stock/existencias actuales de un producto en tiempo real, por almacén. Si se da un almacén (petrolera, lanza, cobol, principal/matriz) muestra solo ese; si no, muestra todos.", parameters: { type: "object", properties: { nombre: { type: "string" }, almacen: { type: "string" } }, required: ["nombre"] } } },
      ];

      const mensajes: any[] = [
        { role: "system", content: systemPrompt },
        ...(input.historial || []).map(h => ({ role: h.rol, content: h.texto })),
        { role: "user", content: `[Fecha actual: ${new Date().toLocaleDateString("es-BO", { day: "numeric", month: "long", year: "numeric" })}] ${input.pregunta}` },
      ];

      try {
        // Primera llamada: el modelo decide si usar una herramienta
        const r1 = await invokeDeepSeek({ messages: mensajes, tools, toolChoice: "auto", maxTokens: 1024 });
        const msg = r1.choices?.[0]?.message;
        const toolCalls = msg?.tool_calls;

        // Log de caché (para ver el ahorro en los logs de Railway)
        if (r1.usage) {
          const hit = r1.usage.prompt_cache_hit_tokens ?? 0;
          const miss = r1.usage.prompt_cache_miss_tokens ?? 0;
          console.log(`[Asistente] tokens: cache_hit=${hit}, cache_miss=${miss}, salida=${r1.usage.completion_tokens}`);
        }

        if (!toolCalls || toolCalls.length === 0) {
          const textoRaw = msg?.content || "";
          // Red de seguridad: a veces el modelo escribe la llamada como texto
          // (patrones tipo DSML/tool_calls o <function...>). Detectar y ejecutar.
          const mFn = textoRaw.match(/(?:invoke\s+name=|function[=(\s])["']?(\w+)["']?/i);
          if (mFn) {
            const fnNombre = mFn[1];
            // Extraer parámetros tipo name="x" string="y" o JSON
            const args: any = {};
            const paramRe = /name=["'](\w+)["'][^>]*?>([^<]+)</gi;
            let pm;
            while ((pm = paramRe.exec(textoRaw)) !== null) { args[pm[1]] = pm[2].trim(); }
            const jsonM = textoRaw.match(/\{[^}]*\}/);
            if (jsonM) { try { Object.assign(args, JSON.parse(jsonM[0])); } catch {} }
            const resultado = await ejecutarHerramienta(fnNombre, args);
            const r3 = await invokeDeepSeek({ maxTokens: 1024, messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: input.pregunta },
              { role: "assistant", content: `Consulté ${fnNombre}: ${JSON.stringify(resultado)}` },
              { role: "user", content: "Redacta la respuesta final breve en español con esos datos. No escribas funciones." },
            ]});
            return { respuesta: r3.choices?.[0]?.message?.content || "No pude redactar la respuesta.", usoHerramienta: fnNombre };
          }
          return { respuesta: textoRaw || "No pude generar una respuesta.", usoHerramienta: null };
        }

        // Ejecutar las herramientas que pidió
        mensajes.push({ role: "assistant", content: msg?.content || "", tool_calls: toolCalls });
        const herramientasUsadas: string[] = [];
        for (const tc of toolCalls) {
          const nombre = tc.function?.name;
          let args: any = {};
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
          herramientasUsadas.push(nombre);
          const resultado = await ejecutarHerramienta(nombre, args);
          mensajes.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(resultado) });
        }

        // Segunda llamada: el modelo redacta la respuesta final con los datos
        const r2 = await invokeDeepSeek({ messages: mensajes, maxTokens: 1024 });
        const respuesta = r2.choices?.[0]?.message?.content || "Obtuve los datos pero no pude redactar la respuesta.";
        return { respuesta, usoHerramienta: herramientasUsadas.join(", ") };
      } catch (e: any) {
        const msg = String(e?.message || "");
        console.error("[Asistente] Error:", msg);
        if (msg.includes("429") || msg.includes("rate")) {
          return { respuesta: "El servicio está ocupado en este momento. Intenta de nuevo en unos segundos.", error: true };
        }
        if (msg.includes("401") || msg.includes("Authentication") || msg.includes("api key")) {
          return { respuesta: "Hay un problema con la configuración del asistente (autenticación). Avisa al administrador.", error: true };
        }
        if (msg.includes("402") || msg.includes("Insufficient Balance")) {
          return { respuesta: "El asistente no tiene saldo disponible en DeepSeek. Hay que recargar el saldo en platform.deepseek.com para que funcione.", error: true };
        }
        return { respuesta: "Lo siento, hubo un problema al procesar tu pregunta. Intenta de nuevo en un momento.", error: true };
      }
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
  consulta: consultaRouter,
  asistente: asistenteRouter,
  ventas: ventasRouter,
  gastos: gastosRouter,
});

export type AppRouter = typeof appRouter;
