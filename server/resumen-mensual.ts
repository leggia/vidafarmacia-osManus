// RESUMEN MENSUAL DE VENTAS — cache persistente por mes y sucursal.
// Regla del proyecto: todo dato ya calculado queda REGISTRADO en la BD local.
// Los meses CERRADOS no cambian → se calculan UNA vez y quedan guardados: las
// consultas de meses anteriores responden al toque (una lectura de tabla chica)
// sin re-escanear decenas de miles de ventas. El mes EN CURSO siempre se calcula
// en vivo (sigue cambiando) y se guarda igualmente al pasar por aquí, de modo que
// al cerrar el mes ya queda su última foto.
import { getDb } from "./db";
import { FILTRO_NO_ANULADA } from "./ventas-comun";
import { sql } from "drizzle-orm";

const filas = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };

let tablaLista = false;
async function asegurarTabla(db: any) {
  if (tablaLista) return;
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS ventas_resumen_mensual (
      anioMes VARCHAR(7) NOT NULL,
      sucursal VARCHAR(150) NOT NULL,
      numVentas INT NOT NULL DEFAULT 0,
      monto DECIMAL(14,2) NOT NULL DEFAULT 0,
      actualizadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (anioMes, sucursal)
    )`));
  } catch { /* existe */ }
  tablaLista = true;
}

function rangoMes(anioMes: string): { desde: string; hasta: string } {
  const [a, m] = anioMes.split("-").map(Number);
  const sig = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, "0")}-01`;
  return { desde: `${anioMes}-01`, hasta: sig };
}

async function calcularYGuardar(db: any, anioMes: string) {
  const { desde, hasta } = rangoMes(anioMes);
  const porSucursal = filas(await db.execute(sql`
    SELECT COALESCE(nombreSucursal, 'Sin sucursal') AS sucursal, COUNT(*) AS n, COALESCE(SUM(total),0) AS monto
    FROM ventas WHERE fecha >= ${desde} AND fecha < ${hasta}${FILTRO_NO_ANULADA}
    GROUP BY nombreSucursal
  `));
  // Reemplazar el resumen del mes completo (idempotente)
  await db.execute(sql`DELETE FROM ventas_resumen_mensual WHERE anioMes = ${anioMes}`);
  for (const s of porSucursal) {
    await db.execute(sql`
      INSERT INTO ventas_resumen_mensual (anioMes, sucursal, numVentas, monto)
      VALUES (${anioMes}, ${String(s.sucursal).slice(0, 150)}, ${num(s.n)}, ${num(s.monto)})
    `);
  }
  return porSucursal.map((s: any) => ({ sucursal: s.sucursal, numVentas: num(s.n), monto: Math.round(num(s.monto) * 100) / 100 }));
}

/**
 * Resumen de UN mes. Meses cerrados: lee del cache (al toque); si no existe aún,
 * lo calcula una vez y lo deja guardado. Mes en curso: siempre en vivo (+guarda).
 */
export async function resumenMensual(anioMes: string, forzarRecalculo = false) {
  const db = await getDb();
  if (!db) return { error: "Sin BD" };
  await asegurarTabla(db);
  const mesActual = new Date().toISOString().slice(0, 7);
  const esMesCerrado = anioMes < mesActual;

  if (esMesCerrado && !forzarRecalculo) {
    const cache = filas(await db.execute(sql`SELECT sucursal, numVentas, monto FROM ventas_resumen_mensual WHERE anioMes = ${anioMes}`));
    if (cache.length > 0) {
      return {
        anioMes, desdeCache: true,
        porSucursal: cache.map((s: any) => ({ sucursal: s.sucursal, numVentas: num(s.numVentas), monto: Math.round(num(s.monto) * 100) / 100 })),
      };
    }
  }
  const porSucursal = await calcularYGuardar(db, anioMes);
  return { anioMes, desdeCache: false, porSucursal };
}

/**
 * Serie histórica de N meses (incluido el actual): totales por mes y sucursal,
 * ágil — los meses cerrados salen del cache y solo el actual se calcula en vivo.
 */
export async function resumenHistorico(meses = 12) {
  const hoy = new Date();
  const lista: any[] = [];
  for (let i = meses - 1; i >= 0; i--) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    const am = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const r: any = await resumenMensual(am);
    if (!r.error) {
      const total = (r.porSucursal || []).reduce((s: number, x: any) => s + x.monto, 0);
      const numVentas = (r.porSucursal || []).reduce((s: number, x: any) => s + x.numVentas, 0);
      lista.push({ anioMes: am, monto: Math.round(total * 100) / 100, numVentas, porSucursal: r.porSucursal, desdeCache: r.desdeCache });
    }
  }
  return { meses: lista };
}
