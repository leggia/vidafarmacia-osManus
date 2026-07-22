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
  async capturarCierres(): Promise<{ guardadas: number; revisadas: number; cerradas: number; conDiferencia: number; paginas: number }> {
    const db = await getDb();
    if (!db) return { guardadas: 0, revisadas: 0, cerradas: 0, conDiferencia: 0, paginas: 0 };
    const { inventarios365 } = await import("./inventarios365");

    let guardadas = 0, revisadas = 0, cerradas = 0, conDiferencia = 0, paginas = 0;
    try {
      for (let page = 1; page <= 20; page++) {
        const data = await inventarios365.diagRaw(`/caja?page=${page}&buscar=&criterio=`);
        const arr = data?.cajas ?? data?.data ?? (Array.isArray(data) ? data : []);
        const lista = Array.isArray(arr) ? arr : arr?.data ?? [];
        if (lista.length === 0) break;
        paginas = page;

        for (const c of lista) {
          revisadas++;
          // Solo cajas cerradas (las abiertas aún pueden cambiar)
          if (!c.fechaCierre) continue;
          cerradas++;
          const cajaId = Number(c.id);
          if (!cajaId) continue;
          const falt = num(c.saldoFaltante);
          const sobr = num(c.saldoSobrante);
          // Si no hubo diferencia, no vale la pena registrar (ahorra filas)
          if (falt === 0 && sobr === 0) continue;
          conDiferencia++;

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

        // Paginación: seguir mientras la página venga llena. Si el paginador
        // reporta última página, respetarlo; si no lo reporta bien, el corte por
        // página vacía o por lista incompleta evita quedarse en la página 1.
        const pag = data?.pagination ?? {};
        const lastPage = Number(pag.last_page ?? pag.lastPage ?? 0);
        const perPage = Number(pag.per_page ?? pag.perPage ?? lista.length);
        if (lastPage > 0 && page >= lastPage) break;
        if (lista.length < perPage) break;
      }
    } catch (e) {
      console.warn("[DiferenciasCaja] Error capturando cierres:", e);
    }
    console.log(`[DiferenciasCaja] ${guardadas} nuevas · ${cerradas} cerradas · ${conDiferencia} con diferencia · ${revisadas} revisadas en ${paginas} páginas`);
    return { guardadas, revisadas, cerradas, conDiferencia, paginas };
  }

  /**
   * Acumulado de SOBRANTES de caja de una sucursal desde una fecha (el último
   * inventario). Solo se consideran los sobrantes: si sobró dinero en el turno,
   * lo más probable es que haya salido producto sin registrarse. Los faltantes de
   * caja no entran porque los vendedores los reponen y son poco frecuentes.
   */
  async acumuladoSucursal(idSucursal: number, desdeFecha?: string): Promise<{
    faltanteTotal: number; sobranteTotal: number; cierres: number;
  }> {
    const db = await getDb();
    if (!db) return { faltanteTotal: 0, sobranteTotal: 0, cierres: 0 };
    const filtroFecha = desdeFecha ? sql` AND fechaCierre >= ${desdeFecha}` : sql``;
    const r = rows(await db.execute(sql`
      SELECT COALESCE(SUM(saldoFaltante),0) AS falt, COALESCE(SUM(saldoSobrante),0) AS sobr, COUNT(*) AS n
      FROM diferencias_caja WHERE idSucursal = ${idSucursal}${filtroFecha}
    `));
    const d = r[0] || {};
    return {
      faltanteTotal: num(d.falt),   // informativo
      sobranteTotal: num(d.sobr),   // este es el que se explica con el inventario
      cierres: num(d.n),
    };
  }

  /**
   * Valor a COSTO de los productos FALTANTES contados en una sesión de inventario
   * (físico < sistema). Ese valor explica el sobrante de caja: salió mercadería
   * que se cobró pero no se descargó del sistema.
   *
   * Los sobrantes de producto no se consideran aquí (no explican dinero de más).
   */
  async valorFaltantesInventario(sesionId: number): Promise<{ valor: number; unidades: number; productos: number; estimados: number; sinDato: number }> {
    const db = await getDb();
    if (!db) return { valor: 0, unidades: 0, productos: 0, estimados: 0, sinDato: 0 };

    const provs = rows(await db.execute(sql`
      SELECT conteos FROM inventario_proveedores WHERE sesionId = ${sesionId}
    `));

    // Juntar los faltantes de todos los proveedores contados en la sesión
    const faltantes = new Map<number, number>(); // articuloId → unidades faltantes
    for (const p of provs) {
      let conteos: any[] = [];
      try {
        conteos = typeof p.conteos === "string" ? JSON.parse(p.conteos) : (p.conteos ?? []);
      } catch { continue; }
      for (const c of conteos ?? []) {
        const dif = Number(c?.diferencia ?? 0);
        const id = Number(c?.articuloId);
        if (!id || !(dif < 0)) continue; // solo faltantes
        faltantes.set(id, (faltantes.get(id) ?? 0) + Math.abs(dif));
      }
    }
    if (faltantes.size === 0) return { valor: 0, unidades: 0, productos: 0, estimados: 0, sinDato: 0 };

    // Costos desde el caché de productos. Si el precio de costo es 0 (nunca se
    // registró una compra de ese producto), se ESTIMA como el precio de venta
    // menos 20%, para que el faltante igual descuente algo razonable.
    const ids = Array.from(faltantes.keys());
    const costos = rows(await db.execute(sql`
      SELECT articuloId, precioCostoUnid, precioUno FROM productos_cache
      WHERE articuloId IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    `));
    const costoPorId = new Map<number, { costo: number; estimado: boolean }>();
    for (const c of costos) {
      const real = num(c.precioCostoUnid);
      if (real > 0) {
        costoPorId.set(Number(c.articuloId), { costo: real, estimado: false });
      } else {
        const venta = num(c.precioUno);
        costoPorId.set(Number(c.articuloId), { costo: venta * 0.8, estimado: venta > 0 });
      }
    }

    let valor = 0, unidades = 0, estimados = 0, sinDato = 0;
    for (const [id, unids] of Array.from(faltantes.entries())) {
      unidades += unids;
      const c = costoPorId.get(id);
      if (!c || c.costo <= 0) { sinDato++; continue; }
      if (c.estimado) estimados++;
      valor += unids * c.costo;
    }
    return {
      valor: Math.round(valor * 100) / 100,
      unidades,
      productos: faltantes.size,
      estimados,   // productos cuyo costo se dedujo del precio de venta (−20%)
      sinDato,     // productos sin costo ni precio de venta: no descuentan
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

  /**
   * Valor en Bs de las correcciones de inventario de una sesión, a precio de COSTO.
   *
   * Los conteos guardan `diferencia = stockFisico − stockSistema`:
   *   - diferencia < 0 → FALTA producto. Explica dinero que faltó, así que ACERCA
   *     la deuda a cero (suma al neto negativo).
   *   - diferencia > 0 → SOBRA producto. AUMENTA la deuda (resta del neto).
   *
   * Por eso el ajuste de cada línea es (−diferencia × costoUnitario) y el total:
   *   restante = netoCaja + ajusteCorrecciones
   */
  async valorCorreccionesSesion(sesionId: number): Promise<{
    ajuste: number; valorFaltantes: number; valorSobrantes: number;
    lineas: number; sinCosto: number;
  }> {
    const db = await getDb();
    if (!db) return { ajuste: 0, valorFaltantes: 0, valorSobrantes: 0, lineas: 0, sinCosto: 0 };

    // Conteos de todos los proveedores de la sesión
    const provs = rows(await db.execute(sql`
      SELECT conteos FROM inventario_proveedores WHERE sesionId = ${sesionId}
    `));

    // Aplanar los conteos con diferencia ≠ 0
    const conDif: Array<{ articuloId: number; diferencia: number }> = [];
    for (const p of provs) {
      let arr: any = p.conteos;
      if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch { arr = null; } }
      if (!Array.isArray(arr)) continue;
      for (const c of arr) {
        const dif = Number(c?.diferencia) || 0;
        const aid = Number(c?.articuloId) || 0;
        if (dif !== 0 && aid > 0) conDif.push({ articuloId: aid, diferencia: dif });
      }
    }
    if (conDif.length === 0) return { ajuste: 0, valorFaltantes: 0, valorSobrantes: 0, lineas: 0, sinCosto: 0 };

    // Costos desde el caché de productos (precioCostoUnid)
    const ids = Array.from(new Set(conDif.map((c) => c.articuloId)));
    const costos = new Map<number, number>();
    // En bloques, para no armar un IN gigante
    for (let i = 0; i < ids.length; i += 300) {
      const bloque = ids.slice(i, i + 300);
      const lista = sql.raw(bloque.join(","));
      const r = rows(await db.execute(sql`
        SELECT articuloId, precioCostoUnid FROM productos_cache WHERE articuloId IN (${lista})
      `));
      for (const row of r) costos.set(Number(row.articuloId), num(row.precioCostoUnid));
    }

    let valorFaltantes = 0, valorSobrantes = 0, sinCosto = 0;
    for (const c of conDif) {
      const costo = costos.get(c.articuloId) ?? 0;
      if (costo <= 0) { sinCosto++; continue; }
      const valor = Math.abs(c.diferencia) * costo;
      if (c.diferencia < 0) valorFaltantes += valor;  // falta producto
      else valorSobrantes += valor;                    // sobra producto
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      ajuste: r2(valorFaltantes - valorSobrantes), // faltante acerca a cero, sobrante aleja
      valorFaltantes: r2(valorFaltantes),
      valorSobrantes: r2(valorSobrantes),
      lineas: conDif.length,
      sinCosto,
    };
  }
}

export const diferenciasCajaService = new DiferenciasCajaService();
