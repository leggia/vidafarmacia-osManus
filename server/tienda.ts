// TIENDA PÚBLICA para clientes de VidaFarma (Fase 1).
// Catálogo de venta libre con disponibilidad por sucursal + reservas sin registro.
// SEGURIDAD: solo expone nombre, precio de venta y estado de disponibilidad
// (nunca costos, cantidades exactas ni datos internos). Productos controlados
// filtrados. Rate limit por IP.
import { getDb } from "./db";
import { sql } from "drizzle-orm";

const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };

// ─── Sustancias controladas (no se muestran al público). Lista inicial:
// benzodiacepinas, opioides, barbitúricos y otros de venta bajo receta retenida.
// El admin puede ocultar más productos con la marca ocultoTienda.
const CONTROLADOS = [
  "diazepam", "clonazepam", "alprazolam", "lorazepam", "midazolam", "bromazepam",
  "zolpidem", "zopiclona", "fenobarbital", "tramadol", "codeina", "codeína",
  "morfina", "fentanil", "metilfenidato", "ketamina", "oxicodona", "petidina",
  "clobazam", "carbamazepina", "metadona", "buprenorfina", "ergotamina",
];
const esControlado = (nombre: string) => {
  const n = (nombre || "").toLowerCase();
  return CONTROLADOS.some(c => n.includes(c));
};

