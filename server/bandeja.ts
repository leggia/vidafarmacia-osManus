/**
 * BANDEJA DE FACTURAS XML.
 *
 * Guarda cada factura XML (subida manual o llegada por correo) en espera, con su
 * estado, para retomarla luego. Base de la cámara-inteligente (reconoce la
 * factura física contra esta bandeja) y de la ingesta por correo.
 *
 * Estados: recibida → emparejada → vencimientos_pendientes → validada.
 */
import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "./db";
import { bandejaFacturas } from "../drizzle/schema";
import type { FacturaXmlResult } from "./factura-xml";

interface ItemBandeja {
  productName: string;
  quantity: number;
  unitCost: number;
  subtotal: number;
  descuento: number;
  expiryDate: string | null;
  codigoProducto: string | null;
  articuloId: number | null;      // producto de 365 emparejado (null = sin emparejar)
  articuloNombre: string | null;
}

/** Recalcula el estado de una factura según su progreso de emparejamiento/vencimientos. */
function calcularEstado(items: ItemBandeja[]): {
  estado: "recibida" | "emparejada" | "vencimientos_pendientes" | "validada";
  emparejados: number;
  conVencimiento: number;
} {
  const total = items.length;
  const emparejados = items.filter((i) => i.articuloId != null && i.articuloId > 0).length;
  const conVencimiento = items.filter((i) => !!i.expiryDate).length;
  let estado: "recibida" | "emparejada" | "vencimientos_pendientes" | "validada";
  if (emparejados < total) {
    estado = "recibida";
  } else if (conVencimiento < total) {
    estado = "vencimientos_pendientes";
  } else {
    estado = "emparejada"; // todo emparejado y con vencimiento; 'validada' se marca al sincronizar
  }
  return { estado, emparejados, conVencimiento };
}

/**
 * NIT de la farmacia, para detectar facturas que llegaron por error y NO son
 * nuestras (importante ahora que entran solas desde el correo).
 *
 * Se toma de la variable de entorno NIT_FARMACIA si está configurada. Si no, se
 * APRENDE solo: el NIT que más se repite entre las facturas ya recibidas es, con
 * evidencia suficiente (3 o más), el de la farmacia. Mientras no haya evidencia,
 * no se marca nada como ajeno para no dar falsas alarmas.
 */
async function nitDeLaFarmacia(db: any): Promise<string | null> {
  const configurado = (process.env.NIT_FARMACIA || "").trim();
  if (configurado) return configurado;
  try {
    const { sql } = await import("drizzle-orm");
    const r: any = await db.execute(sql`
      SELECT nitCliente, COUNT(*) AS n FROM bandeja_facturas
      WHERE nitCliente IS NOT NULL AND nitCliente <> ''
      GROUP BY nitCliente ORDER BY n DESC LIMIT 1
    `);
    const filas = Array.isArray(r) ? r[0] : r?.rows ?? r;
    const top = filas?.[0];
    if (top && Number(top.n) >= 3) return String(top.nitCliente);
  } catch { /* la columna puede no existir todavía */ }
  return null;
}

class BandejaService {
  /** Ingresa una factura XML parseada a la bandeja. Idempotente por CUF: si ya
   *  existe esa factura, no la duplica (devuelve la existente). */
  async ingresar(f: FacturaXmlResult, origen: "manual" | "correo" = "manual"): Promise<{ id: number; duplicada: boolean }> {
    const db = await getDb();
    if (!db) throw new Error("Sin BD");

    // ¿Ya está esta factura (mismo CUF)?
    if (f.cuf) {
      const existente = await db.select().from(bandejaFacturas).where(eq(bandejaFacturas.cuf, f.cuf)).limit(1);
      if (existente.length > 0) return { id: existente[0].id, duplicada: true };
    }

    const items: ItemBandeja[] = f.items.map((it) => ({
      productName: it.productName,
      quantity: it.quantity,
      unitCost: it.unitCost,
      subtotal: it.subtotal,
      descuento: it.descuento,
      expiryDate: it.expiryDate,
      codigoProducto: it.codigoProducto,
      articuloId: null,
      articuloNombre: null,
    }));
    const { estado, emparejados, conVencimiento } = calcularEstado(items);

    // ¿La factura viene a nombre de la farmacia? Si sabemos cuál es nuestro NIT y
    // el de la factura es otro, se marca para revisarla (no se rechaza: puede ser
    // un NIT nuevo o un error de tipeo del proveedor).
    const nitNuestro = await nitDeLaFarmacia(db);
    const nitFactura = (f.nitCliente || "").trim();
    const esAjena = !!(nitNuestro && nitFactura && nitFactura !== nitNuestro);
    if (esAjena) {
      console.warn(`[Bandeja] Factura a nombre de otro NIT (${nitFactura}, esperado ${nitNuestro}): ${f.razonSocialCliente ?? "?"}`);
    }

    const res = await db.insert(bandejaFacturas).values({
      nitEmisor: f.nitEmisor,
      proveedor: f.razonSocialEmisor,
      razonSocialCliente: f.razonSocialCliente ?? null,
      nitCliente: f.nitCliente ?? null,
      ajena: esAjena ? 1 : 0,
      numeroFactura: f.numeroFactura,
      cuf: f.cuf,
      fechaEmision: f.fechaEmision,
      montoTotal: String(f.montoTotal),
      estado,
      origen,
      items,
      totalItems: items.length,
      itemsEmparejados: emparejados,
      itemsConVencimiento: conVencimiento,
    });
    const id = Number((res as any).insertId ?? (res as any)[0]?.insertId);
    return { id, duplicada: false };
  }

