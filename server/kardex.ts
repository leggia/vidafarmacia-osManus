/**
 * KARDEX — libro de movimientos de stock.
 *
 * Diseño (el de los ERP serios): libro APPEND-ONLY. Cada movimiento se registra
 * una vez y nunca se edita ni se borra; si algo salió mal se agrega un movimiento
 * correctivo, igual que en contabilidad. Así la historia siempre es auditable:
 * se puede responder "quién movió qué y cuándo" sin que nadie pueda reescribirla.
 *
 * La llave del producto es su NOMBRE NORMALIZADO (sin tildes, sin dobles
 * espacios, en mayúsculas). Los nombres no se repiten entre productos, pero sí se
 * escriben distinto entre fuentes, y normalizar evita que la historia de un mismo
 * producto se parta en dos. Cuando se conoce el articuloId de 365 también se
 * guarda, para poder reconciliar con precisión.
 *
 * Signo de la cantidad: POSITIVO entra al almacén, NEGATIVO sale.
 */
import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { movimientosStock } from "../drizzle/schema";

export type TipoMovimiento =
  | "venta"
  | "devolucion"
  | "anulacion_venta"
  | "compra"
  | "transferencia_entrada"
  | "transferencia_salida"
  | "ajuste_inventario";

export interface MovimientoNuevo {
  fecha: Date | string;
  articuloNombre: string;
  articuloId?: number | null;
  almacenId?: number | null;
  sucursal?: string | null;
  tipo: TipoMovimiento;
  cantidad: number;            // + entra / − sale
  costoUnitario?: number | null;
  usuario?: string | null;
  referenciaTipo?: string | null;
  referenciaId?: string | number | null;
  detalle?: string | null;
}

const rows = (r: any): any[] => (Array.isArray(r) ? r[0] ?? [] : r?.rows ?? []);

/**
 * Normaliza el nombre de un producto para usarlo como llave del kardex:
 * mayúsculas, sin tildes, sin signos raros y sin espacios repetidos.
 * "Vaselina  sólida x 12 g." y "VASELINA SOLIDA X 12 G" quedan igual.
 */
export function claveArticulo(nombre: string): string {
  return String(nombre || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")  // quitar tildes
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")                        // signos → espacio
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 255);
}

/** Etiqueta legible del tipo de movimiento (para la pantalla y los reportes). */
export const ETIQUETA_TIPO: Record<string, string> = {
  venta: "Venta",
  devolucion: "Devolución",
  anulacion_venta: "Venta anulada",
  compra: "Compra",
  transferencia_entrada: "Transferencia recibida",
  transferencia_salida: "Transferencia enviada",
  ajuste_inventario: "Ajuste de inventario",
};

class KardexService {
  /**
   * Registra movimientos. Es idempotente por (referenciaTipo, referenciaId,
   * artículo, tipo): si una sincronización se repite, no duplica asientos.
   * Nunca lanza: el kardex es un registro paralelo y no debe tumbar la operación
   * principal (una venta o una compra valen más que su asiento).
   */
  async registrar(movs: MovimientoNuevo[]): Promise<number> {
    if (!movs || movs.length === 0) return 0;
    const db = await getDb();
    if (!db) return 0;
    let guardados = 0;
    try {
      const valores = movs
        .filter((m) => m.articuloNombre && Number.isFinite(Number(m.cantidad)))
        .map((m) => ({
          fecha: typeof m.fecha === "string" ? new Date(m.fecha) : m.fecha,
          articuloNombre: String(m.articuloNombre).slice(0, 500),
          articuloClave: claveArticulo(m.articuloNombre),
          articuloId: m.articuloId ?? null,
          almacenId: m.almacenId ?? null,
          sucursal: m.sucursal ?? null,
          tipo: m.tipo,
          cantidad: String(Number(m.cantidad)),
          costoUnitario: m.costoUnitario != null ? String(m.costoUnitario) : null,
          usuario: m.usuario ?? null,
          referenciaTipo: m.referenciaTipo ?? null,
          referenciaId: m.referenciaId != null ? String(m.referenciaId) : null,
          detalle: m.detalle ? String(m.detalle).slice(0, 300) : null,
        }));
      if (valores.length === 0) return 0;

      // Insertar ignorando duplicados (misma referencia + producto + tipo)
      for (const v of valores) {
        try {
          await db.insert(movimientosStock).values(v);
          guardados++;
        } catch (e: any) {
          // Duplicado por el índice único: es lo esperado al re-sincronizar
          if (!/duplicate/i.test(e?.message || "")) {
            console.warn("[Kardex] No se pudo registrar movimiento:", e?.message);
          }
        }
      }
    } catch (e: any) {
      console.warn("[Kardex] Error registrando movimientos:", e?.message);
    }
    return guardados;
  }

