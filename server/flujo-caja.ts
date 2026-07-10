// FLUJO DE CAJA — "modo empresarial": histórico real (últimos meses) + proyección
// (próximos meses) con TODOS los compromisos financieros: ventas, costo de
// mercadería, gastos operativos, sueldos, cuotas de créditos. Da el excedente
// real disponible mes a mes, con metodología transparente (nunca una caja negra).
import { getDb } from "./db";
import { sql } from "drizzle-orm";

const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const round2 = (n: number) => Math.round(n * 100) / 100;

function mesesAtras(n: number): string[] {
  const out: string[] = [];
  const hoy = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
function mesesAdelante(n: number): string[] {
  const out: string[] = [];
  const hoy = new Date();
  for (let i = 1; i <= n; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
function nombreMes(anioMes: string): string {
  const [y, m] = anioMes.split("-").map(Number);
  const NOMBRES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  return `${NOMBRES[m - 1]} ${y}`;
}

type MesFlujo = {
  anioMes: string; mesNombre: string; esProyeccion: boolean;
  ingresos: number; costoMercaderia: number; gastosOperativos: number; sueldos: number; cuotasCreditos: number;
  totalEgresos: number; neto: number; negativo: boolean;
  porSucursal?: { sucursal: string; ingresos: number }[];
};

// Compromisos FIJOS conocidos (no dependen de ventas): gastos fijos activos,
// sueldos aproximados (suma de sueldoMensual de trabajadores activos — una
// aproximación simple; el cálculo exacto por asistencia está en Reportes/
// Rentabilidad para un mes puntual) y la cuota mensual total de créditos activos.
async function compromisosFijosMensuales(db: any) {
  let gastosFijos = 0, sueldosAprox = 0, cuotasCreditos = 0;
  try {
    const r = rows(await db.execute(sql.raw(`SELECT COALESCE(SUM(montoEstimado),0) AS t FROM gastos_fijos WHERE activo = 1`)));
    gastosFijos = num(r[0]?.t);
  } catch { /* tabla puede no existir aún */ }
  try {
    const r = rows(await db.execute(sql.raw(`SELECT COALESCE(SUM(sueldoMensual),0) AS t FROM trabajadores WHERE activo = 1`)));
    sueldosAprox = num(r[0]?.t);
  } catch { /* n/a */ }
  try {
    const r = rows(await db.execute(sql.raw(
      `SELECT COALESCE(SUM(cuotaMensual),0) AS t FROM creditos_farmacia WHERE estado = 'activo'`
    )));
    cuotasCreditos = num(r[0]?.t);
  } catch { /* módulo de créditos puede no tener tabla aún */ }
  return { gastosFijos, sueldosAprox, cuotasCreditos };
}

async function mesHistorico(db: any, anioMes: string): Promise<MesFlujo> {
  const [anio, mes] = anioMes.split("-").map(Number);
  const desde = `${anioMes}-01`;
  const ultimoDia = new Date(anio, mes, 0).getDate();
  const hasta = `${anioMes}-${String(ultimoDia).padStart(2, "0")}`;

  const ing = rows(await db.execute(sql`SELECT COALESCE(SUM(total),0) AS t FROM ventas WHERE fecha >= ${desde} AND fecha <= ${hasta}`));
  const ingresos = num(ing[0]?.t);

  const porSucursalRaw = rows(await db.execute(sql`
    SELECT nombreSucursal, COALESCE(SUM(total),0) AS t FROM ventas
    WHERE fecha >= ${desde} AND fecha <= ${hasta} AND nombreSucursal IS NOT NULL GROUP BY nombreSucursal
  `));
  const porSucursal = porSucursalRaw.map((r: any) => ({ sucursal: r.nombreSucursal, ingresos: num(r.t) }));

  let costoMercaderia = 0;
  try {
    const c = rows(await db.execute(sql`
      SELECT COALESCE(SUM(d.cantidad * pc.precioCostoUnid),0) AS t
      FROM ventas_detalle d JOIN productos_cache pc ON pc.nombre = d.articuloNombre
      WHERE d.fecha >= ${desde} AND d.fecha <= ${hasta}
      AND d.articuloNombre NOT LIKE '%ventas menores%' AND d.articuloNombre NOT LIKE '%venta menor%'
      AND pc.precioCostoUnid > 0
    `));
    costoMercaderia = num(c[0]?.t);
  } catch { /* sin cache de costos */ }

  let gastosOperativos = 0;
  try {
    const g = rows(await db.execute(sql`SELECT COALESCE(SUM(monto),0) AS t FROM gastos_registro WHERE anioMes = ${anioMes} AND pagado = 1`));
    gastosOperativos = num(g[0]?.t);
  } catch { /* n/a */ }

  let cuotasCreditos = 0;
  try {
    const cr = rows(await db.execute(sql`SELECT COALESCE(SUM(monto),0) AS t FROM creditos_pagos WHERE fecha >= ${desde} AND fecha <= ${hasta}`));
    cuotasCreditos = num(cr[0]?.t); // pagos REALES hechos ese mes (histórico = lo real, no lo comprometido)
  } catch { /* n/a */ }

  // Sueldos históricos: aproximado con el mismo criterio (no recalculamos
  // asistencia mes a mes por costo de rendimiento; el exacto está en Rentabilidad).
  const { sueldosAprox } = await compromisosFijosMensuales(db);

  const totalEgresos = round2(costoMercaderia + gastosOperativos + sueldosAprox + cuotasCreditos);
  const neto = round2(ingresos - totalEgresos);
  return {
    anioMes, mesNombre: nombreMes(anioMes), esProyeccion: false,
    ingresos: round2(ingresos), costoMercaderia: round2(costoMercaderia), gastosOperativos: round2(gastosOperativos),
    sueldos: round2(sueldosAprox), cuotasCreditos: round2(cuotasCreditos),
    totalEgresos, neto, negativo: neto < 0,
    porSucursal: porSucursal.map((p) => ({ ...p, ingresos: round2(p.ingresos) })),
  };
}

export async function flujoDeCaja(mesesHistoria = 6, mesesProyectar = 3) {
  const db = await getDb();
  if (!db) return { error: "Sin BD" };

  const historicoMeses = mesesAtras(mesesHistoria);
  const historico: MesFlujo[] = [];
  for (const am of historicoMeses) historico.push(await mesHistorico(db, am));

  // Promedios de los ÚLTIMOS 3 meses completos (excluye el mes actual si está en
  // curso, para no subestimar con un mes a medio terminar) para proyectar.
  const hoyStr = new Date().toISOString().slice(0, 7);
  const mesesCompletos = historico.filter((m) => m.anioMes !== hoyStr);
  const base = mesesCompletos.slice(-3);
  const prom = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const ingresoPromedio = prom(base.map((m) => m.ingresos));
  const costoPromedioPctSobreIngreso = ingresoPromedio > 0 ? prom(base.map((m) => m.costoMercaderia)) / ingresoPromedio : 0;
  const gastosOcasionalesPromedio = prom(base.map((m) => Math.max(0, m.gastosOperativos))); // aproximación: ya incluye fijos pagados

  // Tendencia simple: comparar la mitad más reciente vs la más antigua de la base
  let tendenciaPct = 0;
  if (base.length >= 2) {
    const mitad = Math.floor(base.length / 2) || 1;
    const antiguos = prom(base.slice(0, mitad).map((m) => m.ingresos));
    const recientes = prom(base.slice(-mitad).map((m) => m.ingresos));
    tendenciaPct = antiguos > 0 ? (recientes - antiguos) / antiguos : 0;
  }
  tendenciaPct = Math.max(-0.15, Math.min(0.15, tendenciaPct)); // acotar a ±15% para no proyectar extremos

  const { gastosFijos, sueldosAprox, cuotasCreditos } = await compromisosFijosMensuales(db);

  const proyeccion: MesFlujo[] = [];
  let ingresoProyBase = ingresoPromedio;
  for (const am of mesesAdelante(mesesProyectar)) {
    ingresoProyBase = ingresoProyBase * (1 + tendenciaPct);
    const ingresos = round2(ingresoProyBase);
    const costoMercaderia = round2(ingresos * costoPromedioPctSobreIngreso);
    // Egresos proyectados: compromisos FIJOS conocidos (siempre) + gastos
    // ocasionales al ritmo promedio observado.
    const gastosOperativos = round2(gastosFijos + gastosOcasionalesPromedio);
    const totalEgresos = round2(costoMercaderia + gastosOperativos + sueldosAprox + cuotasCreditos);
    const neto = round2(ingresos - totalEgresos);
    proyeccion.push({
      anioMes: am, mesNombre: nombreMes(am), esProyeccion: true,
      ingresos, costoMercaderia, gastosOperativos, sueldos: round2(sueldosAprox), cuotasCreditos: round2(cuotasCreditos),
      totalEgresos, neto, negativo: neto < 0,
    });
  }

  const mesesNegativosProyectados = proyeccion.filter((m) => m.negativo).map((m) => m.mesNombre);
  const excedentePromedioHistorico = round2(prom(mesesCompletos.map((m) => m.neto)));
  const excedentePromedioProyectado = round2(prom(proyeccion.map((m) => m.neto)));

  return {
    historico, proyeccion,
    metodologia: `Proyección basada en el promedio de ventas de los últimos ${base.length} meses completos, con tendencia acotada a ±15% (comparando la mitad más reciente vs. la más antigua del período base). Los egresos fijos (gastos fijos activos, sueldos aproximados por planilla, cuotas de créditos activos) se mantienen constantes; el costo de mercadería y los gastos ocasionales se proyectan al ritmo promedio observado. Es una estimación, no una garantía — mientras más vieja la tendencia, menos precisa.`,
    compromisosFijosMensuales: { gastosFijos: round2(gastosFijos), sueldosAprox: round2(sueldosAprox), cuotasCreditos: round2(cuotasCreditos), total: round2(gastosFijos + sueldosAprox + cuotasCreditos) },
    resumen: {
      excedentePromedioHistorico, excedentePromedioProyectado,
      mesesNegativosProyectados,
      alerta: mesesNegativosProyectados.length > 0
        ? `⚠ Con el ritmo actual, ${mesesNegativosProyectados.length === 1 ? "el mes" : "los meses"} ${mesesNegativosProyectados.join(", ")} proyecta${mesesNegativosProyectados.length === 1 ? "" : "n"} flujo NEGATIVO. Revisa gastos comprometidos o el ritmo de ventas.`
        : null,
    },
  };
}
