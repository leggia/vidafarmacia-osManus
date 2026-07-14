// INTELIGENCIA DE COMPRAS — al leer una factura, el sistema compara cada precio
// contra la referencia conocida y avisa: ✓ mismo precio (no hay que revisarlo),
// ▲ subió X%, ▼ bajó X%, ● nuevo (sin referencia). Además controla el MARGEN:
// si el costo nuevo aprieta el margen contra el precio de venta actual, lo marca.
//
// Referencia de precio (en orden): 1) el último precio al que NOSOTROS compramos
// ese producto (historial propio, se llena con cada compra confirmada),
// 2) el costo unitario del sistema (productos_cache, viene de 365).
import { getDb } from "./db";
import { sql } from "drizzle-orm";
import { mejoresCandidatos } from "./domain/emparejar";
import { evaluarPrecio } from "./domain/compras";

const filas = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };

let tablaLista = false;
async function asegurarTabla(db: any) {
  if (tablaLista) return;
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS compras_precios_hist (
      id INT AUTO_INCREMENT PRIMARY KEY,
      fecha VARCHAR(10) NOT NULL,
      proveedor VARCHAR(255),
      nombre VARCHAR(500) NOT NULL,
      precioUnit DECIMAL(12,4) NOT NULL,
      cantidad INT NOT NULL DEFAULT 0,
      INDEX idx_cph_nombre (nombre(190))
    )`));
  } catch { /* existe */ }
  tablaLista = true;
}

export type ComparacionItem = {
  productName: string;
  unitCost: number;
  estado: "igual" | "subio" | "bajo" | "nuevo";
  referencia: number | null;
  fuenteReferencia: "compra_anterior" | "costo_sistema" | null;
  diffPct: number | null;          // + sube, - baja
  precioVenta: number | null;      // precio de venta actual (si se encontró)
  margenPct: number | null;        // margen con el costo NUEVO
  alertaMargen: boolean;           // margen < 20%
  matchNombre: string | null;      // nombre del catálogo con el que se comparó
};

export async function compararPreciosCompra(items: { productName: string; unitCost: number }[]): Promise<{ items: ComparacionItem[]; resumen: any }> {
  const db = await getDb();
  const vacio = { items: items.map((i) => base(i)), resumen: resumir([]) };
  if (!db) return vacio;
  await asegurarTabla(db);

  // Catálogo (nombres + costos + venta) — una sola query
  const catalogo = filas(await db.execute(sql`SELECT nombre, precioCostoUnid, precioUno FROM productos_cache WHERE nombre IS NOT NULL`));
  const nombres = catalogo.map((c: any) => String(c.nombre));
  const porNombre = new Map(catalogo.map((c: any) => [String(c.nombre), c]));

  // Último precio propio por producto (historial de compras confirmadas)
  const hist = filas(await db.execute(sql`
    SELECT h.nombre, h.precioUnit FROM compras_precios_hist h
    INNER JOIN (SELECT nombre, MAX(id) AS mid FROM compras_precios_hist GROUP BY nombre) u
      ON u.nombre = h.nombre AND u.mid = h.id
  `));
  const ultimoPropio = new Map(hist.map((h: any) => [String(h.nombre), num(h.precioUnit)]));

  const resultado: ComparacionItem[] = items.map((it) => {
    const r = base(it);
    if (!it.productName || !(it.unitCost > 0)) return r;
    // Emparejado difuso contra el catálogo (motor ya testeado del proyecto)
    const cands = mejoresCandidatos(it.productName, nombres, 1);
    const mejor = cands[0];
    if (!mejor || mejor.confianza === "baja") return r; // sin match confiable → "nuevo"
    r.matchNombre = mejor.nombre;
    const cat: any = porNombre.get(mejor.nombre);

    // Referencia: último precio propio > costo del sistema
    const propio = ultimoPropio.get(mejor.nombre);
    if (propio && propio > 0) { r.referencia = propio; r.fuenteReferencia = "compra_anterior"; }
    else if (cat && num(cat.precioCostoUnid) > 0) { r.referencia = num(cat.precioCostoUnid); r.fuenteReferencia = "costo_sistema"; }

    const venta = cat ? num(cat.precioUno) : 0;
    const ev = evaluarPrecio(it.unitCost, r.referencia, venta > 0 ? venta : null);
    r.estado = ev.estado; r.diffPct = ev.diffPct;
    if (venta > 0) { r.precioVenta = venta; r.margenPct = ev.margenPct; r.alertaMargen = ev.alertaMargen; }
    return r;
  });

  return { items: resultado, resumen: resumir(resultado) };
}

function base(it: { productName: string; unitCost: number }): ComparacionItem {
  return {
    productName: it.productName, unitCost: num(it.unitCost),
    estado: "nuevo", referencia: null, fuenteReferencia: null, diffPct: null,
    precioVenta: null, margenPct: null, alertaMargen: false, matchNombre: null,
  };
}

function resumir(items: ComparacionItem[]) {
  const c = (e: string) => items.filter((i) => i.estado === e).length;
  return {
    igual: c("igual"), subieron: c("subio"), bajaron: c("bajo"), nuevos: c("nuevo"),
    alertasMargen: items.filter((i) => i.alertaMargen).length,
  };
}

// Registrar los precios de una compra CONFIRMADA (alimenta la referencia propia)
export async function registrarPreciosCompra(items: { productName?: string; nombre?: string; unitCost?: number; precio?: number; quantity?: number; cantidad?: number }[], proveedor?: string) {
  const db = await getDb();
  if (!db) return;
  await asegurarTabla(db);
  const fecha = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
  for (const it of items) {
    const nombre = String(it.productName ?? it.nombre ?? "").trim();
    const precio = num(it.unitCost ?? it.precio);
    if (!nombre || precio <= 0) continue;
    try {
      await db.execute(sql`
        INSERT INTO compras_precios_hist (fecha, proveedor, nombre, precioUnit, cantidad)
        VALUES (${fecha}, ${(proveedor || "").slice(0, 255) || null}, ${nombre.slice(0, 500)}, ${precio}, ${num(it.quantity ?? it.cantidad)})
      `);
    } catch { /* no bloquea la compra */ }
  }
}