// ─── Tablas (idempotente) ───
let tablasListas = false;
async function asegurarTablas() {
  if (tablasListas) return;
  const db = await getDb();
  if (!db) return;
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS reservas_tienda (
      id INT AUTO_INCREMENT PRIMARY KEY,
      codigo VARCHAR(12) NOT NULL UNIQUE,
      producto VARCHAR(500) NOT NULL,
      precio DECIMAL(12,2) NOT NULL DEFAULT 0,
      sucursal VARCHAR(150) NOT NULL,
      nombreCliente VARCHAR(150) NOT NULL,
      telefono VARCHAR(30) NOT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_res_estado (estado), INDEX idx_res_codigo (codigo)
    )`));
  } catch { /* ya existe */ }
  try {
    await db.execute(sql.raw("ALTER TABLE productos_cache ADD COLUMN ocultoTienda INT NOT NULL DEFAULT 0"));
  } catch { /* ya existe */ }
  try {
    await db.execute(sql.raw("ALTER TABLE productos_cache ADD COLUMN imagenUrl VARCHAR(600)"));
  } catch { /* ya existe */ }
  try {
    await db.execute(sql.raw("ALTER TABLE branches ADD COLUMN whatsapp VARCHAR(30)"));
  } catch { /* ya existe */ }
  tablasListas = true;
}

// ─── Rate limit simple por IP (en memoria) ───
const hits: Record<string, { n: number; hasta: number }> = {};
export function rateLimitOk(ip: string, tipo: "buscar" | "reservar"): boolean {
  const lim = tipo === "buscar" ? 60 : 5; // por minuto (60 para búsqueda dinámica)
  const key = `${tipo}:${ip}`;
  const ahora = Date.now();
  const h = hits[key];
  if (!h || h.hasta < ahora) { hits[key] = { n: 1, hasta: ahora + 60000 }; return true; }
  if (h.n >= lim) return false;
  h.n++;
  return true;
}

// ─── Stock por almacén con caché (10 min) para no golpear 365 en cada búsqueda ───
const ALMACENES: Array<{ id: number; sucursal: string }> = [
  { id: 1, sucursal: "Casa Matriz" },
  { id: 2, sucursal: "Sucursal Petrolera" },
  { id: 3, sucursal: "Sucursal Lanza" },
  { id: 4, sucursal: "Casa Matriz Cobol" },
];
let stockCache: { data: Record<string, Record<string, number>>; expira: number } | null = null;
async function stockPorProducto(): Promise<Record<string, Record<string, number>>> {
  if (stockCache && stockCache.expira > Date.now()) return stockCache.data;
  const { inventarios365 } = await import("./inventarios365");
  const data: Record<string, Record<string, number>> = {};
  const norm = (s: string) => String(s || "").trim().toLowerCase();
  for (const alm of ALMACENES) {
    try {
      const inv = await inventarios365.listarParaInventario(alm.id, "");
      for (const a of inv) {
        const k = norm((a as any).nombre);
        if (!data[k]) data[k] = {};
        data[k][alm.sucursal] = num((a as any).stock);
      }
    } catch (e: any) {
      console.warn(`[Tienda] stock almacén ${alm.id} falló:`, e?.message);
    }
  }
  stockCache = { data, expira: Date.now() + 10 * 60 * 1000 };
  return data;
}

const estadoDe = (stock: number | undefined) =>
  stock == null ? "consultar" : stock <= 0 ? "agotado" : stock <= 3 ? "ultimas" : "disponible";

// ─── API pública ───
export const tienda = {
  // Buscar en el catálogo (venta libre, visible)
  async buscar(termino: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return { productos: [] };
    const t = String(termino || "").trim().slice(0, 80);
    if (t.length < 3) return { productos: [], mensaje: "Escribe al menos 3 letras." };
    const palabras = t.split(/\s+/).filter(Boolean).slice(0, 5);
    let cond = sql`nombre LIKE ${"%" + palabras[0] + "%"}`;
    for (let i = 1; i < palabras.length; i++) cond = sql`${cond} AND nombre LIKE ${"%" + palabras[i] + "%"}`;
    const prods = rows(await db.execute(sql`
      SELECT nombre, precioUno, imagenUrl FROM productos_cache
      WHERE ${cond} AND ocultoTienda = 0 AND precioUno > 0
      ORDER BY nombre LIMIT 12
    `));
    const visibles = prods.filter((p: any) => !esControlado(p.nombre));
    if (visibles.length === 0) return { productos: [], mensaje: "No encontramos ese producto. Consúltanos por WhatsApp." };
    const stocks = await stockPorProducto();
    const norm = (s: string) => String(s || "").trim().toLowerCase();
    return {
      productos: visibles.map((p: any) => ({
        nombre: p.nombre,
        precio: num(p.precioUno),
        imagen: p.imagenUrl || null,
        disponibilidad: ALMACENES.map(a => ({
          sucursal: a.sucursal,
          estado: estadoDe(stocks[norm(p.nombre)]?.[a.sucursal]),
        })),
      })),
    };
  },

  // Crear una reserva (sin registro: nombre + teléfono)
  async reservar(producto: string, precio: number, sucursal: string, nombreCliente: string, telefono: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return { error: "Servicio no disponible, intenta más tarde." };
    const prod = String(producto || "").trim().slice(0, 500);
    const suc = String(sucursal || "").trim().slice(0, 150);
    const nom = String(nombreCliente || "").trim().slice(0, 150);
    const tel = String(telefono || "").replace(/[^\d+]/g, "").slice(0, 20);
    if (!prod || !suc || nom.length < 2) return { error: "Completa el producto, la sucursal y tu nombre." };
    if (tel.length < 7) return { error: "Escribe un número de teléfono válido." };
    if (esControlado(prod)) return { error: "Ese producto requiere receta y atención en mostrador." };
    if (!ALMACENES.some(a => a.sucursal === suc)) return { error: "Sucursal inválida." };
    // Código corto único VF-XXXX
    let codigo = "";
    for (let i = 0; i < 5; i++) {
      codigo = `VF-${Math.floor(1000 + Math.random() * 9000)}`;
      const dup = rows(await db.execute(sql`SELECT id FROM reservas_tienda WHERE codigo = ${codigo} AND estado = 'pendiente' LIMIT 1`));
      if (dup.length === 0) break;
    }
    await db.execute(sql`
      INSERT INTO reservas_tienda (codigo, producto, precio, sucursal, nombreCliente, telefono)
      VALUES (${codigo}, ${prod}, ${num(precio)}, ${suc}, ${nom}, ${tel})
    `);
    return {
      ok: true, codigo,
      mensaje: `Reserva creada. Preséntate en ${suc} con el código ${codigo}. Te la guardamos por 48 horas.`,
    };
  },

  // Config pública (WhatsApp por sucursal, con respaldo general)
  async config() {
    await asegurarTablas();
    const db = await getDb();
    const general = (process.env.WHATSAPP_FARMACIA || "").replace(/[^\d]/g, "");
    let porSucursal: Array<{ sucursal: string; whatsapp: string }> = [];
    if (db) {
      try {
        const b = rows(await db.execute(sql.raw(`SELECT name, whatsapp FROM branches`)));
        porSucursal = b.map((x: any) => ({
          sucursal: x.name,
          whatsapp: String(x.whatsapp || general || "").replace(/[^\d]/g, ""),
        }));
      } catch { /* sin branches */ }
    }
    return { whatsappGeneral: general, porSucursal, sucursales: ALMACENES.map(a => a.sucursal) };
  },

  // ─── Staff: gestión de reservas ───
  async listarReservas(estado?: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return [];
    // Expirar las de más de 48h
    try { await db.execute(sql.raw(`UPDATE reservas_tienda SET estado='expirada' WHERE estado='pendiente' AND creadoEn < NOW() - INTERVAL 48 HOUR`)); } catch { /* ignore */ }
    const est = ["pendiente", "lista", "entregada", "cancelada", "expirada"].includes(estado || "") ? estado : "pendiente";
    return rows(await db.execute(sql`
      SELECT id, codigo, producto, precio, sucursal, nombreCliente, telefono, estado, creadoEn
      FROM reservas_tienda WHERE estado = ${est} ORDER BY creadoEn DESC LIMIT 50
    `));
  },
  async cambiarEstadoReserva(id: number, estado: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    if (!["pendiente", "lista", "entregada", "cancelada"].includes(estado)) throw new Error("Estado inválido");
    await db.execute(sql`UPDATE reservas_tienda SET estado = ${estado} WHERE id = ${num(id)}`);
    return { ok: true };
  },

  // Herramienta del asistente
  async reservasPendientes() {
    const lista = await this.listarReservas("pendiente");
    if (lista.length === 0) return { mensaje: "No hay reservas de clientes pendientes." };
    return {
      totalPendientes: lista.length,
      reservas: lista.slice(0, 15).map((r: any) => ({
        codigo: r.codigo, producto: r.producto, precio: `Bs ${r.precio}`,
        sucursal: r.sucursal, cliente: r.nombreCliente, telefono: r.telefono,
        desde: String(r.creadoEn),
      })),
      instruccionEstricta: "Muestra SOLO estas reservas. NO inventes.",
    };
  },
};
