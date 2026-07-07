// Motor UNIFICADO de promociones (enfoque Company of One: un sistema, no cuatro).
// Cubre: cupones (código que aplica % o monto fijo) y promos automáticas por monto.
// Las ofertas por producto viven en ofertas_tienda (ya existente). Todo se calcula
// en el servidor al reservar (nunca confiar en precios que manda el cliente).
import { getDb } from "./db";
import { sql } from "drizzle-orm";

const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };

let tablasListas = false;
async function asegurarTablas() {
  if (tablasListas) return;
  const db = await getDb();
  if (!db) return;
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS cupones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      codigo VARCHAR(30) NOT NULL UNIQUE,
      tipo VARCHAR(10) NOT NULL DEFAULT 'pct',   -- 'pct' (%) o 'monto' (Bs)
      valor DECIMAL(12,2) NOT NULL,
      minimo DECIMAL(12,2) NOT NULL DEFAULT 0,   -- compra mínima para aplicar
      usosMax INT NOT NULL DEFAULT 0,            -- 0 = ilimitado
      usados INT NOT NULL DEFAULT 0,
      hastaFecha DATE,
      activo INT NOT NULL DEFAULT 1,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`));
  } catch { /* ya existe */ }
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS promos_monto (
      id INT AUTO_INCREMENT PRIMARY KEY,
      descripcion VARCHAR(200) NOT NULL,
      minimo DECIMAL(12,2) NOT NULL,
      pctDescuento DECIMAL(5,2) NOT NULL,
      hastaFecha DATE,
      activa INT NOT NULL DEFAULT 1,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`));
  } catch { /* ya existe */ }
  tablasListas = true;
}

// ─── Cálculo del total con promociones (server-side, la fuente de verdad) ───
// items ya vienen con su precio (que puede ser precio de oferta). Devuelve el
// desglose para mostrar al cliente y el total final.
export async function calcularTotal(
  items: Array<{ nombre: string; precio: number; cantidad: number }>,
  codigoCupon?: string
): Promise<{
  subtotal: number; descuentos: Array<{ concepto: string; monto: number }>;
  total: number; cuponAplicado?: string; error?: string;
}> {
  await asegurarTablas();
  const db = await getDb();
  const subtotal = items.reduce((t, i) => t + num(i.precio) * num(i.cantidad), 0);
  const descuentos: Array<{ concepto: string; monto: number }> = [];
  if (!db) return { subtotal, descuentos, total: subtotal };

  // 1. Promo automática por monto (la de mayor descuento aplicable)
  try {
    const promos = rows(await db.execute(sql`
      SELECT descripcion, minimo, pctDescuento FROM promos_monto
      WHERE activa = 1 AND minimo <= ${subtotal}
        AND (hastaFecha IS NULL OR hastaFecha >= CURDATE())
      ORDER BY pctDescuento DESC LIMIT 1
    `));
    if (promos.length > 0) {
      const p = promos[0];
      const monto = Math.round(subtotal * (num(p.pctDescuento) / 100) * 100) / 100;
      if (monto > 0) descuentos.push({ concepto: p.descripcion, monto });
    }
  } catch { /* sin promos */ }

  // 2. Cupón (si el cliente ingresó uno válido)
  let cuponAplicado: string | undefined;
  let errorCupon: string | undefined;
  if (codigoCupon && codigoCupon.trim()) {
    const cod = codigoCupon.trim().toUpperCase().slice(0, 30);
    const cs = rows(await db.execute(sql`
      SELECT codigo, tipo, valor, minimo, usosMax, usados, hastaFecha FROM cupones
      WHERE codigo = ${cod} AND activo = 1 LIMIT 1
    `));
    if (cs.length === 0) errorCupon = "Cupón no válido.";
    else {
      const c = cs[0];
      if (c.hastaFecha && String(c.hastaFecha).slice(0, 10) < new Date().toISOString().slice(0, 10)) errorCupon = "El cupón venció.";
      else if (num(c.usosMax) > 0 && num(c.usados) >= num(c.usosMax)) errorCupon = "El cupón ya alcanzó su límite de usos.";
      else if (subtotal < num(c.minimo)) errorCupon = `El cupón requiere una compra mínima de Bs ${num(c.minimo)}.`;
      else {
        const base = subtotal - descuentos.reduce((t, d) => t + d.monto, 0);
        const monto = c.tipo === "monto"
          ? Math.min(num(c.valor), base)
          : Math.round(base * (num(c.valor) / 100) * 100) / 100;
        if (monto > 0) { descuentos.push({ concepto: `Cupón ${cod}`, monto }); cuponAplicado = cod; }
      }
    }
  }

  const totalDesc = descuentos.reduce((t, d) => t + d.monto, 0);
  const total = Math.max(0, Math.round((subtotal - totalDesc) * 100) / 100);
  return { subtotal, descuentos, total, cuponAplicado, error: errorCupon };
}

