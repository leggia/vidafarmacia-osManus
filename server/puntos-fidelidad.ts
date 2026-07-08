// Sistema de PUNTOS de fidelidad estilo Chávez Plus+ (1 punto por Bs, vale al
// acumular). Vinculado a la cuenta de cliente (email de Google). Los puntos se
// otorgan cuando el staff marca una reserva como ENTREGADA (compra confirmada).
// Enfoque Company of One: reglas simples y automáticas, cero gestión manual.
import { getDb } from "./db";
import { sql } from "drizzle-orm";

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
      email VARCHAR(320) PRIMARY KEY,
      nombre VARCHAR(150),
      puntos INT NOT NULL DEFAULT 0,
      puntosHistoricos INT NOT NULL DEFAULT 0,
      valesGenerados INT NOT NULL DEFAULT 0,
      actualizadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  tablasListas = true;
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
  const email = String(r.emailCliente).toLowerCase();
  const puntos = Math.floor(num(r.precio) * PUNTOS_POR_BS);
  if (puntos <= 0) return;
  await db.execute(sql`
    INSERT INTO clientes_puntos (email, nombre, puntos, puntosHistoricos)
    VALUES (${email}, ${r.nombreCliente || null}, ${puntos}, ${puntos})
    ON DUPLICATE KEY UPDATE puntos = puntos + ${puntos}, puntosHistoricos = puntosHistoricos + ${puntos},
      nombre = COALESCE(nombre, ${r.nombreCliente || null}), actualizadoEn = NOW()
  `);
  await db.execute(sql`INSERT INTO puntos_movimientos (email, tipo, puntos, detalle) VALUES (${email}, 'gana', ${puntos}, ${`Compra ${r.id} (Bs ${num(r.precio)})`})`);
  await db.execute(sql`UPDATE reservas_tienda SET puntosOtorgados = 1 WHERE id = ${num(reservaId)}`);

  // ¿Alcanzó para un vale? Convertir automáticamente (como Chávez: vale al llegar a 1000)
  const saldo = rows(await db.execute(sql`SELECT puntos, valesGenerados FROM clientes_puntos WHERE email = ${email} LIMIT 1`))[0];
  if (saldo && num(saldo.puntos) >= PUNTOS_PARA_VALE) {
    const vales = Math.floor(num(saldo.puntos) / PUNTOS_PARA_VALE);
    const puntosUsados = vales * PUNTOS_PARA_VALE;
    await db.execute(sql`UPDATE clientes_puntos SET puntos = puntos - ${puntosUsados}, valesGenerados = valesGenerados + ${vales} WHERE email = ${email}`);
    await db.execute(sql`INSERT INTO puntos_movimientos (email, tipo, puntos, detalle) VALUES (${email}, 'vale', ${-puntosUsados}, ${`${vales} vale(s) de Bs ${VALOR_VALE_BS} generado(s)`})`);
  }
}

// Saldo de un cliente (para la tienda)
export async function saldoCliente(email: string) {
  await asegurarTablas();
  const db = await getDb();
  if (!db || !email) return { puntos: 0, vales: 0, valorVale: VALOR_VALE_BS, faltanParaVale: PUNTOS_PARA_VALE };
  const e = String(email).toLowerCase();
  const s = rows(await db.execute(sql`SELECT puntos, valesGenerados FROM clientes_puntos WHERE email = ${e} LIMIT 1`))[0];
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
