/**
 * Servicio de Inteligencia de Negocio (Fase 0 del agente).
 *
 * Responsabilidad única: acumular métricas por producto/mes y registrar sugerencias
 * de mejora. NO usa IA — es backend puro que llena las tablas a partir de lo que ocurre.
 * La IA (a futuro) solo LEE estas tablas para responder.
 *
 * Diseño defensivo: ninguna función aquí debe romper el flujo principal. Si algo falla
 * (BD caída, dato inesperado), se registra el error y se continúa. Capturar estadísticas
 * NUNCA debe impedir registrar una compra o atender una consulta.
 */

const mesActual = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/**
 * Registra unidades compradas de un producto en el mes (acumula).
 * Se llama al confirmar una compra. Es "fire and forget": si falla, no afecta la compra.
 */
export async function registrarCompraProducto(params: {
  articuloId: number;
  articuloNombre: string;
  unidades: number;
  costoUnitario?: number;
  anioMes?: string;
}): Promise<void> {
  try {
    const { getDb } = await import("./db");
    const { estadisticasProducto } = await import("../drizzle/schema");
    const { eq, and } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return;

    const anioMes = params.anioMes || mesActual();
    const [existente] = await db.select().from(estadisticasProducto)
      .where(and(
        eq(estadisticasProducto.articuloId, params.articuloId),
        eq(estadisticasProducto.anioMes, anioMes),
      ));

    if (existente) {
      const nuevasUnidades = parseFloat(String(existente.unidadesCompradas)) + params.unidades;
      await db.update(estadisticasProducto).set({
        unidadesCompradas: String(nuevasUnidades),
        vecesComprado: existente.vecesComprado + 1,
        ultimoCostoUnitario: params.costoUnitario != null ? String(params.costoUnitario) : existente.ultimoCostoUnitario,
      }).where(eq(estadisticasProducto.id, existente.id));
    } else {
      await db.insert(estadisticasProducto).values({
        articuloId: params.articuloId,
        articuloNombre: params.articuloNombre,
        anioMes,
        unidadesCompradas: String(params.unidades),
        vecesComprado: 1,
        ultimoCostoUnitario: params.costoUnitario != null ? String(params.costoUnitario) : null,
      });
    }
  } catch (e) {
    console.warn("[Inteligencia] No se pudo registrar compra de producto:", e);
  }
}

/**
 * Registra que un producto fue consultado (búsqueda en consulta/agente).
 * Útil para detectar demanda. Si está sin stock, también lo cuenta.
 */
export async function registrarConsultaProducto(params: {
  articuloId: number;
  articuloNombre: string;
  sinStock?: boolean;
  anioMes?: string;
}): Promise<void> {
  try {
    const { getDb } = await import("./db");
    const { estadisticasProducto } = await import("../drizzle/schema");
    const { eq, and } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return;

    const anioMes = params.anioMes || mesActual();
    const [existente] = await db.select().from(estadisticasProducto)
      .where(and(
        eq(estadisticasProducto.articuloId, params.articuloId),
        eq(estadisticasProducto.anioMes, anioMes),
      ));

    if (existente) {
      await db.update(estadisticasProducto).set({
        vecesConsultado: existente.vecesConsultado + 1,
        vecesSinStock: existente.vecesSinStock + (params.sinStock ? 1 : 0),
      }).where(eq(estadisticasProducto.id, existente.id));
    } else {
      await db.insert(estadisticasProducto).values({
        articuloId: params.articuloId,
        articuloNombre: params.articuloNombre,
        anioMes,
        vecesConsultado: 1,
        vecesSinStock: params.sinStock ? 1 : 0,
      });
    }
  } catch (e) {
    console.warn("[Inteligencia] No se pudo registrar consulta de producto:", e);
  }
}

/**
 * Registra una sugerencia de mejora. Si ya existe una igual (misma categoría+descripción)
 * sin implementar, incrementa el contador en vez de duplicar.
 * El agente/sistema SUGIERE; el humano decide. Nunca se auto-implementa.
 */
export async function registrarSugerencia(params: {
  origen?: "sistema" | "agente";
  categoria: string;
  descripcion: string;
  datosRespaldo?: string;
}): Promise<void> {
  try {
    const { getDb } = await import("./db");
    const { sugerenciasSistema } = await import("../drizzle/schema");
    const { eq, and } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return;

    const [existente] = await db.select().from(sugerenciasSistema)
      .where(and(
        eq(sugerenciasSistema.categoria, params.categoria),
        eq(sugerenciasSistema.descripcion, params.descripcion),
        eq(sugerenciasSistema.estado, "nueva"),
      ));

    if (existente) {
      await db.update(sugerenciasSistema).set({
        vecesDetectado: existente.vecesDetectado + 1,
        datosRespaldo: params.datosRespaldo ?? existente.datosRespaldo,
      }).where(eq(sugerenciasSistema.id, existente.id));
    } else {
      await db.insert(sugerenciasSistema).values({
        origen: params.origen || "sistema",
        categoria: params.categoria,
        descripcion: params.descripcion,
        datosRespaldo: params.datosRespaldo || null,
      });
    }
  } catch (e) {
    console.warn("[Inteligencia] No se pudo registrar sugerencia:", e);
  }
}
