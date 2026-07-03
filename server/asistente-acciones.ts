// FASE 2 del asistente: ACCIONES con confirmación y auditoría.
// Flujo: el asistente PROPONE (se guarda pendiente) → el usuario CONFIRMA →
// se EJECUTA → queda AUDITADO (qué, cuándo, valores antes/después, resultado).
// Nunca se ejecuta nada sin confirmación explícita del usuario.
import { getDb } from "./db";
import { sql } from "drizzle-orm";

const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const EXPIRA_MIN = 10; // una propuesta caduca a los 10 minutos

let tablasListas = false;
async function asegurarTablas() {
  if (tablasListas) return;
  const db = await getDb();
  if (!db) return;
  const sentencias = [
    `CREATE TABLE IF NOT EXISTS asistente_acciones_pendientes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tipo VARCHAR(60) NOT NULL,
      params JSON,
      resumen VARCHAR(500),
      estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS asistente_auditoria (
      id INT AUTO_INCREMENT PRIMARY KEY,
      accion VARCHAR(60) NOT NULL,
      detalle VARCHAR(800),
      valorAnterior VARCHAR(300),
      valorNuevo VARCHAR(300),
      resultado VARCHAR(300),
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_aud_fecha (creadoEn)
    )`,
  ];
  for (const st of sentencias) {
    try { await db.execute(sql.raw(st)); } catch { /* ya existe */ }
  }
  tablasListas = true;
}

async function auditar(accion: string, detalle: string, valorAnterior: string, valorNuevo: string, resultado: string) {
  try {
    const db = await getDb();
    if (!db) return;
    await db.execute(sql`
      INSERT INTO asistente_auditoria (accion, detalle, valorAnterior, valorNuevo, resultado)
      VALUES (${accion}, ${detalle.slice(0, 800)}, ${valorAnterior.slice(0, 300)}, ${valorNuevo.slice(0, 300)}, ${resultado.slice(0, 300)})
    `);
  } catch (e: any) {
    console.warn("[Acciones] No se pudo auditar:", e?.message);
  }
}

// Crear una propuesta pendiente (cancela cualquier otra pendiente: solo una a la vez)
async function proponer(tipo: string, params: any, resumen: string) {
  await asegurarTablas();
  const db = await getDb();
  if (!db) return { error: "Sin BD" };
  await db.execute(sql`UPDATE asistente_acciones_pendientes SET estado='cancelada' WHERE estado='pendiente'`);
  await db.execute(sql`
    INSERT INTO asistente_acciones_pendientes (tipo, params, resumen)
    VALUES (${tipo}, ${JSON.stringify(params)}, ${resumen.slice(0, 500)})
  `);
  return {
    propuesta: resumen,
    estado: "PENDIENTE DE CONFIRMACIÓN",
    instruccionEstricta: "Presenta la propuesta al usuario y pregúntale si CONFIRMA. NO digas que ya se hizo: aún NO se ejecutó nada. Si el usuario responde 'sí'/'confirmo', llama la herramienta confirmarAccion. Si dice 'no', llama cancelarAccion.",
  };
}

// ─── Ejecutores reales por tipo ───
async function ejecutarCambioPrecio(params: any) {
  const { inventarios365 } = await import("./inventarios365");
  const ok = await inventarios365.actualizarPrecioVenta(num(params.idArticulo), num(params.nuevoPrecio));
  if (!ok) throw new Error("365 rechazó la actualización tras 3 intentos");
  // Refrescar el cache local para que las consultas muestren el precio nuevo
  try {
    const db = await getDb();
    if (db) await db.execute(sql`UPDATE productos_cache SET precioUno = ${num(params.nuevoPrecio)} WHERE nombre = ${String(params.nombreProducto)}`);
  } catch { /* cache se refresca solo después */ }
  return `Precio de "${params.nombreProducto}" actualizado a Bs ${params.nuevoPrecio} en 365`;
}

async function ejecutarMarcarPagado(params: any) {
  const db = await getDb();
  if (!db) throw new Error("Sin BD");
  const hoy = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10); // Bolivia
  const r: any = await db.execute(sql`
    UPDATE gastos_registro SET pagado = 1, fechaPago = ${hoy} WHERE id = ${num(params.gastoId)} AND pagado = 0
  `);
  const afectadas = Array.isArray(r) ? (r[0]?.affectedRows ?? 0) : (r?.affectedRows ?? 0);
  if (!afectadas) throw new Error("El gasto no existe o ya estaba pagado");
  return `Gasto "${params.nombreGasto}" marcado como PAGADO (${hoy})`;
}