// Marcar un cupón como usado (al confirmar la reserva)
export async function consumirCupon(codigo?: string) {
  if (!codigo) return;
  const db = await getDb();
  if (!db) return;
  try { await db.execute(sql`UPDATE cupones SET usados = usados + 1 WHERE codigo = ${codigo.toUpperCase()}`); } catch { /* ignore */ }
}

// ─── Gestión (para las acciones del asistente) ───
export const promociones = {
  async crearCupon(codigo: string, tipo: string, valor: number, minimo?: number, usosMax?: number, hastaFecha?: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    const cod = String(codigo || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 30);
    if (cod.length < 3) throw new Error("El código debe tener al menos 3 caracteres (letras/números).");
    const t = tipo === "monto" ? "monto" : "pct";
    const v = num(valor);
    if (v <= 0) throw new Error("El valor del descuento debe ser mayor a 0.");
    if (t === "pct" && v > 90) throw new Error("Un cupón de porcentaje no puede superar 90%.");
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(hastaFecha || "") ? hastaFecha : null;
    await db.execute(sql`
      INSERT INTO cupones (codigo, tipo, valor, minimo, usosMax, hastaFecha)
      VALUES (${cod}, ${t}, ${v}, ${num(minimo)}, ${num(usosMax)}, ${hasta})
      ON DUPLICATE KEY UPDATE tipo=${t}, valor=${v}, minimo=${num(minimo)}, usosMax=${num(usosMax)}, hastaFecha=${hasta}, activo=1
    `);
    return `Cupón ${cod} creado: ${t === "pct" ? v + "% de descuento" : "Bs " + v + " de descuento"}${num(minimo) > 0 ? `, compra mínima Bs ${num(minimo)}` : ""}${num(usosMax) > 0 ? `, máximo ${num(usosMax)} usos` : ""}${hasta ? `, hasta ${hasta}` : ""}.`;
  },
  async desactivarCupon(codigo: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    await db.execute(sql`UPDATE cupones SET activo = 0 WHERE codigo = ${String(codigo).trim().toUpperCase()}`);
    return `Cupón ${codigo.toUpperCase()} desactivado.`;
  },
  async crearPromoMonto(descripcion: string, minimo: number, pctDescuento: number, hastaFecha?: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    const desc = String(descripcion || "").trim().slice(0, 200) || `${pctDescuento}% en compras desde Bs ${minimo}`;
    const pct = num(pctDescuento);
    if (pct <= 0 || pct > 50) throw new Error("El % debe estar entre 1 y 50.");
    if (num(minimo) <= 0) throw new Error("El monto mínimo debe ser mayor a 0.");
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(hastaFecha || "") ? hastaFecha : null;
    await db.execute(sql`
      INSERT INTO promos_monto (descripcion, minimo, pctDescuento, hastaFecha)
      VALUES (${desc}, ${num(minimo)}, ${pct}, ${hasta})
    `);
    return `Promoción creada: ${desc} (${pct}% desde Bs ${minimo}${hasta ? ", hasta " + hasta : ""}).`;
  },
  async listar() {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return { cupones: [], promos: [] };
    const cupones = rows(await db.execute(sql.raw(
      `SELECT codigo, tipo, valor, minimo, usosMax, usados, hastaFecha FROM cupones WHERE activo = 1 ORDER BY creadoEn DESC LIMIT 30`
    )));
    const promos = rows(await db.execute(sql.raw(
      `SELECT descripcion, minimo, pctDescuento, hastaFecha FROM promos_monto WHERE activa = 1 ORDER BY creadoEn DESC LIMIT 30`
    )));
    return {
      cupones: cupones.map((c: any) => ({
        codigo: c.codigo,
        descuento: c.tipo === "pct" ? `${num(c.valor)}%` : `Bs ${num(c.valor)}`,
        minimo: num(c.minimo) > 0 ? `Bs ${num(c.minimo)}` : "sin mínimo",
        usos: num(c.usosMax) > 0 ? `${num(c.usados)}/${num(c.usosMax)}` : `${num(c.usados)} (ilimitado)`,
        hasta: c.hastaFecha ? String(c.hastaFecha).slice(0, 10) : "sin vencimiento",
      })),
      promos: promos.map((p: any) => ({
        descripcion: p.descripcion, minimo: `Bs ${num(p.minimo)}`,
        descuento: `${num(p.pctDescuento)}%`, hasta: p.hastaFecha ? String(p.hastaFecha).slice(0, 10) : "sin vencimiento",
      })),
    };
  },
};
