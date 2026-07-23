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

/**
 * Cada fuente nombra la misma sucursal de forma distinta: las ventas de 365 dicen
 * "Sucursal Lanza", los almacenes dicen "Almacen Lanza", y las compras usan el
 * nombre de la sucursal local. Si se guardaran tal cual, el kardex de un mismo
 * lugar quedaría partido en varias etiquetas y no se podría filtrar.
 *
 * Esta función lleva cualquier variante al mismo almacén (id + nombre canónico).
 * OJO con el orden: "Cobol" se evalúa ANTES que "Matriz", porque "Casa Matriz
 * Cobol" contiene ambas palabras y es la sucursal Cobol, no la Casa Matriz.
 */
/** Nombre canónico de cada almacén de 365. */
export const NOMBRE_ALMACEN: Record<number, string> = {
  1: "Casa Matriz", 2: "Petrolera", 3: "Lanza", 4: "Cobol",
};

export function resolverSucursal(nombre?: string | null): { almacenId: number | null; sucursal: string | null } {
  const n = String(nombre || "").toLowerCase();
  if (!n.trim()) return { almacenId: null, sucursal: null };
  if (n.includes("cobol")) return { almacenId: 4, sucursal: "Cobol" };
  if (n.includes("lanza")) return { almacenId: 3, sucursal: "Lanza" };
  if (n.includes("petrolera")) return { almacenId: 2, sucursal: "Petrolera" };
  if (n.includes("matriz") || n.includes("principal") || n.includes("central")) {
    return { almacenId: 1, sucursal: "Casa Matriz" };
  }
  return { almacenId: null, sucursal: String(nombre) }; // desconocida: se conserva tal cual
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
  async registrar(movs: MovimientoNuevo[], origen: "vivo" | "importado" = "vivo"): Promise<number> {
    if (!movs || movs.length === 0) return 0;
    const db = await getDb();
    if (!db) return 0;
    let guardados = 0;
    try {
      const valores = movs
        .filter((m) => m.articuloNombre && Number.isFinite(Number(m.cantidad)))
        .map((m) => {
          // Normalizar la sucursal: cada fuente la nombra distinto
          const suc = resolverSucursal(m.sucursal);
          return {
          fecha: typeof m.fecha === "string" ? new Date(m.fecha) : m.fecha,
          articuloNombre: String(m.articuloNombre).slice(0, 500),
          articuloClave: claveArticulo(m.articuloNombre),
          articuloId: m.articuloId ?? null,
          almacenId: m.almacenId ?? suc.almacenId,
          sucursal: suc.sucursal,
          tipo: m.tipo,
          cantidad: String(Number(m.cantidad)),
          costoUnitario: m.costoUnitario != null ? String(m.costoUnitario) : null,
          usuario: m.usuario ?? null,
          referenciaTipo: m.referenciaTipo ?? null,
          referenciaId: m.referenciaId != null ? String(m.referenciaId) : null,
          detalle: m.detalle ? String(m.detalle).slice(0, 300) : null,
          origen,
        };
        });
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
    if (opts?.sucursal === "Sin sucursal") {
      // Grupo de los movimientos que no se pudieron asignar a un almacén real
      filtros.push(sql`almacenId IS NULL`);
    } else if (opts?.sucursal) {
      filtros.push(sql`sucursal LIKE ${"%" + opts.sucursal + "%"}`);
    }
    let where = filtros[0];
    for (let i = 1; i < filtros.length; i++) where = sql`${where} AND ${filtros[i]}`;

    const limite = Math.min(opts?.limite ?? 300, 1000);
    const movs = rows(await db.execute(sql`
      SELECT id, fecha, articuloNombre, articuloId, sucursal, tipo, cantidad,
             costoUnitario, usuario, referenciaTipo, referenciaId, detalle, origen
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

    // DESGLOSE POR SUCURSAL: dónde está el saldo de este producto. Se calcula
    // sobre TODAS las sucursales (ignora el filtro de sucursal a propósito), para
    // poder comparar de un vistazo aunque se esté mirando una sola.
    const filtrosSuc = [sql`articuloClave = ${clave}`];
    if (opts?.desde) filtrosSuc.push(sql`DATE(fecha) >= ${opts.desde}`);
    if (opts?.hasta) filtrosSuc.push(sql`DATE(fecha) <= ${opts.hasta}`);
    let whereSuc = filtrosSuc[0];
    for (let i = 1; i < filtrosSuc.length; i++) whereSuc = sql`${whereSuc} AND ${filtrosSuc[i]}`;

    const porSucursal = rows(await db.execute(sql`
      SELECT COALESCE(sucursal, '(sin sucursal)') AS sucursal, almacenId,
             COALESCE(SUM(cantidad), 0) AS saldo,
             COALESCE(SUM(CASE WHEN cantidad > 0 THEN cantidad ELSE 0 END), 0) AS entradas,
             COALESCE(SUM(CASE WHEN cantidad < 0 THEN -cantidad ELSE 0 END), 0) AS salidas,
             COUNT(*) AS movimientos,
             MAX(fecha) AS ultimoMovimiento
      FROM movimientos_stock WHERE ${whereSuc}
      GROUP BY sucursal, almacenId
      ORDER BY saldo DESC
    `)).map((s: any) => ({
      sucursal: s.sucursal,
      almacenId: s.almacenId,
      saldo: Math.round((Number(s.saldo) || 0) * 100) / 100,
      entradas: Math.round((Number(s.entradas) || 0) * 100) / 100,
      salidas: Math.round((Number(s.salidas) || 0) * 100) / 100,
      movimientos: Number(s.movimientos) || 0,
      ultimoMovimiento: s.ultimoMovimiento,
    })) as any[];

    // STOCK ACTUAL REAL de cada sucursal (lo que dice 365 ahora mismo). El saldo
    // del libro solo cuenta desde que el kardex empezó; el stock actual es el dato
    // de control. Se muestran juntos para poder compararlos de un vistazo.
    try {
      const { obtenerStockAlmacen } = await import("./stock-cache");
      const stockPorAlmacen = new Map<number, number>();
      await Promise.all([1, 2, 3, 4].map(async (idAlm) => {
        try {
          // Caché de 5 min: al navegar el kardex esto se pide seguido
          const r = await obtenerStockAlmacen(idAlm, { ttlSeg: 300, fallbackCache: true });
          for (const p of (r.lista || []) as any[]) {
            if (claveArticulo(p.nombre) === clave) {
              stockPorAlmacen.set(idAlm, Number(p.stock) || 0);
              break;
            }
          }
        } catch { /* un almacén que falle no rompe el resto */ }
      }));
      for (const s of porSucursal) {
        if (s.almacenId != null && stockPorAlmacen.has(s.almacenId)) {
          s.stockActual = stockPorAlmacen.get(s.almacenId);
          s.diferencia = Math.round(((s.stockActual ?? 0) - s.saldo) * 100) / 100;
        }
      }
      // Sucursales con stock pero SIN movimientos en el libro: deben verse igual,
      // si no parecería que ahí no hay producto.
      for (const [idAlm, stock] of Array.from(stockPorAlmacen.entries())) {
        if (!porSucursal.some((s: any) => s.almacenId === idAlm)) {
          porSucursal.push({
            sucursal: NOMBRE_ALMACEN[idAlm] ?? `Almacén ${idAlm}`,
            almacenId: idAlm, saldo: 0, entradas: 0, salidas: 0,
            movimientos: 0, ultimoMovimiento: null,
            stockActual: stock, diferencia: stock,
          });
        }
      }
      porSucursal.sort((a: any, b: any) => (b.stockActual ?? b.saldo) - (a.stockActual ?? a.saldo));
    } catch (e: any) {
      console.warn("[Kardex] No se pudo leer el stock actual:", e?.message);
    }

    // CONSOLIDAR: la farmacia tiene exactamente 4 almacenes. Cualquier etiqueta
    // que no sea una de esas cuatro (un movimiento sin sucursal, o un nombre que
    // no se pudo identificar) se junta en un solo grupo "Sin sucursal", para que
    // nunca aparezcan sucursales de más. Las cuatro siempre se muestran, aunque
    // no tengan movimientos todavía.
    const CANONICAS = [1, 2, 3, 4];
    const consolidado: any[] = CANONICAS.map((idAlm) => {
      const existente = porSucursal.find((x: any) => x.almacenId === idAlm);
      return existente ?? {
        sucursal: NOMBRE_ALMACEN[idAlm], almacenId: idAlm,
        saldo: 0, entradas: 0, salidas: 0, movimientos: 0,
        ultimoMovimiento: null, stockActual: null, diferencia: null,
      };
    });
    const sueltos = porSucursal.filter((x: any) => !CANONICAS.includes(Number(x.almacenId)));
    if (sueltos.length > 0) {
      const sumar = (k: string) => sueltos.reduce((t: number, x: any) => t + (Number(x[k]) || 0), 0);
      consolidado.push({
        sucursal: "Sin sucursal", almacenId: null,
        saldo: Math.round(sumar("saldo") * 100) / 100,
        entradas: Math.round(sumar("entradas") * 100) / 100,
        salidas: Math.round(sumar("salidas") * 100) / 100,
        movimientos: sumar("movimientos"),
        ultimoMovimiento: null, stockActual: null, diferencia: null,
        // Qué etiquetas se juntaron aquí: útil para rastrear el origen
        etiquetas: sueltos.map((x: any) => x.sucursal).filter(Boolean),
      });
    }
    porSucursal.length = 0;
    porSucursal.push(...consolidado);

    return {
      producto: movs[0]?.articuloNombre || nombre,
      clave,
      movimientos: conSaldo.reverse(), // el más reciente primero para la pantalla
      totalMovimientos: conSaldo.length,
      entradas: Math.round(entradas * 100) / 100,
      salidas: Math.round(salidas * 100) / 100,
      saldoCalculado: Math.round(saldo * 100) / 100,
      porSucursal,
      // Suma de todas las sucursales: si se está filtrando por una, sirve para
      // saber cuánto hay en total sin quitar el filtro.
      saldoTotalTodasSucursales: Math.round(
        porSucursal.reduce((t: number, s: any) => t + s.saldo, 0) * 100,
      ) / 100,
      stockActualTotal: porSucursal.some((s: any) => s.stockActual != null)
        ? Math.round(porSucursal.reduce((t: number, s: any) => t + (s.stockActual ?? 0), 0) * 100) / 100
        : null,
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
             referenciaTipo, referenciaId, detalle, origen
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

  /**
   * IMPORTACIÓN DEL HISTÓRICO.
   *
   * Reconstruye el libro con los movimientos que ya están guardados en el sistema
   * (ventas, compras, transferencias y ajustes de inventario). Se marcan con
   * origen "importado" para distinguirlos de los registrados en vivo: en un
   * histórico reconstruido la hora puede ser aproximada y algunos no tienen
   * usuario, y eso debe verse, no disimularse.
   *
   * Trabaja por LOTES y es reanudable: cada llamada procesa un bloque y devuelve
   * si queda más. El índice único evita duplicar si se corre dos veces.
   */
  async importarHistorico(opts?: { lote?: number; desde?: string }): Promise<{
    ventas: number; compras: number; transferencias: number; ajustes: number;
    total: number; quedaMas: boolean; mensaje: string;
  }> {
    const db = await getDb();
    const vacio = { ventas: 0, compras: 0, transferencias: 0, ajustes: 0, total: 0, quedaMas: false, mensaje: "Sin base de datos" };
    if (!db) return vacio;

    const lote = Math.min(opts?.lote ?? 2000, 5000);
    const desde = opts?.desde || "2000-01-01";
    let ventas = 0, compras = 0, transferencias = 0, ajustes = 0;
    let quedaMas = false;

    // ── 1. VENTAS (salidas). Solo las válidas: las anuladas no movieron stock.
    //    Se eligen las que AÚN NO están en el libro. Antes se usaba "id mayor al
    //    último registrado", pero la sincronización en vivo ya mete las ventas
    //    NUEVAS (id alto), así que ese criterio saltaba todo el histórico viejo y
    //    no se importaba ninguna venta.
    try {
      const filas = rows(await db.execute(sql`
        SELECT d.ventaId, d.articuloNombre, d.cantidad, d.precio, d.fecha,
               v.fechaHora, v.vendedor, v.nombreSucursal, v.numComprobante
        FROM ventas_detalle d
        JOIN ventas v ON v.id = d.ventaId
        WHERE CAST(v.estado AS CHAR) = '1' AND d.fecha >= ${desde}
          AND NOT EXISTS (
            SELECT 1 FROM movimientos_stock m
            WHERE m.referenciaTipo = 'venta' AND m.referenciaId = CAST(v.id AS CHAR)
          )
        ORDER BY v.fechaHora ASC, v.id ASC LIMIT ${lote}
      `));
      if (filas.length > 0) {
        ventas = await this.registrar(filas.map((f: any) => ({
          // La HORA real de la venta: es lo que ordena el kardex frente a un
          // ajuste de inventario hecho el mismo día.
          fecha: f.fechaHora || f.fecha,
          articuloNombre: f.articuloNombre,
          sucursal: f.nombreSucursal,
          tipo: "venta" as const,
          cantidad: -(Number(f.cantidad) || 0),
          costoUnitario: Number(f.precio) || null,
          usuario: f.vendedor,
          referenciaTipo: "venta",
          referenciaId: f.ventaId,
          detalle: `Comprobante ${f.numComprobante ?? f.ventaId}`,
        })), "importado");
        if (filas.length >= lote) quedaMas = true;
      }
    } catch (e: any) { console.warn("[Kardex] histórico ventas:", e?.message); }

    // ── 2. COMPRAS (entradas)
    try {
      const filas = rows(await db.execute(sql`
        SELECT pi.purchaseId, pi.productName, pi.quantity, pi.unitCost,
               p.createdAt, p.supplier, p.receiptNumber, p.userId,
               u.name AS usuarioNombre, u.email AS usuarioEmail, b.name AS sucursal
        FROM purchase_items pi
        JOIN purchases p ON p.id = pi.purchaseId
        LEFT JOIN users u ON u.id = p.userId
        LEFT JOIN branches b ON b.id = p.branchId
        WHERE p.createdAt >= ${desde}
          AND NOT EXISTS (
            SELECT 1 FROM movimientos_stock m
            WHERE m.referenciaTipo = 'compra' AND m.referenciaId = CAST(p.id AS CHAR)
          )
        ORDER BY p.createdAt ASC, p.id ASC LIMIT ${lote}
      `));
      if (filas.length > 0) {
        compras = await this.registrar(filas.map((f: any) => ({
          fecha: f.createdAt,
          articuloNombre: f.productName,
          sucursal: f.sucursal,
          tipo: "compra" as const,
          cantidad: Number(f.quantity) || 0,
          costoUnitario: f.unitCost != null ? Number(f.unitCost) : null,
          usuario: f.usuarioNombre || f.usuarioEmail || null,
          referenciaTipo: "compra",
          referenciaId: f.purchaseId,
          detalle: `${f.supplier || "Proveedor"} · factura ${f.receiptNumber || "s/n"}`,
        })), "importado");
      }
    } catch (e: any) { console.warn("[Kardex] histórico compras:", e?.message); }

    // ── 3. TRANSFERENCIAS completadas (dos asientos: sale y entra)
    try {
      const filas = rows(await db.execute(sql`
        SELECT ti.transferId, ti.productName, ti.quantity, t.createdAt, t.userId,
               u.name AS usuarioNombre, u.email AS usuarioEmail,
               bo.name AS origen, bd.name AS destino
        FROM transfer_items ti
        JOIN transfers t ON t.id = ti.transferId
        LEFT JOIN users u ON u.id = t.userId
        LEFT JOIN branches bo ON bo.id = t.fromBranchId
        LEFT JOIN branches bd ON bd.id = t.toBranchId
        WHERE t.status = 'completed' AND t.createdAt >= ${desde}
          AND NOT EXISTS (
            SELECT 1 FROM movimientos_stock m
            WHERE m.referenciaTipo = 'transferencia' AND m.referenciaId = CAST(t.id AS CHAR)
          )
        ORDER BY t.createdAt ASC, t.id ASC LIMIT ${lote}
      `));
      const asientos: MovimientoNuevo[] = [];
      for (const f of filas as any[]) {
        const cant = Number(f.quantity) || 0;
        if (cant <= 0) continue;
        const usuario = f.usuarioNombre || f.usuarioEmail || null;
        asientos.push({
          fecha: f.createdAt, articuloNombre: f.productName, sucursal: f.origen,
          tipo: "transferencia_salida", cantidad: -cant, usuario,
          referenciaTipo: "transferencia", referenciaId: f.transferId,
          detalle: `Hacia ${f.destino ?? "?"}`,
        });
        asientos.push({
          fecha: f.createdAt, articuloNombre: f.productName, sucursal: f.destino,
          tipo: "transferencia_entrada", cantidad: cant, usuario,
          referenciaTipo: "transferencia", referenciaId: f.transferId,
          detalle: `Desde ${f.origen ?? "?"}`,
        });
      }
      transferencias = await this.registrar(asientos, "importado");
    } catch (e: any) { console.warn("[Kardex] histórico transferencias:", e?.message); }

    // ── 4. AJUSTES DE INVENTARIO (los conteos guardados en JSON)
    try {
      const filas = rows(await db.execute(sql`
        SELECT ip.id, ip.sesionId, ip.proveedorNombre, ip.conteos, ip.completadoEn,
               s.almacenId, s.almacenNombre, s.nombre AS sesionNombre
        FROM inventario_proveedores ip
        JOIN inventario_sesiones s ON s.id = ip.sesionId
        WHERE ip.estado = 'completado' AND ip.conteos IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM movimientos_stock m
            WHERE m.referenciaTipo = 'inventario'
              AND m.referenciaId = CONCAT(ip.sesionId, '-', ip.proveedorNombre)
          )
        ORDER BY ip.completadoEn ASC, ip.id ASC LIMIT 500
      `));
      const asientos: MovimientoNuevo[] = [];
      for (const f of filas as any[]) {
        let conteos: any[] = [];
        try {
          conteos = typeof f.conteos === "string" ? JSON.parse(f.conteos) : (f.conteos ?? []);
        } catch { continue; }
        for (const c of conteos) {
          const dif = Number(c?.diferencia ?? 0);
          if (!dif) continue; // sin diferencia no hubo movimiento de stock
          asientos.push({
            fecha: f.completadoEn || new Date(),
            articuloNombre: c.nombre,
            articuloId: c.articuloId ?? null,
            almacenId: f.almacenId,
            sucursal: f.almacenNombre,
            tipo: "ajuste_inventario",
            cantidad: dif,
            usuario: null, // el histórico no guardó quién completó el conteo
            referenciaTipo: "inventario",
            referenciaId: `${f.sesionId}-${f.proveedorNombre}`,
            detalle: `${f.sesionNombre ?? "Inventario"} · ${f.proveedorNombre} · sistema ${c.stockSistema} → físico ${c.stockFisico}`,
          });
        }
      }
      ajustes = await this.registrar(asientos, "importado");
    } catch (e: any) { console.warn("[Kardex] histórico ajustes:", e?.message); }

    const total = ventas + compras + transferencias + ajustes;
    return {
      ventas, compras, transferencias, ajustes, total, quedaMas,
      mensaje: total === 0
        ? "No había movimientos nuevos que importar (o ya estaban todos)."
        : `Importados ${total} movimientos: ${ventas} de ventas, ${compras} de compras, ${transferencias} de transferencias y ${ajustes} de ajustes.${quedaMas ? " Quedan más: vuelve a ejecutar para continuar." : ""}`,
    };
  }

  /**
   * RECONCILIACIÓN: compara el saldo que dice el libro con el stock real de 365.
   * Es el control de calidad del kardex — si se separan, hubo un movimiento que
   * no quedó registrado (o uno registrado de más).
   *
   * Solo tiene sentido para productos cuyo historial esté completo desde el
   * inicio; por eso se informa también desde cuándo hay datos.
   */
  async reconciliar(almacenId: number, opts?: { limite?: number; toleranciaCero?: boolean }) {
    const db = await getDb();
    if (!db) return null;
    const { obtenerStockAlmacen } = await import("./stock-cache");
    const fresco = await obtenerStockAlmacen(almacenId, { ttlSeg: 60, fallbackCache: true });

    // Saldo del libro por producto
    const saldos = rows(await db.execute(sql`
      SELECT articuloClave, MAX(articuloNombre) AS nombre,
             COALESCE(SUM(cantidad), 0) AS saldo, COUNT(*) AS movimientos
      FROM movimientos_stock
      GROUP BY articuloClave
    `));
    const porClave = new Map<string, any>();
    for (const s of saldos) porClave.set(String(s.articuloClave), s);

    const diferencias: any[] = [];
    let comparados = 0;
    for (const p of (fresco.lista || []) as any[]) {
      const clave = claveArticulo(p.nombre);
      const libro = porClave.get(clave);
      if (!libro) continue; // sin historial en el libro: no se puede comparar
      comparados++;
      const saldoLibro = Number(libro.saldo) || 0;
      const stock365 = Number(p.stock) || 0;
      const dif = Math.round((stock365 - saldoLibro) * 100) / 100;
      if (dif !== 0) {
        diferencias.push({
          producto: p.nombre, articuloId: p.id,
          stock365, saldoLibro, diferencia: dif,
          movimientos: Number(libro.movimientos) || 0,
        });
      }
    }
    diferencias.sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));
    const limite = opts?.limite ?? 50;
    return {
      almacenId,
      comparados,
      conDiferencia: diferencias.length,
      cuadran: comparados - diferencias.length,
      diferencias: diferencias.slice(0, limite),
      nota: "El saldo del libro solo cuadra con 365 si el historial del producto está completo desde el inicio. Un producto con movimientos anteriores al libro mostrará diferencia.",
    };
  }

  /**
   * CONTROL DE INTEGRIDAD: ¿hay ventas, compras o transferencias registradas en
   * el sistema que NO tengan su asiento en el libro? Es el chequeo que delata
   * casos como el de Refrianex (una venta que existía en los reportes pero no en
   * el kardex). Devuelve cuántas faltan de cada fuente.
   */
  async pendientes() {
    const db = await getDb();
    const cero = { ventas: 0, compras: 0, transferencias: 0, ajustes: 0, total: 0 };
    if (!db) return cero;
    const contar = async (q: any) => {
      try { return Number(rows(await db.execute(q))[0]?.n) || 0; } catch { return 0; }
    };

    // Solo cuentan las operaciones que REALMENTE producirían un asiento. Una
    // venta sin líneas útiles, una transferencia de cantidad cero o un inventario
    // donde todo cuadró no generan movimiento de stock, y contarlas como
    // pendientes dejaba un aviso que no se apagaba nunca por más que se importara.
    const ventas = await contar(sql`
      SELECT COUNT(DISTINCT v.id) AS n FROM ventas v
      WHERE CAST(v.estado AS CHAR) = '1'
        AND EXISTS (SELECT 1 FROM ventas_detalle d
                    WHERE d.ventaId = v.id AND d.cantidad <> 0
                      AND d.articuloNombre IS NOT NULL AND d.articuloNombre <> '')
        AND NOT EXISTS (SELECT 1 FROM movimientos_stock m
                        WHERE m.referenciaTipo = 'venta' AND m.referenciaId = CAST(v.id AS CHAR))
    `);
    const compras = await contar(sql`
      SELECT COUNT(*) AS n FROM purchases p
      WHERE EXISTS (SELECT 1 FROM purchase_items i
                    WHERE i.purchaseId = p.id AND i.quantity > 0
                      AND i.productName IS NOT NULL AND i.productName <> '')
        AND NOT EXISTS (SELECT 1 FROM movimientos_stock m
                        WHERE m.referenciaTipo = 'compra' AND m.referenciaId = CAST(p.id AS CHAR))
    `);
    const transferencias = await contar(sql`
      SELECT COUNT(*) AS n FROM transfers t
      WHERE t.status = 'completed'
        AND EXISTS (SELECT 1 FROM transfer_items i
                    WHERE i.transferId = t.id AND i.quantity > 0
                      AND i.productName IS NOT NULL AND i.productName <> '')
        AND NOT EXISTS (SELECT 1 FROM movimientos_stock m
                        WHERE m.referenciaTipo = 'transferencia' AND m.referenciaId = CAST(t.id AS CHAR))
    `);

    // Ajustes: hay que mirar DENTRO del JSON de conteos. Un inventario donde todo
    // cuadró (todas las diferencias en cero) no mueve stock y por lo tanto no
    // está pendiente de nada.
    let ajustes = 0;
    try {
      const candidatos = rows(await db.execute(sql`
        SELECT ip.conteos FROM inventario_proveedores ip
        WHERE ip.estado = 'completado' AND ip.conteos IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM movimientos_stock m
                          WHERE m.referenciaTipo = 'inventario'
                            AND m.referenciaId = CONCAT(ip.sesionId, '-', ip.proveedorNombre))
        LIMIT 1000
      `));
      for (const c of candidatos) {
        let lista: any[] = [];
        try {
          lista = typeof c.conteos === "string" ? JSON.parse(c.conteos) : (c.conteos ?? []);
        } catch { continue; }
        if (lista.some((x: any) => Number(x?.diferencia ?? 0) !== 0)) ajustes++;
      }
    } catch { /* tabla ausente */ }

    return { ventas, compras, transferencias, ajustes, total: ventas + compras + transferencias + ajustes };
  }

  /** Cuántos movimientos hay registrados (para saber si el libro ya tiene datos). */
  async estado() {
    const db = await getDb();
    if (!db) return { total: 0, desde: null, hasta: null, productos: 0 };
    const r = rows(await db.execute(sql`
      SELECT COUNT(*) AS total, MIN(fecha) AS desde, MAX(fecha) AS hasta,
             COUNT(DISTINCT articuloClave) AS productos,
             SUM(CASE WHEN origen = 'importado' THEN 1 ELSE 0 END) AS importados
      FROM movimientos_stock
    `));
    const d = r[0] || {};
    return {
      total: Number(d.total) || 0,
      desde: d.desde || null,
      hasta: d.hasta || null,
      productos: Number(d.productos) || 0,
      importados: Number(d.importados) || 0,
      envivo: (Number(d.total) || 0) - (Number(d.importados) || 0),
    };
  }
}

export const kardex = new KardexService();
