import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, adminProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { invokeLLM } from "./_core/llm";
import { FILTRO_NO_ANULADA, FILTRO_DETALLE_NO_ANULADA } from "./ventas-comun";
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
  // Leer la FECHA DE VENCIMIENTO de una foto (caja/blíster del producto).
  // Útil cuando la factura no imprime el vencimiento pero la caja física sí.
  // Usa el mismo LLM de visión (gratis por ahora). Devuelve YYYY-MM-DD o null.
  leerVencimiento: protectedProcedure
    .input(z.object({ fileBase64: z.string(), mimeType: z.string() }))
    .mutation(async ({ input }) => {
      const dataUrl = `data:${input.mimeType};base64,${input.fileBase64}`;
      const llmResult = await invokeLLM({
        messages: [
          {
            role: "system",
            content: "Eres experto en leer fechas de vencimiento impresas en cajas y blísteres de medicamentos. Las fechas suelen aparecer como VENC, EXP, V., CAD seguidas de mes/año (MM/AAAA, MM-AAAA) o día/mes/año. Responde SOLO JSON.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: 'Lee la fecha de vencimiento de esta imagen. Responde en JSON: {"fecha":"YYYY-MM-DD"} usando el último día del mes si solo hay mes/año (ej: 08/2027 → 2027-08-31). Si no hay fecha visible, {"fecha":null}.' },
              { type: "image_url", image_url: { url: dataUrl } },
            ] as any,
          },
        ],
        response_format: { type: "json_object" },
      });
      try {
        const c = llmResult.choices[0]?.message?.content;
        const parsed = typeof c === "string" ? JSON.parse(c.replace(/```json|```/g, "").trim()) : {};
        const fecha = parsed?.fecha;
        if (typeof fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
          return { fecha };
        }
        return { fecha: null };
      } catch {
        return { fecha: null };
      }
    }),
  list: protectedProcedure.query(async ({ ctx }) => {
    return db.listPurchases(ctx.user.id);
  }),

  // AUDITORÍA DE PRECIOS: revisa TODOS los precios de venta editados en el
  // historial de compras y compara cada uno contra el precio REAL de 365. Sin
  // buscar a mano: dice exactamente cuáles no quedaron aplicados.
  // Clave: si un producto se compró varias veces, solo vale el precio MÁS
  // RECIENTE (un precio viejo pisado por una compra nueva no es un error).
  auditarPrecios: protectedProcedure
    .input(z.object({ desde: z.string().max(10).optional() }).optional())
    .query(async ({ input, ctx }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const dbx = await getDb();
      if (!dbx) return { error: "Sin BD" };
      const filas = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };

      // 1. Todos los ítems con precio de venta editado (de compras sincronizadas)
      let cond = sql`p.userId = ${ctx.user.id} AND i.precioVenta IS NOT NULL AND i.precioVenta > 0 AND p.status = 'completed'`;
      if (input?.desde) cond = sql`${cond} AND DATE(p.createdAt) >= ${input.desde}`;
      const items = filas(await dbx.execute(sql`
        SELECT i.id AS itemId, i.purchaseId, i.productName, i.precioVenta,
               DATE(p.createdAt) AS fecha, p.supplier, p.receiptNumber
        FROM purchase_items i INNER JOIN purchases p ON p.id = i.purchaseId
        WHERE ${cond}
        ORDER BY p.createdAt DESC LIMIT 3000
      `));
      if (items.length === 0) return { total: 0, correctos: 0, incorrectos: [], noEncontrados: [], sinVerificar: 0 };

      // 2. Quedarse con el ÚLTIMO precio editado por producto (lógica pura testeada)
      const { ultimoPrecioPorProducto } = await import("./domain/compras");
      const datosPorClave = new Map<string, any>();
      const paraFiltrar = items.map((it: any) => {
        const clave = String(it.productName).trim().toLowerCase();
        if (!datosPorClave.has(clave)) datosPorClave.set(clave, it);
        return {
          productName: String(it.productName), precioVenta: Number(it.precioVenta),
          fecha: String(it.fecha).slice(0, 10), purchaseId: Number(it.purchaseId), itemId: Number(it.itemId),
        };
      });
      const ultimos = ultimoPrecioPorProducto(paraFiltrar);

      // 3. Leer el catálogo REAL de 365 UNA sola vez (no una llamada por producto)
      const { inventarios365 } = await import("./inventarios365");
      const catalogo = await inventarios365.listarTodosArticulos();
      if (catalogo.length === 0) {
        return { error: "No se pudo leer el catálogo de inventarios365 para comparar. Intenta de nuevo en un momento." };
      }

      // 4. Emparejar por nombre y comparar precios.
      // RENDIMIENTO (v2.28.1): antes se comparaba CADA producto contra TODO el
      // catálogo con el motor difuso — con ~200 productos y ~5.000 artículos son
      // 1.000.000 de comparaciones caras (normalizar + bigramas en cada una) y la
      // auditoría se colgaba 20+ min. Ahora: índice normalizado → búsqueda O(1)
      // para la enorme mayoría, y difuso SOLO para los pocos que no calcen, con
      // tope estricto para no volver a colgarse.
      const { mejoresCandidatos, normalizar } = await import("./domain/emparejar");
      const indice = new Map<string, any>();
      for (const a of catalogo) {
        const clave = normalizar(String(a.nombre || ""));
        if (clave && !indice.has(clave)) indice.set(clave, a);
      }
      const incorrectos: any[] = [];
      const noEncontrados: any[] = [];
      let correctos = 0;

      const sinCalce: typeof ultimos = [];
      const evaluar = (u: any, art: any, nombreEn365: string) => {
        const precio365 = parseFloat(String(art?.precio_uno || 0)) || 0;
        if (Math.abs(precio365 - u.precioVenta) <= 0.01) { correctos++; return; }
        const info = datosPorClave.get(u.productName.trim().toLowerCase()) || {};
        incorrectos.push({
          producto: u.productName,
          nombreEn365,
          articuloId: Number(art?.id) || null, // permite corregir sin volver a buscar
          precioEsperado: u.precioVenta,
          precioEn365: precio365,
          fecha: u.fecha,
          purchaseId: u.purchaseId,
          proveedor: info.supplier || null,
          factura: info.receiptNumber || null,
        });
      };

      for (const u of ultimos) {
        const art = indice.get(normalizar(u.productName));
        if (art) evaluar(u, art, String(art.nombre));
        else sinCalce.push(u);
      }

      // Difuso solo para los que no calzaron exacto, y acotado: si son demasiados,
      // no arriesgamos otro cuelgue — se listan para revisar a mano.
      const TOPE_DIFUSO = 60;
      const nombres365 = sinCalce.length > 0 ? catalogo.map((a: any) => String(a.nombre || "")) : [];
      const porNombre365 = new Map(catalogo.map((a: any) => [String(a.nombre || ""), a]));
      for (const u of sinCalce.slice(0, TOPE_DIFUSO)) {
        const cands = mejoresCandidatos(u.productName, nombres365, 1);
        const mejor = cands[0];
        if (!mejor || mejor.confianza === "baja") { noEncontrados.push({ producto: u.productName, precioEsperado: u.precioVenta }); continue; }
        evaluar(u, porNombre365.get(mejor.nombre), mejor.nombre);
      }
      for (const u of sinCalce.slice(TOPE_DIFUSO)) {
        noEncontrados.push({ producto: u.productName, precioEsperado: u.precioVenta });
      }
      incorrectos.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
      // Rango real revisado: desde la compra más antigua con precio editado hasta
      // la más reciente — para saber exactamente qué período cubre la auditoría.
      const fechas = items.map((it: any) => String(it.fecha).slice(0, 10)).filter(Boolean).sort();
      return {
        total: ultimos.length,
        correctos,
        incorrectos,
        noEncontrados,
        sinVerificar: 0,
        desde: fechas[0] || null,
        hasta: fechas[fechas.length - 1] || null,
        comprasRevisadas: new Set(items.map((it: any) => Number(it.purchaseId))).size,
      };
    }),

  // CORREGIR EN LOTE los precios que la auditoría encontró mal. Solo toca precios
  // (no crea ingresos), verifica releyendo y reintenta — mismo motor que las
  // compras.
  corregirPreciosAuditados: protectedProcedure
    .input(z.object({ productos: z.array(z.object({ nombreEn365: z.string(), precioEsperado: z.number(), articuloId: z.number().nullable().optional() })).min(1).max(300) }))
    .mutation(async ({ input }) => {
      const { inventarios365 } = await import("./inventarios365");
      // Con el id de 365 (que la auditoría ya trae) se corrige DIRECTO, sin una
      // búsqueda de red por producto — eso hacía eterna la corrección en lote.
      const conId = input.productos.filter((p) => p.articuloId && p.articuloId > 0);
      const sinId = input.productos.filter((p) => !p.articuloId || p.articuloId <= 0);
      const aplicados: string[] = [], fallidos: string[] = [], noEncontrados: string[] = [];

      if (conId.length > 0) {
        const r = await inventarios365.aplicarPreciosPorId(
          conId.map((p) => ({ id: p.articuloId!, precio: p.precioEsperado, nombre: p.nombreEn365 }))
        );
        aplicados.push(...r.aplicados); fallidos.push(...r.fallidos);
      }
      if (sinId.length > 0) {
        const r = await inventarios365.aplicarPreciosVenta(sinId.map((p) => ({ nombre: p.nombreEn365, precioVenta: p.precioEsperado })));
        aplicados.push(...r.aplicados); fallidos.push(...r.fallidos); noEncontrados.push(...r.noEncontrados);
      }
      const partes: string[] = [];
      if (aplicados.length > 0) partes.push(`✅ ${aplicados.length} corregido(s)`);
      if (fallidos.length > 0) partes.push(`❌ ${fallidos.length} no se pudo: ${fallidos.slice(0, 8).join(", ")}${fallidos.length > 8 ? "…" : ""}`);
      if (noEncontrados.length > 0) partes.push(`⚠ ${noEncontrados.length} no encontrado(s) en 365`);
      return { ok: fallidos.length === 0, mensaje: partes.join(" · ") || "Sin cambios.", aplicados, fallidos, noEncontrados };
    }),

  // APRENDIZAJE DE DESCUENTOS: analiza los descuentos de la factura recién leída
  // contra lo que ese proveedor SUELE dar en cada producto, y avisa si viene con
  // menos de lo habitual (plata que se perdería sin que nadie lo note).
  analizarDescuentos: protectedProcedure
    .input(z.object({
      proveedor: z.string().max(255),
      items: z.array(z.object({ nombre: z.string(), pctDescuento: z.number() })).max(200),
    }))
    .mutation(async ({ input }) => {
      const { descuentosProveedor } = await import("./descuentos-proveedor");
      return descuentosProveedor.analizar(input.proveedor, input.items);
    }),

  // Descuentos típicos aprendidos de un proveedor (para consultarlos)
  descuentosDe: protectedProcedure
    .input(z.object({ proveedor: z.string().max(255) }))
    .query(async ({ input }) => {
      const { descuentosProveedor } = await import("./descuentos-proveedor");
      return descuentosProveedor.resumen(input.proveedor);
    }),

  // BUSCAR compras por proveedor, número de factura o NOMBRE DE PRODUCTO. Lo
  // último es la clave: permite encontrar en qué facturas entró un producto para
  // revisar/corregir su precio. Devuelve además los ítems que coinciden, con el
  // precio de venta que se editó, para verlo sin abrir la compra.
  buscar: protectedProcedure
    .input(z.object({ q: z.string().max(120), soloConPreciosFallidos: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const dbx = await getDb();
      if (!dbx) return [];
      const q = input.q.trim();
      const filas = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
      const like = `%${q.replace(/\s+/g, "%")}%`;

      let cond = sql`p.userId = ${ctx.user.id}`;
      if (q) {
        cond = sql`${cond} AND (
          p.supplier LIKE ${like}
          OR p.receiptNumber LIKE ${like}
          OR EXISTS (SELECT 1 FROM purchase_items i WHERE i.purchaseId = p.id AND (i.productName LIKE ${like} OR i.nombreFactura LIKE ${like}))
        )`;
      }
      if (input.soloConPreciosFallidos) cond = sql`${cond} AND p.preciosFallidos IS NOT NULL`;

      const compras = filas(await dbx.execute(sql`
        SELECT p.id, p.receiptNumber, p.supplier, p.status, p.totalAmount, p.createdAt,
               p.syncError, p.syncIngresoId, p.preciosFallidos, b.name AS branchName
        FROM purchases p LEFT JOIN branches b ON b.id = p.branchId
        WHERE ${cond}
        ORDER BY p.createdAt DESC LIMIT 40
      `));
      if (compras.length === 0) return [];

      // Traer los ítems que coinciden con la búsqueda (para ver el precio editado)
      const ids = compras.map((c: any) => Number(c.id));
      let itemsPorCompra = new Map<number, any[]>();
      if (q) {
        const items = filas(await dbx.execute(sql`
          SELECT purchaseId, productName, quantity, unitCost, precioVenta
          FROM purchase_items
          WHERE purchaseId IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
            AND (productName LIKE ${like} OR nombreFactura LIKE ${like})
          LIMIT 200
        `));
        for (const it of items) {
          const arr = itemsPorCompra.get(Number(it.purchaseId)) || [];
          arr.push({
            productName: it.productName,
            cantidad: Number(it.quantity) || 0,
            costo: Number(it.unitCost) || 0,
            precioVenta: it.precioVenta != null ? Number(it.precioVenta) : null,
          });
          itemsPorCompra.set(Number(it.purchaseId), arr);
        }
      }
      return compras.map((c: any) => ({
        ...c,
        totalAmount: Number(c.totalAmount) || 0,
        itemsCoincidentes: itemsPorCompra.get(Number(c.id)) || [],
      }));
    }),

  // REINTENTAR la sincronización de una compra YA GUARDADA, usando sus datos tal
  // como quedaron (incluidos los precios editados a mano) — sin volver a cargar
  // la factura ni re-editar nada. Resuelve: "falló la sincronización y tuve que
  // rehacer todos los precios".
  // `forzar` permite re-sincronizar una compra que YA se sincronizó (para
  // corregir una carga doble o con precio equivocado). OJO: 365 no permite borrar
  // ingresos por API, así que re-sincronizar CREA UN INGRESO NUEVO — el viejo hay
  // que borrarlo a mano en 365. Por eso devolvemos su ID y avisamos antes.
  reintentarSync: protectedProcedure
    .input(z.object({ id: z.number(), forzar: z.boolean().optional(), almacenNombre: z.string().max(120).optional() }))
    .mutation(async ({ input }) => {
      const compra: any = await db.getPurchaseById(input.id);
      if (!compra) throw new Error("No se encontró la compra.");
      const yaSincronizada = compra.syncIngresoId != null;
      if (yaSincronizada && !input.forzar) {
        return {
          ok: false,
          requiereConfirmacion: true,
          ingresoIdPrevio: compra.syncIngresoId,
          mensaje: `Esta compra YA está sincronizada en 365 (Ingreso #${compra.syncIngresoId}). Volver a sincronizarla CREARÁ OTRO ingreso — 365 no permite borrar ingresos desde la API. Primero borra el Ingreso #${compra.syncIngresoId} en inventarios365, y recién entonces confirma el reintento.`,
        };
      }

      const items = (compra.items || []).map((it: any) => ({
        nombre: it.productName || it.nombre || "Producto sin nombre",
        cantidad: Number(it.quantity) || 0,
        precio: Number(it.unitCost) || 0, // costo EDITADO A MANO, ya guardado
        fechaVencimiento: it.expiryDate || null,
        // CLAVE: el precio de VENTA editado se guarda en la columna precioVenta.
        // El reintento anterior NO lo enviaba → por eso "el que se subió no tenía
        // el precio editado". Ahora se recupera tal cual quedó guardado.
        nuevoPrecioVenta: (() => { const v = Number(it.precioVenta ?? it.nuevoPrecioVenta); return isNaN(v) || v <= 0 ? null : v; })(),
      }));
      if (items.length === 0) throw new Error("La compra no tiene productos guardados.");

      const { inventarios365 } = await import("./inventarios365");
      let r: any;
      try {
        r = await inventarios365.registrarCompra({
          proveedor: compra.supplier || "",
          tipoComprobante: compra.receiptType || "BOLETA",
          numComprobante: compra.receiptNumber || String(compra.id),
          almacenNombre: input.almacenNombre || "principal",
          items,
          total: Number(compra.totalAmount) || 0,
        });
      } catch (e: any) {
        const msg = e?.message || "Error desconocido";
        await db.updatePurchaseSyncError(input.id, msg);
        return { ok: false, mensaje: `No se pudo sincronizar: ${msg}. Tus datos y precios editados siguen guardados — puedes reintentar.` };
      }

      if (r?.success) {
        await db.updatePurchaseSyncStatus(input.id, "completed", undefined, r.ingresoId, r.preciosVentaFallidos || []);
        try {
          const { registrarPreciosCompra } = await import("./inteligencia-compras");
          await registrarPreciosCompra((compra.items as any[]) || [], compra.supplier || "");
        } catch { /* no bloquea */ }
        let msg = `Sincronizada en 365 (Ingreso #${r.ingresoId}).`;
        if (yaSincronizada) msg += ` ⚠ El ingreso anterior #${compra.syncIngresoId} sigue en 365 — bórralo ahí si no lo hiciste, o quedará duplicado.`;
        if (r.productosNoEncontrados?.length > 0) msg += ` Productos no encontrados: ${r.productosNoEncontrados.map((p: any) => p.nombre).join(", ")}.`;
        // Precios que 365 NO aplicó: se avisan explícitamente (antes solo iban al
        // log del servidor, así que parecía que se habían cambiado todos).
        if (r.preciosVentaFallidos?.length > 0) {
          msg += ` ⚠ El precio de venta NO se aplicó en ${r.preciosVentaFallidos.length} producto(s): ${r.preciosVentaFallidos.join(", ")}. Revísalos en 365 y vuelve a intentar.`;
        }
        return { ok: true, ingresoId: r.ingresoId, mensaje: msg, preciosVentaFallidos: r.preciosVentaFallidos || [] };
      }
      await db.updatePurchaseSyncError(input.id, r?.message || "Error");
      return { ok: false, mensaje: `No se pudo sincronizar: ${r?.message || "error"}. Tus datos y precios editados siguen guardados — puedes reintentar.` };
    }),

  // APLICAR SOLO LOS PRECIOS DE VENTA de una compra ya sincronizada, SIN crear
  // otro ingreso. Es la herramienta correcta cuando 365 aplicó unos precios sí y
  // otros no: re-sincronizar la compra entera duplicaría el ingreso (365 no
  // permite borrarlos por API); esto solo corrige los precios. Verifica releyendo.
  aplicarPreciosVenta: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const compra: any = await db.getPurchaseById(input.id);
      if (!compra) throw new Error("No se encontró la compra.");
      const items = (compra.items || [])
        .map((it: any) => ({
          nombre: it.productName || it.nombre || "",
          precioVenta: (() => { const v = Number(it.precioVenta); return isNaN(v) || v <= 0 ? 0 : v; })(),
        }))
        .filter((i: any) => i.nombre && i.precioVenta > 0);
      if (items.length === 0) {
        return { ok: false, mensaje: "Esta compra no tiene precios de venta editados guardados — no hay nada que aplicar." };
      }
      const { inventarios365 } = await import("./inventarios365");
      const r = await inventarios365.aplicarPreciosVenta(items, compra.supplier || "");
      // Dejar registrado el resultado: si ya no falla ninguno, el aviso de
      // reparación desaparece solo de la lista de compras.
      try {
        const { getDb } = await import("./db");
        const { sql } = await import("drizzle-orm");
        const dbx = await getDb();
        if (dbx) {
          const val = r.fallidos.length > 0 ? r.fallidos.join(", ") : null;
          await dbx.execute(sql`UPDATE purchases SET preciosFallidos = ${val} WHERE id = ${input.id}`);
        }
      } catch { /* no bloquea */ }
      const partes: string[] = [];
      if (r.aplicados.length > 0) partes.push(`✅ ${r.aplicados.length} precio(s) ya correcto(s) en 365`);
      if (r.fallidos.length > 0) partes.push(`❌ ${r.fallidos.length} NO se aplicaron: ${r.fallidos.join(", ")}`);
      if (r.noEncontrados.length > 0) partes.push(`⚠ ${r.noEncontrados.length} no encontrado(s) en 365: ${r.noEncontrados.join(", ")}`);
      return {
        ok: r.fallidos.length === 0 && r.noEncontrados.length === 0,
        mensaje: partes.join(" · ") || "Sin cambios.",
        aplicados: r.aplicados.length, fallidos: r.fallidos, noEncontrados: r.noEncontrados,
      };
    }),

  // INTELIGENCIA DE PRECIOS: compara cada precio de la factura contra la
  // referencia (última compra propia > costo del sistema) y el margen de venta.
  compararPrecios: protectedProcedure
    .input(z.object({ items: z.array(z.object({ productName: z.string(), unitCost: z.number() })).min(1).max(200) }))
    .mutation(async ({ input }) => {
      const { compararPreciosCompra } = await import("./inteligencia-compras");
      return compararPreciosCompra(input.items);
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

      // RAMA XML: si es una factura electrónica del SIN (XML), se parsea DIRECTO
      // con datos exactos (precios y descuentos oficiales), sin LLM. Cero errores
      // de OCR. Devuelve el mismo formato que la extracción por foto.
      const isXml = input.mimeType.includes("xml") || input.fileName.toLowerCase().endsWith(".xml");
      if (isXml) {
        try {
          const contenidoXml = buffer.toString("utf-8");
          const { esFacturaXml, parsearFacturaXml } = await import("./factura-xml");
          if (esFacturaXml(contenidoXml, input.fileName)) {
            const f = parsearFacturaXml(contenidoXml);
            if (f.items.length === 0) {
              throw new Error("El XML no contiene productos (detalle vacío).");
            }
            console.log(`[FacturaXML] ${f.items.length} productos, proveedor ${f.razonSocialEmisor}, factura ${f.numeroFactura}`);
            return {
              imageUrl,
              imageKey,
              fuente: "xml" as const,
              supplier: f.razonSocialEmisor || "",
              nitEmisor: f.nitEmisor || "",
              receiptNumber: f.numeroFactura || "",
              cuf: f.cuf || "",
              fechaEmision: f.fechaEmision || "",
              totalFactura: f.montoTotal,
              descuentoTotal: f.descuentoTotalLineas + f.descuentoAdicional,
              items: f.items.map((it) => ({
                productName: it.productName,
                productNameFactura: it.productName,
                quantity: it.quantity,
                unitCost: it.unitCost,
                subtotal: it.subtotal,
                descuento: it.descuento,
                expiryDate: it.expiryDate,
                codigoProducto: it.codigoProducto,
              })),
            };
          }
        } catch (e: any) {
          throw new Error(`No se pudo leer el XML de la factura: ${e?.message || "formato no reconocido"}. Verifica que sea el XML de factura electrónica del SIN.`);
        }
      }

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
      let ultimoError = "";
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
          const finishReason = resultToUse.choices[0]?.finish_reason;
          console.log(`[LLM] Respuesta raw (intento ${intento + 1}, finish=${finishReason}):`, String(rawContent || "").substring(0, 200));
          // Respuesta cortada por límite de tokens: el JSON llega incompleto,
          // la factura es muy grande y reintentar no ayuda. Revisar ANTES de parsear.
          if (finishReason === "length") {
            throw new Error("FACTURA_MUY_GRANDE");
          }
          if (typeof rawContent === "string" && rawContent.trim()) {
            const clean = rawContent.replace(/```json|```/g, "").trim();
            extracted = JSON.parse(clean);
            extraccionExitosa = true;
            break;
          }
          ultimoError = `respuesta vacía del modelo (finish_reason=${finishReason})`;
        } catch (e: any) {
          const msg = String(e?.message || e);
          if (msg === "FACTURA_MUY_GRANDE") {
            throw new Error("La factura tiene demasiados productos para procesarla de una vez. Divídela en dos fotos (mitad superior y mitad inferior) y súbelas como dos compras, o recorta la foto.");
          }
          // Límite por minuto de Groq: reintentar en segundos no sirve.
          if (msg.includes("tokens per minute") || msg.includes("413")) {
            throw new Error("Se alcanzó el límite por minuto del plan gratuito de Groq. Espera 1 minuto y vuelve a intentar.");
          }
          ultimoError = msg.substring(0, 400);
          console.error(`[LLM] Error intento ${intento + 1}:`, ultimoError);
        }
      }

      if (!extraccionExitosa) {
        throw new Error(`No se pudo extraer la factura. Detalle técnico: ${ultimoError || "sin detalle"}`);
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
        descuentoGlobalPct: extracted.descuentoGlobalPct || (sumaSubtotales > 0 && descuentoGlobal > 0 ? Math.round((descuentoGlobal / sumaSubtotales) * 1000) / 10 : 0),
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
            precioVenta: z.number().nullable().optional(),
            // % de descuento comercial de la línea (para aprender el patrón del proveedor)
            pctDescuento: z.number().nullable().optional(),
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
      const itemsLimpios = (input.items || []).map((it: any) => ({
        productName: (it.productName && String(it.productName).trim()) || "Producto sin nombre",
        nombreFactura: it.nombreFactura ?? null,
        // % de descuento comercial de la línea: alimenta el aprendizaje por proveedor
        pctDescuento: (() => { const v = Number(it.pctDescuento); return isNaN(v) || v < 0 ? 0 : v; })(),
        quantity: Number(it.quantity) || 0,
        unitCost: Number(it.unitCost) || 0,
        subtotal: Number(it.subtotal) || (Number(it.quantity) || 0) * (Number(it.unitCost) || 0),
        expiryDate: it.expiryDate ?? null,
        nuevoPrecioVenta: it.nuevoPrecioVenta ?? null,
        precioVenta: (() => { const v = Number(it.precioVenta ?? it.nuevoPrecioVenta); return isNaN(v) || v <= 0 ? null : v; })(),
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
            await db.updatePurchaseSyncStatus(purchaseId, "completed", undefined, syncResult.ingresoId, syncResult.preciosVentaFallidos || []);
            // Alimentar la referencia de precios propia (inteligencia de compras)
            try {
              const { registrarPreciosCompra } = await import("./inteligencia-compras");
              await registrarPreciosCompra(itemsLimpios as any[], input.supplier || "");
            } catch { /* no bloquea */ }
            // APRENDER los descuentos de este proveedor: con cada compra el sistema
            // afina qué descuento suele dar en cada producto, para avisar cuando
            // una factura venga con menos de lo habitual.
            try {
              const { descuentosProveedor } = await import("./descuentos-proveedor");
              await descuentosProveedor.registrar(
                input.supplier || "",
                (itemsLimpios as any[]).map((it: any) => ({ nombre: it.productName || "", pctDescuento: Number(it.pctDescuento) || 0 })),
                purchaseId
              );
            } catch { /* no bloquea */ }
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
        preciosVentaFallidos: syncResultData?.preciosVentaFallidos || [],
      };
    }),

  confirm: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      // 1. Confirmar la compra en BD inmediatamente
      const purchase = await db.getPurchaseById(input.id);
      const result = await db.confirmPurchase(input.id, ctx.user.id);
      // Alimentar la referencia de precios propia (inteligencia de compras)
      try {
        const { registrarPreciosCompra } = await import("./inteligencia-compras");
        await registrarPreciosCompra((purchase?.items as any[]) || [], (purchase as any)?.supplier || "");
      } catch { /* no bloquea */ }

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
            // El precio de VENTA editado a mano queda guardado en la columna
            // precioVenta. Antes NO se enviaba aquí, así que al reintentar la
            // sincronización el producto llegaba a 365 SIN el precio editado.
            nuevoPrecioVenta: (() => { const v = Number(item.precioVenta); return isNaN(v) || v <= 0 ? null : v; })(),
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
            await db.updatePurchaseSyncStatus(purchaseId, "completed", undefined, syncResult.ingresoId, syncResult.preciosVentaFallidos || []);
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
      try {
        const filtroSup = input.supplier ? sql`AND supplier = ${input.supplier}` : sql``;
        const r: any = await dbc.execute(sql`
          SELECT id, supplier, createdAt FROM purchases
           WHERE receiptNumber = ${input.receiptNumber} AND status = 'completed' ${filtroSup}
           ORDER BY createdAt DESC LIMIT 1
        `);
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

  // DICTADO POR VOZ de la lista de transferencia: audio → Whisper (español) →
  // el modelo separa productos y cantidades → mismos {productName, quantity} que
  // la foto, para reutilizar tal cual el flujo de emparejar/confirmar ya probado.
  // No usa audio conversacional (caro e innecesario): dictar no es conversar.
  dictarLista: protectedProcedure
    .input(z.object({ audioBase64: z.string().max(20_000_000), mimeType: z.string() }))
    .mutation(async ({ input }) => {
      const { transcribirAudio } = await import("./_core/llm");
      const buffer = Buffer.from(input.audioBase64, "base64");
      let texto = "";
      try {
        texto = await transcribirAudio(buffer, input.mimeType, "dictado.webm");
      } catch (e: any) {
        return { error: "No se pudo transcribir el audio. Intenta de nuevo, hablando cerca del micrófono." };
      }
      if (!texto || texto.trim().length < 3) return { error: "No se escuchó nada. Acerca el micrófono y vuelve a dictar." };

      const llmResult = await invokeLLM({
        messages: [
          { role: "system", content: "Extraes listas de productos de farmacia dictadas en voz alta (español boliviano). Respondes SOLO JSON válido." },
          { role: "user", content: `Este texto es una lista de productos DICTADA en voz alta por el personal de una farmacia para una transferencia entre sucursales:

"${texto}"

Extrae cada producto con su cantidad. Reglas:
- Las cantidades suelen decirse ANTES del producto ("cinco paracetamol") pero a veces después ("paracetamol, cinco"). Interpreta con sentido común.
- Los números dictados en palabras van a dígitos: "cinco" → 5, "quince" → 15, "veinticinco" → 25.
- OJO: la concentración/dosis es parte del NOMBRE, no la cantidad. En "tres amoxicilina de quinientos", la cantidad es 3 y el producto es "amoxicilina 500". En "dos ibuprofeno cuatrocientos", cantidad 2, producto "ibuprofeno 400".
- Si de un producto no se dice cantidad, asume 1.
- Ignora muletillas ("eh", "a ver", "también", "y") y frases que no sean productos.
- Escribe el nombre tal como se entendió, sin inventar ni completar marcas.

Devuelve SOLO este JSON:
{"items":[{"productName":"nombre del producto","quantity": numero_entero}]}` },
        ],
        temperature: 0,
      });

      let extracted: any = { items: [] };
      try {
        const content = (llmResult.choices[0]?.message?.content || "").replace(/```json|```/g, "").trim();
        extracted = JSON.parse(content);
      } catch (e) {
        return { error: "No entendí la lista dictada. Intenta decir: 'cinco paracetamol 500, tres amoxicilina 500'.", textoDictado: texto };
      }
      const items = (extracted.items || [])
        .filter((i: any) => i?.productName && String(i.productName).trim())
        .map((i: any) => ({ productName: String(i.productName).trim(), quantity: Math.max(1, Math.round(Number(i.quantity) || 1)) }));
      if (items.length === 0) return { error: "No se reconocieron productos en el dictado.", textoDictado: texto };
      // textoDictado se devuelve SIEMPRE para que se vea qué se entendió (transparencia)
      return { items, textoDictado: texto };
    }),

  // BÚSQUEDA EN VIVO con el STOCK DEL ALMACÉN DE ORIGEN. Es una query (no una
  // mutation) para poder buscar mientras se escribe, sin botón. Devuelve el stock
  // real de cada candidato en el origen: así se ve de entrada si alcanza para
  // transferir, en vez de descubrirlo cuando 365 rechaza la operación.
  buscarConStock: protectedProcedure
    .input(z.object({ q: z.string().max(200), sucursalOrigen: z.string().max(150).optional() }))
    .query(async ({ input }) => {
      const q = input.q.trim();
      if (q.length < 2) return { productos: [] };
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const dbx = await getDb();
      if (!dbx) return { productos: [] };
      // Catálogo local (rápido, no depende de 365 para sugerir nombres)
      const r: any = await dbx.execute(sql.raw(`SELECT nombre, nombreProveedor FROM productos_cache WHERE precioUno >= 0`));
      const f = Array.isArray(r) ? r[0] : r?.rows ?? r;
      const filas: any[] = Array.isArray(f) ? f : [];
      const catalogo: string[] = filas.map((x: any) => String(x.nombre));
      const proveedorPorNombre = new Map(filas.map((x: any) => [String(x.nombre), x.nombreProveedor ? String(x.nombreProveedor) : null]));
      const { mejoresCandidatos } = await import("./domain/emparejar");
      const candidatos = mejoresCandidatos(q, catalogo, 8);
      if (candidatos.length === 0) return { productos: [] };

      // Stock real del ORIGEN (cache 60s: buscar mientras se escribe no debe
      // castigar a 365 con una llamada por tecla).
      let stockPorNombre = new Map<string, { stock: number; id: number }>();
      const { resolverAlmacen } = await import("./asistente-acciones");
      const almacen = input.sucursalOrigen ? resolverAlmacen(input.sucursalOrigen) : null;
      if (almacen) {
        try {
          const { obtenerStockAlmacen } = await import("./stock-cache");
          const { lista } = await obtenerStockAlmacen(almacen.id, { ttlSeg: 60, fallbackCache: true });
          stockPorNombre = new Map(lista.map((p: any) => [String(p.nombre), { stock: Number(p.stock) || 0, id: Number(p.id) }]));
        } catch { /* sin stock: se devuelven igual los nombres */ }
      }
      return {
        productos: candidatos.map((c) => {
          const s = stockPorNombre.get(c.nombre);
          return {
            nombre: c.nombre,
            confianza: c.confianza,
            proveedor: proveedorPorNombre.get(c.nombre) || null,
            stockOrigen: s ? s.stock : null, // null = no se pudo leer el stock
            articuloId: s ? s.id : null,
          };
        }),
      };
    }),

  // STOCK del origen para una lista de productos concreta (los de la
  // transferencia). Permite avisar ANTES de confirmar si alguno no alcanza, en
  // vez de que 365 rechace la operación al final.
  stockDeProductos: protectedProcedure
    .input(z.object({ sucursalOrigen: z.string().max(150), nombres: z.array(z.string().max(500)).max(60) }))
    .query(async ({ input }) => {
      const { resolverAlmacen } = await import("./asistente-acciones");
      const almacen = resolverAlmacen(input.sucursalOrigen);
      if (!almacen || input.nombres.length === 0) return { stock: {} as Record<string, number> };
      try {
        const { obtenerStockAlmacen } = await import("./stock-cache");
        const { lista } = await obtenerStockAlmacen(almacen.id, { ttlSeg: 60, fallbackCache: true });
        const porNombre = new Map(lista.map((p: any) => [String(p.nombre), Number(p.stock) || 0]));
        const stock: Record<string, number> = {};
        for (const n of input.nombres) {
          const v = porNombre.get(n);
          if (v != null) stock[n] = v; // ausente = no se encontró: no se afirma nada
        }
        return { stock, almacen: almacen.nombre };
      } catch {
        return { stock: {} as Record<string, number> };
      }
    }),

  // AJUSTAR EL STOCK DEL ORIGEN cuando no alcanza para la transferencia.
  // Caso real: el stock físico está en el estante, pero el sistema dice menos —
  // sin corregirlo, 365 rechaza la transferencia.
  // IMPORTANTE: se envía el stock REAL que hay en la sucursal, no "lo que hace
  // falta para transferir". Poner solo el mínimo dejaría el origen en 0 tras la
  // transferencia aunque físicamente quedaran unidades: sería meter un dato falso
  // al inventario para salir del paso. Por eso el valor es editable en pantalla y
  // por defecto propone lo necesario.
  ajustarStockOrigen: protectedProcedure
    .input(z.object({
      sucursalOrigen: z.string().max(150),
      productos: z.array(z.object({ nombre: z.string().max(500), stockReal: z.number().min(0), cantidadNecesaria: z.number().min(1) })).min(1).max(60),
    }))
    .mutation(async ({ input, ctx }) => {
      if (ctx?.user?.role !== "admin" && ctx?.user?.role !== "regente") {
        throw new Error("Solo administrador o regente puede ajustar stock.");
      }
      const { resolverAlmacen } = await import("./asistente-acciones");
      const almacen = resolverAlmacen(input.sucursalOrigen);
      if (!almacen) throw new Error(`No reconozco la sucursal de origen "${input.sucursalOrigen}".`);
      const { obtenerStockAlmacen } = await import("./stock-cache");
      // SIEMPRE en vivo: nunca ajustar stock con datos de cache.
      const { lista } = await obtenerStockAlmacen(almacen.id, { ttlSeg: 0, fallbackCache: false });
      const porNombre = new Map(lista.map((p: any) => [String(p.nombre), p]));

      const ajustes: any[] = [];
      const noEncontrados: string[] = [];
      const insuficientes: string[] = [];
      for (const p of input.productos) {
        const art: any = porNombre.get(p.nombre);
        if (!art) { noEncontrados.push(p.nombre); continue; }
        // El stock declarado debe alcanzar para lo que se quiere transferir; si no,
        // el ajuste no resolvería nada y 365 rechazaría igual.
        if (p.stockReal < p.cantidadNecesaria) { insuficientes.push(`${p.nombre} (declaraste ${p.stockReal}, necesitas ${p.cantidadNecesaria})`); continue; }
        const actual = Number(art.stock) || 0;
        if (actual === p.stockReal) continue; // ya está así: nada que hacer
        ajustes.push({
          productoId: art.id, inventarioId: art.inventarioId ?? null,
          stockAnterior: actual, stockReal: p.stockReal, fechaVencimiento: null,
          _nombre: p.nombre,
        });
      }
      if (insuficientes.length > 0) {
        return { ok: false, ajustados: 0, noEncontrados, mensaje: `El stock declarado no alcanza para transferir: ${insuficientes.join(" · ")}. Corrige la cantidad a transferir o declara el stock real.` };
      }
      if (ajustes.length === 0) {
        return { ok: true, ajustados: 0, noEncontrados, mensaje: noEncontrados.length > 0 ? `No encontré en el origen: ${noEncontrados.join(", ")}` : "No hubo cambios que aplicar." };
      }
      const { inventarios365 } = await import("./inventarios365");
      const r = await inventarios365.ajustarInventario({
        almacenId: almacen.id,
        motivoId: 2,
        ajustes: ajustes.map(({ productoId, inventarioId, stockAnterior, stockReal, fechaVencimiento }) => ({ productoId, inventarioId, stockAnterior, stockReal, fechaVencimiento })),
      });
      const detalle = ajustes.map((a) => `${a._nombre}: ${a.stockAnterior} → ${a.stockReal}`).join(" · ");
      return {
        ok: r.ok,
        ajustados: r.ok ? ajustes.length : 0,
        noEncontrados,
        mensaje: r.ok
          ? `Stock del origen ajustado en ${ajustes.length} producto(s): ${detalle}. Ya puedes transferir.`
          : `No se pudo ajustar: ${r.mensaje}`,
      };
    }),

  // Emparejar los nombres extraídos de la lista MANUSCRITA contra el catálogo real.
  // Resuelve el problema de la letra variable de cada trabajadora: la visión
  // transcribe con errores y este endpoint devuelve, por ítem, los candidatos del
  // catálogo con su confianza, para confirmar con un toque.
  emparejar: protectedProcedure
    .input(z.object({
      items: z.array(z.object({ productName: z.string().max(500), quantity: z.number() })).max(60),
    }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const dbx = await getDb();
      if (!dbx) throw new Error("Sin BD");
      const r: any = await dbx.execute(sql.raw(`SELECT nombre FROM productos_cache WHERE precioUno >= 0`));
      const filas = Array.isArray(r) ? r[0] : r?.rows ?? r;
      const catalogo: string[] = (Array.isArray(filas) ? filas : []).map((f: any) => String(f.nombre));
      const { mejoresCandidatos } = await import("./domain/emparejar");
      return {
        items: input.items.map((it) => {
          const candidatos = mejoresCandidatos(it.productName, catalogo, 3);
          return {
            textoLeido: it.productName,
            quantity: it.quantity,
            candidatos, // [{nombre, puntaje, confianza}]
            sugerido: candidatos[0]?.confianza !== "baja" ? candidatos[0]?.nombre ?? null : null,
          };
        }),
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
      if (input.fromBranchId === input.toBranchId) {
        throw new Error("La sucursal origen y destino deben ser diferentes.");
      }
      const itemsLimpios = input.items.filter((i) => i.productName?.trim() && i.quantity > 0);
      if (itemsLimpios.length === 0) {
        throw new Error("Agrega al menos un producto con cantidad mayor a 0.");
      }
      // Se crea SIEMPRE como borrador primero (deja el registro y los items).
      const created = await db.createTransfer({
        userId: ctx.user.id,
        fromBranchId: input.fromBranchId,
        toBranchId: input.toBranchId,
        referenceNumber: input.referenceNumber,
        notes: input.notes,
        items: itemsLimpios,
        imageUrl: input.imageUrl,
        imageKey: input.imageKey,
        status: "draft",
      });
      // Si el usuario pidió confirmar directamente, se ejecuta el movimiento real
      // en 365 vía confirmTransfer (que mueve el stock y actualiza el estado según
      // el resultado). Antes esto se marcaba "completed" sin tocar 365 — el stock
      // nunca se movía. Ahora el resultado de 365 se devuelve al frontend.
      if (input.confirmDirectly) {
        const r = await db.confirmTransfer(created.id, ctx.user.id);
        return { id: created.id, confirmada: true, exito365: r.success, mensaje365: r.message, items: itemsLimpios.length };
      }
      return { id: created.id, confirmada: false, exito365: null, mensaje365: "Guardada como borrador.", items: itemsLimpios.length };
    }),

  confirm: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.confirmTransfer(input.id, ctx.user.id);
      return result;
    }),

  // Detalle completo de una transferencia (cabecera + items + historial) para el
  // modal de la lista/historial.
  detalle: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      return db.getTransferDetalle(input.id);
    }),

  // Revertir una transferencia YA COMPLETADA: registra en 365 el movimiento
  // inverso (destino → origen) por las mismas cantidades. Operación delicada:
  // solo admin, solo si estaba "completed", y deja constancia en el historial.
  revertir: adminProcedure
    .input(z.object({ id: z.number(), motivo: z.string().trim().max(300).optional() }))
    .mutation(async ({ ctx, input }) => {
      return db.revertTransfer(input.id, ctx.user.id, input.motivo);
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
  estadisticas: protectedProcedure.query(async () => {
    const { confirmacionesService } = await import("./confirmaciones");
    return confirmacionesService.estadisticas();
  }),

  // Confirmar emparejamiento: nombre en factura → artículo en sistema
  confirmar: protectedProcedure
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
  invalidar: protectedProcedure
    .input(z.object({ proveedor: z.string(), nombreFactura: z.string() }))
    .mutation(async ({ input }) => {
      const { confirmacionesService } = await import("./confirmaciones");
      await confirmacionesService.invalidar(input.proveedor, input.nombreFactura);
      return { success: true };
    }),

  // Buscar confirmación guardada para un producto específico
  buscarConfirmacion: protectedProcedure
    .input(z.object({ proveedor: z.string(), nombreFactura: z.string() }))
    .query(async ({ input }) => {
      const { confirmacionesService } = await import("./confirmaciones");
      return await confirmacionesService.buscar(input.proveedor, input.nombreFactura);
    }),

  // Buscar artículo en sistema para confirmar manualmente
  buscarArticulo: protectedProcedure
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
  verificar: protectedProcedure.mutation(async () => {
    const { confirmacionesService } = await import("./confirmaciones");
    return confirmacionesService.verificar();
  }),

  // Listar todas las confirmaciones
  todos: protectedProcedure.query(async () => {
    const { confirmacionesService } = await import("./confirmaciones");
    return confirmacionesService.todos();
  }),

  // Listar categorías del sistema
  listarCategorias: protectedProcedure.query(async () => {
    const { inventarios365 } = await import("./inventarios365");
    return inventarios365.listarCategorias();
  }),

  // Buscar proveedores del sistema (para selección/emparejamiento manual)
  listarProveedores: protectedProcedure
    .input(z.object({ filtro: z.string() }))
    .query(async ({ input }) => {
      const { inventarios365 } = await import("./inventarios365");
      return inventarios365.listarProveedores(input.filtro);
    }),

  // Buscar el proveedor del sistema aprendido para un nombre de factura
  buscarProveedorConfirmado: protectedProcedure
    .input(z.object({ nombreFactura: z.string() }))
    .query(async ({ input }) => {
      const { confirmacionesProveedoresService } = await import("./confirmaciones-proveedores");
      return confirmacionesProveedoresService.buscar(input.nombreFactura);
    }),

  // Confirmar (aprender) el emparejamiento de un proveedor
  confirmarProveedor: protectedProcedure
    .input(z.object({ nombreFactura: z.string(), proveedorId: z.string(), proveedorNombre: z.string() }))
    .mutation(async ({ input }) => {
      const { confirmacionesProveedoresService } = await import("./confirmaciones-proveedores");
      await confirmacionesProveedoresService.confirmar(input.nombreFactura, input.proveedorId, input.proveedorNombre);
      return { success: true };
    }),

  // Analizar el costo de un producto vs su historial de compras
  analizarPrecio: protectedProcedure
    .input(z.object({ articuloId: z.number(), costoActual: z.number() }))
    .query(async ({ input }) => {
      const { historialPreciosService } = await import("./historial-precios");
      return historialPreciosService.analizar(input.articuloId, input.costoActual);
    }),

  // Historial completo de precios de un producto (consultas)
  historialPrecios: protectedProcedure
    .input(z.object({ articuloId: z.number() }))
    .query(async ({ input }) => {
      const { historialPreciosService } = await import("./historial-precios");
      return historialPreciosService.historialDe(input.articuloId);
    }),

  // Sugerir categoría para un producto usando IA
  sugerirCategoria: protectedProcedure
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
  crearProducto: protectedProcedure
    .input(z.object({
      nombre: z.string(),
      codigo: z.string().optional(),
      descripcion: z.string().optional(),
      principioActivo: z.string().optional(),
      esGenerico: z.boolean().optional(),
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

      // Componer la DESCRIPCIÓN con el formato del negocio: "Proveedor | Principio activo".
      // Los genéricos no llevan principio activo (su nombre ya lo es).
      const prov = input.nombreProveedor ? input.nombreProveedor.trim() : "";
      const pa = (!input.esGenerico && input.principioActivo) ? input.principioActivo.trim() : "";
      const partes = [prov, pa].filter(Boolean);
      const descripcion = input.descripcion?.trim() || partes.join(" | ");

      return inventarios365.crearProducto({
        nombre: input.nombre,
        codigo,
        descripcion,
        nombreGenerico: pa,
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
  estadisticas: protectedProcedure.query(async () => {
    const { productosCache } = await import("./productos-cache");
    return productosCache.estadisticas();
  }),
  actualizar: protectedProcedure.mutation(async () => {
    const { productosCache } = await import("./productos-cache");
    await productosCache.actualizar(true);
    return { success: true, message: "Cache actualizado exitosamente" };
  }),
  listar: protectedProcedure.query(async () => {
    const { productosCache } = await import("./productos-cache");
    return productosCache.obtenerTodos();
  }),
});

// ─── Inventario Router ───────────────────────────────────────────────────────
// Migración idempotente centralizada para inventario_proveedores. IMPORTANTE:
// se debe llamar al INICIO de CUALQUIER endpoint que lea o escriba esta tabla
// (no solo el que la usó primero) — si no, un endpoint que corra antes de que
// otro haya disparado el ALTER puede fallar con "Unknown column" y romper la
// pantalla en blanco/"no hay inventario" para el usuario. (Lección real: pasó.)
async function asegurarColumnasInventarioProveedores(db: any) {
  const { sql: sqlRaw } = await import("drizzle-orm");
  try { await db.execute(sqlRaw.raw("ALTER TABLE inventario_proveedores ADD COLUMN ajusteEstado VARCHAR(20)")); } catch { /* ya existe */ }
  try { await db.execute(sqlRaw.raw("ALTER TABLE inventario_proveedores ADD COLUMN ajusteMensaje VARCHAR(500)")); } catch { /* ya existe */ }
}

const inventarioRouter = router({
  // Listar productos para conteo, por proveedor (vacío = todos)
  listar: protectedProcedure
    .input(z.object({ idAlmacen: z.number(), idProveedor: z.string().optional() }))
    .query(async ({ input }) => {
      // En vivo obligatorio (el stock del sistema define las diferencias del
      // conteo) — la extracción queda registrada en el snapshot local.
      const { obtenerStockAlmacen } = await import("./stock-cache");
      const { lista: productos } = await obtenerStockAlmacen(input.idAlmacen, { idProveedor: input.idProveedor || "", ttlSeg: 0, fallbackCache: false });
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

  // Extraer cantidades contadas desde una FOTO de la hoja de conteo físico y
  // emparejarlas contra los productos de la sesión en pantalla (letra manuscrita).
  extraerConteoFoto: protectedProcedure
    .input(z.object({
      fileBase64: z.string().max(12_000_000),
      mimeType: z.string(),
      // productos en el MISMO ORDEN que la hoja impresa (alfabético), con su
      // número de fila (1..N) tal como aparece en la columna "#" del PDF.
      productos: z.array(z.object({ id: z.number(), nombre: z.string(), codigo: z.string().optional(), stock: z.number().optional(), numero: z.number().optional() })),
    }))
    .mutation(async ({ input }) => {
      const isImage = input.mimeType.startsWith("image/");
      if (!isImage) return { error: "Sube una foto (imagen) de la hoja de conteo." };
      const dataUrl = `data:${input.mimeType};base64,${input.fileBase64}`;
      let leidos: { numero: number | null; nombre: string; sistema: number | null; fisico: number }[] = [];
      try {
        const llmResult = await invokeLLM({
          messages: [
            { role: "system", content: "Eres experto en leer hojas de conteo de inventario de farmacia, incluida letra manuscrita. Respondes SOLO JSON válido." },
            { role: "user", content: [
              { type: "text", text: `Esta foto es una hoja de conteo físico de inventario, con columnas: # (número de fila, IMPRESO), Clase (A/B/C, impreso), Producto (nombre, impreso), Sistema (cantidad del sistema, IMPRESA a máquina), Físico (una CASILLA EN BLANCO donde el personal ANOTA A MANO la cantidad contada).

⚠️ LA HOJA ESTÁ IMPRESA EN 2 COLUMNAS lado a lado (como un periódico). El orden de impresión es: primero TODA la columna IZQUIERDA de arriba a abajo (filas #1, #2, #3... en orden correlativo), y RECIÉN DESPUÉS continúa la columna DERECHA. NO leas fila por fila cruzando ambas columnas por su altura en la imagen (eso mezcla filas de columnas distintas que están a la misma altura y es causa de errores).

TAREA CRÍTICA: para CADA fila donde la casilla "Físico" tiene algo ESCRITO A MANO, repórtala con LOS 4 DATOS DE ESA FILA EXACTA (no te saltes ni mezcles filas):
1. El número de la columna "#" (impreso, a la izquierda de la fila).
2. El nombre del producto (columna "Producto", impreso).
3. El número de la columna "Sistema" (IMPRESO A MÁQUINA, junto a Físico — NO es lo que escribió el personal).
4. El número que el personal escribió A MANO en la casilla "Físico" (el recuadro en blanco).

Los 4 datos deben venir DE LA MISMA FILA — verifica que el "Sistema" y el "Físico" que reportas están realmente al lado del mismo nombre y del mismo número "#", sin cruzarte a la fila de arriba/abajo o a la otra columna. Si no puedes leer con seguridad el número "#" o el "Sistema" de una fila, igual repórtala (pon null en lo que no puedas leer) — con el NOMBRE y el FÍSICO alcanza para intentar identificarla, pero entre más datos leas bien, mejor.
- Si la casilla "Físico" está vacía o no hay nada escrito a mano ahí, OMITE esa fila por completo.

Devuelve JSON:
{"items":[{"numero": numero_columna_#_o_null, "nombre":"nombre del producto tal como se lee", "sistema": numero_columna_Sistema_o_null, "fisico": numero_entero_escrito_a_mano}]}
- Responde SOLO el JSON.` },
              { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
            ] },
          ],
          temperature: 0,
        });
        const txt = (llmResult?.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(txt);
        const aNumOrNull = (v: any) => v != null && !isNaN(Number(v)) ? Math.round(Number(v)) : null;
        leidos = Array.isArray(parsed?.items)
          ? parsed.items.filter((i: any) => i?.nombre && i?.fisico != null)
              .map((i: any) => ({ numero: aNumOrNull(i.numero), nombre: i.nombre, sistema: aNumOrNull(i.sistema), fisico: Math.round(Number(i.fisico)) }))
          : [];
      } catch (e: any) {
        return { error: "No se pudo leer la foto. Asegúrate de que se vean bien los nombres y las cantidades." };
      }
      if (leidos.length === 0) return { error: "No se encontraron cantidades en la foto." };

      // TRIANGULACIÓN: combina número de fila + cantidad de SISTEMA (que YA
      // CONOCEMOS de antemano, la imprimimos nosotros) + nombre — no depende de
      // una sola señal manuscrita/leída. Ver server/domain/emparejar.ts.
      const { triangularFila, numerosSospechosos } = await import("./domain/emparejar");
      const catalogoNumerado = input.productos
        .filter((p) => p.numero != null && p.stock != null)
        .map((p) => ({ id: p.id, nombre: p.nombre, codigo: p.codigo || null, stock: p.stock!, numero: p.numero! }));

      // Triangulación ADELANTE-ATRÁS: un número que no encaja entre sus vecinos
      // (que sí están en orden entre ellos) probablemente se leyó mal — se deja
      // de usar como señal para ESA fila puntual, sin romper el resto de la
      // cadena; el nombre y la cantidad de sistema siguen aportando igual.
      const sospechosos = numerosSospechosos(leidos.map((l) => ({ numero: l.numero })));

      const resultados = leidos.map((l, idx) => {
        const numeroConfiable = sospechosos[idx] ? null : l.numero;
        const cands = triangularFila({ numero: numeroConfiable, nombre: l.nombre, sistema: l.sistema }, catalogoNumerado);
        const candidatos = cands.map((c) => ({ id: c.id, nombre: c.nombre, codigo: c.codigo, stock: c.stock, numero: c.numero, confianza: c.confianza, señales: c.señales }));
        const mejor = candidatos[0];
        const sugerido = mejor && mejor.confianza !== "baja" ? { id: mejor.id, nombre: mejor.nombre, confianza: mejor.confianza } : null;
        return {
          numeroLeido: l.numero,
          numeroSospechoso: sospechosos[idx],
          textoLeido: l.nombre,
          sistemaLeido: l.sistema,
          cantidad: l.fisico,
          sugerido,
          señales: mejor?.señales || [],
          candidatos,
        };
      });
      const emparejados = resultados.filter((r) => r.sugerido).length;
      return { ok: true, total: resultados.length, emparejados, resultados };
    }),

  // Crear una nueva sesión de inventario
  crearSesion: protectedProcedure
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
  // Lista COMPLETA de proveedores (para el desplegable de faltantes en la sesión)
  todosProveedores: protectedProcedure.query(async () => {
    const { inventarios365 } = await import("./inventarios365");
    return inventarios365.listarTodosProveedores();
  }),

  // Diferencias de caja acumuladas de una sucursal desde el último inventario
  // completado (o desde una fecha dada). Para mostrar al iniciar el inventario.
  diferenciasCaja: protectedProcedure
    .input(z.object({ almacenId: z.number(), desdeFecha: z.string().optional(), sesionId: z.number().optional() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { inventarioSesiones } = await import("../drizzle/schema");
      const { and, eq, desc } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return null;
      // Si no se da fecha, usar la del último inventario COMPLETADO de esa sucursal.
      let desde = input.desdeFecha;
      if (!desde) {
        const ult = await db.select().from(inventarioSesiones)
          .where(and(eq(inventarioSesiones.almacenId, input.almacenId), eq(inventarioSesiones.estado, "completado")))
          .orderBy(desc(inventarioSesiones.creadoEn)).limit(1);
        if (ult.length > 0) desde = ult[0].creadoEn.toISOString().slice(0, 19).replace("T", " ");
      }
      const { diferenciasCajaService } = await import("./diferencias-caja");
      const acum = await diferenciasCajaService.acumuladoSucursal(input.almacenId, desde);
      const detalle = await diferenciasCajaService.detalleSucursal(input.almacenId, desde);
      // DESCUENTO PROGRESIVO: el sobrante de caja se explica con los productos
      // FALTANTES del inventario en curso, valorados a COSTO (salió mercadería que
      // se cobró pero no se descargó del sistema). Lo que quede es lo no explicado.
      let faltantes = { valor: 0, unidades: 0, productos: 0, estimados: 0, sinDato: 0 };
      if (input.sesionId) {
        faltantes = await diferenciasCajaService.valorFaltantesInventario(input.sesionId);
      }
      const restante = Math.round((acum.sobranteTotal - faltantes.valor) * 100) / 100;
      return { desde: desde || "(todo el historial)", ...acum, faltantes, restante, detalle };
    }),

  listarSesiones: protectedProcedure.query(async () => {
    const { getDb } = await import("./db");
    const { inventarioSesiones, inventarioProveedores } = await import("../drizzle/schema");
    const { desc } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return [];
    await asegurarColumnasInventarioProveedores(db);
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
  detalleSesion: protectedProcedure
    .input(z.object({ sesionId: z.number() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { inventarioSesiones, inventarioProveedores } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return null;
      await asegurarColumnasInventarioProveedores(db);
      const sesion = (await db.select().from(inventarioSesiones).where(eq(inventarioSesiones.id, input.sesionId)))[0];
      if (!sesion) return null;
      const provs = await db.select().from(inventarioProveedores).where(eq(inventarioProveedores.sesionId, input.sesionId));
      return { sesion, proveedores: provs };
    }),

  // Guardar/actualizar el conteo de un proveedor dentro de una sesión
  guardarConteoProveedor: protectedProcedure
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
      await asegurarColumnasInventarioProveedores(db);

      const conDif = input.conteos.filter((c) => c.diferencia !== 0).length;
      const estado = input.completar ? "completado" : "en_progreso";

      // ¿Ya existe el registro de este proveedor en esta sesión?
      const existente = (await db.select().from(inventarioProveedores)
        .where(and(
          eq(inventarioProveedores.sesionId, input.sesionId),
          eq(inventarioProveedores.proveedorNombre, input.proveedorNombre)
        )))[0];

      // PASO 1 (siempre primero, protege el conteo): guardar el conteo local.
      // Esto NO depende de 365 — aunque el ajuste real falle después, el conteo
      // manuscrito del personal ya quedó a salvo y NUNCA hay que volver a contar.
      let idRegistro: number;
      if (existente) {
        // "Conteo puntual" es acumulativo: cada conteo se SUMA al historial de la
        // sesión (por producto, el más reciente reemplaza al anterior). Antes se
        // sobrescribía todo el registro y solo quedaba el último conteo.
        let conteosFinales = input.conteos;
        if (input.proveedorNombre === "Conteo puntual" && Array.isArray(existente.conteos)) {
          const porArticulo = new Map<number, any>();
          for (const c of existente.conteos as any[]) porArticulo.set(c.articuloId, c);
          for (const c of input.conteos) porArticulo.set(c.articuloId, c);
          conteosFinales = Array.from(porArticulo.values());
        }
        const difFinal = conteosFinales.filter((c: any) => c.diferencia !== 0).length;
        await db.update(inventarioProveedores).set({
          totalProductos: input.proveedorNombre === "Conteo puntual" ? conteosFinales.length : input.totalProductos,
          productosContados: conteosFinales.length,
          conDiferencia: difFinal,
          conteos: conteosFinales,
          estado,
          completadoEn: input.completar ? new Date() : null,
        }).where(eq(inventarioProveedores.id, existente.id));
        idRegistro = existente.id;
      } else {
        const ins: any = await db.insert(inventarioProveedores).values({
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
        idRegistro = ins?.[0]?.insertId ?? ins?.insertId ?? existente?.id;
      }

      // PASO 2: intentar el ajuste REAL en 365 (puede fallar por conexión — nunca
      // hace perder el conteo del paso 1, que ya quedó guardado).
      let ajusteResultado: { ok: boolean; ajustados: number; mensaje: string; eliminados?: string[] } | null = null;
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
          // PASO 3: dejar registrado el resultado REAL del ajuste (no solo un
          // toast pasajero) — así al reabrir la sesión se ve claramente si el
          // stock de 365 quedó al día o si hace falta reintentar.
          try {
            await db.update(inventarioProveedores).set({
              ajusteEstado: ajusteResultado.ok ? "ok" : "fallo",
              ajusteMensaje: ajusteResultado.mensaje.slice(0, 500),
            }).where(eq(inventarioProveedores.id, idRegistro));
          } catch { /* no crítico */ }
        }
      }

      return { success: true, conDiferencia: conDif, contados: input.conteos.length, ajuste: ajusteResultado, registroId: idRegistro };
    }),

  // CONTINGENCIA: reintentar el ajuste real en 365 cuando falló antes (ej. se
  // cortó la conexión). NUNCA reenvía a ciegas: primero VERIFICA el stock actual
  // de cada producto en 365. Si ya quedó en el valor contado, lo salta (evita
  // duplicar el ajuste). Si cambió a algo distinto de lo esperado, lo marca para
  // revisión manual en vez de sobrescribirlo. Solo reintenta lo que sigue
  // genuinamente pendiente. El conteo (ya guardado) nunca se vuelve a pedir.
  reintentarAjuste: protectedProcedure
    .input(z.object({ registroId: z.number() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { inventarioProveedores, inventarioSesiones } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin base de datos");
      await asegurarColumnasInventarioProveedores(db);

      const reg = (await db.select().from(inventarioProveedores).where(eq(inventarioProveedores.id, input.registroId)))[0];
      if (!reg) throw new Error("No se encontró el registro del conteo.");
      const conteos: any[] = Array.isArray(reg.conteos) ? (reg.conteos as any[]) : [];
      const conDiferencia = conteos.filter((c) => c.diferencia !== 0);
      if (conDiferencia.length === 0) return { ok: true, mensaje: "No hay diferencias pendientes de ajustar." };

      const sesion = (await db.select().from(inventarioSesiones).where(eq(inventarioSesiones.id, reg.sesionId)))[0];
      if (!sesion) throw new Error("No se encontró la sesión de inventario.");

      // Verificar el stock ACTUAL de cada producto antes de reenviar nada —
      // SIEMPRE en vivo (nunca decidir un reintento con datos de cache). La
      // extracción queda registrada en el snapshot local.
      const { obtenerStockAlmacen: obtenerStockVivo } = await import("./stock-cache");
      const { lista: stockActualLista } = await obtenerStockVivo(sesion.almacenId, { ttlSeg: 0, fallbackCache: false });
      const stockActualPorId = new Map(stockActualLista.map((p: any) => [p.id, Number(p.stock)]));

      const pendientes: typeof conDiferencia = [];
      const yaAplicados: string[] = [];
      const ambiguos: string[] = [];
      for (const c of conDiferencia) {
        const actual = stockActualPorId.get(c.articuloId);
        if (actual == null) { ambiguos.push(c.nombre); continue; } // no se pudo verificar: no tocar, avisar
        if (actual === c.stockFisico) { yaAplicados.push(c.nombre); continue; } // ya quedó como se contó: no duplicar
        if (actual === c.stockSistema) { pendientes.push(c); continue; } // sigue en el valor de antes: seguro reintentar
        ambiguos.push(c.nombre); // cambió a otro valor distinto (ej. una venta de por medio): no sobrescribir a ciegas
      }

      let resultado: { ok: boolean; ajustados: number; mensaje: string } = { ok: true, ajustados: 0, mensaje: "Nada pendiente de reintentar." };
      if (pendientes.length > 0) {
        const { inventarios365 } = await import("./inventarios365");
        resultado = await inventarios365.ajustarInventario({
          almacenId: sesion.almacenId,
          motivoId: 2,
          ajustes: pendientes.map((c: any) => ({
            productoId: c.articuloId, inventarioId: c.inventarioId ?? null,
            stockAnterior: c.stockSistema, stockReal: c.stockFisico,
            fechaVencimiento: c.fechaVencimiento || null,
          })),
        });
      }

      const partes: string[] = [];
      if (pendientes.length > 0) partes.push(`${resultado.ok ? "✅" : "❌"} ${resultado.ok ? pendientes.length : 0} reintentado(s): ${resultado.mensaje}`);
      if (yaAplicados.length > 0) partes.push(`✓ ${yaAplicados.length} ya estaban aplicados en 365 (no se duplicaron): ${yaAplicados.slice(0, 5).join(", ")}${yaAplicados.length > 5 ? "…" : ""}`);
      if (ambiguos.length > 0) partes.push(`⚠️ ${ambiguos.length} requieren revisión manual (el stock cambió desde el conteo): ${ambiguos.slice(0, 5).join(", ")}${ambiguos.length > 5 ? "…" : ""}`);
      const mensajeFinal = partes.join(" · ") || "Nada que reintentar.";
      const nuevoEstado = ambiguos.length > 0 ? "revisar" : (pendientes.length === 0 || resultado.ok) ? "ok" : "fallo";

      try {
        await db.update(inventarioProveedores).set({ ajusteEstado: nuevoEstado, ajusteMensaje: mensajeFinal.slice(0, 500) })
          .where(eq(inventarioProveedores.id, input.registroId));
      } catch { /* no crítico */ }

      return { ok: nuevoEstado !== "fallo", mensaje: mensajeFinal, aplicadosAhora: pendientes.length, yaEstaban: yaAplicados.length, revisar: ambiguos.length };
    }),

  // Marcar sesión como completada
  completarSesion: protectedProcedure
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
  listarTrabajadores: protectedProcedure.query(async () => {
    const { getDb } = await import("./db");
    const { trabajadores } = await import("../drizzle/schema");
    const db = await getDb();
    if (!db) return [];
    return db.select().from(trabajadores).orderBy(trabajadores.nombre);
  }),

  // Crear o actualizar un trabajador
  guardarTrabajador: protectedProcedure
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
  desactivarTrabajador: protectedProcedure
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
  listarUsuariosSistema: protectedProcedure.query(async () => {
    const { inventarios365 } = await import("./inventarios365");
    return inventarios365.listarUsuarios();
  }),

  // Agregar campo usuario al guardar trabajador (ya manejado por guardarTrabajador abajo)

  // Resumen mensual de un trabajador: lee las aperturas de caja de inventarios365
  resumenMensual: protectedProcedure
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

  guardarAjusteDia: protectedProcedure
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

  marcarPagado: protectedProcedure
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

  pagosDelMes: protectedProcedure
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
  dashboardPagos: protectedProcedure
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
  buscarProductos: protectedProcedure
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
  // Tendencias y alertas proactivas (semana actual vs anterior + serie 6 meses)
  tendencias: protectedProcedure.query(async () => {
    const { tendencias } = await import("./tendencias");
    return tendencias();
  }),

  // Resumen de UN mes (meses cerrados: del cache, al toque)
  resumenMensual: protectedProcedure
    .input(z.object({ anioMes: z.string().max(7), forzar: z.boolean().optional() }))
    .query(async ({ input }) => {
      const { resumenMensual } = await import("./resumen-mensual");
      return resumenMensual(input.anioMes, input.forzar === true);
    }),
  // Serie histórica de N meses por sucursal (ágil: cache para cerrados)
  resumenHistorico: protectedProcedure
    .input(z.object({ meses: z.number().min(1).max(24).optional() }).optional())
    .query(async ({ input }) => {
      const { resumenHistorico } = await import("./resumen-mensual");
      return resumenHistorico(input?.meses ?? 12);
    }),

  // DIAGNÓSTICO del mes: cuántas ventas hay en la BD local, por sucursal y por
  // día, y cuántas quedaron sin detalle de productos — para detectar de un
  // vistazo si falta información del mes.
  diagnosticoMes: protectedProcedure
    .input(z.object({ anioMes: z.string().max(7).optional() }).optional())
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return { error: "Sin BD" };
      const hoy = new Date();
      const am = input?.anioMes || `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
      const filas = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
      // Rango de fechas (usa el índice idx_ventas_fecha; DATE_FORMAT lo anulaba y
      // hacía full scan — contribuía a colgar la BD chica de producción)
      const [anioD, mesD] = am.split("-").map(Number);
      const desde = `${am}-01`;
      const sigMes = mesD === 12 ? `${anioD + 1}-01-01` : `${anioD}-${String(mesD + 1).padStart(2, "0")}-01`;

      const porSucursal = filas(await db.execute(sql`
        SELECT nombreSucursal, COUNT(*) AS n, COALESCE(SUM(total),0) AS monto
        FROM ventas WHERE fecha >= ${desde} AND fecha < ${sigMes}${FILTRO_NO_ANULADA}
        GROUP BY nombreSucursal ORDER BY monto DESC
      `));
      const porDia = filas(await db.execute(sql`
        SELECT fecha, COUNT(*) AS n, COALESCE(SUM(total),0) AS monto
        FROM ventas WHERE fecha >= ${desde} AND fecha < ${sigMes}${FILTRO_NO_ANULADA}
        GROUP BY fecha ORDER BY fecha
      `));
      const sinDetalle = filas(await db.execute(sql`
        SELECT COUNT(*) AS n FROM ventas v
        WHERE v.fecha >= ${desde} AND v.fecha < ${sigMes} AND v.total > 0 AND CAST(v.estado AS CHAR) = '1'
          AND NOT EXISTS (SELECT 1 FROM ventas_detalle d WHERE d.ventaId = v.id)
      `));
      const totales = filas(await db.execute(sql`
        SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS monto FROM ventas WHERE fecha >= ${desde} AND fecha < ${sigMes}${FILTRO_NO_ANULADA}
      `));

      // Días del mes transcurridos SIN ninguna venta registrada (sospechoso en una
      // farmacia que abre a diario — probable hueco de sincronización)
      const [anio, mes] = am.split("-").map(Number);
      const ultimoDia = am === hoy.toISOString().slice(0, 7) ? hoy.getDate() : new Date(anio, mes, 0).getDate();
      const diasConVenta = new Set(porDia.map((d: any) => String(d.fecha).slice(0, 10)));
      const diasSinVenta: string[] = [];
      for (let d = 1; d <= ultimoDia; d++) {
        const f = `${am}-${String(d).padStart(2, "0")}`;
        if (!diasConVenta.has(f)) diasSinVenta.push(f);
      }

      return {
        anioMes: am,
        totalVentas: Number(totales[0]?.n || 0),
        montoTotal: Math.round(Number(totales[0]?.monto || 0) * 100) / 100,
        porSucursal: porSucursal.map((s: any) => ({ sucursal: s.nombreSucursal || "Sin sucursal", ventas: Number(s.n), monto: Math.round(Number(s.monto) * 100) / 100 })),
        ventasSinDetalle: Number(sinDetalle[0]?.n || 0),
        diasSinVenta,
      };
    }),

  // RESINCRONIZAR un mes: rescata de 365 toda venta del mes que falte en la BD
  // local (cubre los huecos que dejó la lógica anterior) y repara detalles.
  resincronizarMes: protectedProcedure
    .input(z.object({ anioMes: z.string().max(7) }))
    .mutation(async ({ input }) => {
      const { resincronizarMes } = await import("./sync-ventas");
      const r = await resincronizarMes(input.anioMes);
      // El mes cambió: recalcular y guardar su resumen (cache al día)
      try { const { resumenMensual } = await import("./resumen-mensual"); await resumenMensual(input.anioMes, true); } catch { /* no bloquea */ }
      return { ok: true, rescatadas: r.rescatadas, paginasRevisadas: r.paginas };
    }),

  // Reparar ventas sin detalle de productos (lote manual más grande)
  repararDetalles: protectedProcedure.mutation(async () => {
    const { repararDetallesFaltantes } = await import("./sync-ventas");
    return repararDetallesFaltantes(40);
  }),

  // Botón: sincronizar ventas ahora (incremental, conservador)
  sincronizar: protectedProcedure.mutation(async () => {
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
    const { sincronizarVentasIncremental, refrescarEstadoVentasRecientes } = await import("./sync-ventas");
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
    // Refrescar estados recientes para capturar anulaciones de ventas ya sincronizadas.
    await refrescarEstadoVentasRecientes(3);
    // Tras sincronizar ventas, otorgar puntos de fidelidad a las ventas de mostrador
    // con cliente identificado (idempotente). No bloquea si falla.
    try {
      const { otorgarPuntosVentas365 } = await import("./puntos-fidelidad");
      await otorgarPuntosVentas365(30);
    } catch (e: any) { console.warn("[Sync] puntos 365 no procesados:", e?.message); }
    return { nuevas: totalNuevas, ultimoId, primeraVez, huboHueco };
  }),

  // Botón: sincronizar clientes
  sincronizarClientes: protectedProcedure.mutation(async () => {
    const { sincronizarClientes } = await import("./sync-ventas");
    return sincronizarClientes();
  }),

  // Rellenar huecos: recorre las ventas recientes por FECHA y guarda las que falten
  // (sin depender del ultimoId). Rescata días que quedaron sin sincronizar.
  rellenarHuecos: protectedProcedure
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
  cargarHistoricoLote: protectedProcedure
    .input(z.object({ desde: z.string(), hasta: z.string() }))
    .mutation(async ({ input }) => {
      const { cargarHistoricoLote } = await import("./sync-ventas");
      return cargarHistoricoLote(input.desde, input.hasta);
    }),

  // Reiniciar el progreso de la carga histórica
  reiniciarHistorico: protectedProcedure.mutation(async () => {
    const { reiniciarProgresoHistorico } = await import("./sync-ventas");
    await reiniciarProgresoHistorico();
    return { success: true };
  }),

  // Estado de la sincronización
  estado: protectedProcedure.query(async () => {
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
  reportes: protectedProcedure
    .input(z.object({ desde: z.string(), hasta: z.string(), sucursal: z.string().optional() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return null;
      const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
      const rango = sql`fecha >= ${input.desde} AND fecha <= ${input.hasta}`;
      const filtroSuc = input.sucursal ? sql`AND nombreSucursal = ${input.sucursal}` : sql``;
      // Excluir "ventas menores del día" de los reportes de productos: no es un
      // medicamento real, solo un registro para ventas mínimas olvidadas.
      const excluirMenores = sql`AND articuloNombre NOT LIKE '%ventas menores%' AND articuloNombre NOT LIKE '%venta menor%'`;

      // Clientes identificados (excluye consumidor final / sin cliente registrado)
      const excluirGenerico = sql`AND idCliente IS NOT NULL AND razonSocialCliente NOT LIKE '%consumidor final%'`;

      try {
        const [masVendidos, masVendidosValor, vendedores, mejoresClientes, sucursales, diasSemana, totales] = await Promise.all([
          // Productos más vendidos POR CANTIDAD
          db.execute(sql`
            SELECT articuloNombre, SUM(cantidad) as unidades, SUM(subtotal) as monto, COUNT(*) as veces
             FROM ventas_detalle WHERE ${rango} ${filtroSuc} ${excluirMenores}${FILTRO_DETALLE_NO_ANULADA}
             GROUP BY articuloNombre ORDER BY unidades DESC LIMIT 15
          `),
          // Productos más vendidos POR VALOR (ingreso generado)
          db.execute(sql`
            SELECT articuloNombre, SUM(cantidad) as unidades, SUM(subtotal) as monto, COUNT(*) as veces
             FROM ventas_detalle WHERE ${rango} ${filtroSuc} ${excluirMenores}${FILTRO_DETALLE_NO_ANULADA}
             GROUP BY articuloNombre ORDER BY monto DESC LIMIT 15
          `),
          // Mejores vendedores
          db.execute(sql`
            SELECT vendedor, SUM(total) as monto, COUNT(*) as ventas
             FROM ventas WHERE ${rango} ${filtroSuc}${FILTRO_NO_ANULADA}
             GROUP BY vendedor ORDER BY monto DESC LIMIT 10
          `),
          // Mejores clientes (más Bs pagados en el periodo)
          db.execute(sql`
            SELECT idCliente, razonSocialCliente, SUM(total) as monto, COUNT(*) as ventas
             FROM ventas WHERE ${rango} ${filtroSuc} ${excluirGenerico}${FILTRO_NO_ANULADA}
             GROUP BY idCliente, razonSocialCliente ORDER BY monto DESC LIMIT 15
          `),
          // Ventas por sucursal
          db.execute(sql`
            SELECT nombreSucursal, SUM(total) as monto, COUNT(*) as ventas
             FROM ventas WHERE ${rango}${FILTRO_NO_ANULADA}
             GROUP BY nombreSucursal ORDER BY monto DESC
          `),
          // Mejores días de la semana
          db.execute(sql`
            SELECT diaSemana, SUM(total) as monto, COUNT(*) as ventas
             FROM ventas WHERE ${rango} ${filtroSuc}${FILTRO_NO_ANULADA}
             GROUP BY diaSemana ORDER BY diaSemana
          `),
          // Totales del periodo
          db.execute(sql`
            SELECT COUNT(*) as ventas, SUM(total) as monto, AVG(total) as promedio
             FROM ventas WHERE ${rango} ${filtroSuc}${FILTRO_NO_ANULADA}
          `),
        ]);
        return {
          masVendidos: rows(masVendidos),
          masVendidosValor: rows(masVendidosValor),
          vendedores: rows(vendedores),
          mejoresClientes: rows(mejoresClientes),
          sucursales: rows(sucursales),
          diasSemana: rows(diasSemana),
          totales: rows(totales)[0] || { ventas: 0, monto: 0, promedio: 0 },
        };
      } catch (err: any) {
        return { error: err.message, masVendidos: [], vendedores: [], mejoresClientes: [], sucursales: [], diasSemana: [], totales: null };
      }
    }),

  // Productos comprados por un cliente específico en un periodo (detalle al hacer click en "Mejores clientes")
  productosCliente: protectedProcedure
    .input(z.object({ idCliente: z.number(), desde: z.string(), hasta: z.string() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return { productos: [] };
      const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
      try {
        const r = rows(await db.execute(sql`
          SELECT d.articuloNombre, SUM(d.cantidad) as unidades, SUM(d.subtotal) as monto
           FROM ventas_detalle d JOIN ventas v ON v.id = d.ventaId
           WHERE v.idCliente = ${input.idCliente} AND d.fecha >= ${input.desde} AND d.fecha <= ${input.hasta}
             AND d.articuloNombre NOT LIKE '%venta menor%' AND d.articuloNombre NOT LIKE '%ventas menores%'
           GROUP BY d.articuloNombre ORDER BY monto DESC LIMIT 30
        `));
        return { productos: r };
      } catch (err: any) {
        return { productos: [], error: err.message };
      }
    }),

  // Lista de sucursales disponibles (para el filtro)
  // Diagnóstico temporal: ver qué gastos y sucursales hay (para depurar el reporte)
  sucursalesDisponibles: protectedProcedure.query(async () => {
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
  comprasDelMes: protectedProcedure
    .input(z.object({ anioMes: z.string() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return { compras: [], total: 0, cantidad: 0 };
      const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
      const [anio, mes] = input.anioMes.split("-").map(Number);
      const desde = `${input.anioMes}-01 00:00:00`;
      const ultimoDia = new Date(anio, mes, 0).getDate();
      const hasta = `${input.anioMes}-${String(ultimoDia).padStart(2, "0")} 23:59:59`;
      try {
        // Compras completadas del mes (por fecha de creación), con nombre de sucursal
        const compras = rows(await db.execute(sql`
          SELECT p.id, p.receiptNumber, p.supplier, p.totalAmount, p.createdAt, p.status, b.name as branchName
           FROM purchases p LEFT JOIN branches b ON b.id = p.branchId
           WHERE p.status='completed' AND p.createdAt >= ${desde} AND p.createdAt <= ${hasta}
           ORDER BY CAST(p.totalAmount AS DECIMAL(12,2)) DESC
        `));
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

  rentabilidadPorSucursal: protectedProcedure
    .input(z.object({ anioMes: z.string(), forzar: z.boolean().optional() }))
    .query(async ({ input }) => {
      // Servir desde caché si está fresco (salvo que se fuerce recálculo)
      const cacheKey = input.anioMes;
      if (!input.forzar) {
        const cached = cacheRentabilidadSucursal.get(cacheKey);
        if (cached && cached.expira > Date.now()) return cached.data;
      }
      const { calcularRentabilidadPorSucursal } = await import("./rentabilidad");
      const respuesta = await calcularRentabilidadPorSucursal(input.anioMes);
      if (!respuesta.error) {
        cacheRentabilidadSucursal.set(cacheKey, { data: respuesta, expira: Date.now() + RENTABILIDAD_TTL });
      }
      return respuesta;
    }),

  // Rentabilidad: une ventas con el costo (productos_cache por nombre).
  // Calcula ganancia = (precio - costo) * cantidad, y margen % = (precio-costo)/precio.
  rentabilidad: protectedProcedure
    .input(z.object({ desde: z.string(), hasta: z.string(), sucursal: z.string().optional() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return null;
      const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
      const rango = sql`d.fecha >= ${input.desde} AND d.fecha <= ${input.hasta}`;
      const filtroSuc = input.sucursal ? sql`AND d.nombreSucursal = ${input.sucursal}` : sql``;
      // Excluir "ventas menores del día" (no es un producto real)
      const excluirMenores = sql`AND d.articuloNombre NOT LIKE '%ventas menores%' AND d.articuloNombre NOT LIKE '%venta menor%'`;

      try {
        // Productos que MÁS GANANCIA generaron (suma de ganancia por línea)
        const masGanancia = await db.execute(sql`
          SELECT d.articuloNombre,
                  SUM(d.cantidad) as unidades,
                  SUM(d.subtotal) as ingreso,
                  SUM(d.cantidad * c.precioCostoUnid) as costoTotal,
                  SUM(d.subtotal - (d.cantidad * c.precioCostoUnid)) as ganancia
           FROM ventas_detalle d
           JOIN productos_cache c ON c.nombre = d.articuloNombre
           WHERE ${rango} ${filtroSuc} ${excluirMenores} AND c.precioCostoUnid > 0
           GROUP BY d.articuloNombre
           HAVING ganancia IS NOT NULL
           ORDER BY ganancia DESC LIMIT 15
        `);

        // Productos con MAYOR MARGEN % (promedio ponderado por línea)
        const mayorMargen = await db.execute(sql`
          SELECT d.articuloNombre,
                  SUM(d.cantidad) as unidades,
                  AVG((d.precio - c.precioCostoUnid) / d.precio * 100) as margenPct,
                  SUM(d.subtotal - (d.cantidad * c.precioCostoUnid)) as ganancia
           FROM ventas_detalle d
           JOIN productos_cache c ON c.nombre = d.articuloNombre
           WHERE ${rango} ${filtroSuc} ${excluirMenores} AND c.precioCostoUnid > 0 AND d.precio > 0
           GROUP BY d.articuloNombre
           HAVING margenPct IS NOT NULL
           ORDER BY margenPct DESC LIMIT 15
        `);

        // Resumen: ganancia total estimada del periodo (solo productos con costo conocido)
        const resumen = await db.execute(sql`
          SELECT SUM(d.subtotal) as ingreso,
                  SUM(d.cantidad * c.precioCostoUnid) as costo,
                  SUM(d.subtotal - (d.cantidad * c.precioCostoUnid)) as ganancia,
                  COUNT(DISTINCT d.articuloNombre) as productosConCosto
           FROM ventas_detalle d
           JOIN productos_cache c ON c.nombre = d.articuloNombre
           WHERE ${rango} ${filtroSuc} AND c.precioCostoUnid > 0
        `);

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

// ─── Créditos de la farmacia (admin y finanzas) ───
const soloFinanzas = (ctx: any) => {
  if (ctx?.user?.role !== "admin" && ctx?.user?.role !== "regente") throw new Error("Solo administrador o regente.");
};

// ─── MODO CONTINGENCIA (365 caído): ventas locales por sucursal + cierre asistido ───
const contingenciaRouter = router({
  estado: protectedProcedure.query(async () => {
    const { contingencia } = await import("./contingencia");
    return contingencia.estado();
  }),
  activar: protectedProcedure
    .input(z.object({ motivo: z.string().min(3).max(300) }))
    .mutation(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { contingencia } = await import("./contingencia");
      return contingencia.activar(input.motivo);
    }),
  desactivar: protectedProcedure.mutation(async ({ ctx }) => {
    soloFinanzas(ctx);
    const { contingencia } = await import("./contingencia");
    return contingencia.desactivar();
  }),
  // Búsqueda offline: la puede usar CUALQUIER rol (incluida la vendedora viewer)
  buscarProducto: protectedProcedure
    .input(z.object({ q: z.string().max(120) }))
    .query(async ({ input }) => {
      const { contingencia } = await import("./contingencia");
      return contingencia.buscarProductoOffline(input.q);
    }),
  // Registrar venta: cualquier rol logueado — es el corazón de la contingencia
  registrarVenta: protectedProcedure
    .input(z.object({
      sucursal: z.string().min(2).max(120),
      items: z.array(z.object({
        articuloId: z.number().nullable().optional(),
        nombre: z.string().min(1).max(500),
        cantidad: z.number().min(1).max(10000),
        precioUnit: z.number().min(0.01).max(1000000),
      })).min(1).max(60),
      metodoPago: z.string().max(20).optional(),
      nota: z.string().max(300).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { contingencia } = await import("./contingencia");
      const usuario = (ctx as any)?.user?.email || (ctx as any)?.user?.name || `usuario-${(ctx as any)?.user?.id ?? "?"}`;
      return contingencia.registrarVenta({ ...input, usuario });
    }),
  listar: protectedProcedure
    .input(z.object({ estado: z.string().max(20).optional(), sucursal: z.string().max(120).optional() }).optional())
    .query(async ({ input }) => {
      const { contingencia } = await import("./contingencia");
      return contingencia.listar({ estado: input?.estado, sucursal: input?.sucursal });
    }),
  marcarRegistrada: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { contingencia } = await import("./contingencia");
      const por = (ctx as any)?.user?.email || (ctx as any)?.user?.name || "admin";
      return contingencia.marcarRegistrada(input.id, por);
    }),
  anular: protectedProcedure
    .input(z.object({ id: z.number(), nota: z.string().min(2).max(250) }))
    .mutation(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { contingencia } = await import("./contingencia");
      const por = (ctx as any)?.user?.email || (ctx as any)?.user?.name || "admin";
      return contingencia.anular(input.id, input.nota, por);
    }),
  resumenCierre: protectedProcedure.query(async ({ ctx }) => {
    soloFinanzas(ctx);
    const { contingencia } = await import("./contingencia");
    return contingencia.resumenCierre();
  }),
});
// ─── Apartado personal PRIVADO (solo admin/dueño) ───
const soloDueno = (ctx: any) => {
  if (ctx?.user?.role !== "admin") throw new Error("Apartado personal: solo el dueño (admin).");
};

const creditosRouter = router({
  listar: protectedProcedure.query(async ({ ctx }) => {
    soloFinanzas(ctx);
    const { creditos } = await import("./finanzas-personal");
    return creditos.listar();
  }),
  crear: protectedProcedure
    .input(z.object({ banco: z.string().max(120), descripcion: z.string().max(250).optional(), montoTotal: z.number(), cuotaMensual: z.number(), plazoMeses: z.number(), tasaAnual: z.number().optional(), fechaInicio: z.string().max(12).optional(), diaPago: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { creditos } = await import("./finanzas-personal");
      return creditos.crear(input);
    }),
  editar: protectedProcedure
    .input(z.object({ id: z.number(), banco: z.string().max(120).optional(), descripcion: z.string().max(250).optional(), montoTotal: z.number().optional(), cuotaMensual: z.number().optional(), plazoMeses: z.number().optional(), tasaAnual: z.number().optional(), fechaInicio: z.string().max(12).optional(), diaPago: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { creditos } = await import("./finanzas-personal");
      const { id, ...campos } = input;
      return creditos.editar(id, campos);
    }),
  registrarPago: protectedProcedure
    .input(z.object({ creditoId: z.number(), monto: z.number(), fecha: z.string().max(12), nota: z.string().max(250).optional() }))
    .mutation(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { creditos } = await import("./finanzas-personal");
      return creditos.registrarPago(input);
    }),
  editarPago: protectedProcedure
    .input(z.object({ pagoId: z.number(), monto: z.number().optional(), fecha: z.string().max(12).optional(), nota: z.string().max(250).optional() }))
    .mutation(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { creditos } = await import("./finanzas-personal");
      return creditos.editarPago(input);
    }),
  pagosDe: protectedProcedure
    .input(z.object({ creditoId: z.number() }))
    .query(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { creditos } = await import("./finanzas-personal");
      return creditos.pagosDe(input.creditoId);
    }),
  eliminar: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { creditos } = await import("./finanzas-personal");
      return creditos.eliminar(input.id);
    }),
  marcarEstado: protectedProcedure
    .input(z.object({ id: z.number(), estado: z.string().max(20) }))
    .mutation(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { creditos } = await import("./finanzas-personal");
      return creditos.marcarEstado(input.id, input.estado);
    }),
});

const personalRouter = router({
  resumen: protectedProcedure
    .input(z.object({ desde: z.string().max(12).optional(), hasta: z.string().max(12).optional() }).optional())
    .query(async ({ input, ctx }) => {
      soloDueno(ctx);
      const { personal } = await import("./finanzas-personal");
      return personal.resumen(input?.desde, input?.hasta);
    }),
  categorias: protectedProcedure.query(async ({ ctx }) => {
    soloDueno(ctx);
    const { CATEGORIAS_INGRESO, CATEGORIAS_GASTO } = await import("./finanzas-personal");
    return { ingreso: CATEGORIAS_INGRESO, gasto: CATEGORIAS_GASTO };
  }),
  registrar: protectedProcedure
    .input(z.object({ tipo: z.string().max(10), categoria: z.string().max(80).optional(), detalle: z.string().max(250).optional(), monto: z.number(), fecha: z.string().max(12) }))
    .mutation(async ({ input, ctx }) => {
      soloDueno(ctx);
      const { personal } = await import("./finanzas-personal");
      return personal.registrar(input);
    }),
  eliminar: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      soloDueno(ctx);
      const { personal } = await import("./finanzas-personal");
      return personal.eliminar(input.id);
    }),
});

const obligacionesRouter = router({
  delMes: protectedProcedure
    .input(z.object({ anioMes: z.string().max(7).optional() }).optional())
    .query(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { obligacionesDelMes } = await import("./obligaciones");
      return obligacionesDelMes(input?.anioMes);
    }),
  pagar: protectedProcedure
    .input(z.object({ tipo: z.enum(["credito", "gasto", "sueldo"]), refId: z.number(), anioMes: z.string().max(7), monto: z.number() }))
    .mutation(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { pagarObligacion } = await import("./obligaciones");
      return pagarObligacion(input);
    }),
});

const flujoCajaRouter = router({
  ver: protectedProcedure
    .input(z.object({ mesesHistoria: z.number().min(1).max(24).optional(), mesesProyectar: z.number().min(1).max(12).optional() }).optional())
    .query(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { flujoDeCaja } = await import("./flujo-caja");
      return flujoDeCaja(input?.mesesHistoria ?? 6, input?.mesesProyectar ?? 3);
    }),
});

const gastosRouter = router({
  // Listar plantilla de gastos fijos
  listarFijos: protectedProcedure.query(async () => {
    const { getDb } = await import("./db");
    const { sql } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return [];
    try {
      const r: any = await db.execute(sql`SELECT * FROM gastos_fijos WHERE activo=1 ORDER BY categoria, nombre`);
      const rows = Array.isArray(r) ? r[0] : r?.rows ?? r;
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }),

  // Crear un gasto fijo (plantilla)
  crearFijo: protectedProcedure
    .input(z.object({ nombre: z.string(), categoria: z.string(), montoEstimado: z.number(), diaVencimiento: z.number().optional(), sucursal: z.string().optional(), esVariable: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin BD");
      await db.execute(sql`
        INSERT INTO gastos_fijos (nombre, categoria, montoEstimado, diaVencimiento, sucursal, esVariable)
         VALUES (${input.nombre}, ${input.categoria}, ${input.montoEstimado}, ${input.diaVencimiento ?? null}, ${input.sucursal ?? null}, ${input.esVariable ? 1 : 0})
      `);
      return { success: true };
    }),

  // Eliminar (desactivar) un gasto fijo
  eliminarFijo: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin BD");
      await db.execute(sql`UPDATE gastos_fijos SET activo=0 WHERE id=${input.id}`);
      return { success: true };
    }),

  // Obtener los gastos de un mes (genera los fijos si no existen aún + ocasionales)
  delMes: protectedProcedure
    .input(z.object({ anioMes: z.string(), sucursal: z.string().optional() }))
    .query(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) return { gastos: [], totalPagado: 0, totalPendiente: 0 };
      const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };

      try {
        // Generar registros de gastos fijos para el mes si aún no existen.
        // Verificamos por gastoFijoId Y por nombre, para no duplicar gastos que
        // fueron movidos a este mes (y quedaron desvinculados de la plantilla).
        const fijos = rows(await db.execute(sql`SELECT * FROM gastos_fijos WHERE activo=1`));
        const existentes = rows(await db.execute(sql`SELECT gastoFijoId, nombre FROM gastos_registro WHERE anioMes=${input.anioMes}`));
        const idsExistentes = new Set(existentes.filter((e: any) => e.gastoFijoId != null).map((e: any) => e.gastoFijoId));
        const nombresExistentes = new Set(existentes.map((e: any) => String(e.nombre || "").trim().toLowerCase()));
        for (const f of fijos) {
          const yaExistePorId = idsExistentes.has(f.id);
          const yaExistePorNombre = nombresExistentes.has(String(f.nombre || "").trim().toLowerCase());
          if (!yaExistePorId && !yaExistePorNombre) {
            // Para gastos variables (luz, agua), el monto inicial es 0 (se ingresa al llegar la factura)
            const montoInicial = f.esVariable ? 0 : (Number(f.montoEstimado) || 0);
            await db.execute(sql`
              INSERT INTO gastos_registro (anioMes, gastoFijoId, nombre, categoria, monto, pagado, esOcasional, sucursal, esVariable)
               VALUES (${input.anioMes}, ${f.id}, ${f.nombre}, ${f.categoria}, ${montoInicial}, 0, 0, ${f.sucursal}, ${f.esVariable ? 1 : 0})
            `);
          }
        }

        // Devolver gastos del mes (filtrados por sucursal si se indicó)
        const filtroSuc = input.sucursal ? sql`AND sucursal=${input.sucursal}` : sql``;
        const gastos = rows(await db.execute(sql`SELECT * FROM gastos_registro WHERE anioMes=${input.anioMes} ${filtroSuc} ORDER BY esOcasional, categoria, nombre`));
        const totalPagado = gastos.filter((g: any) => g.pagado).reduce((s: number, g: any) => s + Number(g.monto), 0);
        const totalPendiente = gastos.filter((g: any) => !g.pagado).reduce((s: number, g: any) => s + Number(g.monto), 0);
        return { gastos, totalPagado, totalPendiente };
      } catch (err: any) {
        return { gastos: [], totalPagado: 0, totalPendiente: 0, error: err.message };
      }
    }),

  // Marcar pagado/no pagado un gasto + ajustar monto y fecha de pago
  marcarPago: protectedProcedure
    .input(z.object({ id: z.number(), pagado: z.boolean(), monto: z.number().optional(), fechaPago: z.string().optional() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin BD");
      const hoy = new Date().toISOString().slice(0, 10);
      const fecha = input.pagado ? (input.fechaPago || hoy) : null;
      const setMonto = input.monto != null ? sql`, monto=${input.monto}` : sql``;
      await db.execute(sql`
        UPDATE gastos_registro SET pagado=${input.pagado ? 1 : 0}, fechaPago=${input.pagado ? fecha : null} ${setMonto} WHERE id=${input.id}
      `);
      return { success: true };
    }),

  // Cambiar solo la fecha de pago de un gasto
  cambiarFechaPago: protectedProcedure
    .input(z.object({ id: z.number(), fechaPago: z.string() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin BD");
      await db.execute(sql`UPDATE gastos_registro SET fechaPago=${input.fechaPago} WHERE id=${input.id}`);
      return { success: true };
    }),

  // Registrar un gasto ocasional
  registrarOcasional: protectedProcedure
    .input(z.object({ anioMes: z.string(), nombre: z.string(), categoria: z.string(), monto: z.number(), pagado: z.boolean(), sucursal: z.string().optional(), fechaPago: z.string().optional() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin BD");
      const hoy = new Date().toISOString().slice(0, 10);
      const fecha = input.pagado ? (input.fechaPago || hoy) : null;
      await db.execute(sql`
        INSERT INTO gastos_registro (anioMes, nombre, categoria, monto, pagado, fechaPago, esOcasional, sucursal)
         VALUES (${input.anioMes}, ${input.nombre}, ${input.categoria}, ${input.monto}, ${input.pagado ? 1 : 0}, ${fecha}, 1, ${input.sucursal ?? null})
      `);
      return { success: true };
    }),

  // Eliminar un gasto del registro. Si es un fijo, opcionalmente elimina también
  // la plantilla (para que no se regenere el próximo mes).
  eliminar: protectedProcedure
    .input(z.object({ id: z.number(), eliminarPlantilla: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin BD");
      const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };

      // Ver si el gasto viene de una plantilla fija
      const g = rows(await db.execute(sql`SELECT gastoFijoId FROM gastos_registro WHERE id=${input.id} LIMIT 1`));
      const gastoFijoId = g[0]?.gastoFijoId;

      // Borrar el registro de este mes
      await db.execute(sql`DELETE FROM gastos_registro WHERE id=${input.id}`);

      // Si es fijo y se pide eliminar la plantilla, desactivarla (no se regenera más)
      if (gastoFijoId && input.eliminarPlantilla) {
        await db.execute(sql`UPDATE gastos_fijos SET activo=0 WHERE id=${gastoFijoId}`);
      }
      return { success: true, eraFijo: !!gastoFijoId };
    }),

  // Total de sueldos del mes (opcionalmente por sucursal, infiriendo del vendedor).
  sueldosDelMes: protectedProcedure
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
          const r: any = await db.execute(sql`
            SELECT DISTINCT vendedor FROM ventas WHERE nombreSucursal=${input.sucursal} AND vendedor IS NOT NULL
          `);
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
  editar: protectedProcedure
    .input(z.object({ id: z.number(), nombre: z.string(), categoria: z.string(), monto: z.number(), sucursal: z.string().optional(), anioMes: z.string().optional() }))
    .mutation(async ({ input }) => {
      const { getDb } = await import("./db");
      const { sql } = await import("drizzle-orm");
      const db = await getDb();
      if (!db) throw new Error("Sin BD");
      const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };

      // Ver el mes actual y si viene de una plantilla fija
      const actual = rows(await db.execute(sql`SELECT anioMes, gastoFijoId, nombre FROM gastos_registro WHERE id=${input.id} LIMIT 1`));
      const mesActual = actual[0]?.anioMes;
      const esFijo = actual[0]?.gastoFijoId != null;

      let setMes = sql``;
      if (input.anioMes && input.anioMes !== mesActual) {
        setMes = sql`, anioMes=${input.anioMes}`;
        // Si es un gasto fijo y se MUEVE a otro mes, eliminar en el mes destino
        // cualquier registro de la MISMA plantilla o mismo nombre (regenerado con
        // monto 0), para no duplicar. NO desvinculamos: delMes deduplica por nombre.
        if (esFijo) {
          const fijoId = actual[0].gastoFijoId;
          const nombreActual = String(actual[0].nombre || "").trim().toLowerCase();
          await db.execute(sql`
            DELETE FROM gastos_registro WHERE anioMes=${input.anioMes} AND id<>${input.id}
             AND (gastoFijoId=${fijoId} OR LOWER(TRIM(nombre))=${nombreActual})
          `);
        }
      }

      await db.execute(sql`
        UPDATE gastos_registro SET nombre=${input.nombre}, categoria=${input.categoria}, monto=${input.monto}, sucursal=${input.sucursal ?? null} ${setMes} WHERE id=${input.id}
      `);
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
  // Período: si la pregunta trae una fecha específica, antier o "hace N días",
  // se pasa el texto crudo (rangoFechas lo interpreta); si no, la clasificación simple.
  const tieneFechaEspecifica = /antier|anteayer|ante ayer|hace\s+\d+\s*d[ií]a|\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{1,2}\s+de\s+[a-záéíóú]+/.test(q);
  const periodo = tieneFechaEspecifica ? q
    : q.includes("hoy") ? "hoy" : q.includes("ayer") ? "ayer" : q.includes("semana") ? "semana"
    : (q.includes("mes anterior") || q.includes("mes pasado")) ? "mes anterior" : "mes";
  // Detectar sucursal mencionada en la pregunta
  let sucursal: string | undefined;
  if (q.includes("petrolera")) sucursal = "Petrolera";
  else if (q.includes("lanza")) sucursal = "Lanza";
  else if (q.includes("cobol")) sucursal = "Cobol";
  else if (q.includes("matriz") || q.includes("casa matriz") || q.includes("honduras") || q.includes("central")) sucursal = "Casa Matriz";

  const { asistenteTools } = await import("./asistente");

  // Resumen ejecutivo / cómo está el negocio
  if (q.includes("resumen") || q.includes("cómo está") || q.includes("como esta") || q.includes("cómo vamos") || q.includes("como vamos") || q.includes("parte del d") || q.includes("panorama")) {
    return { nombre: "resumenEjecutivo", resultado: await asistenteTools.resumenEjecutivo() };
  }
  // Comparar períodos / crecimiento
  if (q.includes("crecimiento") || (q.includes("compar") && (q.includes("mes") || q.includes("venta"))) || q.includes("vs") || q.includes("más que el mes")) {
    return { nombre: "compararPeriodos", resultado: await asistenteTools.compararPeriodos() };
  }
  // Capital muerto / sin rotación
  if (q.includes("no rota") || q.includes("sin rotac") || q.includes("estancad") || q.includes("plata parada") || q.includes("no se vende")) {
    return { nombre: "productosSinRotacion", resultado: await asistenteTools.productosSinRotacion() };
  }
  // Vencimientos
  if (q.includes("vence") || q.includes("vencimiento") || q.includes("por vencer") || q.includes("caduc")) {
    return { nombre: "vencimientosProximos", resultado: await asistenteTools.vencimientosProximos() };
  }
  // Margen por producto
  if (q.includes("margen") || q.includes("poco rentable") || q.includes("gano más") || q.includes("gano mas")) {
    const orden = (q.includes("alto") || q.includes("más rentable") || q.includes("gano")) && !q.includes("poco") ? "alto" : "bajo";
    return { nombre: "margenProductos", resultado: await asistenteTools.margenProductos(orden, sucursal) };
  }
  // Pedido / requerimiento de una sucursal según proveedor
  if (q.includes("pedido") || q.includes("requerimiento") || q.includes("que pedir a") || q.includes("qué pedir a")) {
    let prov: string | undefined;
    const mp = q.match(/(?:de|a|proveedor)\s+([a-záéíóúñ]+)(?:\s|$)/);
    // Buscar nombre de proveedor conocido en la pregunta (heurística simple)
    const posibles = q.match(/\b(inti|bago|bag[oó]|delta|vita|ifa|cofar|sigma|lafar|farmacorp)\b/);
    if (posibles) prov = posibles[1];
    // "para 15 días" / "de 15 dias" → cobertura personalizada (default 10 en la herramienta)
    const md = q.match(/(\d{1,2})\s*d[ií]as/);
    const dias = md ? parseInt(md[1], 10) : undefined;
    return { nombre: "pedidoSucursal", resultado: await asistenteTools.pedidoSucursal(sucursal, prov, dias) };
  }
  // Productos urgentes de reponer
  if (q.includes("reponer") || q.includes("urgente") || q.includes("qué pedir") || q.includes("que pedir") || q.includes("debo pedir") || (q.includes("poco stock") && q.includes("vend"))) {
    let prov: string | undefined;
    const mProv = q.match(/proveedor\s+(\w+)/);
    if (mProv) prov = mProv[1];
    return { nombre: "productosUrgentes", resultado: await asistenteTools.productosUrgentes(prov, sucursal) };
  }
  // Estado de pagos: "qué falta pagar", "a quién pagué", "qué servicios debo"
  if (q.includes("falta pagar") || q.includes("pagar") || q.includes("pagu") || q.includes("debo") || q.includes("pendiente")) {
    return { nombre: "estadoPagosGastos", resultado: await asistenteTools.estadoPagosGastos(undefined, sucursal) };
  }
  // Historial de compra: "a cuánto compré X", "precio más bajo de compra"
  if (q.includes("compr") || (q.includes("más bajo") && q.includes("pag"))) {
    const limpio = q.replace(/(a\s+cu[aá]nto|cu[aá]nto|compr[eé]|compra|precio|m[aá]s\s+bajo|pagu[eé]|de|del|la|el|los|las|mi|\u00faltima|ultima|\?|¿)/g, " ").replace(/\s+/g, " ").trim();
    if (limpio.length >= 2) {
      return { nombre: "historialCompraProducto", resultado: await asistenteTools.historialCompraProducto(limpio) };
    }
  }
  // Precio / cuánto cuesta un producto (precio de VENTA actual)
  if (q.includes("precio") || q.includes("cuesta") || q.includes("vale")) {
    const limpio = q.replace(/(cu[aá]nto|cuesta|precio|de|del|la|el|los|las|vale|costo|es|\?|¿)/g, " ").replace(/\s+/g, " ").trim();
    if (limpio.length >= 2) {
      return { nombre: "infoProducto", resultado: await asistenteTools.infoProducto(limpio) };
    }
  }
  // Stock / existencias
  if (q.includes("stock") || q.includes("unidades") || q.includes("existencia") || q.includes("cuántos tengo") || q.includes("cuantas tengo")) {
    const limpio = q.replace(/(cu[aá]nt[oa]s?|stock|unidades|existencias?|tengo|de|del|la|el|los|las|en|hay|\?|¿|petrolera|lanza|cobol|matriz|casa)/g, " ").replace(/\s+/g, " ").trim();
    if (limpio.length >= 2) {
      return { nombre: "stockProducto", resultado: await asistenteTools.stockProducto(limpio) };
    }
  }
  // Mejor vendedor (con sucursal si se mencionó)
  if (q.includes("mejor vendedor") || q.includes("mejor vendedora") || q.includes("quién vende") || q.includes("quien vende")) {
    return { nombre: "mejoresVendedores", resultado: await asistenteTools.mejoresVendedores(periodo, sucursal) };
  }
  // Faltantes / sobrantes de caja (va ANTES de ventas: "sobró de las ventas"
  // menciona 'venta' pero pregunta por la diferencia de caja)
  if (q.includes("faltante") || q.includes("sobrante") || q.includes("faltó") || q.includes("falto") ||
      q.includes("sobró") || q.includes("sobro") || q.includes("cuadr") ||
      (q.includes("caja") && (q.includes("diferencia") || q.includes("descuadr")))) {
    return { nombre: "diferenciasCaja", resultado: await asistenteTools.diferenciasCaja(periodo, sucursal) };
  }
  // Cuánto vendí (con sucursal si se mencionó)
  if (q.includes("vend") || q.includes("venta")) {
    return { nombre: "ventasPeriodo", resultado: await asistenteTools.ventasPeriodo(periodo, sucursal) };
  }
  // Cuánto gané
  if (q.includes("gan")) {
    return { nombre: "gananciaPeriodo", resultado: await asistenteTools.gananciaPeriodo(periodo, sucursal) };
  }
  return null;
}

// Ejecuta una herramienta del asistente por nombre con sus argumentos
// ─── MATRIZ DE PERMISOS por rol (deny by default) ───
// admin: todo. regente: asistente operativo + asistencias + inventarios (sin
// finanzas ni acciones). viewer (vendedor): stock, precios e info de productos.
const HERRAMIENTAS_REGENTE = new Set([
  "reservasPendientes",
  "stockProducto", "infoProducto", "listarSucursales", "cajasAbiertas",
  "vencimientosProximos", "productosUrgentes", "pedidoSucursal", "productosSinRotacion",
  "trabajadoresSucursal",
]);
const HERRAMIENTAS_VENDEDOR = new Set([
  "stockProducto", "infoProducto", "listarSucursales", "reservasPendientes",
]);
function herramientaPermitida(nombre: string, rol?: string): boolean {
  if (rol === "admin") return true;
  if (rol === "regente") return HERRAMIENTAS_REGENTE.has(nombre);
  if (rol === "viewer") return HERRAMIENTAS_VENDEDOR.has(nombre);
  return false; // rol "user" u otro: sin herramientas
}
// Compatibilidad: sigue existiendo para el filtro del fallback
const HERRAMIENTAS_SOLO_ADMIN = new Set([
  "gananciaPeriodo", "rentabilidadSucursales", "margenProductos", "compararPeriodos",
  "estadoPagosGastos", "resumenEjecutivo", "verAuditoria", "ventasPeriodo", "diferenciasCaja",
  "mejoresVendedores", "ventasCliente",
  "comprasProveedor", "historialCompraProducto",
]);

// Nombres de herramientas que requieren rol ADMIN (incluye acciones que modifican
// datos y consultas sensibles de negocio como segmentación/promociones).
const NOMBRES_SOLO_ADMIN_ASISTENTE = ["cambiarPrecioVenta", "aumentarStock", "marcarGastoPagado", "registrarGasto", "confirmarAccion", "cancelarAccion", "autorizarCorreo", "revocarCorreo", "verCorreosAutorizados", "ponerOferta", "quitarOferta", "crearCupon", "desactivarCupon", "crearPromoMonto", "verPromociones", "programaFidelidad", "sugerirOfertas", "segmentarClientes", "retirarProducto", "ocultarDeTienda"];
// Subconjunto que REALMENTE modifica datos (para el mensaje de fallback: no decir
// "la acción se procesó" cuando en realidad solo se hizo una consulta de lectura).
const NOMBRES_ACCIONES_QUE_MODIFICAN = ["cambiarPrecioVenta", "aumentarStock", "marcarGastoPagado", "registrarGasto", "confirmarAccion", "autorizarCorreo", "revocarCorreo", "ponerOferta", "quitarOferta", "crearCupon", "desactivarCupon", "crearPromoMonto", "retirarProducto", "ocultarDeTienda"];
// Herramientas de proponer/confirmar/cancelar una acción: su respuesta al usuario
// se construye DIRECTO de los datos que devuelven (nunca redactada libremente por
// el modelo) — ver "ATAJO DETERMINÍSTICO" más abajo.
const NOMBRES_BYPASS_REDACCION = [...NOMBRES_ACCIONES_QUE_MODIFICAN, "cancelarAccion"];

// Construye la respuesta final DIRECTO del resultado de una herramienta de acción,
// sin pasar por el modelo. Devuelve null si el resultado no tiene una forma
// reconocida (en ese caso, se usa la redacción normal como respaldo).
function respuestaDirectaAccion(resultado: any): string | null {
  if (!resultado || typeof resultado !== "object") return null;
  if (typeof resultado.error === "string") return `⚠️ ${resultado.error}`;
  if (resultado.ejecutada === true && typeof resultado.resultado === "string") return `✅ ${resultado.resultado}`;
  if (resultado.cancelada === true) return resultado.mensaje || "Propuesta cancelada. No se ejecutó nada.";
  if (resultado.estado === "PENDIENTE DE CONFIRMACIÓN" && typeof resultado.propuesta === "string") {
    return `${resultado.propuesta}\n\n¿Confirmas? Responde "sí" para aplicarlo o "no" para cancelar.`;
  }
  if (Array.isArray(resultado.opciones) && resultado.opciones.length > 0) {
    const lista = resultado.opciones.slice(0, 6).map((o: any, i: number) => {
      const extra = o.stockActual != null ? ` (stock: ${o.stockActual})` : o.precioActual ? ` (precio: ${o.precioActual})` : "";
      return `${i + 1}. ${o.nombre}${extra}`;
    }).join("\n");
    return `${resultado.mensaje || "Hay varias coincidencias, dime cuál exactamente:"}\n${lista}`;
  }
  return null;
}

async function ejecutarHerramienta(nombre: string, args: any, usuario?: { id?: string; name?: string; email?: string; role?: string }): Promise<any> {
  // SEGURIDAD: las ACCIONES (modifican datos) son solo para administradores.
  const esAccion = NOMBRES_SOLO_ADMIN_ASISTENTE.includes(nombre);
  if (esAccion && usuario?.role !== "admin") {
    return { error: "Solo el administrador puede ejecutar acciones. Tu usuario es de consulta." };
  }
  // SEGURIDAD: matriz de permisos por rol (deny by default).
  if (!herramientaPermitida(nombre, usuario?.role)) {
    const disponibles = usuario?.role === "regente"
      ? "stock, precios, info de productos, vencimientos, productos urgentes, pedidos, inventario sin rotación, cajas y asistencia del personal"
      : "stock, precios e información de productos";
    return { error: `Tu usuario no tiene permiso para esa consulta. Puedes consultar: ${disponibles}.` };
  }
  const { asistenteTools } = await import("./asistente");
  try {
    switch (nombre) {
      case "ventasPeriodo": return await asistenteTools.ventasPeriodo(args.periodo, args.sucursal);
      case "diferenciasCaja": return await asistenteTools.diferenciasCaja(args.periodo, args.sucursal);
      case "comprasProveedor": return await asistenteTools.comprasProveedor(args.proveedor, args.periodo);
      case "productoMasVendido": return await asistenteTools.productoMasVendido(args.periodo, args.porValor);
      case "gananciaPeriodo": return await asistenteTools.gananciaPeriodo(args.periodo, args.sucursal);
      case "infoProducto": return await asistenteTools.infoProducto(args.nombre, args.incluirCodigo === true);
      case "ventasCliente": return await asistenteTools.ventasCliente(args.cliente, args.periodo);
      case "trabajadoresSucursal": return await asistenteTools.trabajadoresSucursal(args.sucursal);
      case "mejoresVendedores": return await asistenteTools.mejoresVendedores(args.periodo, args.sucursal);
      case "listarSucursales": return await asistenteTools.listarSucursales();
      case "stockProducto": return await asistenteTools.stockProducto(args.nombre, args.almacen);
      case "cajasAbiertas": return await asistenteTools.cajasAbiertas();
      case "historialCompraProducto": return await asistenteTools.historialCompraProducto(args.nombre);
      case "rentabilidadSucursales": return await asistenteTools.rentabilidadSucursales(args.periodo);
      case "estadoPagosGastos": return await asistenteTools.estadoPagosGastos(args.periodo, args.sucursal);
      case "productosUrgentes": return await asistenteTools.productosUrgentes(args.proveedor, args.sucursal);
      case "pedidoSucursal": return await asistenteTools.pedidoSucursal(args.sucursal, args.proveedor, args.dias);
      case "compararPeriodos": return await asistenteTools.compararPeriodos(args.mesA, args.mesB);
      case "productosSinRotacion": return await asistenteTools.productosSinRotacion(args.mesesSinVenta, args.proveedor);
      case "vencimientosProximos": return await asistenteTools.vencimientosProximos(args.meses);
      case "margenProductos": return await asistenteTools.margenProductos(args.orden, args.sucursal);
      case "resumenEjecutivo": return await asistenteTools.resumenEjecutivo();
      case "usoIA": return await asistenteTools.usoIA(args.dias);
      case "buscarContacto": return await asistenteTools.buscarContacto(args.consulta, args.tipo);
      case "cambiarPrecioVenta": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.cambiarPrecioVenta(args.nombreProducto, args.nuevoPrecio); }
      case "aumentarStock": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.aumentarStock(args.nombreProducto, args.sucursal, args.cantidad, args.nuevoTotal); }
      case "marcarGastoPagado": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.marcarGastoPagado(args.nombreGasto, args.sucursal); }
      case "registrarGasto": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.registrarGasto(args.nombre, args.monto, args.sucursal, args.categoria, args.yaPagado); }
      case "confirmarAccion": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.confirmarAccion(usuario); }
      case "cancelarAccion": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.cancelarAccion(); }
      case "verAuditoria": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.verAuditoria(args.limite); }
      case "autorizarCorreo": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.autorizarCorreo(args.email, args.rol); }
      case "revocarCorreo": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.revocarCorreo(args.email); }
      case "verCorreosAutorizados": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.verCorreosAutorizados(); }
      case "reservasPendientes": { const { tienda } = await import("./tienda"); return await tienda.reservasPendientes(); }
      case "programaFidelidad": { const { resumenFidelidad } = await import("./puntos-fidelidad"); return await resumenFidelidad(); }
      case "sugerirOfertas": { const { asistenteTools } = await import("./asistente"); return await asistenteTools.sugerirOfertas(); }
      case "segmentarClientes": { const { asistenteTools } = await import("./asistente"); return await asistenteTools.segmentarClientes(); }
      case "ponerOferta": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.ponerOferta(args.nombreProducto, args.precioOferta, args.hastaFecha); }
      case "quitarOferta": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.quitarOferta(args.nombreProducto); }
      case "crearCupon": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.crearCupon(args.codigo, args.tipo, args.valor, args.minimo, args.usosMax, args.hastaFecha); }
      case "desactivarCupon": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.desactivarCupon(args.codigo); }
      case "crearPromoMonto": { const { accionesTools } = await import("./asistente-acciones"); return await accionesTools.crearPromoMonto(args.descripcion, args.minimo, args.pctDescuento, args.hastaFecha); }
      case "verPromociones": { const { promociones } = await import("./promociones"); return await promociones.listar(); }
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

  // Transcribe audio grabado en el navegador (voz → texto) con Groq Whisper.
  // Más confiable que el reconocimiento de voz del navegador: funciona igual
  // en cualquier navegador/dispositivo y entiende mejor nombres de productos.
  transcribir: protectedProcedure
    .input(z.object({ audioBase64: z.string(), mimeType: z.string() }))
    .mutation(async ({ input }) => {
      try {
        const { transcribirAudio } = await import("./_core/llm");
        const buffer = Buffer.from(input.audioBase64, "base64");
        const texto = await transcribirAudio(buffer, input.mimeType);
        if (!texto.trim()) return { texto: "", error: "No se entendió el audio. Intenta de nuevo." };
        return { texto: texto.trim() };
      } catch (e: any) {
        return { texto: "", error: e?.message || "No se pudo transcribir el audio." };
      }
    }),

  preguntar: protectedProcedure
    .input(z.object({
      pregunta: z.string(),
      modoVoz: z.boolean().optional(),
      historial: z.array(z.object({
        rol: z.enum(["user", "assistant"]),
        texto: z.string(),
      })).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const usuarioActual = (ctx as any)?.user;
      const { invokeDeepSeek, deepseekDisponible } = await import("./_core/deepseek");

      // Si DeepSeek no está configurado, avisar claramente
      if (!deepseekDisponible()) {
        return { respuesta: "El asistente aún no está configurado (falta la clave de DeepSeek). Avisa al administrador para activarlo.", error: true };
      }

      // Atajo determinístico para confirmar/cancelar una acción pendiente: NO se
      // delega al modelo (a veces falla al elegir la herramienta o filtra texto
      // crudo de function-calling). Si hay una propuesta pendiente, se juzga por
      // la PRIMERA PALABRA del mensaje (no el mensaje exacto), para cubrir
      // respuestas naturales como "sí, hazlo" o "sí dale nomás".
      const qNorm = input.pregunta.trim().toLowerCase().replace(/[.!¡¿?,]/g, "");
      const primeraPalabra = qNorm.split(/\s+/)[0] || "";
      const esConfirmacion = /^(s[ií]|confirmo|confirmar|dale|hazlo|adelante|procede|correcto|ok|okay|claro|afirmativo)$/.test(primeraPalabra);
      const esCancelacion = /^(no|cancela|cancelar|olv[ií]dalo|detente|espera)$/.test(primeraPalabra);
      if (esConfirmacion || esCancelacion) {
        const { accionesTools } = await import("./asistente-acciones");
        if (await accionesTools.hayPendiente()) {
          if (esConfirmacion) {
            const r = await accionesTools.confirmarAccion(usuarioActual);
            return { respuesta: r.error || `✅ ${r.resultado}`, usoHerramienta: "confirmarAccion" };
          } else {
            const r = await accionesTools.cancelarAccion();
            return { respuesta: r.error || r.mensaje, usoHerramienta: "cancelarAccion" };
          }
        }
      }

      // PREFIJO ESTABLE (para caché de contexto de DeepSeek): system + tools
      // SIEMPRE idénticos y al inicio. El contenido variable (pregunta) va al final.
      const systemPrompt = `Asistente de VidaFarma (farmacia, Cochabamba, Bolivia). Responde en español, breve, directo y profesional. Respuestas CORTAS: ve al grano, sin rodeos ni repetir lo que ya sabe el usuario. Evita párrafos largos — 1-3 frases o una lista corta, salvo que pidan detalle.

REGLA ABSOLUTA — NO INVENTAR: Solo puedes mencionar nombres, cifras, productos, trabajadores o datos que provengan EXACTAMENTE de los resultados de las herramientas. Está PROHIBIDO inventar o completar datos. Si una herramienta devuelve vacío, pocos datos o un mensaje de "no disponible", di EXACTAMENTE eso ("No tengo esa información disponible" o el mensaje que devolvió la herramienta). NUNCA inventes nombres de personas ni tablas de trabajadores. Si no estás seguro, di que no tienes el dato.

REGLA ABSOLUTA — CÓDIGO DE PRODUCTO: nunca menciones el código de un producto (ej. "TR8888") a menos que el usuario lo pida explícitamente. No es un dato relevante para el trabajo diario.

REGLA ABSOLUTA — ACCIONES, UNA SOLA CONFIRMACIÓN: si el usuario pide MODIFICAR algo (cambiar/subir/bajar precio, cambiar/aumentar stock, marcar gasto pagado, registrar gasto, poner/quitar oferta, crear/desactivar cupón), DEBES invocar la herramienta de acción correspondiente INMEDIATAMENTE, en esta misma respuesta — sin preguntar antes en texto libre si desea continuar. La HERRAMIENTA ya genera la pregunta de confirmación por ti; NUNCA hagas tú una pregunta de confirmación previa a mano ("¿confirmas que...?", "¿deseas continuar?") — eso obliga al usuario a confirmar DOS veces. Está PROHIBIDO escribir frases como "procedo a cambiar", "voy a actualizar" o "ya se hizo" sin haber invocado la herramienta — esas palabras sin la herramienta invocada NO producen ningún cambio real y confunden al usuario. Si necesitas datos primero (ej. el stock actual), invoca la herramienta de consulta Y la de acción en la MISMA respuesta, una tras otra. Si el usuario da un valor OBJETIVO final (ej. "cambia el stock A 700", "que quede en 700"), usa el parámetro correspondiente para el valor final (ej. nuevoTotal) en vez de calcular tú la diferencia.

Para comparar sucursales usa una sola llamada. Nunca escribas funciones como texto. Solo lectura. Montos en Bs.

SUCURSALES: Petrolera, Lanza, Cobol (nombre completo "Casa Matriz Cobol" — "Cobol" o "Sucursal Cobol" es la misma) y Casa Matriz (también conocida como "Honduras" o "Central" — son la misma sucursal; si el usuario dice "Honduras" o "Central" trátalo como Casa Matriz).`;

      const tools = [
        { type: "function" as const, function: { name: "ventasPeriodo", description: "Ventas en un período, opcional por sucursal. El período acepta: hoy, ayer, antier/anteayer, 'hace N días', semana, mes, mes anterior, un mes YYYY-MM, o una FECHA ESPECÍFICA (YYYY-MM-DD, DD/MM/YYYY, o 'DD de <mes>' como '15 de junio'). Pasa la fecha tal como la dijo el usuario.", parameters: { type: "object", properties: { periodo: { type: "string" }, sucursal: { type: "string" } }, required: ["periodo"] } } },
        { type: "function" as const, function: { name: "diferenciasCaja", description: "Faltantes y sobrantes de caja (dinero que no cuadró en los cierres de turno) en un período, opcional por sucursal. Úsala cuando pregunten por faltantes, sobrantes, si cuadró la caja, o diferencias de dinero.", parameters: { type: "object", properties: { periodo: { type: "string" }, sucursal: { type: "string" } }, required: ["periodo"] } } },
        { type: "function" as const, function: { name: "comprasProveedor", description: "Compras a un proveedor en un período.", parameters: { type: "object", properties: { proveedor: { type: "string" }, periodo: { type: "string" } }, required: ["proveedor", "periodo"] } } },
        { type: "function" as const, function: { name: "productoMasVendido", description: "Productos más vendidos en un período.", parameters: { type: "object", properties: { periodo: { type: "string" }, porValor: { type: "boolean" } }, required: ["periodo"] } } },
        { type: "function" as const, function: { name: "gananciaPeriodo", description: "Ganancia de un período: bruta y NETA (descontando gastos del mes). Opcional por sucursal.", parameters: { type: "object", properties: { periodo: { type: "string" }, sucursal: { type: "string" } }, required: ["periodo"] } } },
        { type: "function" as const, function: { name: "infoProducto", description: "Precio/costo de un producto por su nombre. Por defecto NO incluye el código del producto — usa incluirCodigo=true SOLO si el usuario pidió explícitamente el código.", parameters: { type: "object", properties: { nombre: { type: "string" }, incluirCodigo: { type: "boolean" } }, required: ["nombre"] } } },
        { type: "function" as const, function: { name: "ventasCliente", description: "Productos vendidos a un cliente.", parameters: { type: "object", properties: { cliente: { type: "string" }, periodo: { type: "string" } }, required: ["cliente"] } } },
        { type: "function" as const, function: { name: "trabajadoresSucursal", description: "Trabajadores de una sucursal.", parameters: { type: "object", properties: { sucursal: { type: "string" } }, required: ["sucursal"] } } },
        { type: "function" as const, function: { name: "mejoresVendedores", description: "Mejores vendedores en un período.", parameters: { type: "object", properties: { periodo: { type: "string" }, sucursal: { type: "string" } }, required: ["periodo"] } } },
        { type: "function" as const, function: { name: "listarSucursales", description: "Lista las sucursales.", parameters: { type: "object", properties: {} } } },
        { type: "function" as const, function: { name: "stockProducto", description: "Stock/existencias actuales de un producto en tiempo real, por almacén. Si se da un almacén (petrolera, lanza, cobol, principal/matriz/honduras/central) muestra solo ese; si no, muestra todos.", parameters: { type: "object", properties: { nombre: { type: "string" }, almacen: { type: "string" } }, required: ["nombre"] } } },
        { type: "function" as const, function: { name: "cajasAbiertas", description: "Quién tiene caja abierta ahora mismo y en qué sucursal (tiempo real). Úsala para 'quién está vendiendo', 'quién abrió caja', 'quién está en cada sucursal ahora'.", parameters: { type: "object", properties: {} } } },
        { type: "function" as const, function: { name: "historialCompraProducto", description: "A cuánto se compró un producto: precio más bajo registrado y la última compra (avisa si la última fue la más baja).", parameters: { type: "object", properties: { nombre: { type: "string" } }, required: ["nombre"] } } },
        { type: "function" as const, function: { name: "rentabilidadSucursales", description: "Rentabilidad/ganancia neta por sucursal: ingresos, costo, sueldos (por asistencia) y gastos de cada sucursal. Úsala para 'ganancia por sucursal', 'cuánto gana cada sucursal', 'qué sucursal es más rentable'.", parameters: { type: "object", properties: { periodo: { type: "string" } }, required: ["periodo"] } } },
        { type: "function" as const, function: { name: "estadoPagosGastos", description: "Qué gastos ya se pagaron y cuáles faltan pagar (alquiler, luz, internet, etc.), por sucursal. Úsala para 'qué falta pagar', 'a quién ya pagué', 'qué servicios debo'.", parameters: { type: "object", properties: { periodo: { type: "string" }, sucursal: { type: "string" } } } } },
        { type: "function" as const, function: { name: "productosUrgentes", description: "Productos urgentes de reponer: los más vendidos el mes pasado que tienen poco stock. Opcional por proveedor y por sucursal. Úsala para 'qué reponer', 'qué pedir', 'productos urgentes de X proveedor'.", parameters: { type: "object", properties: { proveedor: { type: "string" }, sucursal: { type: "string" } } } } },
        { type: "function" as const, function: { name: "pedidoSucursal", description: "Genera el PEDIDO/requerimiento de una sucursal según proveedor: qué productos pedir y cuánto para cubrir N días de venta (default 10), usando la rotación real (ventas de 3 meses vs stock actual del almacén). Úsala para 'pedido de cofar de la petrolera', 'requerimiento de X sucursal', 'qué pedir a X proveedor para Y sucursal', 'pedido de Z para 15 días'.", parameters: { type: "object", properties: { sucursal: { type: "string" }, proveedor: { type: "string" }, dias: { type: "number", description: "Días de venta a cubrir. Default 10." } } } } },
        { type: "function" as const, function: { name: "compararPeriodos", description: "Compara ventas entre dos meses con % de crecimiento total y por sucursal. Por defecto: los dos últimos meses concluidos. Úsala para 'vendí más este mes?', 'cómo va junio vs mayo', 'crecimiento de ventas'.", parameters: { type: "object", properties: { mesA: { type: "string", description: "YYYY-MM más reciente" }, mesB: { type: "string", description: "YYYY-MM anterior" } } } } },
        { type: "function" as const, function: { name: "productosSinRotacion", description: "Capital muerto: productos con stock que NO se venden hace N meses (default 3), con valor inmovilizado. Úsala para 'qué no rota', 'plata parada', 'productos estancados', 'qué no se vende'.", parameters: { type: "object", properties: { mesesSinVenta: { type: "number" }, proveedor: { type: "string" } } } } },
        { type: "function" as const, function: { name: "vencimientosProximos", description: "Productos comprados que vencen en los próximos N meses (default 4), según fechas registradas en compras. Úsala para 'qué vence pronto', 'vencimientos', 'productos por vencer'.", parameters: { type: "object", properties: { meses: { type: "number" } } } } },
        { type: "function" as const, function: { name: "margenProductos", description: "Margen de ganancia por producto (vendidos el mes pasado): con orden 'bajo' muestra los que casi no dejan ganancia (revisar precios), con 'alto' los más rentables. Úsala para 'qué productos me dejan poco margen', 'dónde gano más', 'productos poco rentables'.", parameters: { type: "object", properties: { orden: { type: "string", description: "'bajo' o 'alto'" }, sucursal: { type: "string" } } } } },
        { type: "function" as const, function: { name: "retirarProducto", description: "RETIRA un producto de circulación en una sucursal dejando su stock en 0 (deja de venderse). Úsala cuando pidan 'eliminar', 'borrar', 'sacar' o 'dar de baja' un producto: inventarios365 NO permite borrar productos del catálogo (y borrarlos rompería el historial de ventas), así que esto es el equivalente real y reversible. Requiere la sucursal.", parameters: { type: "object", properties: { nombreProducto: { type: "string" }, sucursal: { type: "string" } }, required: ["nombreProducto", "sucursal"] } } },
        { type: "function" as const, function: { name: "ocultarDeTienda", description: "Oculta un producto de la TIENDA ONLINE (deja de verlo el cliente). No toca el stock ni la venta en mostrador; es reversible. Úsala para 'sacar de la tienda', 'que no aparezca en la web'.", parameters: { type: "object", properties: { nombreProducto: { type: "string" } }, required: ["nombreProducto"] } } },
        { type: "function" as const, function: { name: "buscarContacto", description: "Teléfono de un cliente o proveedor del directorio por su nombre o empresa. Úsala para 'dame el número de X', 'el celular de la empresa Y', 'contacto de Z'.", parameters: { type: "object", properties: { consulta: { type: "string" }, tipo: { type: "string", enum: ["cliente", "proveedor"] } }, required: ["consulta"] } } },
        { type: "function" as const, function: { name: "usoIA", description: "Uso y costo del propio asistente de IA (llamadas, tokens, % de cache y costo estimado en USD). Úsala para 'cuánto gastamos en IA', 'costo del asistente', 'uso de DeepSeek'.", parameters: { type: "object", properties: { dias: { type: "number" } } } } },
        { type: "function" as const, function: { name: "resumenEjecutivo", description: "Parte ejecutivo del negocio en una sola consulta: ventas de HOY por sucursal, ritmo del mes (acumulado vs mes anterior al mismo día), pagos pendientes, vencimientos a 30 días y cajas abiertas. Úsala para 'cómo está el negocio', 'resumen del día', 'cómo vamos', 'dame el parte'.", parameters: { type: "object", properties: {} } } },
        { type: "function" as const, function: { name: "cambiarPrecioVenta", description: "ACCIÓN (requiere confirmación): propone cambiar el precio de venta de un producto. NO se ejecuta hasta que el usuario confirme. Úsala cuando pidan 'cambia el precio de X a Y'.", parameters: { type: "object", properties: { nombreProducto: { type: "string" }, nuevoPrecio: { type: "number" } }, required: ["nombreProducto", "nuevoPrecio"] } } },
        { type: "function" as const, function: { name: "aumentarStock", description: "ACCIÓN (requiere confirmación): propone AUMENTAR el stock de un producto en una sucursal (Petrolera, Lanza, Cobol o Casa Matriz/Honduras/Central) — para correcciones o entradas que no son compra ni transferencia. SIEMPRE debes invocar esta herramienta para proponer el cambio — nunca digas 'procedo a cambiar' o similar sin haberla llamado. NO se ejecuta hasta que el usuario confirme.", parameters: { type: "object", properties: { nombreProducto: { type: "string" }, sucursal: { type: "string" }, cantidad: { type: "number", description: "Unidades a AGREGAR al stock actual. Usa esto si el usuario dice 'agrega/aumenta N unidades'." }, nuevoTotal: { type: "number", description: "El stock FINAL deseado (valor objetivo). Usa esto si el usuario dice 'cambia/pon el stock A N' — así no calculas tú la diferencia, la herramienta lo hace con el stock real actual." } }, required: ["nombreProducto", "sucursal"] } } },
        { type: "function" as const, function: { name: "marcarGastoPagado", description: "ACCIÓN (requiere confirmación): propone marcar como pagado un gasto pendiente del mes (alquiler, luz, etc.). Úsala cuando digan 'ya pagué X', 'marca como pagado X'.", parameters: { type: "object", properties: { nombreGasto: { type: "string" }, sucursal: { type: "string" } }, required: ["nombreGasto"] } } },
        { type: "function" as const, function: { name: "registrarGasto", description: "ACCIÓN (requiere confirmación): propone registrar un gasto ocasional del mes. Úsala cuando digan 'registra un gasto de X por Y Bs'.", parameters: { type: "object", properties: { nombre: { type: "string" }, monto: { type: "number" }, sucursal: { type: "string" }, categoria: { type: "string" }, yaPagado: { type: "boolean" } }, required: ["nombre", "monto"] } } },
        { type: "function" as const, function: { name: "confirmarAccion", description: "Ejecuta la acción pendiente de confirmación. Úsala SOLO cuando el usuario confirme explícitamente ('sí', 'confirmo', 'dale', 'hazlo').", parameters: { type: "object", properties: {} } } },
        { type: "function" as const, function: { name: "cancelarAccion", description: "Cancela la acción pendiente. Úsala cuando el usuario diga 'no', 'cancela', 'mejor no'.", parameters: { type: "object", properties: {} } } },
        { type: "function" as const, function: { name: "verAuditoria", description: "Muestra las últimas acciones ejecutadas por el asistente (auditoría: qué se cambió, cuándo, valores antes/después). Úsala para 'qué acciones hiciste', 'auditoría', 'historial de cambios'.", parameters: { type: "object", properties: { limite: { type: "number" } } } } },
        { type: "function" as const, function: { name: "autorizarCorreo", description: "ACCIÓN (requiere confirmación): autoriza un correo de Google para entrar al sistema. Roles: 'viewer' = vendedor (stock y precios), 'regente' = asistente operativo + asistencias + inventarios, 'admin' = acceso total. Úsala para 'autoriza el correo X como vendedor/regente/admin'.", parameters: { type: "object", properties: { email: { type: "string" }, rol: { type: "string" } }, required: ["email"] } } },
        { type: "function" as const, function: { name: "revocarCorreo", description: "ACCIÓN (requiere confirmación): revoca el acceso de un correo (ya no podrá entrar con Google). Úsala para 'quita el acceso a X', 'revoca el correo X'.", parameters: { type: "object", properties: { email: { type: "string" } }, required: ["email"] } } },
        { type: "function" as const, function: { name: "verCorreosAutorizados", description: "Lista los correos autorizados a entrar con Google y su rol. Úsala para 'qué correos tienen acceso', 'lista de usuarios autorizados'.", parameters: { type: "object", properties: {} } } },
        { type: "function" as const, function: { name: "reservasPendientes", description: "Reservas de CLIENTES de la tienda pública pendientes de recoger (código, producto, sucursal, cliente, teléfono). Úsala para 'hay reservas?', 'reservas pendientes', 'qué reservaron los clientes'.", parameters: { type: "object", properties: {} } } },
        { type: "function" as const, function: { name: "programaFidelidad", description: "Resumen del programa de puntos de fidelidad: clientes inscritos, puntos activos, vales generados y los mejores clientes. Úsala para 'cómo va la fidelización', 'programa de puntos', 'mejores clientes'.", parameters: { type: "object", properties: {} } } },
        { type: "function" as const, function: { name: "sugerirOfertas", description: "MARKETING: sugiere qué productos poner en OFERTA cruzando vencimiento próximo + rotación de ventas + margen (precio sugerido sin bajar del costo). Úsala para 'qué pongo en oferta', 'sugerencias de ofertas', 'productos por vencer para ofertar', 'cómo reduzco merma'.", parameters: { type: "object", properties: {} } } },
        { type: "function" as const, function: { name: "segmentarClientes", description: "MARKETING: segmenta a los clientes (con teléfono) en grupos accionables: frecuentes (4+ compras), alto valor (gasto 90 días), inactivos (45+ días sin volver) y nuevos (primera compra <30 días), con acciones sugeridas de campaña. Úsala para 'segmenta mis clientes', 'clientes inactivos', 'mejores clientes para campaña', 'a quién le mando promociones'.", parameters: { type: "object", properties: {} } } },
        { type: "function" as const, function: { name: "ponerOferta", description: "ACCIÓN (requiere confirmación): pone un producto en OFERTA en la tienda de clientes, con precio rebajado y fecha límite opcional (YYYY-MM-DD). Úsala para 'pon en oferta X a Y Bs', 'oferta de la semana'.", parameters: { type: "object", properties: { nombreProducto: { type: "string" }, precioOferta: { type: "number" }, hastaFecha: { type: "string" } }, required: ["nombreProducto", "precioOferta"] } } },
        { type: "function" as const, function: { name: "quitarOferta", description: "ACCIÓN (requiere confirmación): quita una oferta de la tienda. Úsala para 'quita la oferta de X'.", parameters: { type: "object", properties: { nombreProducto: { type: "string" } }, required: ["nombreProducto"] } } },
        { type: "function" as const, function: { name: "crearCupon", description: "ACCIÓN (confirmación): crea un cupón de descuento para la tienda. tipo 'pct' (porcentaje) o 'monto' (Bs fijos). Opcional: minimo (compra mínima), usosMax (límite de usos), hastaFecha (YYYY-MM-DD). Úsala para 'crea un cupón X de 10%', 'cupón de 20 Bs con compra mínima de 100'.", parameters: { type: "object", properties: { codigo: { type: "string" }, tipo: { type: "string" }, valor: { type: "number" }, minimo: { type: "number" }, usosMax: { type: "number" }, hastaFecha: { type: "string" } }, required: ["codigo", "tipo", "valor"] } } },
        { type: "function" as const, function: { name: "desactivarCupon", description: "ACCIÓN (confirmación): desactiva un cupón. Úsala para 'desactiva el cupón X'.", parameters: { type: "object", properties: { codigo: { type: "string" } }, required: ["codigo"] } } },
        { type: "function" as const, function: { name: "crearPromoMonto", description: "ACCIÓN (confirmación): crea una promoción automática por monto de compra ('X% en compras desde Bs Y'). Se aplica sola en el carrito. Úsala para 'promoción de 10% en compras sobre 150 Bs'.", parameters: { type: "object", properties: { descripcion: { type: "string" }, minimo: { type: "number" }, pctDescuento: { type: "number" }, hastaFecha: { type: "string" } }, required: ["minimo", "pctDescuento"] } } },
        { type: "function" as const, function: { name: "verPromociones", description: "Lista los cupones y promociones activas de la tienda. Úsala para 'qué cupones hay', 'promociones activas'.", parameters: { type: "object", properties: {} } } },
      ];

      // Directiva de modo voz: va en el mensaje VARIABLE (no en el prefijo estable
      // de systemPrompt/tools) para no romper el caché de contexto de DeepSeek.
      const directivaVoz = input.modoVoz
        ? " [MODO VOZ: esta pregunta llegó hablada y la respuesta se leerá en voz alta. Responde en 1-2 frases cortas y directas, sin markdown (nada de ** ni listas), como si hablaras.]"
        : "";

      const mensajes: any[] = [
        { role: "system", content: systemPrompt },
        ...(input.historial || []).slice(-10).map(h => ({ role: h.rol, content: h.texto })),
        { role: "user", content: `[Fecha actual: ${new Date().toLocaleDateString("es-BO", { day: "numeric", month: "long", year: "numeric" })}]${directivaVoz} ${input.pregunta}` },
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
          // Red de seguridad: si el modelo escribió funciones como texto (DSML/tool_calls,
          // invoke name=..., <function...>), no intentamos parsear sus nombres (suele
          // inventarlos). En su lugar, detectamos la INTENCIÓN de la pregunta y ejecutamos
          // la herramienta correcta directamente.
          const pareceFuncionTexto = /DSML|tool_calls|invoke\s+name=|<function|<\uff5c/i.test(textoRaw);
          if (pareceFuncionTexto) {
            let fallback = await intentarHerramientaPorIntencion(input.pregunta);
            if (fallback && !herramientaPermitida(fallback.nombre, usuarioActual?.role)) {
              fallback = { nombre: fallback.nombre, resultado: { error: "Tu usuario no tiene permiso para esa consulta." } };
            }
            if (fallback) {
              const r3 = await invokeDeepSeek({ maxTokens: 1024, messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: input.pregunta },
                { role: "assistant", content: `Datos: ${JSON.stringify(fallback.resultado)}` },
                { role: "user", content: "Redacta la respuesta final breve en español con esos datos. No escribas funciones." },
              ]});
              return { respuesta: r3.choices?.[0]?.message?.content || "No pude redactar la respuesta.", usoHerramienta: fallback.nombre };
            }
            // Si no detectamos intención, dar un mensaje útil en vez del texto crudo
            return { respuesta: "No pude procesar bien esa consulta. ¿Puedes reformularla? Por ejemplo: \"ventas de hoy por sucursal\".", usoHerramienta: null };
          }
          return { respuesta: textoRaw || "No pude generar una respuesta.", usoHerramienta: null };
        }

        // Ejecutar las herramientas que pidió
        mensajes.push({ role: "assistant", content: msg?.content || "", tool_calls: toolCalls });
        const herramientasUsadas: string[] = [];
        const resultadosPorHerramienta: { nombre: string; resultado: any }[] = [];
        for (const tc of toolCalls) {
          const nombre = tc.function?.name;
          let args: any = {};
          try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
          herramientasUsadas.push(nombre);
          const resultado = await ejecutarHerramienta(nombre, args, usuarioActual);
          resultadosPorHerramienta.push({ nombre, resultado });
          mensajes.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(resultado) });
        }

        // ATAJO DETERMINÍSTICO: si se llamó una herramienta de PROPONER/CONFIRMAR/
        // CANCELAR una acción, la respuesta se construye DIRECTO de sus datos reales
        // — sin pasar por la segunda llamada al modelo. Esto evita dos problemas
        // reales que ocurrieron: (1) el modelo "narraba" que iba a hacer un cambio
        // sin haber invocado la herramienta (ahora es imposible: si no se llamó la
        // herramienta, no hay texto de confirmación que mostrar), y (2) la fuga de
        // tokens internos del modelo podía perder el mensaje de confirmación.
        const ultimaAccion = [...resultadosPorHerramienta].reverse().find((r) => NOMBRES_BYPASS_REDACCION.includes(r.nombre));
        if (ultimaAccion) {
          const directa = respuestaDirectaAccion(ultimaAccion.resultado);
          if (directa) {
            return { respuesta: directa, usoHerramienta: herramientasUsadas.join(", ") };
          }
        }

        // Segunda llamada: el modelo redacta la respuesta final con los datos
        const instruccionRedaccion = "Redacta usando ÚNICAMENTE los datos de las herramientas anteriores. No agregues nombres, filas ni cifras que no estén en esos datos. Si los datos están vacíos, dilo. SÉ BREVE: 1-3 frases o una lista corta, sin rodeos. NUNCA menciones el código del producto salvo que el usuario lo haya pedido explícitamente."
          + (input.modoVoz ? " MODO VOZ: 1-2 frases cortas y directas, sin markdown ni listas, como si hablaras en voz alta." : "");
        mensajes.push({ role: "system", content: instruccionRedaccion });
        const r2 = await invokeDeepSeek({ messages: mensajes, maxTokens: 1024 });
        const respuestaCruda = r2.choices?.[0]?.message?.content || "Obtuve los datos pero no pude redactar la respuesta.";
        // Defensa: si el modelo filtró tokens internos (ej. intento de otra
        // invocación) al final del texto, RESCATAMOS lo que alcanzó a redactar
        // antes de la fuga en vez de descartar toda la respuesta.
        const patronFuga = /DSML|tool_calls|invoke\s+name=|<function|<｜/i;
        const idxFuga = respuestaCruda.search(patronFuga);
        const rescatado = idxFuga > 0 ? respuestaCruda.slice(0, idxFuga).trim() : "";
        const seModificaronDatos = herramientasUsadas.some((n) => NOMBRES_ACCIONES_QUE_MODIFICAN.includes(n));
        let respuesta: string;
        if (idxFuga < 0) {
          respuesta = respuestaCruda; // sin fuga, todo normal
        } else if (rescatado.length >= 15) {
          respuesta = rescatado; // se alcanzó a redactar algo útil antes de la fuga: usarlo
        } else {
          // Nada útil que rescatar: mensaje honesto según si hubo una acción o solo consulta
          respuesta = seModificaronDatos
            ? "La acción se procesó, pero no pude redactar el mensaje final. Escribe \"muéstrame la auditoría\" para confirmar qué se hizo."
            : "Encontré los datos pero tuve un problema para redactar la respuesta. Vuelve a hacer la pregunta, por favor — no se modificó nada.";
        }
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

// ─── Fidelización de clientes crónicos ───────────────────────────────────────

const soloAdminMkt = (ctx: any) => {
  if (ctx?.user?.role !== "admin") throw new Error("Solo el administrador puede gestionar marketing.");
};

const marketingRouter = router({
  tipos: protectedProcedure.query(async ({ ctx }) => {
    soloAdminMkt(ctx);
    const { tiposDePost } = await import("./marketing");
    return { tipos: tiposDePost };
  }),
  generar: protectedProcedure
    .input(z.object({ tipo: z.string().max(40), indicaciones: z.string().max(500).optional() }))
    .mutation(async ({ input, ctx }) => {
      soloAdminMkt(ctx);
      const { generarPost } = await import("./marketing");
      return generarPost(input.tipo, input.indicaciones);
    }),
  listar: protectedProcedure
    .input(z.object({ estado: z.string().max(20).optional() }).optional())
    .query(async ({ input, ctx }) => {
      soloAdminMkt(ctx);
      const { marketing } = await import("./marketing");
      return marketing.listar(input?.estado);
    }),
  editar: protectedProcedure
    .input(z.object({ id: z.number(), titulo: z.string().max(200).optional(), contenido: z.string().max(4000).optional(), hashtags: z.string().max(400).optional() }))
    .mutation(async ({ input, ctx }) => {
      soloAdminMkt(ctx);
      const { marketing } = await import("./marketing");
      return marketing.editar(input.id, input);
    }),
  cambiarEstado: protectedProcedure
    .input(z.object({ id: z.number(), estado: z.string().max(20) }))
    .mutation(async ({ input, ctx }) => {
      soloAdminMkt(ctx);
      const { marketing } = await import("./marketing");
      return marketing.cambiarEstado(input.id, input.estado);
    }),
  publicar: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      soloAdminMkt(ctx);
      const { marketing } = await import("./marketing");
      return marketing.publicar(input.id);
    }),
  redes: protectedProcedure.query(async ({ ctx }) => {
    soloAdminMkt(ctx);
    const { redesDisponibles } = await import("./publicacion-redes");
    return redesDisponibles();
  }),
  generarImagen: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      soloAdminMkt(ctx);
      const { generarImagenPost } = await import("./marketing-imagen");
      return generarImagenPost(input.id);
    }),
  programar: protectedProcedure
    .input(z.object({ id: z.number(), fecha: z.string().max(25).nullable() }))
    .mutation(async ({ input, ctx }) => {
      soloAdminMkt(ctx);
      const { marketing } = await import("./marketing");
      return marketing.programar(input.id, input.fecha);
    }),
  subirImagen: protectedProcedure
    .input(z.object({ id: z.number(), imagenBase64: z.string().max(8_000_000), mime: z.string().max(40).optional() }))
    .mutation(async ({ input, ctx }) => {
      soloAdminMkt(ctx);
      const { guardarImagenPost } = await import("./marketing-imagen");
      return guardarImagenPost(input.id, input.imagenBase64, input.mime);
    }),
});

const fidelizacionRouter = router({
  // Lista diaria de clientes a recordar (recompra próxima o atrasada).
  porRecordar: protectedProcedure
    .input(z.object({
      minCompras: z.number().optional(),
      anticipacionDias: z.number().optional(),
      toleranciaAtraso: z.number().optional(),
      sucursal: z.string().optional(),
      incluir: z.enum(["ambos", "por_acabar", "atrasado"]).optional(),
    }).optional())
    .query(async ({ input }) => {
      const { clientesPorRecordar } = await import("./fidelizacion");
      return clientesPorRecordar(input ?? {});
    }),
  // Registrar que se contactó a un cliente (para no repetir el recordatorio)
  marcarContactado: protectedProcedure
    .input(z.object({ idCliente: z.number(), producto: z.string(), telefono: z.string().optional(), estado: z.string().optional() }))
    .mutation(async ({ input }) => {
      const { registrarRecordatorioEnviado } = await import("./fidelizacion");
      return registrarRecordatorioEnviado(input.idCliente, input.producto, input.telefono || "", input.estado || "");
    }),
});

// ─── TIENDA PÚBLICA (clientes, sin login) ───
const tiendaRouter = router({
  buscar: publicProcedure
    .input(z.object({ termino: z.string().max(80) }))
    .query(async ({ input, ctx }) => {
      const { tienda, rateLimitOk } = await import("./tienda");
      const ip = (ctx as any)?.req?.ip || "?";
      if (!rateLimitOk(ip, "buscar")) return { productos: [], mensaje: "Demasiadas búsquedas, espera un momento." };
      return tienda.buscar(input.termino);
    }),
  reservar: publicProcedure
    .input(z.object({
      producto: z.string().max(500).optional(), precio: z.number().optional(),
      items: z.array(z.object({ nombre: z.string().max(500), precio: z.number(), cantidad: z.number() })).max(15).optional(),
      sucursal: z.string().max(150), nombreCliente: z.string().max(150), telefono: z.string().max(30),
      cupon: z.string().max(30).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { tienda, rateLimitOk } = await import("./tienda");
      const ip = (ctx as any)?.req?.ip || "?";
      if (!rateLimitOk(ip, "reservar")) return { error: "Demasiadas reservas seguidas, espera un momento." };
      const email = (ctx as any)?.user?.email;
      return tienda.reservar(input.producto || "", input.precio || 0, input.sucursal, input.nombreCliente, input.telefono, input.items, email, input.cupon);
    }),
  previewTotal: publicProcedure
    .input(z.object({
      items: z.array(z.object({ nombre: z.string().max(500), precio: z.number(), cantidad: z.number() })).max(15),
      cupon: z.string().max(30).optional(),
    }))
    .query(async ({ input }) => {
      const { tienda } = await import("./tienda");
      return tienda.previewTotal(input.items, input.cupon);
    }),
  misReservas: publicProcedure.query(async ({ ctx }) => {
    const email = (ctx as any)?.user?.email;
    if (!email) return { reservas: [] };
    const { tienda } = await import("./tienda");
    return tienda.misReservas(email);
  }),
  recompra: publicProcedure.query(async ({ ctx }) => {
    const email = (ctx as any)?.user?.email;
    if (!email) return { productos: [] };
    const { tienda } = await import("./tienda");
    return tienda.recompra(email);
  }),
  misPuntos: publicProcedure.query(async ({ ctx }) => {
    const email = (ctx as any)?.user?.email;
    if (!email) return null;
    const { tienda } = await import("./tienda");
    return tienda.misPuntos(email);
  }),
  // ─── Pagos QR ───
  // Los 3 endpoints de pago son públicos (un invitado puede reservar sin cuenta),
  // así que exigen PRUEBA DE PROPIEDAD: el email del usuario logueado o el código
  // de la reserva. Sin esto habría IDOR — los ids son correlativos y cualquiera
  // podría operar sobre la reserva de otro cliente.
  iniciarPago: publicProcedure
    .input(z.object({ reservaId: z.number(), codigo: z.string().max(20).optional() }))
    .mutation(async ({ input, ctx }) => {
      const { pagos } = await import("./pagos");
      return pagos.iniciarPagoReserva(input.reservaId, { email: (ctx as any)?.user?.email, codigo: input.codigo });
    }),
  subirComprobante: publicProcedure
    .input(z.object({ reservaId: z.number(), comprobanteUrl: z.string().max(600), codigo: z.string().max(20).optional() }))
    .mutation(async ({ input, ctx }) => {
      const { pagos } = await import("./pagos");
      return pagos.subirComprobante(input.reservaId, input.comprobanteUrl, { email: (ctx as any)?.user?.email, codigo: input.codigo });
    }),
  estadoPago: publicProcedure
    .input(z.object({ reservaId: z.number(), codigo: z.string().max(20).optional() }))
    .query(async ({ input, ctx }) => {
      const { pagos } = await import("./pagos");
      return pagos.estadoPago(input.reservaId, { email: (ctx as any)?.user?.email, codigo: input.codigo });
    }),
  // Staff: confirmar pago manual tras revisar comprobante
  confirmarPagoManual: protectedProcedure
    .input(z.object({ reservaId: z.number() }))
    .mutation(async ({ input }) => {
      const { pagos } = await import("./pagos");
      return pagos.confirmarPagoManual(input.reservaId);
    }),
  ofertas: publicProcedure.query(async () => {
    const { tienda } = await import("./tienda");
    return tienda.ofertas();
  }),
  masVendidos: publicProcedure.query(async () => {
    const { tienda } = await import("./tienda");
    return tienda.masVendidos();
  }),
  config: publicProcedure.query(async () => {
    const { tienda } = await import("./tienda");
    return tienda.config();
  }),
  // Staff: gestión de reservas
  listarReservas: protectedProcedure
    .input(z.object({ estado: z.string().optional() }))
    .query(async ({ input }) => {
      const { tienda } = await import("./tienda");
      return tienda.listarReservas(input.estado);
    }),
  cambiarEstado: protectedProcedure
    .input(z.object({ id: z.number(), estado: z.string() }))
    .mutation(async ({ input }) => {
      const { tienda } = await import("./tienda");
      return tienda.cambiarEstadoReserva(input.id, input.estado);
    }),
});

const fotosRouter = router({
  subir: protectedProcedure
    .input(z.object({ articuloId: z.number(), base64: z.string().max(450000), mime: z.string().max(40) }))
    .mutation(async ({ input, ctx }) => {
      const rol = (ctx as any)?.user?.role;
      if (rol !== "admin" && rol !== "regente") throw new Error("Solo admin o regente pueden subir fotos");
      const { fotosProductos } = await import("./fotos-productos");
      return fotosProductos.subir(input.articuloId, input.base64, input.mime);
    }),
  quitar: protectedProcedure
    .input(z.object({ articuloId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const rol = (ctx as any)?.user?.role;
      if (rol !== "admin" && rol !== "regente") throw new Error("Solo admin o regente pueden quitar fotos");
      const { fotosProductos } = await import("./fotos-productos");
      return fotosProductos.quitar(input.articuloId);
    }),
});

// ─── REGISTRO DE DISPENSACIÓN DE CONTROLADOS (libro de auditoría legal) ───
const dispensacionRouter = router({
  // Cualquier vendedora registra una dispensación (es su trabajo en mostrador)
  registrar: protectedProcedure
    .input(z.object({
      sucursal: z.string().min(2).max(120),
      producto: z.string().min(1).max(500),
      cantidad: z.number().min(1).max(10000),
      recetaNumero: z.string().max(80).optional(),
      medico: z.string().max(200).optional(),
      matriculaMedico: z.string().max(80).optional(),
      paciente: z.string().max(200).optional(),
      documentoPaciente: z.string().max(50).optional(),
      nota: z.string().max(400).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { dispensacion } = await import("./dispensacion");
      const dispensadoPor = (ctx as any)?.user?.email || (ctx as any)?.user?.name || `usuario-${(ctx as any)?.user?.id ?? "?"}`;
      return dispensacion.registrar({ ...input, dispensadoPor });
    }),
  // Consulta: si un producto es controlado (para avisar en el mostrador)
  esControlado: protectedProcedure
    .input(z.object({ nombre: z.string(), descripcion: z.string().optional() }))
    .query(async ({ input }) => {
      const { dispensacion } = await import("./dispensacion");
      return { controlado: dispensacion.esControlado(input.nombre, input.descripcion) };
    }),
  listar: protectedProcedure
    .input(z.object({ desde: z.string().max(10).optional(), hasta: z.string().max(10).optional(), producto: z.string().max(120).optional() }).optional())
    .query(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { dispensacion } = await import("./dispensacion");
      return dispensacion.listar(input || {});
    }),
  anular: protectedProcedure
    .input(z.object({ id: z.number(), motivo: z.string().min(3).max(300) }))
    .mutation(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { dispensacion } = await import("./dispensacion");
      const por = (ctx as any)?.user?.email || (ctx as any)?.user?.name || "admin";
      return dispensacion.anular(input.id, input.motivo, por);
    }),
  resumen: protectedProcedure
    .input(z.object({ desde: z.string().max(10), hasta: z.string().max(10) }))
    .query(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { dispensacion } = await import("./dispensacion");
      return dispensacion.resumen(input.desde, input.hasta);
    }),
});

// ─── LIBRO DE PSICOTRÓPICOS (informes trimestral/semestral/anual a SEDES) ───
const psicoRouter = router({
  // Subir foto (receta o factura) y devolver su URL — para adjuntar al movimiento
  subirFoto: protectedProcedure
    .input(z.object({ fileBase64: z.string().max(12_000_000), mimeType: z.string(), tipo: z.enum(["receta", "factura"]) }))
    .mutation(async ({ input }) => {
      const { nanoid } = await import("nanoid");
      const { storagePut } = await import("./storage");
      const buffer = Buffer.from(input.fileBase64, "base64");
      const ext = (input.mimeType.split("/").pop() || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
      const { url } = await storagePut(`psico/${input.tipo}-${nanoid()}.${ext}`, buffer, input.mimeType);
      return { url };
    }),
  listarProductos: protectedProcedure.query(async ({ ctx }) => {
    soloFinanzas(ctx);
    const { psico } = await import("./psicotropicos");
    return psico.listarProductos();
  }),
  guardarProducto: protectedProcedure
    .input(z.object({
      id: z.number().optional(),
      nombreComercial: z.string().min(1).max(255),
      dci: z.string().max(255).optional(),
      concentracion: z.string().max(120).optional(),
      presentacion: z.string().max(120).optional(),
      laboratorio: z.string().max(255).optional(),
      registroSanitario: z.string().min(1).max(120),
      origen: z.string().max(120).optional(),
      articuloId365: z.number().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { psico } = await import("./psicotropicos");
      return psico.guardarProducto(input);
    }),
  registrarMovimiento: protectedProcedure
    .input(z.object({
      productoId: z.number(),
      tipo: z.enum(["ingreso", "egreso"]),
      cantidad: z.number().min(1).max(100000),
      fecha: z.string().max(10).optional(),
      recetaNumero: z.string().max(80).optional(),
      paciente: z.string().max(200).optional(),
      medico: z.string().max(200).optional(),
      numFactura: z.string().max(80).optional(),
      recetaFotoUrl: z.string().max(500).optional(),
      facturaFotoUrl: z.string().max(500).optional(),
      nota: z.string().max(400).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { psico } = await import("./psicotropicos");
      const registradoPor = (ctx as any)?.user?.email || (ctx as any)?.user?.name || `usuario-${(ctx as any)?.user?.id ?? "?"}`;
      return psico.registrarMovimiento({ ...input, registradoPor });
    }),
  libroProducto: protectedProcedure
    .input(z.object({ productoId: z.number(), desde: z.string().max(10), hasta: z.string().max(10) }))
    .query(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { psico } = await import("./psicotropicos");
      return psico.libroProducto(input.productoId, input.desde, input.hasta);
    }),
  informe: protectedProcedure
    .input(z.object({ tipo: z.enum(["trimestral", "semestral", "anual"]), anio: z.number(), trimestre: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { psico } = await import("./psicotropicos");
      return psico.informe(input.tipo, input.anio, input.trimestre);
    }),
  // Detecta psicotrópicos en los items de una compra (para avisar en Compras)
  detectarEnCompra: protectedProcedure
    .input(z.object({ items: z.array(z.object({ productName: z.string().optional(), nombre: z.string().optional(), quantity: z.number().optional(), cantidad: z.number().optional() })).max(200) }))
    .mutation(async ({ input }) => {
      const { psico } = await import("./psicotropicos");
      return psico.detectarEnCompra(input.items);
    }),
  // Importar los productos del libro Excel de VidaFarma (semilla, un clic)
  importarSemilla: protectedProcedure.mutation(async ({ ctx }) => {
    soloFinanzas(ctx);
    const { psico } = await import("./psicotropicos");
    const SEMILLA = [
      { nombreComercial: "CLONEX CD", dci: "CLONAZEPAM", concentracion: "0.5 MG", presentacion: "COMPRIMIDO DISPERSABLE", laboratorio: "FARMAVAL BOLIVIA SRL.", registroSanitario: "N.R.S II-36109/2023", origen: "CHILE" },
      { nombreComercial: "FLUNITRAZEPAM", dci: "FLUNITRAZEPAM", concentracion: "2 MG", presentacion: "TABLETA", laboratorio: "SAE", registroSanitario: "R.S.II 17864/2024", origen: "CHILE" },
      { nombreComercial: "HIPNOL", dci: "FENOBARBITAL SODICO", concentracion: "2%", presentacion: "GOTAS", laboratorio: "ALFA", registroSanitario: "R.S.NN-21395/2021", origen: "BOLIVIA" },
      { nombreComercial: "IDANTINA COMPUESTA", dci: "FENITOINA SODICA", concentracion: "100 MG - 15MG", presentacion: "TABLETA", laboratorio: "INTI", registroSanitario: "R.S.NN-24145/2023", origen: "BOLIVIA" },
      { nombreComercial: "MIDAZOLAM", dci: "MIDAZOLAM", concentracion: "5 MG/ML", presentacion: "AMPOLLA", laboratorio: "NOVAPHARMA", registroSanitario: "R. S. II-83871/2022", origen: "INDIA" },
      { nombreComercial: "NEURYL", dci: "CLONAZEPAM", concentracion: "0.5 MG", presentacion: "TABLETA", laboratorio: "BAGO", registroSanitario: "R.S.NN 74275/2020", origen: "BOLIVIA" },
      { nombreComercial: "NEURYL", dci: "CLONAZEPAM", concentracion: "2 MG", presentacion: "TABLETA", laboratorio: "BAGO", registroSanitario: "R.S.NN 59656/2021", origen: "BOLIVIA" },
      { nombreComercial: "OBEXOL", dci: "FENTERMINA CLORHIDRATO", concentracion: "37,5 mg", presentacion: "CAPSULAS", laboratorio: "FARMAVAL BOLIVIA SRL.", registroSanitario: "N.R.S.II-60753/2022", origen: "CHILE" },
    ];
    return psico.importarProductos(SEMILLA);
  }),
});

// ─── DIRECTORIO DE CONTACTOS (clientes y proveedores con su celular) ───
const contactosRouter = router({
  buscar: protectedProcedure
    .input(z.object({ q: z.string().max(120).optional(), tipo: z.enum(["cliente", "proveedor"]).optional() }).optional())
    .query(async ({ input }) => {
      const { contactos } = await import("./contactos");
      return contactos.buscar(input?.q || "", input?.tipo);
    }),
  guardar: protectedProcedure
    .input(z.object({
      id: z.number().optional(),
      nombre: z.string().min(1).max(200),
      telefono: z.string().min(6).max(30),
      tipo: z.enum(["cliente", "proveedor"]),
      empresa: z.string().max(200).optional(),
      email: z.string().max(320).optional(),
      nota: z.string().max(400).optional(),
    }))
    .mutation(async ({ input }) => {
      const { contactos } = await import("./contactos");
      return contactos.guardar(input);
    }),
  eliminar: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      soloFinanzas(ctx);
      const { contactos } = await import("./contactos");
      return contactos.eliminar(input.id);
    }),
});

// Estado del sistema (modo staging, etc.) — público, para que el banner de
// aviso se vea incluso antes de iniciar sesión.
const sistemaRouter = router({
  estado: publicProcedure.query(() => ({
    modoStaging: process.env.MODO_STAGING === "true",
  })),
});

export const appRouter = router({
  bandeja: router({
    // Ingresar una factura XML a la bandeja (sube el archivo y lo parsea).
    ingresar: protectedProcedure
      .input(z.object({ fileBase64: z.string(), fileName: z.string() }))
      .mutation(async ({ input }) => {
        const contenido = Buffer.from(input.fileBase64, "base64").toString("utf-8");
        const { esFacturaXml, parsearFacturaXml } = await import("./factura-xml");
        if (!esFacturaXml(contenido, input.fileName)) {
          throw new Error("El archivo no es una factura XML del SIN válida.");
        }
        const f = parsearFacturaXml(contenido);
        if (f.items.length === 0) throw new Error("El XML no contiene productos.");
        const { bandejaService } = await import("./bandeja");
        const r = await bandejaService.ingresar(f, "manual");
        return {
          id: r.id,
          duplicada: r.duplicada,
          proveedor: f.razonSocialEmisor,
          numeroFactura: f.numeroFactura,
          totalItems: f.items.length,
        };
      }),
    // Listar la bandeja (pendientes por defecto).
    listar: protectedProcedure
      .input(z.object({ incluirValidadas: z.boolean().default(false) }).optional())
      .query(async ({ input }) => {
        const { bandejaService } = await import("./bandeja");
        return bandejaService.listar(input?.incluirValidadas ?? false);
      }),
    // Detalle de una factura de la bandeja.
    detalle: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        const { bandejaService } = await import("./bandeja");
        return bandejaService.detalle(input.id);
      }),
    // Reconocer una factura por número/proveedor (cámara inteligente, Paso B).
    reconocer: protectedProcedure
      .input(z.object({ numeroFactura: z.string().optional(), proveedor: z.string().optional() }))
      .query(async ({ input }) => {
        const { bandejaService } = await import("./bandeja");
        return bandejaService.reconocer(input.numeroFactura, input.proveedor);
      }),
    // CÁMARA INTELIGENTE: recibe una foto de la factura física, lee su número y
    // proveedor con visión, y lo cruza con la bandeja. Devuelve qué factura XML
    // reconoció (si alguna) para dirigir el flujo: si está en la bandeja → capturar
    // vencimientos; si no → foto normal para extracción.
    reconocerFoto: protectedProcedure
      .input(z.object({ fileBase64: z.string(), mimeType: z.string() }))
      .mutation(async ({ input }) => {
        const dataUrl = `data:${input.mimeType};base64,${input.fileBase64}`;
        const llmResult = await invokeLLM({
          messages: [
            {
              role: "system",
              content: "Eres experto en leer facturas bolivianas. Extraes SOLO el número de factura y el nombre del proveedor/emisor. Responde SOLO JSON.",
            },
            {
              role: "user",
              content: [
                { type: "text", text: 'Lee el NÚMERO DE FACTURA y el PROVEEDOR (emisor) de esta factura. Responde JSON: {"numeroFactura":"...","proveedor":"..."}. Si algo no se ve, usa null.' },
                { type: "image_url", image_url: { url: dataUrl } },
              ] as any,
            },
          ],
          response_format: { type: "json_object" },
        });
        let numeroFactura: string | null = null;
        let proveedor: string | null = null;
        try {
          const c = llmResult.choices[0]?.message?.content;
          const parsed = typeof c === "string" ? JSON.parse(c.replace(/```json|```/g, "").trim()) : {};
          numeroFactura = parsed?.numeroFactura || null;
          proveedor = parsed?.proveedor || null;
        } catch { /* sin datos */ }

        const { bandejaService } = await import("./bandeja");
        const coincidencias = await bandejaService.reconocer(numeroFactura || undefined, proveedor || undefined);
        return {
          leido: { numeroFactura, proveedor },
          coincidencias, // ordenadas por score; la mejor primero
          reconocida: coincidencias.length > 0 ? coincidencias[0] : null,
        };
      }),
    // Actualizar items (emparejamiento/vencimientos) de una factura.
    actualizarItems: protectedProcedure
      .input(z.object({ id: z.number(), items: z.array(z.any()) }))
      .mutation(async ({ input }) => {
        const { bandejaService } = await import("./bandeja");
        return bandejaService.actualizarItems(input.id, input.items as any);
      }),
    // Descartar una factura de la bandeja.
    eliminar: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        const { bandejaService } = await import("./bandeja");
        await bandejaService.eliminar(input.id);
        return { success: true };
      }),
  }),
  pedidos: router({
    // Buscar proveedores REALES en 365 (para el autocompletado de la página Pedidos).
    buscarProveedores: protectedProcedure
      .input(z.object({ filtro: z.string().trim().min(2).max(120) }))
      .query(async ({ input }) => {
        const { inventarios365 } = await import("./inventarios365");
        const lista = await inventarios365.listarProveedores(input.filtro);
        return lista.slice(0, 12).map((p) => ({ id: String(p.id), nombre: p.nombre }));
      }),
    // Pedido sugerido: por almacén (almacenId 1-4) o consolidado de todas (almacenId null).
    // El proveedor llega como idProveedor exacto (elegido del autocompletado).
    sugerido: protectedProcedure
      .input(z.object({
        almacenId: z.number().int().min(1).max(4).nullable(),
        idProveedor: z.string().trim().max(30).optional(),
        dias: z.number().int().min(1).max(90).default(10),
      }))
      .query(async ({ input }) => {
        const { calcularPedidoAlmacen, calcularPedidoConsolidado, ALMACENES_PEDIDO } = await import("./pedidos");
        const idProveedor = input.idProveedor || "";
        if (input.almacenId != null) {
          const items = await calcularPedidoAlmacen({ almacenId: input.almacenId, idProveedor, dias: input.dias });
          const alm = ALMACENES_PEDIDO.find((a) => a.id === input.almacenId);
          return { modo: "sucursal" as const, sucursal: alm?.nombre ?? "", dias: input.dias, items };
        }
        const items = await calcularPedidoConsolidado({ idProveedor, dias: input.dias });
        return { modo: "consolidado" as const, dias: input.dias, sucursales: ALMACENES_PEDIDO.map((a) => a.nombre), items };
      }),
  }),
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
  tienda: tiendaRouter,
  fotos: fotosRouter,
  ventas: ventasRouter,
  gastos: gastosRouter,
  flujoCaja: flujoCajaRouter,
  obligaciones: obligacionesRouter,
  contingencia: contingenciaRouter,
  sistema: sistemaRouter,
  dispensacion: dispensacionRouter,
  psico: psicoRouter,
  contactos: contactosRouter,
  fidelizacion: fidelizacionRouter,
  marketing: marketingRouter,
  creditos: creditosRouter,
  personal: personalRouter,
});

export type AppRouter = typeof appRouter;
