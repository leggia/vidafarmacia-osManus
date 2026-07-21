/**
 * DIFERENCIAS DE CAJA (faltantes / sobrantes).
 *
 * Cada cierre de caja en 365 reporta saldoFaltante y saldoSobrante: la diferencia
 * entre las ventas del sistema y el efectivo real contado. Estas diferencias son
 * pistas de ventas dadas sin registrar, errores de cambio, etc.
 *
 * Se capturan por caja (única por cajaId) y se acumulan por sucursal para
 * mostrarlas en el próximo inventario, donde se van descontando con cada
 * corrección (una diferencia de caja puede explicarse por un producto que salió
 * sin registrarse).
 *
 * Manejamos DOS números: ventas del sistema (lo registrado) vs efectivo real
 * (sistema − faltante + sobrante).
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { diferenciasCaja } from "../drizzle/schema";

const num = (v: any) => (typeof v === "number" ? v : parseFloat(String(v ?? 0)) || 0);
const rows = (r: any): any[] => (Array.isArray(r) ? r[0] ?? [] : r?.rows ?? []);

class DiferenciasCajaService {
  /**
   * Captura las cajas CERRADAS de 365 y guarda su faltante/sobrante. Idempotente
   * por cajaId (una caja cerrada no cambia). Solo procesa cajas con fechaCierre.
   */
  async capturarCierres(): Promise<{ guardadas: number; revisadas: number }> {
    const db = await getDb();
    if (!db) return { guardadas: 0, revisadas: 0 };
    const { inventarios365 } = await import("./inventarios365");

    let guardadas = 0, revisadas = 0;
    try {
      for (let page = 1; page <= 10; page++) {
        const data = await inventarios365.diagRaw(`/caja?page=${page}&buscar=&criterio=`);
        const arr = data?.cajas ?? data?.data ?? (Array.isArray(data) ? data : []);
        const lista = Array.isArray(arr) ? arr : arr?.data ?? [];
        if (lista.length === 0) break;

        for (const c of lista) {
          revisadas++;
          // Solo cajas cerradas (las abiertas aún pueden cambiar)
          if (!c.fechaCierre) continue;
          const cajaId = Number(c.id);
          if (!cajaId) continue;
          const falt = num(c.saldoFaltante);
          const sobr = num(c.saldoSobrante);
          // Si no hubo diferencia, no vale la pena registrar (ahorra filas)
          if (falt === 0 && sobr === 0) continue;

          // Idempotente: si ya existe esta caja, saltar
          const existe = rows(await db.execute(sql`SELECT id FROM diferencias_caja WHERE cajaId = ${cajaId} LIMIT 1`));
          if (existe.length > 0) continue;

          await db.insert(diferenciasCaja).values({
            cajaId,
            idSucursal: c.idsucursal ? Number(c.idsucursal) : null,
            sucursal: c.nombre_sucursal ?? null,
            usuario: c.usuario ?? null,
            fechaCierre: String(c.fechaCierre).slice(0, 19),
            ventasSistema: String(num(c.ventas)),
            saldoFaltante: String(falt),
            saldoSobrante: String(sobr),
          });
          guardadas++;
        }

        const pag = data?.pagination ?? {};
        const lastPage = pag.last_page ?? pag.lastPage ?? 1;
        if (page >= lastPage) break;
      }
    } catch (e) {
      console.warn("[DiferenciasCaja] Error capturando cierres:", e);
    }
    if (guardadas > 0) console.log(`[DiferenciasCaja] ${guardadas} cierres con diferencia guardados`);
    return { guardadas, revisadas };
  }

  /**
   * Acumulado de diferencias de una sucursal desde una fecha (el último inventario).
   * Devuelve faltante total, sobrante total y el neto en Bs.
   */
  async acumuladoSucursal(idSucursal: number, desdeFecha?: string): Promise<{
    faltanteTotal: number; sobranteTotal: number; neto: number; cierres: number;
  }> {
    const db = await getDb();
    if (!db) return { faltanteTotal: 0, sobranteTotal: 0, neto: 0, cierres: 0 };
    const filtroFecha = desdeFecha ? sql` AND fechaCierre >= ${desdeFecha}` : sql``;
    const r = rows(await db.execute(sql`
      SELECT COALESCE(SUM(saldoFaltante),0) AS falt, COALESCE(SUM(saldoSobrante),0) AS sobr, COUNT(*) AS n
      FROM diferencias_caja WHERE idSucursal = ${idSucursal}${filtroFecha}
    `));
    const d = r[0] || {};
    const faltanteTotal = num(d.falt);
    const sobranteTotal = num(d.sobr);
    return {
      faltanteTotal,
      sobranteTotal,
      neto: Math.round((sobranteTotal - faltanteTotal) * 100) / 100, // + sobró / − faltó
      cierres: num(d.n),
    };
  }

  /** Detalle de diferencias de una sucursal desde una fecha. */
  async detalleSucursal(idSucursal: number, desdeFecha?: string) {
    const db = await getDb();
    if (!db) return [];
    const filtroFecha = desdeFecha ? sql` AND fechaCierre >= ${desdeFecha}` : sql``;
    return rows(await db.execute(sql`
      SELECT fechaCierre, usuario, ventasSistema, saldoFaltante, saldoSobrante
      FROM diferencias_caja WHERE idSucursal = ${idSucursal}${filtroFecha}
      ORDER BY fechaCierre DESC
    `));
  }
}

export const diferenciasCajaService = new DiferenciasCajaService();
