/**
 * Filtro compartido para contar SOLO ventas válidas (excluye canceladas/anuladas).
 *
 * DATO CONFIRMADO por diagnóstico (v2.52.3): 365 guarda el `estado` como NÚMERO,
 * no como texto. Los valores reales en la tabla son:
 *   - estado "1"  → venta VÁLIDA/vigente (la gran mayoría)
 *   - estado "0"  → cancelada
 *   - estado "4"  → anulada/otro estado no vigente
 * (En la interfaz de 365 estas aparecen como "Cancelado", pero internamente es un
 *  número, por eso el filtro anterior que buscaba la palabra "cancel" nunca
 *  encontraba nada y los totales seguían inflados: Lanza 2000.5 vs 1749.3 real.)
 *
 * Enfoque seguro: contar ÚNICAMENTE estado = '1' (válidas). Cualquier otro estado
 * (0, 4, o cualquiera que aparezca a futuro) se excluye. Así no hay que enumerar
 * todos los estados "malos"; solo se admite el único estado bueno conocido.
 *
 * Uso: agregar `${FILTRO_NO_ANULADA}` a la cláusula WHERE de cualquier SUM/COUNT
 * sobre `ventas`.
 */
import { sql } from "drizzle-orm";

// Solo ventas válidas (estado = '1'). El estado se guarda como texto de un número.
export const FILTRO_NO_ANULADA = sql` AND CAST(estado AS CHAR) = '1' `;

// Para consultas con alias de tabla (ej. FROM ventas v): pasar el alias.
export const filtroNoAnuladaAlias = (alias: string) =>
  sql.raw(` AND CAST(${alias}.estado AS CHAR) = '1' `);

/**
 * Igual pero para `ventas_detalle` (las LÍNEAS de producto), que no tiene columna
 * estado: se excluyen las líneas cuya venta padre está anulada/cancelada.
 * Se usa NOT IN (anuladas) en vez de EXISTS(válidas) para no descartar líneas
 * huérfanas cuya venta aún no se sincronizó.
 */
export const FILTRO_DETALLE_NO_ANULADA = sql` AND ventaId NOT IN (SELECT id FROM ventas WHERE CAST(estado AS CHAR) <> '1') `;

export const filtroDetalleNoAnuladaAlias = (alias: string) =>
  sql.raw(` AND ${alias}.ventaId NOT IN (SELECT id FROM ventas WHERE CAST(estado AS CHAR) <> '1') `);
