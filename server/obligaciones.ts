// OBLIGACIONES DEL MES — centro empresarial de pagos comprometidos: cuotas de
// créditos bancarios + gastos fijos (alquiler, luz, etc.). Cada obligación es una
// FICHA accionable con fecha límite: el día de pago del banco (diaPago) o el día
// de vencimiento del gasto (diaVencimiento); si no tiene, se exige desde el día
// 10 del mes (regla del negocio: todo el mes anterior cerrado sin deudas).
// Estado: pagado | alerta (hoy >= fecha límite y sin pagar) | proximo.
import { getDb } from "./db";
import { sql } from "drizzle-orm";

const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const DIA_LIMITE_DEFECTO = 10;

export type Obligacion = {
  clave: string;               // única: "credito-3" | "gasto-7"
  tipo: "credito" | "gasto" | "sueldo";
  refId: number;               // id del crédito o del gasto fijo
  nombre: string;
  detalle: string;
  monto: number;
  diaLimite: number;
  fechaLimite: string;         // YYYY-MM-DD del mes consultado
  estado: "pagado" | "alerta" | "proximo";
  diasParaVencer: number;      // negativo si ya pasó
  fechaPago?: string | null;   // si ya se pagó este mes
};

export async function obligacionesDelMes(anioMes?: string) {
  const db = await getDb();
  if (!db) return { error: "Sin BD" };
  const hoy = new Date();
  const am = anioMes || `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
  const [anio, mes] = am.split("-").map(Number);
  const ultimoDia = new Date(anio, mes, 0).getDate();
  const hoyStr = hoy.toISOString().slice(0, 10);

  const obligaciones: Obligacion[] = [];

  // ── 1. Cuotas de créditos bancarios activos ──
  try {
    const creditos = rows(await db.execute(sql.raw(`SELECT id, banco, descripcion, cuotaMensual, diaPago FROM creditos_farmacia WHERE estado = 'activo'`)));
    if (creditos.length > 0) {
      const desde = `${am}-01`, hasta = `${am}-${String(ultimoDia).padStart(2, "0")}`;
      const pagosMes = rows(await db.execute(sql`SELECT creditoId, MAX(fecha) AS fecha FROM creditos_pagos WHERE fecha >= ${desde} AND fecha <= ${hasta} GROUP BY creditoId`));
      const pagadoMap = new Map(pagosMes.map((p: any) => [num(p.creditoId), String(p.fecha).slice(0, 10)]));
      for (const c of creditos) {
        const dia = Math.min(c.diaPago != null && num(c.diaPago) >= 1 ? num(c.diaPago) : DIA_LIMITE_DEFECTO, ultimoDia);
        const fechaLimite = `${am}-${String(dia).padStart(2, "0")}`;
        const fechaPago = pagadoMap.get(num(c.id)) || null;
        const diasParaVencer = Math.round((new Date(fechaLimite).getTime() - new Date(hoyStr).getTime()) / 86400000);
        obligaciones.push({
          clave: `credito-${c.id}`, tipo: "credito", refId: num(c.id),
          nombre: `Cuota ${c.banco}`,
          detalle: c.descripcion || "Crédito bancario",
          monto: num(c.cuotaMensual), diaLimite: dia, fechaLimite,
          estado: fechaPago ? "pagado" : (hoyStr >= fechaLimite ? "alerta" : "proximo"),
          diasParaVencer, fechaPago,
        });
      }
    }
  } catch { /* módulo créditos sin tabla aún */ }

  // ── 2. Gastos fijos activos (alquiler, servicios, etc.) ──
  try {
    const fijos = rows(await db.execute(sql.raw(`SELECT id, nombre, categoria, montoEstimado, diaVencimiento FROM gastos_fijos WHERE activo = 1`)));
    if (fijos.length > 0) {
      const registros = rows(await db.execute(sql`SELECT gastoFijoId, pagado, fechaPago, monto FROM gastos_registro WHERE anioMes = ${am} AND gastoFijoId IS NOT NULL`));
      const regMap = new Map(registros.map((r: any) => [num(r.gastoFijoId), r]));
      for (const g of fijos) {
        const dia = Math.min(g.diaVencimiento != null && num(g.diaVencimiento) >= 1 ? num(g.diaVencimiento) : DIA_LIMITE_DEFECTO, ultimoDia);
        const fechaLimite = `${am}-${String(dia).padStart(2, "0")}`;
        const reg: any = regMap.get(num(g.id));
        const pagado = reg && num(reg.pagado) === 1;
        const diasParaVencer = Math.round((new Date(fechaLimite).getTime() - new Date(hoyStr).getTime()) / 86400000);
        obligaciones.push({
          clave: `gasto-${g.id}`, tipo: "gasto", refId: num(g.id),
          nombre: g.nombre,
          detalle: `Gasto fijo · ${g.categoria}`,
          monto: reg ? num(reg.monto) || num(g.montoEstimado) : num(g.montoEstimado),
          diaLimite: dia, fechaLimite,
          estado: pagado ? "pagado" : (hoyStr >= fechaLimite ? "alerta" : "proximo"),
          diasParaVencer, fechaPago: pagado ? (reg.fechaPago || null) : null,
        });
      }
    }
  } catch { /* módulo gastos sin tabla aún */ }

  // SUELDOS: son una obligación mensual más. Se toma el sueldo de cada trabajador
  // activo y se marca pagado si existe el registro del mes en pagos_sueldo (donde
  // queda el monto realmente pagado, que puede diferir por descuentos o extras).
  try {
    const trabs = rows(await db.execute(sql.raw(
      `SELECT id, nombre, sucursalFija, sueldoMensual FROM trabajadores WHERE activo = 1`
    )));
    if (trabs.length > 0) {
      const pagos = rows(await db.execute(sql`
        SELECT trabajadorId, pagado, montoPagado, fechaPago FROM pagos_sueldo WHERE anioMes = ${am}
      `));
      const pagoMap = new Map(pagos.map((p: any) => [num(p.trabajadorId), p]));
      // Los sueldos se pagan a fin de mes salvo que se configure otra cosa.
      const dia = ultimoDia;
      const fechaLimite = `${am}-${String(dia).padStart(2, "0")}`;
      const diasParaVencer = Math.round((new Date(fechaLimite).getTime() - new Date(hoyStr).getTime()) / 86400000);
      for (const t of trabs) {
        const pago: any = pagoMap.get(num(t.id));
        const pagado = pago && num(pago.pagado) === 1;
        const monto = pagado && num(pago.montoPagado) > 0 ? num(pago.montoPagado) : num(t.sueldoMensual);
        if (monto <= 0) continue; // sin sueldo configurado: no es obligación
        obligaciones.push({
          clave: `sueldo-${t.id}`, tipo: "sueldo", refId: num(t.id),
          nombre: `Sueldo · ${t.nombre}`,
          detalle: t.sucursalFija ? `Sueldo mensual · ${t.sucursalFija}` : "Sueldo mensual",
          monto,
          diaLimite: dia, fechaLimite,
          estado: pagado ? "pagado" : (hoyStr >= fechaLimite ? "alerta" : "proximo"),
          diasParaVencer, fechaPago: pagado ? (pago.fechaPago || null) : null,
        });
      }
    }
  } catch { /* módulo de sueldos sin tabla aún */ }

  // Orden empresarial: alertas primero (más vencida primero), luego próximas por
  // fecha, pagadas al final.
  const peso = (o: Obligacion) => o.estado === "alerta" ? 0 : o.estado === "proximo" ? 1 : 2;
  obligaciones.sort((a, b) => peso(a) - peso(b) || a.fechaLimite.localeCompare(b.fechaLimite));

  const totalMes = obligaciones.reduce((s, o) => s + o.monto, 0);
  const pagadoMes = obligaciones.filter(o => o.estado === "pagado").reduce((s, o) => s + o.monto, 0);
  const enAlerta = obligaciones.filter(o => o.estado === "alerta");

  return {
    anioMes: am,
    obligaciones,
    resumen: {
      total: Math.round(totalMes * 100) / 100,
      pagado: Math.round(pagadoMes * 100) / 100,
      pendiente: Math.round((totalMes - pagadoMes) * 100) / 100,
      enAlerta: enAlerta.length,
      montoEnAlerta: Math.round(enAlerta.reduce((s, o) => s + o.monto, 0) * 100) / 100,
    },
  };
}

// Pagar una obligación desde la ficha (acción directa, sin ir a otro módulo).
export async function pagarObligacion(d: { tipo: "credito" | "gasto" | "sueldo"; refId: number; anioMes: string; monto: number }) {
  const db = await getDb();
  if (!db) throw new Error("Sin BD");
  const hoyStr = new Date().toISOString().slice(0, 10);
  if (d.tipo === "sueldo") {
    // Un pago de sueldo por trabajador y mes (sin duplicados)
    const ya = rows(await db.execute(sql`SELECT id, montoPagado FROM pagos_sueldo WHERE trabajadorId = ${num(d.refId)} AND anioMes = ${d.anioMes} LIMIT 1`));
    if (ya.length > 0) throw new Error(`El sueldo de este mes ya está registrado (Bs ${num(ya[0].montoPagado)}). Edítalo en el módulo de sueldos si hubo un detalle.`);
    await db.execute(sql`INSERT INTO pagos_sueldo (trabajadorId, anioMes, montoPagado, pagado, notas) VALUES (${num(d.refId)}, ${d.anioMes}, ${num(d.monto)}, 1, ${"Pagado desde Obligaciones"})`);
    return { ok: true, mensaje: "Pago de sueldo registrado" };
  }
  if (d.tipo === "credito") {
    // Misma protección que /creditos: una cuota por mes, sin duplicados
    const ya = rows(await db.execute(sql`SELECT id, monto, fecha FROM creditos_pagos WHERE creditoId = ${num(d.refId)} AND DATE_FORMAT(fecha, '%Y-%m') = ${d.anioMes} LIMIT 1`));
    if (ya.length > 0) throw new Error(`La cuota de este mes ya está registrada (Bs ${num(ya[0].monto)} el ${String(ya[0].fecha).slice(0, 10)}). Edítala en /creditos si hubo un detalle.`);
    await db.execute(sql`INSERT INTO creditos_pagos (creditoId, monto, fecha, nota) VALUES (${num(d.refId)}, ${num(d.monto)}, ${hoyStr}, ${"Pagado desde Obligaciones"})`);
    return { ok: true, mensaje: "Pago de cuota registrado" };
  }
  // Gasto fijo: marcar el registro del mes como pagado (crearlo si no existe)
  const reg = rows(await db.execute(sql`SELECT id FROM gastos_registro WHERE anioMes = ${d.anioMes} AND gastoFijoId = ${num(d.refId)} LIMIT 1`));
  if (reg.length > 0) {
    await db.execute(sql`UPDATE gastos_registro SET pagado = 1, fechaPago = ${hoyStr}, monto = ${num(d.monto)} WHERE id = ${num(reg[0].id)}`);
  } else {
    const fijo = rows(await db.execute(sql`SELECT nombre, categoria FROM gastos_fijos WHERE id = ${num(d.refId)}`));
    await db.execute(sql`
      INSERT INTO gastos_registro (anioMes, gastoFijoId, nombre, categoria, monto, pagado, fechaPago)
      VALUES (${d.anioMes}, ${num(d.refId)}, ${fijo[0]?.nombre || "Gasto fijo"}, ${fijo[0]?.categoria || "servicios"}, ${num(d.monto)}, 1, ${hoyStr})
    `);
  }
  return { ok: true, mensaje: "Gasto marcado como pagado" };
}
