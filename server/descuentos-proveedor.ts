// HISTORIAL DE DESCUENTOS POR PROVEEDOR — el sistema aprende solo, factura a
// factura, qué descuento suele dar cada laboratorio en cada producto. Con eso
// avisa cuando una factura viene con MENOS descuento del habitual: plata que se
// perdería en silencio.
// La decisión de qué es "típico" y cuándo avisar es lógica pura y testeada
// (shared/descuentos.ts). Aquí solo se guarda y se lee.
import { getDb } from "./db";
import { sql } from "drizzle-orm";
import { evaluarDescuento, descuentoTipico, type AlertaDescuento } from "../shared/descuentos";

const filas = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const norm = (s: string) => String(s || "").trim().toLowerCase();

let tablaLista = false;
async function asegurarTabla(db: any) {
  if (tablaLista) return;
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS descuentos_proveedor (
      id INT AUTO_INCREMENT PRIMARY KEY,
      proveedor VARCHAR(255) NOT NULL,
      producto VARCHAR(500) NOT NULL,
      pctDescuento DECIMAL(6,2) NOT NULL DEFAULT 0,
      fecha VARCHAR(10) NOT NULL,
      purchaseId INT,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_dp_prov (proveedor(120)),
      INDEX idx_dp_prod (producto(190))
    )`));
  } catch { /* existe */ }
  tablaLista = true;
}

export const descuentosProveedor = {
  /** Registrar los descuentos de una compra confirmada (así aprende). */
  async registrar(proveedor: string, items: { nombre: string; pctDescuento: number }[], purchaseId?: number) {
    const db = await getDb();
    if (!db || !proveedor?.trim()) return;
    await asegurarTabla(db);
    const fecha = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10);
    for (const it of items) {
      if (!it.nombre?.trim()) continue;
      const pct = num(it.pctDescuento);
      if (pct < 0 || pct > 100) continue;
      try {
        await db.execute(sql`
          INSERT INTO descuentos_proveedor (proveedor, producto, pctDescuento, fecha, purchaseId)
          VALUES (${proveedor.trim().slice(0, 255)}, ${it.nombre.trim().slice(0, 500)}, ${pct}, ${fecha}, ${purchaseId ?? null})
        `);
      } catch { /* no bloquea la compra */ }
    }
  },

  /**
   * Analizar los descuentos de una factura contra lo habitual de ese proveedor.
   * Devuelve solo las desviaciones que valen la pena mirar.
   */
  async analizar(proveedor: string, items: { nombre: string; pctDescuento: number }[]): Promise<{ alertas: AlertaDescuento[]; sinHistorial: number }> {
    const db = await getDb();
    if (!db || !proveedor?.trim() || items.length === 0) return { alertas: [], sinHistorial: items.length };
    await asegurarTabla(db);
    // Traer TODO el historial de ese proveedor de una sola query (no una por producto)
    const hist = filas(await db.execute(sql`
      SELECT producto, pctDescuento FROM descuentos_proveedor
      WHERE proveedor = ${proveedor.trim().slice(0, 255)}
      ORDER BY id DESC LIMIT 3000
    `));
    const porProducto = new Map<string, number[]>();
    for (const h of hist) {
      const k = norm(h.producto);
      const arr = porProducto.get(k) || [];
      arr.push(num(h.pctDescuento));
      porProducto.set(k, arr);
    }
    const alertas: AlertaDescuento[] = [];
    let sinHistorial = 0;
    for (const it of items) {
      const historial = porProducto.get(norm(it.nombre)) || [];
      if (historial.length === 0) { sinHistorial++; continue; }
      const a = evaluarDescuento(it.nombre, num(it.pctDescuento), historial);
      if (a) alertas.push(a);
    }
    // Los que te dan MENOS descuento primero: son los que cuestan plata
    alertas.sort((a, b) => (a.peor === b.peor ? a.diferencia - b.diferencia : a.peor ? -1 : 1));
    return { alertas, sinHistorial };
  },

  /** Resumen para consulta: descuento típico por producto de un proveedor. */
  async resumen(proveedor: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    await asegurarTabla(db);
    const hist = filas(await db.execute(sql`
      SELECT producto, pctDescuento FROM descuentos_proveedor
      WHERE proveedor = ${String(proveedor).trim().slice(0, 255)} ORDER BY id DESC LIMIT 3000
    `));
    const porProducto = new Map<string, { nombre: string; valores: number[] }>();
    for (const h of hist) {
      const k = norm(h.producto);
      const e = porProducto.get(k) || { nombre: String(h.producto), valores: [] };
      e.valores.push(num(h.pctDescuento));
      porProducto.set(k, e);
    }
    const productos = [...porProducto.values()]
      .map((e) => ({ producto: e.nombre, descuentoTipico: descuentoTipico(e.valores), vecesComprado: e.valores.length }))
      .filter((p) => p.descuentoTipico != null)
      .sort((a, b) => (b.descuentoTipico || 0) - (a.descuentoTipico || 0));
    return { proveedor, productos, totalRegistros: hist.length };
  },
};
