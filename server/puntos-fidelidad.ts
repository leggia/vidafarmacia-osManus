// Sistema de PUNTOS de fidelidad estilo Chávez Plus+ (1 punto por Bs, vale al
// acumular). Vinculado a la cuenta de cliente (email de Google). Los puntos se
// otorgan cuando el staff marca una reserva como ENTREGADA (compra confirmada).
// Enfoque Company of One: reglas simples y automáticas, cero gestión manual.
import { getDb } from "./db";
import { sql } from "drizzle-orm";
import { normTel } from "./domain/telefono";

const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };


// Reglas (como Chávez Plus+): 1 punto por cada Bs gastado; 1000 puntos = vale Bs 10.
const PUNTOS_POR_BS = 1;
const PUNTOS_PARA_VALE = 1000;
const VALOR_VALE_BS = 10;

let tablasListas = false;
async function asegurarTablas() {
  if (tablasListas) return;
  const db = await getDb();
  if (!db) return;
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS clientes_puntos (
      telefono VARCHAR(30) PRIMARY KEY,
      email VARCHAR(320),
      nombre VARCHAR(150),
      puntos INT NOT NULL DEFAULT 0,
      puntosHistoricos INT NOT NULL DEFAULT 0,
      valesGenerados INT NOT NULL DEFAULT 0,
      actualizadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cp_email (email)
    )`));
  } catch { /* ya existe */ }
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS puntos_movimientos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(320) NOT NULL,
      tipo VARCHAR(20) NOT NULL,
      puntos INT NOT NULL,
      detalle VARCHAR(300),
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pm_email (email)
    )`));
  } catch { /* ya existe */ }
  // Evitar doble otorgamiento por reserva: marca en reservas_tienda
  try { await db.execute(sql.raw("ALTER TABLE reservas_tienda ADD COLUMN puntosOtorgados INT NOT NULL DEFAULT 0")); } catch { /* ya existe */ }
  // Registro de ventas de 365 ya premiadas (idempotencia por idVenta)
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS puntos_ventas_procesadas (
      idVenta BIGINT PRIMARY KEY,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`));
  } catch { /* ya existe */ }
  tablasListas = true;
}

// Otorga puntos a un teléfono. Núcleo común para reservas y ventas de 365.
async function acreditar(telefono: string, monto: number, nombre: string | null, email: string | null, detalle: string) {
  const db = await getDb();
  if (!db) return;
  const tel = normTel(telefono);
  if (!tel) return;
  const puntos = Math.floor(monto * PUNTOS_POR_BS);
  if (puntos <= 0) return;
  await db.execute(sql`
    INSERT INTO clientes_puntos (telefono, email, nombre, puntos, puntosHistoricos)
    VALUES (${tel}, ${email}, ${nombre}, ${puntos}, ${puntos})
    ON DUPLICATE KEY UPDATE puntos = puntos + ${puntos}, puntosHistoricos = puntosHistoricos + ${puntos},
      nombre = COALESCE(nombre, ${nombre}), email = COALESCE(email, ${email}), actualizadoEn = NOW()
  `);
  await db.execute(sql`INSERT INTO puntos_movimientos (email, tipo, puntos, detalle) VALUES (${tel}, 'gana', ${puntos}, ${detalle})`);
  // Vale automático al llegar a 1000
  const saldo = rows(await db.execute(sql`SELECT puntos FROM clientes_puntos WHERE telefono = ${tel} LIMIT 1`))[0];
  if (saldo && num(saldo.puntos) >= PUNTOS_PARA_VALE) {
    const vales = Math.floor(num(saldo.puntos) / PUNTOS_PARA_VALE);
    const usados = vales * PUNTOS_PARA_VALE;
    await db.execute(sql`UPDATE clientes_puntos SET puntos = puntos - ${usados}, valesGenerados = valesGenerados + ${vales} WHERE telefono = ${tel}`);
    await db.execute(sql`INSERT INTO puntos_movimientos (email, tipo, puntos, detalle) VALUES (${tel}, 'vale', ${-usados}, ${`${vales} vale(s) de Bs ${VALOR_VALE_BS}`})`);
  }
}

// Otorgar puntos por una reserva entregada (idempotente por reserva).
export async function otorgarPuntosPorReserva(reservaId: number) {
  await asegurarTablas();
  const db = await getDb();
  if (!db) return;
  const res = rows(await db.execute(sql`
    SELECT id, emailCliente, nombreCliente, precio, puntosOtorgados
    FROM reservas_tienda WHERE id = ${num(reservaId)} LIMIT 1
  `));
  const r = res[0];
  if (!r || !r.emailCliente || num(r.puntosOtorgados) === 1) return; // sin cuenta o ya otorgado
  await acreditar(String(r.telefono || ""), num(r.precio), r.nombreCliente || null, r.emailCliente ? String(r.emailCliente).toLowerCase() : null, `Reserva ${r.id} (Bs ${num(r.precio)})`);
  await db.execute(sql`UPDATE reservas_tienda SET puntosOtorgados = 1 WHERE id = ${num(reservaId)}`);
}

// Otorgar puntos por VENTAS de 365 (mostrador). Enlaza venta -> idCliente ->
// cliente.telefono. Idempotente por idVenta. Procesa las ventas recientes con
// cliente identificado que aún no fueron premiadas.
export async function otorgarPuntosVentas365(desdeDias = 30) {
  await asegurarTablas();
  const db = await getDb();
  if (!db) return { procesadas: 0 };
  const ventas = rows(await db.execute(sql`
    SELECT v.id, v.total, v.razonSocialCliente, c.telefono, c.email, c.nombre
    FROM ventas v
    JOIN clientes c ON c.id = v.idCliente
    LEFT JOIN puntos_ventas_procesadas pp ON pp.idVenta = v.id
    WHERE v.idCliente IS NOT NULL AND v.idCliente > 0
      AND c.telefono IS NOT NULL AND c.telefono != ''
      AND v.fecha >= DATE_SUB(CURDATE(), INTERVAL ${num(desdeDias)} DAY)
      AND pp.idVenta IS NULL
    LIMIT 500
  `));
  let procesadas = 0;
  for (const v of ventas) {
    try {
      await acreditar(String(v.telefono), num(v.total), v.nombre || v.razonSocialCliente || null, v.email ? String(v.email).toLowerCase() : null, `Venta mostrador ${v.id} (Bs ${num(v.total)})`);
      await db.execute(sql`INSERT INTO puntos_ventas_procesadas (idVenta) VALUES (${v.id})`);
      procesadas++;
    } catch (e: any) {
      // Si ya estaba (carrera), marcar igual para no reintentar en loop
      try { await db.execute(sql`INSERT IGNORE INTO puntos_ventas_procesadas (idVenta) VALUES (${v.id})`); } catch { /* ignore */ }
    }
  }
  return { procesadas };
}

// Saldo de un cliente (para la tienda)
export async function saldoCliente(email: string) {
  await asegurarTablas();
  const db = await getDb();
  if (!db || !email) return { puntos: 0, vales: 0, valorVale: VALOR_VALE_BS, faltanParaVale: PUNTOS_PARA_VALE };
  const e = String(email).toLowerCase();
  const s = rows(await db.execute(sql`SELECT puntos, valesGenerados FROM clientes_puntos WHERE email = ${e} ORDER BY puntos DESC LIMIT 1`))[0];
  const puntos = num(s?.puntos);
  return {
    puntos,
    vales: num(s?.valesGenerados),
    valorVale: VALOR_VALE_BS,
    faltanParaVale: Math.max(0, PUNTOS_PARA_VALE - puntos),
    reglas: `Ganas ${PUNTOS_POR_BS} punto por Bs. Con ${PUNTOS_PARA_VALE} puntos recibes un vale de Bs ${VALOR_VALE_BS}.`,
  };
}

// Para el asistente: resumen del programa
export async function resumenFidelidad() {
  await asegurarTablas();
  const db = await getDb();
  if (!db) return { error: "Sin BD" };
  const tot = rows(await db.execute(sql.raw(
    `SELECT COUNT(*) as clientes, COALESCE(SUM(puntos),0) as puntosActivos, COALESCE(SUM(valesGenerados),0) as vales FROM clientes_puntos`
  )))[0] || {};
  const top = rows(await db.execute(sql.raw(
    `SELECT nombre, email, puntos, valesGenerados FROM clientes_puntos ORDER BY puntosHistoricos DESC LIMIT 10`
  )));
  return {
    clientesInscritos: num(tot.clientes),
    puntosActivos: num(tot.puntosActivos),
    valesGenerados: num(tot.vales),
    mejoresClientes: top.map((c: any) => ({
      cliente: c.nombre || c.email, puntos: num(c.puntos), vales: num(c.valesGenerados),
    })),
    instruccionEstricta: "Muestra SOLO estos datos. NO inventes.",
  };
}