  /** Lista las facturas de la bandeja. Por defecto solo pendientes (no validadas). */
  async listar(incluirValidadas = false) {
    const db = await getDb();
    if (!db) return [];
    const where = incluirValidadas ? undefined : ne(bandejaFacturas.estado, "validada");
    const q = db.select({
      id: bandejaFacturas.id,
      proveedor: bandejaFacturas.proveedor,
      numeroFactura: bandejaFacturas.numeroFactura,
      montoTotal: bandejaFacturas.montoTotal,
      estado: bandejaFacturas.estado,
      origen: bandejaFacturas.origen,
      totalItems: bandejaFacturas.totalItems,
      itemsEmparejados: bandejaFacturas.itemsEmparejados,
      itemsConVencimiento: bandejaFacturas.itemsConVencimiento,
      fechaEmision: bandejaFacturas.fechaEmision,
      recibidaEn: bandejaFacturas.recibidaEn,
    }).from(bandejaFacturas);
    const rows = where ? await q.where(where).orderBy(desc(bandejaFacturas.recibidaEn)) : await q.orderBy(desc(bandejaFacturas.recibidaEn));
    return rows;
  }

  /** Detalle completo de una factura de la bandeja. */
  async detalle(id: number) {
    const db = await getDb();
    if (!db) return null;
    const r = await db.select().from(bandejaFacturas).where(eq(bandejaFacturas.id, id)).limit(1);
    return r[0] ?? null;
  }

  /** Reconoce una factura por número y/o proveedor (para la cámara inteligente).
   *  Devuelve las coincidencias PENDIENTES de la bandeja. */
  async reconocer(numeroFactura?: string, proveedor?: string) {
    const db = await getDb();
    if (!db) return [];
    const pend = await db.select().from(bandejaFacturas).where(ne(bandejaFacturas.estado, "validada"));
    const numNorm = (numeroFactura || "").replace(/\D/g, "");
    const provNorm = (proveedor || "").trim().toLowerCase();
    return pend
      .map((f) => {
        let score = 0;
        if (numNorm && f.numeroFactura && f.numeroFactura.replace(/\D/g, "") === numNorm) score += 0.7;
        if (provNorm && f.proveedor && f.proveedor.toLowerCase().includes(provNorm)) score += 0.3;
        return { factura: f, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => ({
        id: x.factura.id,
        proveedor: x.factura.proveedor,
        numeroFactura: x.factura.numeroFactura,
        estado: x.factura.estado,
        score: x.score,
        totalItems: x.factura.totalItems,
        itemsConVencimiento: x.factura.itemsConVencimiento,
      }));
  }

  /** Actualiza los items (emparejamiento y/o vencimientos) y recalcula el estado. */
  async actualizarItems(id: number, items: ItemBandeja[]) {
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    const { estado, emparejados, conVencimiento } = calcularEstado(items);

    await db.update(bandejaFacturas).set({
      items,
      totalItems: items.length,
      itemsEmparejados: emparejados,
      itemsConVencimiento: conVencimiento,
      estado,
    }).where(eq(bandejaFacturas.id, id));
    return { estado, emparejados, conVencimiento };
  }

  /** Marca una factura como validada (ya sincronizada como compra real). */
  async marcarValidada(id: number, purchaseId?: number) {
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    await db.update(bandejaFacturas).set({
      estado: "validada",
      purchaseId: purchaseId ?? null,
    }).where(eq(bandejaFacturas.id, id));
  }

  /** Elimina una factura de la bandeja (descartar). */
  async eliminar(id: number) {
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    await db.delete(bandejaFacturas).where(eq(bandejaFacturas.id, id));
  }
}

export const bandejaService = new BandejaService();