  /**
   * Kardex de un producto: movimientos ordenados en el tiempo con SALDO CORRIENTE
   * acumulado. El saldo es relativo a los movimientos registrados (el libro empezó
   * en una fecha), por eso también se devuelve el stock actual de 365 para poder
   * comparar.
   */
  async porProducto(nombre: string, opts?: { desde?: string; hasta?: string; sucursal?: string; limite?: number }) {
    const db = await getDb();
    if (!db) return null;
    const clave = claveArticulo(nombre);
    if (!clave) return null;

    const filtros = [sql`articuloClave = ${clave}`];
    if (opts?.desde) filtros.push(sql`DATE(fecha) >= ${opts.desde}`);
    if (opts?.hasta) filtros.push(sql`DATE(fecha) <= ${opts.hasta}`);
    if (opts?.sucursal) filtros.push(sql`sucursal LIKE ${"%" + opts.sucursal + "%"}`);
    let where = filtros[0];
    for (let i = 1; i < filtros.length; i++) where = sql`${where} AND ${filtros[i]}`;

    const limite = Math.min(opts?.limite ?? 300, 1000);
    const movs = rows(await db.execute(sql`
      SELECT id, fecha, articuloNombre, articuloId, sucursal, tipo, cantidad,
             costoUnitario, usuario, referenciaTipo, referenciaId, detalle
      FROM movimientos_stock WHERE ${where}
      ORDER BY fecha ASC, id ASC LIMIT ${limite}
    `));

    // Saldo corriente: se acumula en orden cronológico
    let saldo = 0;
    const conSaldo = movs.map((m: any) => {
      const cant = Number(m.cantidad) || 0;
      saldo += cant;
      return {
        ...m,
        cantidad: cant,
        entrada: cant > 0 ? cant : null,
        salida: cant < 0 ? Math.abs(cant) : null,
        saldo: Math.round(saldo * 100) / 100,
        tipoEtiqueta: ETIQUETA_TIPO[m.tipo] || m.tipo,
      };
    });

    // Totales del período
    const entradas = conSaldo.filter((m) => m.cantidad > 0).reduce((s, m) => s + m.cantidad, 0);
    const salidas = conSaldo.filter((m) => m.cantidad < 0).reduce((s, m) => s + Math.abs(m.cantidad), 0);

    return {
      producto: movs[0]?.articuloNombre || nombre,
      clave,
      movimientos: conSaldo.reverse(), // el más reciente primero para la pantalla
      totalMovimientos: conSaldo.length,
      entradas: Math.round(entradas * 100) / 100,
      salidas: Math.round(salidas * 100) / 100,
      saldoCalculado: Math.round(saldo * 100) / 100,
    };
  }

