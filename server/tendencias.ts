// TENDENCIAS Y ALERTAS PROACTIVAS — compara esta semana contra la anterior (por
// sucursal y total) y arma la serie de los últimos meses (reutiliza el resumen
// mensual ya cacheado). El umbral y la lógica de alerta son puros y testeados
// en domain/tendencias.ts — aquí solo se traen los montos reales.
import { getDb } from "./db";
import { sql } from "drizzle-orm";
import { compararPeriodo } from "./domain/tendencias";

const filas = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };

function hace(dias: number): string {
  const d = new Date(Date.now() - 4 * 3600 * 1000); // hoy Bolivia
  d.setDate(d.getDate() - dias);
  return d.toISOString().slice(0, 10);
}

async function montoPorSucursal(db: any, desde: string, hasta: string): Promise<Map<string, number>> {
  const r = filas(await db.execute(sql`
    SELECT COALESCE(nombreSucursal, 'Sin sucursal') AS sucursal, COALESCE(SUM(total),0) AS monto
    FROM ventas WHERE fecha >= ${desde} AND fecha < ${hasta} GROUP BY nombreSucursal
  `));
  return new Map(r.map((s: any) => [String(s.sucursal), num(s.monto)]));
}

export async function tendencias() {
  const db = await getDb();
  if (!db) return { error: "Sin BD" };

  // Semana actual (últimos 7 días incluido hoy) vs. los 7 días anteriores a esos
  const hoyMasUno = hace(-1); // límite exclusivo (mañana) para incluir hoy completo
  const inicioActual = hace(6);
  const inicioAnterior = hace(13);

  const [actualPorSuc, anteriorPorSuc] = await Promise.all([
    montoPorSucursal(db, inicioActual, hoyMasUno),
    montoPorSucursal(db, inicioAnterior, inicioActual),
  ]);

  const sucursales = new Set([...actualPorSuc.keys(), ...anteriorPorSuc.keys()]);
  const porSucursal = Array.from(sucursales).map((s) => {
    const actual = actualPorSuc.get(s) || 0;
    const anterior = anteriorPorSuc.get(s) || 0;
    return { sucursal: s, montoActual: Math.round(actual * 100) / 100, montoAnterior: Math.round(anterior * 100) / 100, ...compararPeriodo(actual, anterior) };
  }).sort((a, b) => (b.alerta ? 1 : 0) - (a.alerta ? 1 : 0));

  const totalActual = Array.from(actualPorSuc.values()).reduce((s, v) => s + v, 0);
  const totalAnterior = Array.from(anteriorPorSuc.values()).reduce((s, v) => s + v, 0);
  const total = { montoActual: Math.round(totalActual * 100) / 100, montoAnterior: Math.round(totalAnterior * 100) / 100, ...compararPeriodo(totalActual, totalAnterior) };

  // Serie histórica mensual (reutiliza el cache — meses cerrados al toque)
  const { resumenHistorico } = await import("./resumen-mensual");
  const historico = await resumenHistorico(6);

  const alertas = porSucursal.filter((s) => s.alerta);
  return {
    semana: { total, porSucursal },
    historicoMensual: historico.meses,
    resumen: {
      hayAlertas: alertas.length > 0,
      mensajes: alertas.map((s) =>
        `${s.sucursal}: ${s.direccion === "bajo" ? "bajaron" : "subieron"} ${Math.abs(s.cambioPct || 0)}% las ventas esta semana vs. la anterior`
      ),
    },
  };
}
