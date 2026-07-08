// TIENDA PÚBLICA para clientes de VidaFarma (Fase 1).
// Catálogo de venta libre con disponibilidad por sucursal + reservas sin registro.
// SEGURIDAD: solo expone nombre, precio de venta y estado de disponibilidad
// (nunca costos, cantidades exactas ni datos internos). Productos controlados
// filtrados. Rate limit por IP.
import { getDb } from "./db";
import { sql } from "drizzle-orm";

const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };
import { expandirBusqueda, principioDeMarca } from "./diccionario-principios";

// ─── Sustancias controladas (no se muestran al público). Lista inicial:
// benzodiacepinas, opioides, barbitúricos y otros de venta bajo receta retenida.
// El admin puede ocultar más productos con la marca ocultoTienda.
const CONTROLADOS = [
  // Benzodiacepinas
  "diazepam", "clonazepam", "alprazolam", "lorazepam", "midazolam", "bromazepam",
  "clobazam", "flunitrazepam", "nitrazepam", "triazolam", "cloxazolam", "ketazolam",
  "clordiazepoxido", "clordiazepóxido", "flurazepam", "tetrazepam",
  // Hipnóticos / sedantes
  "zolpidem", "zopiclona", "zaleplon", "fenobarbital", "pentobarbital", "secobarbital",
  // Opioides
  "tramadol", "codeina", "codeína", "morfina", "fentanil", "fentanilo", "oxicodona",
  "hidrocodona", "petidina", "meperidina", "metadona", "buprenorfina", "nalbufina",
  "tapentadol", "dextropropoxifeno", "tilidina",
  // Estimulantes / TDAH
  "metilfenidato", "anfetamina", "lisdexanfetamina", "modafinilo",
  // Anestésicos / otros de control
  "ketamina", "ergotamina", "flunarizina",
  // Anticonvulsivos de control
  "carbamazepina", "pregabalina", "gabapentina",
  // Precursores de uso restringido
  "pseudoefedrina", "efedrina", "misoprostol",
];
const esControlado = (nombre: string, descripcion?: string | null) => {
  const texto = `${nombre || ""} ${descripcion || ""}`.toLowerCase();
  if (CONTROLADOS.some(c => texto.includes(c))) return true;
  // Respaldo: si el nombre es una marca conocida cuyo principio es controlado
  const pa = principioDeMarca(nombre || "");
  return pa ? CONTROLADOS.some(c => pa.includes(c)) : false;
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
    await db.execute(sql.raw("ALTER TABLE productos_cache ADD COLUMN descripcion VARCHAR(600)"));
  } catch { /* ya existe */ }
  try {
    await db.execute(sql.raw("ALTER TABLE reservas_tienda ADD COLUMN items JSON"));
  } catch { /* ya existe */ }
  try {
    await db.execute(sql.raw("ALTER TABLE reservas_tienda ADD COLUMN emailCliente VARCHAR(320)"));
  } catch { /* ya existe */ }
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS ofertas_tienda (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombreProducto VARCHAR(500) NOT NULL,
      precioNormal DECIMAL(12,2) NOT NULL DEFAULT 0,
      precioOferta DECIMAL(12,2) NOT NULL,
      hastaFecha DATE,
      activa INT NOT NULL DEFAULT 1,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`));
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
let stockCargando: Promise<void> | null = null;

// Carga el stock de los 4 almacenes (lento: consulta 365 en vivo). Se ejecuta en
// segundo plano para no bloquear la búsqueda.
async function cargarStock(): Promise<void> {
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
}

// Devuelve el stock disponible AHORA (del caché) sin bloquear. Si el caché está
// vencido o vacío, dispara la carga en segundo plano y devuelve lo que haya (o
// vacío → los productos se muestran como "consultar", nunca se traba la búsqueda).
function stockPorProductoNoBloqueante(): Record<string, Record<string, number>> {
  const vigente = stockCache && stockCache.expira > Date.now();
  if (!vigente && !stockCargando) {
    stockCargando = cargarStock().finally(() => { stockCargando = null; });
  }
  return stockCache?.data || {};
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
    const enNombreODesc = (w: string) => sql`(nombre LIKE ${"%" + w + "%"} OR descripcion LIKE ${"%" + w + "%"})`;
    // Condición principal: todas las palabras en nombre o descripción.
    let cond = enNombreODesc(palabras[0]);
    for (let i = 1; i < palabras.length; i++) cond = sql`${cond} AND ${enNombreODesc(palabras[i])}`;
    // Ampliación por DICCIONARIO (respaldo para el ~20% sin principio activo en la
    // descripción): si el término es un principio activo o una marca conocida, se
    // agregan como alternativas (OR) las marcas/principios equivalentes por nombre.
    const extras = expandirBusqueda(t);
    let condFinal = cond;
    if (extras.length > 0) {
      let condExtra = sql`nombre LIKE ${"%" + extras[0] + "%"}`;
      for (let i = 1; i < extras.length; i++) condExtra = sql`${condExtra} OR nombre LIKE ${"%" + extras[i] + "%"}`;
      condFinal = sql`(${cond}) OR (${condExtra})`;
    }
    const prods = rows(await db.execute(sql`
      SELECT nombre, precioUno, imagenUrl, descripcion FROM productos_cache
      WHERE (${condFinal}) AND ocultoTienda = 0 AND precioUno > 0
      ORDER BY nombre LIMIT 15
    `));
    const visibles = prods.filter((p: any) => !esControlado(p.nombre, p.descripcion));
    if (visibles.length === 0) return { productos: [], mensaje: "No encontramos ese producto. Consúltanos por WhatsApp." };
    const stocks = stockPorProductoNoBloqueante();
    const norm = (s: string) => String(s || "").trim().toLowerCase();
    // Ofertas activas: mapa nombre → precio de oferta (para mostrar "antes/ahora").
    let ofertasMap: Record<string, number> = {};
    try {
      const ofs = rows(await db.execute(sql.raw(
        `SELECT nombreProducto, precioOferta FROM ofertas_tienda
         WHERE activa = 1 AND (hastaFecha IS NULL OR hastaFecha >= CURDATE())`
      )));
      for (const o of ofs) ofertasMap[norm(o.nombreProducto)] = num(o.precioOferta);
    } catch { /* sin ofertas */ }
    return {
      productos: visibles.map((p: any) => {
        const precioNormal = num(p.precioUno);
        const oferta = ofertasMap[norm(p.nombre)];
        const enOferta = oferta != null && oferta > 0 && oferta < precioNormal;
        return {
          nombre: p.nombre,
          precio: enOferta ? oferta : precioNormal,
          precioNormal: enOferta ? precioNormal : null,
          enOferta,
          imagen: p.imagenUrl || null,
          descripcion: p.descripcion || null,
          disponibilidad: ALMACENES.map(a => ({
            sucursal: a.sucursal,
            estado: estadoDe(stocks[norm(p.nombre)]?.[a.sucursal]),
          })),
        };
      }),
    };
  },

  // Crear una reserva (sin registro: nombre + teléfono). Acepta carrito (items[]).
  async reservar(producto: string, precio: number, sucursal: string, nombreCliente: string, telefono: string, items?: Array<{ nombre: string; precio: number; cantidad: number }>, emailCliente?: string, cupon?: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return { error: "Servicio no disponible, intenta más tarde." };
    const prod = String(producto || "").trim().slice(0, 500);
    const suc = String(sucursal || "").trim().slice(0, 150);
    const nom = String(nombreCliente || "").trim().slice(0, 150);
    const tel = String(telefono || "").replace(/[^\d+]/g, "").slice(0, 20);
    // Carrito: validar items (máx 15), filtrar controlados, resumir
    let itemsLimpios: Array<{ nombre: string; precio: number; cantidad: number }> = [];
    if (Array.isArray(items) && items.length > 0) {
      itemsLimpios = items.slice(0, 15).map(i => ({
        nombre: String(i.nombre || "").trim().slice(0, 500),
        precio: num(i.precio),
        cantidad: Math.min(20, Math.max(1, Math.round(num(i.cantidad) || 1))),
      })).filter(i => i.nombre.length > 1 && !esControlado(i.nombre));
      if (itemsLimpios.length === 0) return { error: "El carrito quedó vacío (productos inválidos o con receta)." };
    }
    const resumen = itemsLimpios.length > 0
      ? itemsLimpios.map(i => `${i.cantidad}x ${i.nombre}`).join(", ").slice(0, 500)
      : prod;
    if (!resumen || !suc || nom.length < 2) return { error: "Completa el producto, la sucursal y tu nombre." };
    if (tel.length < 7) return { error: "Escribe un número de teléfono válido." };
    if (itemsLimpios.length === 0 && esControlado(prod)) return { error: "Ese producto requiere receta y atención en mostrador." };
    if (!ALMACENES.some(a => a.sucursal === suc)) return { error: "Sucursal inválida." };
    // Código corto único VF-XXXX
    let codigo = "";
    for (let i = 0; i < 5; i++) {
      codigo = `VF-${Math.floor(1000 + Math.random() * 9000)}`;
      const dup = rows(await db.execute(sql`SELECT id FROM reservas_tienda WHERE codigo = ${codigo} AND estado = 'pendiente' LIMIT 1`));
      if (dup.length === 0) break;
    }
    // Total con promociones (server-side). Si es carrito, aplica motor; si es 1 item, subtotal simple.
    let total = itemsLimpios.length > 0
      ? itemsLimpios.reduce((t, i) => t + i.precio * i.cantidad, 0)
      : num(precio);
    let cuponUsado: string | undefined;
    if (itemsLimpios.length > 0) {
      const { calcularTotal, consumirCupon } = await import("./promociones");
      const calc = await calcularTotal(itemsLimpios, cupon);
      total = calc.total;
      cuponUsado = calc.cuponAplicado;
      if (cuponUsado) await consumirCupon(cuponUsado);
    }
    const em = emailCliente ? String(emailCliente).trim().toLowerCase().slice(0, 320) : null;
    await db.execute(sql`
      INSERT INTO reservas_tienda (codigo, producto, precio, sucursal, nombreCliente, telefono, items, emailCliente)
      VALUES (${codigo}, ${resumen}, ${total}, ${suc}, ${nom}, ${tel}, ${itemsLimpios.length > 0 ? JSON.stringify(itemsLimpios) : null}, ${em})
    `);
    return {
      ok: true, codigo,
      mensaje: `Reserva creada. Preséntate en ${suc} con el código ${codigo}. Te la guardamos por 48 horas.`,
    };
  },

  // Previsualizar total con promociones y cupón (sin crear reserva)
  async previewTotal(items: Array<{ nombre: string; precio: number; cantidad: number }>, cupon?: string) {
    const { calcularTotal } = await import("./promociones");
    const limpios = (items || []).slice(0, 15).map(i => ({
      nombre: String(i.nombre || "").slice(0, 500), precio: num(i.precio),
      cantidad: Math.min(20, Math.max(1, Math.round(num(i.cantidad) || 1))),
    }));
    return calcularTotal(limpios, cupon);
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

  // Ofertas activas (público): para la zona de ofertas del home
  async ofertas() {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return { ofertas: [] };
    try { await db.execute(sql.raw(`UPDATE ofertas_tienda SET activa=0 WHERE activa=1 AND hastaFecha IS NOT NULL AND hastaFecha < CURDATE()`)); } catch { /* ignore */ }
    const lista = rows(await db.execute(sql`
      SELECT o.nombreProducto, o.precioNormal, o.precioOferta, o.hastaFecha, c.imagenUrl
      FROM ofertas_tienda o LEFT JOIN productos_cache c ON c.nombre = o.nombreProducto
      WHERE o.activa = 1 ORDER BY o.creadoEn DESC LIMIT 10
    `));
    return {
      ofertas: lista.filter((o: any) => !esControlado(o.nombreProducto)).map((o: any) => ({
        nombre: o.nombreProducto,
        precioNormal: num(o.precioNormal),
        precio: num(o.precioOferta),
        imagen: o.imagenUrl || null,
        hasta: o.hastaFecha ? String(o.hastaFecha).slice(0, 10) : null,
      })),
    };
  },
  async ponerOferta(nombreProducto: string, precioOferta: number, hastaFecha?: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    const prods = rows(await db.execute(sql`
      SELECT nombre, precioUno FROM productos_cache WHERE nombre = ${nombreProducto} LIMIT 1
    `));
    const precioNormal = prods.length ? num(prods[0].precioUno) : 0;
    const hasta = /^\d{4}-\d{2}-\d{2}$/.test(hastaFecha || "") ? hastaFecha : null;
    await db.execute(sql`UPDATE ofertas_tienda SET activa=0 WHERE nombreProducto = ${nombreProducto}`);
    await db.execute(sql`
      INSERT INTO ofertas_tienda (nombreProducto, precioNormal, precioOferta, hastaFecha)
      VALUES (${nombreProducto}, ${precioNormal}, ${num(precioOferta)}, ${hasta})
    `);
    return `Oferta activa: ${nombreProducto} a Bs ${precioOferta}${hasta ? " hasta " + hasta : ""} (normal Bs ${precioNormal}).`;
  },
  async quitarOferta(nombreProducto: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    await db.execute(sql`UPDATE ofertas_tienda SET activa=0 WHERE nombreProducto LIKE ${"%" + nombreProducto + "%"}`);
    return `Oferta de "${nombreProducto}" desactivada.`;
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
      SELECT id, codigo, producto, precio, sucursal, nombreCliente, telefono, estado, estadoPago, items, creadoEn
      FROM reservas_tienda WHERE estado = ${est} ORDER BY creadoEn DESC LIMIT 50
    `));
  },
  async cambiarEstadoReserva(id: number, estado: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    if (!["pendiente", "lista", "entregada", "cancelada"].includes(estado)) throw new Error("Estado inválido");
    await db.execute(sql`UPDATE reservas_tienda SET estado = ${estado} WHERE id = ${num(id)}`);
    // Al ENTREGAR: otorgar puntos de fidelidad (si el cliente tiene cuenta). Idempotente.
    if (estado === "entregada") {
      try { const { otorgarPuntosPorReserva } = await import("./puntos-fidelidad"); await otorgarPuntosPorReserva(num(id)); }
      catch (e: any) { console.warn("[Tienda] puntos no otorgados:", e?.message); }
    }
    return { ok: true };
  },

  // Saldo de puntos del cliente (para la tienda)
  async misPuntos(email: string) {
    const { saldoCliente } = await import("./puntos-fidelidad");
    return saldoCliente(email);
  },

  // Historial de reservas de un cliente (por su email de sesión)
  async misReservas(email: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db || !email) return { reservas: [] };
    const e = String(email).trim().toLowerCase();
    const lista = rows(await db.execute(sql`
      SELECT id, codigo, producto, precio, sucursal, estado, estadoPago, items, creadoEn
      FROM reservas_tienda WHERE emailCliente = ${e} ORDER BY creadoEn DESC LIMIT 30
    `));
    return {
      reservas: lista.map((r: any) => {
        let items: any[] = [];
        try { items = typeof r.items === "string" ? JSON.parse(r.items) : (r.items || []); } catch { items = []; }
        return {
          id: num(r.id), codigo: r.codigo, resumen: r.producto, total: num(r.precio),
          sucursal: r.sucursal, estado: r.estado, estadoPago: r.estadoPago || "no_pagado", items,
          fecha: String(r.creadoEn).slice(0, 10),
        };
      }),
    };
  },

  // Recompra rápida: productos que el cliente ya reservó antes (para "pedir de nuevo")
  async recompra(email: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db || !email) return { productos: [] };
    const e = String(email).trim().toLowerCase();
    const lista = rows(await db.execute(sql`
      SELECT items, producto FROM reservas_tienda
      WHERE emailCliente = ${e} AND estado IN ('entregada','lista','pendiente')
      ORDER BY creadoEn DESC LIMIT 20
    `));
    const vistos = new Set<string>();
    const productos: string[] = [];
    for (const r of lista) {
      let items: any[] = [];
      try { items = typeof r.items === "string" ? JSON.parse(r.items) : (r.items || []); } catch { items = []; }
      const nombres = items.length ? items.map((i: any) => i.nombre) : [r.producto];
      for (const n of nombres) {
        const k = String(n || "").trim().toLowerCase();
        if (k && !vistos.has(k)) { vistos.add(k); productos.push(n); }
      }
    }
    return { productos: productos.slice(0, 12) };
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