  /** Productos con movimientos, para el buscador del kardex. */
  async buscarProductos(texto: string, limite = 20) {
    const db = await getDb();
    if (!db || !texto || texto.trim().length < 2) return [];
    const palabras = claveArticulo(texto).split(" ").filter(Boolean);
    if (palabras.length === 0) return [];
    let cond = sql`articuloClave LIKE ${"%" + palabras[0] + "%"}`;
    for (let i = 1; i < palabras.length; i++) {
      cond = sql`${cond} AND articuloClave LIKE ${"%" + palabras[i] + "%"}`;
    }
    return rows(await db.execute(sql`
      SELECT articuloNombre, articuloClave, COUNT(*) AS movimientos,
             MAX(fecha) AS ultimoMovimiento
      FROM movimientos_stock WHERE ${cond}
      GROUP BY articuloClave, articuloNombre
      ORDER BY ultimoMovimiento DESC LIMIT ${limite}
    `));
  }

  /**
   * AUDITORÍA: quién movió qué y cuándo. Es la vista principal que pidió Luis.
   * Permite filtrar por usuario, tipo, sucursal y rango de fechas.
   */
  async auditoria(opts: {
    desde?: string; hasta?: string; usuario?: string; tipo?: string;
    sucursal?: string; producto?: string; limite?: number;
  }) {
    const db = await getDb();
    if (!db) return { movimientos: [], porUsuario: [] };

    const filtros: any[] = [sql`1 = 1`];
    if (opts.desde) filtros.push(sql`DATE(fecha) >= ${opts.desde}`);
    if (opts.hasta) filtros.push(sql`DATE(fecha) <= ${opts.hasta}`);
    if (opts.usuario) filtros.push(sql`usuario LIKE ${"%" + opts.usuario + "%"}`);
    if (opts.tipo) filtros.push(sql`tipo = ${opts.tipo}`);
    if (opts.sucursal) filtros.push(sql`sucursal LIKE ${"%" + opts.sucursal + "%"}`);
    if (opts.producto) filtros.push(sql`articuloClave LIKE ${"%" + claveArticulo(opts.producto) + "%"}`);
    let where = filtros[0];
    for (let i = 1; i < filtros.length; i++) where = sql`${where} AND ${filtros[i]}`;

    const limite = Math.min(opts.limite ?? 200, 500);
    const movimientos = rows(await db.execute(sql`
      SELECT id, fecha, articuloNombre, sucursal, tipo, cantidad, usuario,
             referenciaTipo, referenciaId, detalle
      FROM movimientos_stock WHERE ${where}
      ORDER BY fecha DESC, id DESC LIMIT ${limite}
    `)).map((m: any) => ({
      ...m,
      cantidad: Number(m.cantidad) || 0,
      tipoEtiqueta: ETIQUETA_TIPO[m.tipo] || m.tipo,
    }));

    // Resumen por usuario: cuántos movimientos hizo cada uno
    const porUsuario = rows(await db.execute(sql`
      SELECT COALESCE(usuario, '(sin usuario)') AS usuario, tipo,
             COUNT(*) AS movimientos, COALESCE(SUM(ABS(cantidad)), 0) AS unidades
      FROM movimientos_stock WHERE ${where}
      GROUP BY usuario, tipo ORDER BY movimientos DESC LIMIT 50
    `)).map((u: any) => ({
      ...u,
      movimientos: Number(u.movimientos) || 0,
      unidades: Number(u.unidades) || 0,
      tipoEtiqueta: ETIQUETA_TIPO[u.tipo] || u.tipo,
    }));

    return { movimientos, porUsuario };
  }

  /** Cuántos movimientos hay registrados (para saber si el libro ya tiene datos). */
  async estado() {
    const db = await getDb();
    if (!db) return { total: 0, desde: null, hasta: null, productos: 0 };
    const r = rows(await db.execute(sql`
      SELECT COUNT(*) AS total, MIN(fecha) AS desde, MAX(fecha) AS hasta,
             COUNT(DISTINCT articuloClave) AS productos
      FROM movimientos_stock
    `));
    const d = r[0] || {};
    return {
      total: Number(d.total) || 0,
      desde: d.desde || null,
      hasta: d.hasta || null,
      productos: Number(d.productos) || 0,
    };
  }
}

export const kardex = new KardexService();
