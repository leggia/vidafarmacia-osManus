// Módulo de CRÉDITOS de la farmacia + APARTADO PERSONAL (privado del dueño).
// Dos áreas separadas que NO afectan los reportes de rentabilidad del negocio:
//   - creditos_farmacia: deudas bancarias adquiridas para inventario (control, no
//     acelera pagos). Con sus pagos de cuota registrables.
//   - finanzas_personales: ingresos (sueldo, retiros de la farmacia, otros) y gastos
//     personales con detalle. Totalmente aislado de la contabilidad de la farmacia.
import { getDb } from "./db";
import { sql } from "drizzle-orm";

const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };

let listas = false;
async function asegurarTablas() {
  if (listas) return;
  const db = await getDb();
  if (!db) return;
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS creditos_farmacia (
      id INT AUTO_INCREMENT PRIMARY KEY,
      banco VARCHAR(120) NOT NULL,
      descripcion VARCHAR(250),
      montoTotal DECIMAL(12,2) NOT NULL,
      cuotaMensual DECIMAL(12,2) NOT NULL,
      plazoMeses INT NOT NULL,
      tasaAnual DECIMAL(6,2),
      fechaInicio DATE,
      diaPago INT,
      estado VARCHAR(20) NOT NULL DEFAULT 'activo',
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`));
  } catch { /* existe */ }
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS creditos_pagos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      creditoId INT NOT NULL,
      monto DECIMAL(12,2) NOT NULL,
      fecha DATE NOT NULL,
      nota VARCHAR(250),
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cp_credito (creditoId)
    )`));
  } catch { /* existe */ }
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS finanzas_personales (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tipo VARCHAR(10) NOT NULL,
      categoria VARCHAR(80),
      detalle VARCHAR(250),
      monto DECIMAL(12,2) NOT NULL,
      fecha DATE NOT NULL,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_fp_tipo (tipo),
      INDEX idx_fp_fecha (fecha)
    )`));
  } catch { /* existe */ }
  listas = true;
}

// ─────────────────────────── CRÉDITOS DE LA FARMACIA ───────────────────────────
export const creditos = {
  async listar() {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return { creditos: [], resumen: { deudaTotal: 0, cuotaMensualTotal: 0, activos: 0 } };
    const lista = rows(await db.execute(sql.raw(`SELECT * FROM creditos_farmacia ORDER BY estado, creadoEn DESC`)));
    const pagos = rows(await db.execute(sql.raw(`SELECT creditoId, COALESCE(SUM(monto),0) AS pagado, COUNT(*) AS numPagos FROM creditos_pagos GROUP BY creditoId`)));
    const pagosMap: Record<number, { pagado: number; numPagos: number }> = {};
    for (const p of pagos) pagosMap[num(p.creditoId)] = { pagado: num(p.pagado), numPagos: num(p.numPagos) };

    let deudaTotal = 0, cuotaMensualTotal = 0, activos = 0;
    const enriquecidos = lista.map((c: any) => {
      const pg = pagosMap[num(c.id)] || { pagado: 0, numPagos: 0 };
      const totalAPagar = num(c.cuotaMensual) * num(c.plazoMeses) || num(c.montoTotal);
      const saldo = Math.max(0, totalAPagar - pg.pagado);
      const cuotasPagadas = num(c.cuotaMensual) > 0 ? Math.round(pg.pagado / num(c.cuotaMensual)) : 0;
      const cuotasRestantes = Math.max(0, num(c.plazoMeses) - cuotasPagadas);
      const estaActivo = c.estado === "activo" && saldo > 0.5;
      if (estaActivo) { deudaTotal += saldo; cuotaMensualTotal += num(c.cuotaMensual); activos++; }
      return {
        ...c,
        montoTotal: num(c.montoTotal), cuotaMensual: num(c.cuotaMensual), tasaAnual: num(c.tasaAnual),
        totalAPagar, pagado: pg.pagado, saldo, cuotasPagadas, cuotasRestantes,
        pctPagado: totalAPagar > 0 ? Math.round((pg.pagado / totalAPagar) * 100) : 0,
        estado: saldo <= 0.5 ? "pagado" : c.estado,
      };
    });
    return { creditos: enriquecidos, resumen: { deudaTotal: Math.round(deudaTotal * 100) / 100, cuotaMensualTotal: Math.round(cuotaMensualTotal * 100) / 100, activos } };
  },

  async crear(d: { banco: string; descripcion?: string; montoTotal: number; cuotaMensual: number; plazoMeses: number; tasaAnual?: number; fechaInicio?: string; diaPago?: number }) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    await db.execute(sql`
      INSERT INTO creditos_farmacia (banco, descripcion, montoTotal, cuotaMensual, plazoMeses, tasaAnual, fechaInicio, diaPago)
      VALUES (${d.banco.slice(0, 120)}, ${(d.descripcion || "").slice(0, 250)}, ${num(d.montoTotal)}, ${num(d.cuotaMensual)},
              ${num(d.plazoMeses)}, ${d.tasaAnual != null ? num(d.tasaAnual) : null}, ${d.fechaInicio || null}, ${d.diaPago != null ? num(d.diaPago) : null})
    `);
    return { ok: true };
  },

  async registrarPago(d: { creditoId: number; monto: number; fecha: string; nota?: string }) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    await db.execute(sql`
      INSERT INTO creditos_pagos (creditoId, monto, fecha, nota)
      VALUES (${num(d.creditoId)}, ${num(d.monto)}, ${d.fecha}, ${(d.nota || "").slice(0, 250)})
    `);
    return { ok: true };
  },

  async pagosDe(creditoId: number) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return { pagos: [] };
    const pagos = rows(await db.execute(sql`SELECT * FROM creditos_pagos WHERE creditoId = ${num(creditoId)} ORDER BY fecha DESC`));
    return { pagos };
  },

  async eliminar(id: number) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    await db.execute(sql`DELETE FROM creditos_pagos WHERE creditoId = ${num(id)}`);
    await db.execute(sql`DELETE FROM creditos_farmacia WHERE id = ${num(id)}`);
    return { ok: true };
  },

  async marcarEstado(id: number, estado: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    if (!["activo", "pagado", "pausado"].includes(estado)) throw new Error("Estado inválido");
    await db.execute(sql`UPDATE creditos_farmacia SET estado = ${estado} WHERE id = ${num(id)}`);
    return { ok: true };
  },
};

// ─────────────────────────── APARTADO PERSONAL (privado) ───────────────────────
export const personal = {
  async resumen(desde?: string, hasta?: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return { movimientos: [], resumen: { ingresos: 0, gastos: 0, balance: 0 }, porCategoria: [] };
    const cond = desde && hasta ? sql`WHERE fecha >= ${desde} AND fecha <= ${hasta}` : sql``;
    const movs = rows(await db.execute(sql`SELECT * FROM finanzas_personales ${cond} ORDER BY fecha DESC, id DESC LIMIT 300`));
    let ingresos = 0, gastos = 0;
    for (const m of movs) { if (m.tipo === "ingreso") ingresos += num(m.monto); else gastos += num(m.monto); }
    // Gastos por categoría
    const catMap: Record<string, number> = {};
    for (const m of movs) if (m.tipo === "gasto") { const k = m.categoria || "Otros"; catMap[k] = (catMap[k] || 0) + num(m.monto); }
    const porCategoria = Object.entries(catMap).map(([categoria, monto]) => ({ categoria, monto: Math.round(monto * 100) / 100 })).sort((a, b) => b.monto - a.monto);
    return {
      movimientos: movs.map((m: any) => ({ ...m, monto: num(m.monto) })),
      resumen: { ingresos: Math.round(ingresos * 100) / 100, gastos: Math.round(gastos * 100) / 100, balance: Math.round((ingresos - gastos) * 100) / 100 },
      porCategoria,
    };
  },

  async registrar(d: { tipo: string; categoria?: string; detalle?: string; monto: number; fecha: string }) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    if (!["ingreso", "gasto"].includes(d.tipo)) throw new Error("Tipo inválido");
    await db.execute(sql`
      INSERT INTO finanzas_personales (tipo, categoria, detalle, monto, fecha)
      VALUES (${d.tipo}, ${(d.categoria || "").slice(0, 80)}, ${(d.detalle || "").slice(0, 250)}, ${num(d.monto)}, ${d.fecha})
    `);
    return { ok: true };
  },

  async eliminar(id: number) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    await db.execute(sql`DELETE FROM finanzas_personales WHERE id = ${num(id)}`);
    return { ok: true };
  },
};

// Categorías sugeridas para el apartado personal
export const CATEGORIAS_INGRESO = ["Sueldo", "Retiro de la farmacia", "Otros ingresos"];
export const CATEGORIAS_GASTO = ["Alimentación", "Servicios (luz, agua, internet)", "Vivienda/Alquiler", "Familia", "Salud", "Transporte", "Educación", "Ocio", "Otros"];