async function ejecutarRegistrarGasto(params: any) {
  const db = await getDb();
  if (!db) throw new Error("Sin BD");
  const anioMes = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 7);
  await db.execute(sql`
    INSERT INTO gastos_registro (anioMes, nombre, categoria, monto, pagado, esOcasional, sucursal)
    VALUES (${anioMes}, ${String(params.nombre).slice(0, 150)}, ${String(params.categoria || "otros").slice(0, 40)},
            ${num(params.monto)}, ${params.yaPagado ? 1 : 0}, 1, ${params.sucursal ? String(params.sucursal) : null})
  `);
  return `Gasto ocasional "${params.nombre}" de Bs ${params.monto} registrado en ${anioMes}${params.sucursal ? " (" + params.sucursal + ")" : ""}`;
}

// ─── API pública (las herramientas del asistente) ───
export const accionesTools = {
  // Proponer: cambiar precio de venta
  async cambiarPrecioVenta(nombreProducto: string, nuevoPrecio: number) {
    if (!nombreProducto || !nombreProducto.trim()) return { error: "Falta el nombre del producto." };
    const precio = num(nuevoPrecio);
    if (precio <= 0) return { error: "El precio debe ser mayor a 0." };
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    // Buscar el producto en el cache (con id de 365 y precio actual)
    const palabras = nombreProducto.trim().split(/\s+/).filter(Boolean);
    let cond = sql`nombre LIKE ${"%" + palabras[0] + "%"}`;
    for (let i = 1; i < palabras.length; i++) cond = sql`${cond} AND nombre LIKE ${"%" + palabras[i] + "%"}`;
    const prods = rows(await db.execute(sql`
      SELECT articuloId, nombre, precioUno FROM productos_cache WHERE ${cond} LIMIT 5
    `));
    if (prods.length === 0) return { error: `No encontré el producto "${nombreProducto}" en el catálogo.` };
    if (prods.length > 1) {
      return {
        mensaje: "Hay varios productos que coinciden. Pide al usuario precisar cuál:",
        opciones: prods.map((p: any) => ({ nombre: p.nombre, precioActual: `Bs ${p.precioUno}` })),
      };
    }
    const p = prods[0];
    const actual = num(p.precioUno);
    // Guardrail: cambio mayor a 5x o menor a 1/5 del actual es sospechoso
    let alerta = "";
    if (actual > 0 && (precio > actual * 5 || precio < actual / 5)) {
      alerta = ` ⚠ OJO: el precio actual es Bs ${actual} y el nuevo difiere mucho (${(precio / actual).toFixed(1)}x). Verificar que no sea un error.`;
    }
    return proponer("cambiarPrecio",
      { idArticulo: p.articuloId, nombreProducto: p.nombre, precioAnterior: actual, nuevoPrecio: precio },
      `Cambiar el precio de venta de "${p.nombre}" de Bs ${actual} a Bs ${precio}.${alerta}`);
  },

  // Proponer: marcar un gasto como pagado
  async marcarGastoPagado(nombreGasto: string, sucursal?: string) {
    if (!nombreGasto || !nombreGasto.trim()) return { error: "Falta indicar qué gasto." };
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const anioMes = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 7);
    const palabras = nombreGasto.trim().split(/\s+/).filter(Boolean);
    let cond = sql`nombre LIKE ${"%" + palabras[0] + "%"}`;
    for (let i = 1; i < palabras.length; i++) cond = sql`${cond} AND nombre LIKE ${"%" + palabras[i] + "%"}`;
    if (sucursal) cond = sql`${cond} AND sucursal LIKE ${"%" + sucursal + "%"}`;
    const gastos = rows(await db.execute(sql`
      SELECT id, nombre, monto, sucursal FROM gastos_registro
      WHERE anioMes = ${anioMes} AND pagado = 0 AND ${cond} LIMIT 5
    `));
    if (gastos.length === 0) return { error: `No encontré gastos PENDIENTES de este mes que coincidan con "${nombreGasto}"${sucursal ? " en " + sucursal : ""}.` };
    if (gastos.length > 1) {
      return {
        mensaje: "Hay varios gastos pendientes que coinciden. Pide al usuario precisar cuál:",
        opciones: gastos.map((g: any) => ({ gasto: g.nombre, monto: `Bs ${g.monto}`, sucursal: g.sucursal || "general" })),
      };
    }
    const g = gastos[0];
    return proponer("marcarPagado",
      { gastoId: g.id, nombreGasto: g.nombre },
      `Marcar como PAGADO el gasto "${g.nombre}" de Bs ${g.monto}${g.sucursal ? " (" + g.sucursal + ")" : ""} del mes ${anioMes}.`);
  },

  // Proponer: registrar un gasto ocasional
  async registrarGasto(nombre: string, monto: number, sucursal?: string, categoria?: string, yaPagado?: boolean) {
    if (!nombre || !nombre.trim()) return { error: "Falta el nombre del gasto." };
    const m = num(monto);
    if (m <= 0) return { error: "El monto debe ser mayor a 0." };
    if (m > 100000) return { error: "Monto demasiado alto (máx Bs 100.000 por el asistente). Regístralo desde el módulo de gastos." };
    return proponer("registrarGasto",
      { nombre: nombre.trim(), monto: m, sucursal, categoria, yaPagado: !!yaPagado },
      `Registrar gasto ocasional "${nombre.trim()}" de Bs ${m}${sucursal ? " en " + sucursal : " (general)"}${yaPagado ? ", ya pagado" : ", pendiente de pago"}.`);
  },

  // Confirmar la propuesta pendiente → EJECUTA de verdad
  async confirmarAccion() {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const pend = rows(await db.execute(sql`
      SELECT id, tipo, params, resumen, creadoEn FROM asistente_acciones_pendientes
      WHERE estado = 'pendiente' ORDER BY id DESC LIMIT 1
    `));
    if (pend.length === 0) return { error: "No hay ninguna acción pendiente de confirmar." };
    const a = pend[0];
    const antiguedadMin = (Date.now() - new Date(a.creadoEn).getTime()) / 60000;
    if (antiguedadMin > EXPIRA_MIN) {
      await db.execute(sql`UPDATE asistente_acciones_pendientes SET estado='expirada' WHERE id = ${a.id}`);
      return { error: `La propuesta caducó (${EXPIRA_MIN} min). Vuelve a pedir la acción.` };
    }
    const params = typeof a.params === "string" ? JSON.parse(a.params) : a.params;
    try {
      let resultado = "";
      if (a.tipo === "cambiarPrecio") {
        resultado = await ejecutarCambioPrecio(params);
        await auditar("cambiarPrecio", a.resumen, `Bs ${params.precioAnterior}`, `Bs ${params.nuevoPrecio}`, "OK");
      } else if (a.tipo === "marcarPagado") {
        resultado = await ejecutarMarcarPagado(params);
        await auditar("marcarPagado", a.resumen, "pendiente", "pagado", "OK");
      } else if (a.tipo === "registrarGasto") {
        resultado = await ejecutarRegistrarGasto(params);
        await auditar("registrarGasto", a.resumen, "-", `Bs ${params.monto}`, "OK");
      } else {
        throw new Error(`Tipo de acción desconocido: ${a.tipo}`);
      }
      await db.execute(sql`UPDATE asistente_acciones_pendientes SET estado='ejecutada' WHERE id = ${a.id}`);
      return { ejecutada: true, resultado, nota: "Acción registrada en la auditoría." };
    } catch (e: any) {
      await auditar(a.tipo, a.resumen, "-", "-", `ERROR: ${e?.message || "desconocido"}`);
      await db.execute(sql`UPDATE asistente_acciones_pendientes SET estado='error' WHERE id = ${a.id}`);
      return { error: `La acción falló: ${e?.message || "error desconocido"}. No se aplicó ningún cambio parcial.` };
    }
  },

  // Cancelar la propuesta pendiente
  async cancelarAccion() {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const r: any = await db.execute(sql`UPDATE asistente_acciones_pendientes SET estado='cancelada' WHERE estado='pendiente'`);
    return { cancelada: true, mensaje: "Propuesta cancelada. No se ejecutó nada." };
  },

  // Consultar la auditoría (últimas acciones ejecutadas)
  async verAuditoria(limite?: number) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const n = Math.min(30, Math.max(1, num(limite) || 10));
    const regs = rows(await db.execute(sql.raw(
      `SELECT accion, detalle, valorAnterior, valorNuevo, resultado, creadoEn
       FROM asistente_auditoria ORDER BY id DESC LIMIT ${n}`
    )));
    if (regs.length === 0) return { mensaje: "Aún no hay acciones registradas en la auditoría." };
    return {
      ultimasAcciones: regs.map((r: any) => ({
        accion: r.accion, detalle: r.detalle,
        cambio: `${r.valorAnterior} → ${r.valorNuevo}`,
        resultado: r.resultado, fecha: String(r.creadoEn),
      })),
      instruccionEstricta: "Muestra SOLO estos registros. NO inventes.",
    };
  },
};
