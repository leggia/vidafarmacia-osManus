/**
 * Sincronización de VENTAS — versión conservadora y segura.
 *
 * Lecciones aplicadas tras el incidente de arranque:
 *  - NUNCA corre automáticamente al arrancar.
 *  - Se ejecuta SOLO bajo demanda (botón) o en cron controlado (más adelante).
 *  - Lotes pequeños con límites bajos de páginas.
 *  - Idempotente: no duplica ventas ya guardadas.
 *  - SQL directo (las tablas se crean con SQL directo, no las conoce drizzle).
 */

const diaSemanaDe = (fecha: string): number => {
  const [a, m, d] = fecha.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d)).getUTCDay();
};

async function leerUltimoId(db: any, sql: any): Promise<number> {
  try {
    const r: any = await db.execute(sql`SELECT ultimoId FROM sync_estado WHERE clave='ventas' LIMIT 1`);
    const rows = Array.isArray(r) ? r[0] : r?.rows ?? r;
    const val = Array.isArray(rows) ? rows[0]?.ultimoId : rows?.ultimoId;
    return Number(val ?? 0);
  } catch { return 0; }
}

async function guardarUltimoId(db: any, sql: any, ultimoId: number, notas: string): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO sync_estado (clave, ultimoId, notas) VALUES ('ventas', ${ultimoId}, ${notas})
       ON DUPLICATE KEY UPDATE ultimoId=${ultimoId}, notas=${notas}, ultimaSync=CURRENT_TIMESTAMP
    `);
  } catch (e) { console.warn("[SyncVentas] Error guardando ultimoId:", e); }
}

async function ventaExiste(db: any, sql: any, id: number): Promise<boolean> {
  try {
    const r: any = await db.execute(sql`SELECT id FROM ventas WHERE id=${id} LIMIT 1`);
    const rows = Array.isArray(r) ? r[0] : r?.rows ?? r;
    return Array.isArray(rows) ? rows.length > 0 : !!rows?.id;
  } catch { return false; }
}

async function guardarVenta(db: any, sql: any, venta: any): Promise<boolean> {
  const { inventarios365 } = await import("./inventarios365");
  const ventaId = Number(venta.id);
  if (!ventaId) return false;
  if (await ventaExiste(db, sql, ventaId)) return false;

  const fechaHora = String(venta.fecha_hora || "");
  const fecha = fechaHora.slice(0, 10);
  if (!fecha) return false;

  try {
    await db.execute(sql`
      INSERT INTO ventas (id, numComprobante, tipoComprobante, fechaHora, fecha, diaSemana, total, descuentoTotal, vendedor, nombreSucursal, idCliente, razonSocialCliente, estado)
       VALUES (${ventaId}, ${venta.num_comprobante ?? null}, ${venta.tipo_comprobante ?? null}, ${fechaHora}, ${fecha}, ${diaSemanaDe(fecha)}, ${Number(venta.total) || 0}, ${Number(venta.descuento_total) || 0}, ${venta.usuario ?? null}, ${venta.nombre_sucursal ?? null}, ${venta.idcliente ? Number(venta.idcliente) : null}, ${venta.razonSocial ?? null}, ${String(venta.estado ?? "")})
    `);
  } catch (e) {
    console.warn(`[SyncVentas] Error insertando venta ${ventaId}:`, e);
    return false;
  }

  try {
    const detalles = await inventarios365.obtenerDetallesVenta(ventaId);
    for (const d of detalles) {
      await db.execute(sql`
        INSERT INTO ventas_detalle (ventaId, articuloNombre, cantidad, precio, descuento, subtotal, fecha, nombreSucursal)
         VALUES (${ventaId}, ${d.articulo || "—"}, ${Number(d.cantidad) || 0}, ${Number(d.precio) || 0}, ${Number(d.descuento) || 0}, ${Number(d.subtotal) || 0}, ${fecha}, ${venta.nombre_sucursal ?? null})
      `);
    }
  } catch (e) {
    console.warn(`[SyncVentas] Error en detalle de venta ${ventaId}:`, e);
  }
  return true;
}

/**
 * Incremental: trae las ventas nuevas (id > último guardado).
 * La PRIMERA vez (sin punto de partida) captura las páginas recientes y deja el
 * punto en la más antigua que trajo, para que llamadas siguientes continúen el hueco.
 */
export async function sincronizarVentasIncremental(maxPaginas = 60): Promise<{ nuevas: number; ultimoId: number; primeraVez?: boolean; huboHueco?: boolean }> {
  const { getDb } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const { inventarios365 } = await import("./inventarios365");
  const db = await getDb();
  if (!db) return { nuevas: 0, ultimoId: 0 };

  const ultimoIdPrevio = await leerUltimoId(db, sql);
  const primeraVez = ultimoIdPrevio === 0;

  let nuevas = 0;
  let maxIdVisto = ultimoIdPrevio;
  let alcanzado = false;
  let huboHueco = false;
  // En primera vez, traer solo unas pocas páginas (lo reciente); el histórico se carga aparte.
  const tope = primeraVez ? 8 : maxPaginas;
  try {
    let page = 1;
    for (; page <= tope && !alcanzado; page++) {
      const { ventas: lista } = await inventarios365.listarVentasPagina(page);
      if (lista.length === 0) { alcanzado = true; break; } // ya no hay más: sin hueco
      for (const v of lista) {
        const vid = Number(v.id);
        // Si ya teníamos punto de partida, parar al alcanzar lo conocido (sin hueco)
        if (!primeraVez && vid <= ultimoIdPrevio) { alcanzado = true; break; }
        const guardada = await guardarVenta(db, sql, v);
        if (guardada) nuevas++;
        if (vid > maxIdVisto) maxIdVisto = vid;
      }
      if (!alcanzado) await new Promise((r) => setTimeout(r, 80));
    }
    // Si recorrimos todas las páginas permitidas SIN alcanzar el último ID conocido,
    // significa que se acumularon demasiadas ventas y quedó un HUECO. No guardamos el
    // maxId (para no perder el rango intermedio); avisamos para repetir.
    if (!primeraVez && !alcanzado) {
      huboHueco = true;
      // Guardamos igual el avance para no reprocesar lo ya traído en la próxima pasada,
      // pero marcamos el hueco para que el usuario/cron vuelva a sincronizar.
    }
    if (maxIdVisto > ultimoIdPrevio) await guardarUltimoId(db, sql, maxIdVisto, primeraVez ? `inicial +${nuevas}` : `incremental +${nuevas}${huboHueco ? " (hueco, repetir)" : ""}`);
  } catch (e) {
    console.warn("[SyncVentas] Error incremental:", e);
  }
  return { nuevas, ultimoId: maxIdVisto, primeraVez, huboHueco };
}

/** Sincroniza clientes (~500, todos). Idempotente. */
export async function sincronizarClientes(maxPaginas = 60): Promise<{ total: number }> {
  const { getDb } = await import("./db");
  const { sql } = await import("drizzle-orm");
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
        await db.execute(sql`
          INSERT INTO clientes (id, nombre, tipoDocumento, numDocumento, complementoId, telefono, email, direccion, creadoEnSistema)
           VALUES (${id}, ${c.nombre ?? null}, ${c.tipo_documento != null ? String(c.tipo_documento) : null}, ${c.num_documento ?? null}, ${c.complemento_id ?? null}, ${c.telefono ?? null}, ${c.email ?? null}, ${c.direccion ?? null}, ${c.created_at ?? null})
           ON DUPLICATE KEY UPDATE nombre=${c.nombre ?? null}, numDocumento=${c.num_documento ?? null}, telefono=${c.telefono ?? null}, email=${c.email ?? null}, direccion=${c.direccion ?? null}
        `);
        total++;
      }
      if (lista.length < 10) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (e) {
    console.warn("[SyncClientes] Error:", e);
  }
  return { total };
}

/**
 * Carga histórica POR LOTES (segura). Procesa un bloque pequeño de páginas por llamada
 * y guarda el progreso en sync_estado (clave 'historico'). El usuario la dispara
 * repetidamente; cada vez avanza un poco. Nunca una operación larga que cuelgue.
 *
 * @param desde "YYYY-MM-DD" inicio del rango a capturar
 * @param hasta "YYYY-MM-DD" fin del rango
 * @param paginasPorLote cuántas páginas procesar en esta llamada (bajo)
 */
export async function cargarHistoricoLote(
  desde: string,
  hasta: string,
  paginasPorLote = 40
): Promise<{ guardadas: number; paginaActual: number; terminado: boolean; mensaje: string; enRango?: boolean }> {
  const { getDb } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const { inventarios365 } = await import("./inventarios365");
  const db = await getDb();
  if (!db) return { guardadas: 0, paginaActual: 0, terminado: true, mensaje: "Sin BD" };

  // Leer desde qué página continuar (progreso guardado)
  let paginaInicio = 1;
  try {
    const r: any = await db.execute(sql`SELECT ultimoId FROM sync_estado WHERE clave='historico' LIMIT 1`);
    const rows = Array.isArray(r) ? r[0] : r?.rows ?? r;
    const val = Array.isArray(rows) ? rows[0]?.ultimoId : rows?.ultimoId;
    paginaInicio = Number(val ?? 0) + 1;
    if (paginaInicio < 1) paginaInicio = 1;
  } catch { paginaInicio = 1; }

  let guardadas = 0;
  let pagina = paginaInicio;
  let terminado = false;
  let mensaje = "";
  let llegoAlRango = false;
  let paginasSaltadas = 0;

  try {
    // Tope por llamada: saltar páginas recientes es rápido, pero limitamos para
    // no acercarnos al timeout. El progreso se guarda y se continúa en el siguiente clic.
    const TOPE_DURO = 150;
    for (pagina = paginaInicio; pagina < paginaInicio + TOPE_DURO; pagina++) {
      const { ventas: lista } = await inventarios365.listarVentasPagina(pagina);
      if (lista.length === 0) { terminado = true; mensaje = "No hay más ventas"; break; }

      const fechas = lista.map((v: any) => String(v.fecha_hora || "").slice(0, 10)).filter(Boolean);

      // Página toda más NUEVA que el rango (junio): saltar rápido, sin pausa
      if (fechas.length > 0 && fechas.every((f: string) => f > hasta)) {
        paginasSaltadas++;
        // Mientras solo saltamos, avanzar hasta el tope duro para llegar pronto al rango
        if (!llegoAlRango && paginasSaltadas >= TOPE_DURO) break;
        continue;
      }
      // Página toda más VIEJA que el rango: ya pasamos mayo, terminado
      if (fechas.length > 0 && fechas.every((f: string) => f < desde)) {
        terminado = true; mensaje = `Histórico de ${desde} a ${hasta} completo`; break;
      }

      // Página dentro del rango: guardar las que caen en mayo
      llegoAlRango = true;
      for (const v of lista) {
        const fecha = String(v.fecha_hora || "").slice(0, 10);
        if (!fecha || fecha < desde || fecha > hasta) continue;
        const guardada = await guardarVenta(db, sql, v);
        if (guardada) guardadas++;
      }
      await new Promise((r) => setTimeout(r, 80));

      // Si ya estamos en rango, parar tras procesar el lote pedido (para responder)
      if (llegoAlRango && (pagina - paginaInicio + 1) >= paginasPorLote) break;
    }

    const ultimaPagina = pagina;
    const notasRango = `${desde}..${hasta}`;
    await db.execute(sql`
      INSERT INTO sync_estado (clave, ultimoId, notas) VALUES ('historico', ${ultimaPagina}, ${notasRango})
       ON DUPLICATE KEY UPDATE ultimoId=${ultimaPagina}, notas=${notasRango}, ultimaSync=CURRENT_TIMESTAMP
    `);
    if (!mensaje) {
      mensaje = llegoAlRango
        ? `Procesado hasta pág. ${ultimaPagina} · +${guardadas} ventas de mayo`
        : `Avanzando... saltadas ${paginasSaltadas} pág. de junio (pág. ${ultimaPagina})`;
    }
  } catch (e: any) {
    mensaje = `Error: ${e.message}`;
  }

  return { guardadas, paginaActual: pagina, terminado, mensaje, enRango: llegoAlRango };
}

/** Reinicia el progreso de la carga histórica (para empezar de nuevo). */
export async function reiniciarProgresoHistorico(): Promise<void> {
  const { getDb } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return;
  try {
    await db.execute(sql`DELETE FROM sync_estado WHERE clave='historico'`);
  } catch (e) { console.warn("[Historico] Error reiniciando:", e); }
}

/** Versión pública de guardarVenta (para rellenar huecos desde el router). */
export async function guardarVentaPublica(db: any, sql: any, venta: any): Promise<boolean> {
  return guardarVenta(db, sql, venta);
}
