/**
 * PEDIDOS SUGERIDOS — por sucursal y consolidado.
 *
 * Cálculo: rotación diaria real (ventas locales de los últimos 3 meses CONCLUIDOS,
 * por sucursal) contra el stock actual del almacén en 365. Un producto entra al
 * pedido si su stock no cubre los días de cobertura pedidos (default 10).
 *
 * Este módulo alimenta la página /pedidos. El asistente tiene su propia versión
 * resumida (asistenteTools.pedidoSucursal) — misma lógica, salida acotada.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";

const num = (v: any) => (typeof v === "number" ? v : parseFloat(String(v ?? 0)) || 0);
const rows = (r: any): any[] => (Array.isArray(r) ? r[0] ?? [] : r?.rows ?? []);
const norm = (s: string) => String(s || "").trim().toLowerCase();

// Mapeo almacén (365) ↔ nombre de sucursal en ventas_detalle.
export const ALMACENES_PEDIDO = [
  { id: 1, nombre: "Casa Matriz", sucursalVentas: "Casa Matriz" },
  { id: 2, nombre: "Petrolera", sucursalVentas: "Petrolera" },
  { id: 3, nombre: "Lanza", sucursalVentas: "Lanza" },
  { id: 4, nombre: "Cobol", sucursalVentas: "Cobol" },
] as const;

export interface ItemPedido {
  producto: string;
  proveedor?: string;
  ventaDiaria: number;      // unidades/día (promedio 3 meses concluidos)
  stockActual: number;      // puede ser negativo (descuadre en 365)
  coberturaDias: number;    // stock ÷ venta diaria
  cantidadSugerida: number; // lo que falta para cubrir los días objetivo
  descuadre?: boolean;      // stock negativo en 365
}

/** Rotación mensual promedio por producto en una sucursal (3 meses concluidos). */
async function rotacionMensual(sucursalVentas: string): Promise<Record<string, number>> {
  const db = await getDb();
  if (!db) return {};
  const hoy = new Date();
  const finMesAnterior = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 0));
  const ini3Meses = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 3, 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const ventas = rows(await db.execute(sql`
    SELECT articuloNombre, SUM(cantidad) as total3m,
           COUNT(DISTINCT DATE_FORMAT(fecha, '%Y-%m')) as mesesConVenta
      FROM ventas_detalle
     WHERE fecha >= ${iso(ini3Meses)} AND fecha <= ${iso(finMesAnterior)}
       AND nombreSucursal = ${sucursalVentas}
       AND articuloNombre NOT LIKE '%venta menor%' AND articuloNombre NOT LIKE '%ventas menores%'
     GROUP BY articuloNombre HAVING total3m > 0
  `));
  const rot: Record<string, number> = {};
  for (const v of ventas) {
    // Producto nuevo con 1 mes de historia: dividir entre sus meses reales (mín 1).
    const meses = Math.min(3, Math.max(1, num(v.mesesConVenta)));
    rot[norm(v.articuloNombre)] = num(v.total3m) / meses;
  }
  return rot;
}

/** Resolver id de proveedor a partir de un nombre parcial: primero el caché local
 *  (rápido), y si no está, búsqueda EN VIVO en 365 (el caché suele venir sin
 *  proveedor, así que este fallback es el camino habitual). */
export async function resolverIdProveedor(proveedor?: string): Promise<string> {
  if (!proveedor || !proveedor.trim()) return "";
  const db = await getDb();
  if (db) {
    const pr = rows(await db.execute(sql`
      SELECT DISTINCT idProveedor FROM productos_cache
       WHERE nombreProveedor LIKE ${"%" + proveedor.trim() + "%"} AND idProveedor IS NOT NULL LIMIT 1
    `));
    if (pr[0]?.idProveedor) return String(pr[0].idProveedor);
  }
  try {
    const { inventarios365 } = await import("./inventarios365");
    const p = await inventarios365.buscarProveedor(proveedor.trim());
    if (p?.id) return String(p.id);
  } catch { /* sin conexión a 365: devolver vacío */ }
  return "";
}

/** Pedido de UN almacén: productos que no cubren `dias` días de venta. */
export async function calcularPedidoAlmacen(params: {
  almacenId: number; idProveedor?: string; dias: number;
}): Promise<ItemPedido[]> {
  const alm = ALMACENES_PEDIDO.find((a) => a.id === params.almacenId);
  if (!alm) return [];
  const rot = await rotacionMensual(alm.sucursalVentas);
  const { inventarios365 } = await import("./inventarios365");
  const inv = await inventarios365.listarParaInventario(alm.id, params.idProveedor || "");
  const items: ItemPedido[] = [];
  for (const a of inv) {
    const rotMes = rot[norm(a.nombre)];
    if (!rotMes || rotMes <= 0) continue; // solo productos que rotan en esa sucursal
    const ventaDiaria = rotMes / 30;
    const stockReal = num(a.stock);
    const stock = Math.max(0, stockReal); // negativo = descuadre: no inflar el pedido
    const objetivo = ventaDiaria * params.dias;
    if (stock < objetivo) {
      items.push({
        producto: a.nombre,
        proveedor: a.proveedor || undefined,
        ventaDiaria: Math.round(ventaDiaria * 100) / 100,
        stockActual: stockReal,
        coberturaDias: Math.round((stock / ventaDiaria) * 10) / 10,
        cantidadSugerida: Math.ceil(objetivo - stock),
        descuadre: stockReal < 0 || undefined,
      });
    }
  }
  items.sort((a, b) => a.coberturaDias - b.coberturaDias);
  return items;
}

export interface ItemConsolidado {
  producto: string;
  proveedor?: string;
  totalSugerido: number;
  porSucursal: Record<string, { stock: number; ventaDiaria: number; sugerido: number }>;
  descuadre?: boolean;
}

/** Pedido CONSOLIDADO: suma de lo que necesita cada sucursal, con el detalle por sucursal. */
export async function calcularPedidoConsolidado(params: {
  idProveedor?: string; dias: number;
}): Promise<ItemConsolidado[]> {
  // Secuencial a propósito: 365 es lento y no conviene dispararle 4 listados en paralelo.
  const porProducto = new Map<string, ItemConsolidado>();
  for (const alm of ALMACENES_PEDIDO) {
    const items = await calcularPedidoAlmacen({ almacenId: alm.id, idProveedor: params.idProveedor, dias: params.dias });
    for (const it of items) {
      const k = norm(it.producto);
      const acc = porProducto.get(k) ?? {
        producto: it.producto, proveedor: it.proveedor, totalSugerido: 0, porSucursal: {},
      };
      acc.porSucursal[alm.nombre] = { stock: it.stockActual, ventaDiaria: it.ventaDiaria, sugerido: it.cantidadSugerida };
      acc.totalSugerido += it.cantidadSugerida;
      if (it.descuadre) acc.descuadre = true;
      porProducto.set(k, acc);
    }
  }
  const lista = Array.from(porProducto.values());
  lista.sort((a, b) => b.totalSugerido - a.totalSugerido);
  return lista;
}
