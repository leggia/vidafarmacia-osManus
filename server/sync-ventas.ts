/**
 * Servicio de sincronización de VENTAS desde inventarios365.
 *
 * Estrategia:
 *  - Captura incremental: guarda el último id de venta procesado (tabla sync_estado).
 *    Cada sync trae solo las ventas con id mayor al último (las nuevas).
 *  - Carga histórica: trae las ventas de un rango de fechas (ej. el mes anterior),
 *    por lotes controlados, una sola vez.
 *
 * Diseño defensivo: errores se registran y no tumban el proceso. La sincronización
 * nunca debe afectar el resto del sistema.
 */

const diaSemanaDe = (fecha: string): number => {
  const [a, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
};

/** Lee el último id de venta procesado. */
async function leerUltimoId(): Promise<number> {
  const { getDb } = await import("./db");
  const { syncEstado } = await import("../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db.select().from(syncEstado).where(eq(syncEstado.clave, "ventas"));
  return row?.ultimoId ?? 0;
}

/** Guarda el último id de venta procesado. */
async function guardarUltimoId(ultimoId: number, notas?: string): Promise<void> {
  const { getDb } = await import("./db");
  const { syncEstado } = await import("../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return;
  const [row] = await db.select().from(syncEstado).where(eq(syncEstado.clave, "ventas"));
  if (row) {
    await db.update(syncEstado).set({ ultimoId, notas: notas || row.notas }).where(eq(syncEstado.clave, "ventas"));
  } else {
    await db.insert(syncEstado).values({ clave: "ventas", ultimoId, notas: notas || null });
  }
}

/** Guarda una venta y su detalle en la BD (idempotente: si ya existe, la ignora). */
async function guardarVenta(db: any, venta: any): Promise<boolean> {
  const { ventas, ventasDetalle } = await import("../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const { inventarios365 } = await import("./inventarios365");

  const ventaId = Number(venta.id);
  if (!ventaId) return false;

  // ¿Ya existe? (idempotencia)
  const [existe] = await db.select().from(ventas).where(eq(ventas.id, ventaId));
  if (existe) return false;

  const fechaHora = String(venta.fecha_hora || "");
  const fecha = fechaHora.slice(0, 10); // YYYY-MM-DD
  if (!fecha) return false;

  // Cabecera
  await db.insert(ventas).values({
    id: ventaId,
    numComprobante: venta.num_comprobante || null,
    tipoComprobante: venta.tipo_comprobante || null,
    fechaHora: new Date(fechaHora.replace(" ", "T")),
    fecha,
    diaSemana: diaSemanaDe(fecha),
    total: String(venta.total ?? 0),
    descuentoTotal: String(venta.descuento_total ?? 0),
    vendedor: venta.usuario || null,
    nombreSucursal: venta.nombre_sucursal || null,
    idCliente: venta.idcliente ? Number(venta.idcliente) : null,
    razonSocialCliente: venta.razonSocial || null,
    estado: String(venta.estado ?? ""),
  });

  // Detalle (productos vendidos)
  const detalles = await inventarios365.obtenerDetallesVenta(ventaId);
  for (const d of detalles) {
    await db.insert(ventasDetalle).values({
      ventaId,
      articuloNombre: d.articulo || "—",
      cantidad: String(d.cantidad ?? 0),
      precio: String(d.precio ?? 0),
      descuento: String(d.descuento ?? 0),
      subtotal: String(d.subtotal ?? 0),
      fecha,
      nombreSucursal: venta.nombre_sucursal || null,
    });
  }
  return true;
}

/**
 * Sincronización INCREMENTAL: trae solo las ventas nuevas (id mayor al último guardado).
 * Recorre las primeras páginas (las más recientes) hasta encontrar ventas ya conocidas.
 */
export async function sincronizarVentasIncremental(maxPaginas = 30): Promise<{ nuevas: number; ultimoId: number }> {
  const { getDb } = await import("./db");
  const { inventarios365 } = await import("./inventarios365");
  const db = await getDb();
  if (!db) return { nuevas: 0, ultimoId: 0 };

  const ultimoIdPrevio = await leerUltimoId();
  let nuevas = 0;
  let maxIdVisto = ultimoIdPrevio;
  let alcanzado = false;

  try {
    for (let page = 1; page <= maxPaginas && !alcanzado; page++) {
      const { ventas: lista } = await inventarios365.listarVentasPagina(page);
      if (lista.length === 0) break;

      for (const v of lista) {
        const vid = Number(v.id);
        if (vid <= ultimoIdPrevio) { alcanzado = true; break; } // llegamos a lo ya conocido
        const guardada = await guardarVenta(db, v);
        if (guardada) nuevas++;
        if (vid > maxIdVisto) maxIdVisto = vid;
      }
    }
    if (maxIdVisto > ultimoIdPrevio) {
      await guardarUltimoId(maxIdVisto, `incremental: +${nuevas}`);
    }
  } catch (e) {
    console.warn("[SyncVentas] Error en incremental:", e);
  }
  return { nuevas, ultimoId: maxIdVisto };
}

/**
 * Carga HISTÓRICA: trae ventas de un rango de fechas (ej. mes anterior), por lotes.
 * Recorre páginas hasta pasar la fecha de inicio. Solo se usa una vez para sembrar datos.
 */
export async function cargarVentasHistorico(desde: string, hasta: string, maxPaginas = 600): Promise<{ guardadas: number }> {
  const { getDb } = await import("./db");
  const { inventarios365 } = await import("./inventarios365");
  const db = await getDb();
  if (!db) return { guardadas: 0 };

  let guardadas = 0;
  let maxId = await leerUltimoId();

  try {
    for (let page = 1; page <= maxPaginas; page++) {
      const { ventas: lista } = await inventarios365.listarVentasPagina(page);
      if (lista.length === 0) break;

      let todasMasViejas = true;
      for (const v of lista) {
        const fecha = String(v.fecha_hora || "").slice(0, 10);
        if (!fecha) continue;
        if (fecha > hasta) { todasMasViejas = false; continue; }   // aún no llegamos al rango
        if (fecha < desde) { continue; }                            // ya pasamos el rango (esta venta es más vieja)
        todasMasViejas = false;
        const guardada = await guardarVenta(db, v);
        if (guardada) guardadas++;
        const vid = Number(v.id);
        if (vid > maxId) maxId = vid;
      }
      // Si toda la página es más vieja que 'desde', ya no hay nada más reciente que capturar
      const fechasPagina = lista.map((v: any) => String(v.fecha_hora || "").slice(0, 10)).filter(Boolean);
      if (fechasPagina.length && fechasPagina.every((f: string) => f < desde)) break;

      // Pausa breve entre páginas para no saturar inventarios365
      await new Promise((r) => setTimeout(r, 150));
    }
    if (maxId > 0) await guardarUltimoId(maxId, `historico ${desde}..${hasta}: +${guardadas}`);
  } catch (e) {
    console.warn("[SyncVentas] Error en histórico:", e);
  }
  return { guardadas };
}

/**
 * Sincroniza CLIENTES desde inventarios365 (son ~500, se traen todos).
 * Idempotente: actualiza los existentes, inserta los nuevos.
 */
export async function sincronizarClientes(maxPaginas = 60): Promise<{ total: number }> {
  const { getDb } = await import("./db");
  const { clientes } = await import("../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const { inventarios365 } = await import("./inventarios365");
  const db = await getDb();
  if (!db) return { total: 0 };

  let total = 0;
  try {
    for (let page = 1; page <= maxPaginas; page++) {
      const { clientes: lista } = await inventarios365.listarClientesPagina(page);
      if (lista.length === 0) break;

      for (const c of lista) {
        const id = Number(c.id);
        if (!id) continue;
        const valores = {
          nombre: c.nombre || null,
          tipoDocumento: c.tipo_documento != null ? String(c.tipo_documento) : null,
          numDocumento: c.num_documento || null,
          complementoId: c.complemento_id || null,
          telefono: c.telefono || null,
          email: c.email || null,
          direccion: c.direccion || null,
          creadoEnSistema: c.created_at || null,
        };
        const [existe] = await db.select().from(clientes).where(eq(clientes.id, id));
        if (existe) {
          await db.update(clientes).set(valores).where(eq(clientes.id, id));
        } else {
          await db.insert(clientes).values({ id, ...valores });
        }
        total++;
      }
      // Si la página vino incompleta, es la última
      if (lista.length < 10) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (e) {
    console.warn("[SyncClientes] Error:", e);
  }
  return { total };
}
