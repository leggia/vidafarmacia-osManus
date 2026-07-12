// MODO CONTINGENCIA — cuando inventarios365 se cae, la farmacia NO se detiene:
// cada sucursal registra sus ventas en una ventana local (precios desde nuestro
// cache, sin depender de 365) y, al volver el servicio, un CIERRE ASISTIDO
// permite re-registrar cada venta en 365 sin perder ninguna.
//
// Decisión de diseño (honesta): 365 NO expone API para registrar ventas (solo
// ingresos y traspasos), y aunque existiera, la venta debe facturarse en 365
// para que su contabilidad y su stock queden correctos. Por eso el cierre es un
// CHECKLIST auditado (venta por venta, con totales por sucursal y método de
// pago para cuadrar caja) y no un envío automático que dejaría la contabilidad
// de 365 coja.
import { getDb } from "./db";
import { sql } from "drizzle-orm";
import { calcularVenta, validarVenta, type ItemContingencia } from "./domain/contingencia";

const filas = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const ahoraBolivia = () => new Date(Date.now() - 4 * 3600 * 1000);

let tablasListas = false;
async function asegurarTablas(db: any) {
  if (tablasListas) return;
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS contingencia_estado (
      id INT PRIMARY KEY,
      activa TINYINT NOT NULL DEFAULT 0,
      motivo VARCHAR(300),
      desde DATETIME,
      hasta DATETIME
    )`));
  } catch { /* existe */ }
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS contingencia_ventas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      fecha VARCHAR(10) NOT NULL,
      hora VARCHAR(8) NOT NULL,
      sucursal VARCHAR(120) NOT NULL,
      usuario VARCHAR(200) NOT NULL,
      items MEDIUMTEXT NOT NULL,
      total DECIMAL(12,2) NOT NULL DEFAULT 0,
      metodoPago VARCHAR(20) NOT NULL DEFAULT 'efectivo',
      nota VARCHAR(300),
      estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      registradaEn DATETIME NULL,
      registradaPor VARCHAR(200) NULL,
      creadaEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cont_estado (estado),
      INDEX idx_cont_fecha (fecha)
    )`));
  } catch { /* existe */ }
  tablasListas = true;
}

