// Cálculo de rentabilidad por sucursal (ingresos, costo, gastos, sueldos por
// asistencia, ganancia neta). Compartido entre el reporte (router) y el asistente
// para que ambos den EXACTAMENTE los mismos números.
import { getDb } from "./db";
import { sql } from "drizzle-orm";

export type RentabilidadSucursal = {
  sucursal: string;
  ingreso: number;
  ventas: number;
  costo: number;
  gastos: number;
  sueldos: number;
  gananciaProductos: number;
  netaAntesGenerales: number;
  cubreGastos: boolean;
};

export type RentabilidadResultado = {
  sucursales: RentabilidadSucursal[];
  gastosGenerales: number;
  gastosNoCancelados?: Array<{ nombre: string; categoria: string; monto: number; sucursal: string }>;
  nota: string;
  error?: string;
};

// anioMes en formato "YYYY-MM"
export async function calcularRentabilidadPorSucursal(anioMes: string): Promise<RentabilidadResultado> {
  const db = await getDb();
  if (!db) return { sucursales: [], gastosGenerales: 0, nota: "Sin BD" };
  const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
  const [anio, mes] = anioMes.split("-").map(Number);
  const desde = `${anioMes}-01`;
  const ultimoDia = new Date(anio, mes, 0).getDate();
  const hasta = `${anioMes}-${String(ultimoDia).padStart(2, "0")}`;

  try {
    const ingresos = rows(await db.execute(sql`
      SELECT nombreSucursal, SUM(total) as ingreso, COUNT(*) as ventas
       FROM ventas WHERE fecha >= ${desde} AND fecha <= ${hasta} AND nombreSucursal IS NOT NULL
       GROUP BY nombreSucursal
    `));
    const costos = rows(await db.execute(sql`
      SELECT d.nombreSucursal, SUM(d.cantidad * c.precioCostoUnid) as costo
       FROM ventas_detalle d JOIN productos_cache c ON c.nombre = d.articuloNombre
       WHERE d.fecha >= ${desde} AND d.fecha <= ${hasta}
       AND d.articuloNombre NOT LIKE '%ventas menores%' AND d.articuloNombre NOT LIKE '%venta menor%'
       AND c.precioCostoUnid > 0 AND d.nombreSucursal IS NOT NULL
       GROUP BY d.nombreSucursal
    `));
    const gastos = rows(await db.execute(sql`
      SELECT sucursal, SUM(monto) as gastos FROM gastos_registro
       WHERE anioMes=${anioMes} AND sucursal IS NOT NULL
       GROUP BY sucursal
    `));
    const gastosGenerales = rows(await db.execute(sql`
      SELECT SUM(monto) as total FROM gastos_registro
       WHERE anioMes=${anioMes} AND (sucursal IS NULL OR sucursal='')
    `))[0]?.total || 0;

    // Gastos NO cancelados (pagado=0) del mes, con su sucursal (o general)
    const noCancelados = rows(await db.execute(sql`
      SELECT nombre, categoria, monto, sucursal FROM gastos_registro
       WHERE anioMes=${anioMes} AND pagado=0
       ORDER BY sucursal, monto DESC
    `));
    const gastosNoCancelados = noCancelados.map((g: any) => ({
      nombre: g.nombre,
      categoria: g.categoria,
      monto: Number(g.monto) || 0,
      sucursal: g.sucursal || "general",
    }));

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

    // Sueldos por sucursal (calculados por asistencia / aperturas de caja)
    const { trabajadores } = await import("../drizzle/schema");
    const { eq } = await import("drizzle-orm");
    const { inventarios365 } = await import("./inventarios365");
    const { calcularResumenMensual } = await import("./domain/sueldos");
    const lista = await db.select().from(trabajadores).where(eq(trabajadores.activo, 1));

    const norm = (x: any) => String(x || "").trim().toLowerCase().replace(/\s+/g, " ");
    const sueldoPorTrabajador: any[] = [];
    for (const trab of lista) {
      const sueldoMensualNum = parseFloat(String(trab.sueldoMensual)) || 0;
      const esTipoFijo = (trab.tipoTrabajador || "fijo_mensual") === "fijo_mensual" || trab.tipoTrabajador === "fijo_turnos" || trab.tipoTrabajador === "fijo_horas";
      let sueldoCalc = 0;
      try {
        if (!trab.usuarioSistemaId) {
          sueldoCalc = sueldoMensualNum;
        } else {
          const aperturas = await inventarios365.aperturasCajaDelMes(trab.usuarioSistemaId, anioMes);
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
          } as any, anioMes);
          sueldoCalc = res.sueldoFinal;
          if (esTipoFijo && (sueldoCalc === 0 || isNaN(sueldoCalc)) && sueldoMensualNum > 0) {
            sueldoCalc = sueldoMensualNum;
          }
        }
      } catch {
        sueldoCalc = sueldoMensualNum;
      }
      if (isNaN(sueldoCalc)) sueldoCalc = sueldoMensualNum;
      sueldoPorTrabajador.push({ trab, sueldoCalc });
    }

    for (const s of Object.keys(mapa)) {
      const vend = rows(await db.execute(sql`
        SELECT DISTINCT vendedor FROM ventas WHERE nombreSucursal=${s} AND vendedor IS NOT NULL
      `));
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

    const resultado = Object.values(mapa).map((m: any) => {
      const gananciaProductos = m.ingreso - m.costo;
      const netaAntesGenerales = gananciaProductos - m.sueldos - m.gastos;
      return { ...m, gananciaProductos, netaAntesGenerales, cubreGastos: netaAntesGenerales >= 0 };
    }).sort((a: any, b: any) => b.netaAntesGenerales - a.netaAntesGenerales);

    return {
      sucursales: resultado,
      gastosGenerales: Number(gastosGenerales) || 0,
      gastosNoCancelados,
      nota: "Ganancia neta por sucursal = ingresos - costo de productos - sueldos (por asistencia) - gastos de la sucursal. Los gastos generales sin sucursal se muestran aparte.",
    };
  } catch (err: any) {
    return { sucursales: [], gastosGenerales: 0, nota: "Error", error: err.message };
  }
}