export const contingencia = {
  async estado() {
    const db = await getDb();
    if (!db) return { activa: false, pendientes: 0 };
    await asegurarTablas(db);
    const e = filas(await db.execute(sql`SELECT activa, motivo, desde FROM contingencia_estado WHERE id = 1`));
    const p = filas(await db.execute(sql`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS monto FROM contingencia_ventas WHERE estado = 'pendiente'`));
    return {
      activa: e.length > 0 && num(e[0].activa) === 1,
      motivo: e[0]?.motivo || null,
      desde: e[0]?.desde || null,
      pendientes: num(p[0]?.n),
      montoPendiente: Math.round(num(p[0]?.monto) * 100) / 100,
    };
  },

  async activar(motivo: string) {
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    await asegurarTablas(db);
    await db.execute(sql`
      INSERT INTO contingencia_estado (id, activa, motivo, desde, hasta) VALUES (1, 1, ${motivo.slice(0, 300)}, NOW(), NULL)
      ON DUPLICATE KEY UPDATE activa = 1, motivo = ${motivo.slice(0, 300)}, desde = NOW(), hasta = NULL
    `);
    return { ok: true };
  },

  async desactivar() {
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    await asegurarTablas(db);
    await db.execute(sql`UPDATE contingencia_estado SET activa = 0, hasta = NOW() WHERE id = 1`);
    return { ok: true };
  },

  // Búsqueda OFFLINE de productos (no toca 365): nombre/código y precio desde
  // productos_cache — la vendedora puede armar la venta aunque 365 esté muerto.
  async buscarProductoOffline(q: string) {
    const db = await getDb();
    if (!db) return [];
    const limpio = q.trim();
    if (limpio.length < 2) return [];
    const like = `%${limpio.replace(/\s+/g, "%")}%`;
    const r = filas(await db.execute(sql`
      SELECT articuloId, nombre, codigo, precioUno FROM productos_cache
      WHERE nombre LIKE ${like} OR codigo LIKE ${like}
      ORDER BY nombre LIMIT 12
    `));
    return r.map((p: any) => ({ articuloId: num(p.articuloId), nombre: p.nombre, codigo: p.codigo, precio: num(p.precioUno) }));
  },

  async registrarVenta(d: { sucursal: string; usuario: string; items: ItemContingencia[]; metodoPago?: string; nota?: string }) {
    const error = validarVenta(d.items);
    if (error) throw new Error(error);
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    await asegurarTablas(db);
    const { items, total } = calcularVenta(d.items);
    const ahora = ahoraBolivia();
    const fecha = ahora.toISOString().slice(0, 10);
    const hora = ahora.toISOString().slice(11, 19);
    const metodo = ["efectivo", "qr", "tarjeta", "otro"].includes(d.metodoPago || "") ? d.metodoPago! : "efectivo";
    const ins: any = await db.execute(sql`
      INSERT INTO contingencia_ventas (fecha, hora, sucursal, usuario, items, total, metodoPago, nota)
      VALUES (${fecha}, ${hora}, ${d.sucursal.slice(0, 120)}, ${d.usuario.slice(0, 200)}, ${JSON.stringify(items)}, ${total}, ${metodo}, ${(d.nota || "").slice(0, 300) || null})
    `);
    const id = ins?.[0]?.insertId ?? ins?.insertId ?? null;
    return { ok: true, id, total };
  },

  async listar(opts?: { estado?: string; sucursal?: string; limite?: number }) {
    const db = await getDb();
    if (!db) return [];
    await asegurarTablas(db);
    const limite = Math.min(Math.max(opts?.limite ?? 200, 1), 500);
    let where = sql`1=1`;
    if (opts?.estado && opts.estado !== "todas") where = sql`${where} AND estado = ${opts.estado}`;
    if (opts?.sucursal) where = sql`${where} AND sucursal = ${opts.sucursal}`;
    const r = filas(await db.execute(sql`
      SELECT id, fecha, hora, sucursal, usuario, items, total, metodoPago, nota, estado, registradaEn, registradaPor
      FROM contingencia_ventas WHERE ${where}
      ORDER BY estado = 'pendiente' DESC, fecha DESC, hora DESC LIMIT ${limite}
    `));
    return r.map((v: any) => ({
      ...v,
      total: num(v.total),
      items: (() => { try { return JSON.parse(v.items); } catch { return []; } })(),
    }));
  },

  // Marcar una venta como YA REGISTRADA en 365 (paso del checklist de cierre)
  async marcarRegistrada(id: number, por: string) {
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    await asegurarTablas(db);
    await db.execute(sql`UPDATE contingencia_ventas SET estado = 'registrada', registradaEn = NOW(), registradaPor = ${por.slice(0, 200)} WHERE id = ${id} AND estado = 'pendiente'`);
    return { ok: true };
  },

  async anular(id: number, nota: string, por: string) {
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    await asegurarTablas(db);
    await db.execute(sql`UPDATE contingencia_ventas SET estado = 'anulada', nota = ${`Anulada por ${por}: ${nota}`.slice(0, 300)} WHERE id = ${id} AND estado = 'pendiente'`);
    return { ok: true };
  },

  // Resumen de cierre: totales por sucursal y método de pago, para cuadrar caja
  // y verificar que ninguna venta quede sin pasar a 365.
  async resumenCierre() {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    await asegurarTablas(db);
    const porSucursal = filas(await db.execute(sql`
      SELECT sucursal, estado, COUNT(*) AS n, COALESCE(SUM(total),0) AS monto
      FROM contingencia_ventas GROUP BY sucursal, estado ORDER BY sucursal
    `));
    const porMetodo = filas(await db.execute(sql`
      SELECT metodoPago, COUNT(*) AS n, COALESCE(SUM(total),0) AS monto
      FROM contingencia_ventas WHERE estado = 'pendiente' GROUP BY metodoPago
    `));
    return {
      porSucursal: porSucursal.map((s: any) => ({ sucursal: s.sucursal, estado: s.estado, ventas: num(s.n), monto: Math.round(num(s.monto) * 100) / 100 })),
      pendientesPorMetodo: porMetodo.map((m: any) => ({ metodo: m.metodoPago, ventas: num(m.n), monto: Math.round(num(m.monto) * 100) / 100 })),
    };
  },
};
