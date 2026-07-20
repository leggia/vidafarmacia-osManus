/**
 * Filtro compartido para EXCLUIR ventas anuladas de los totales.
 *
 * Problema que resuelve: la tabla `ventas` guarda el `estado` tal como viene de
 * 365. Cuando una venta se anula en 365, sigue en la tabla pero con un estado de
 * anulación. Si los reportes suman TODAS las filas, inflan el total con ventas
 * que ya no son válidas (bug reportado: Lanza mostraba Bs 2000.5/81 ventas vs
 * Bs 1749.3/70 reales — la diferencia eran anulaciones del día).
 *
 * 365 puede escribir el estado como "ANULADA", "Anulada", "anulado", etc. Por eso
 * se filtra por coincidencia de "anul" (case-insensitive), no por igualdad exacta.
 * Las ventas vigentes suelen tener estado vacío, "VIGENTE", "VALIDA", "ACTIVA",
 * null, etc. — todas se conservan; solo se descartan las que digan "anul".
 *
 * Uso: agregar `${FILTRO_NO_ANULADA}` a la cláusula WHERE de cualquier SUM/COUNT
 * sobre `ventas`. Asume que la tabla está aliasada como su nombre por defecto; si
 * se usa alias, usar FILTRO_NO_ANULADA_ALIAS.
 */
import { sql } from "drizzle-orm";

// Para consultas sin alias: ... WHERE fecha >= X ${FILTRO_NO_ANULADA}
export const FILTRO_NO_ANULADA = sql` AND (estado IS NULL OR LOWER(estado) NOT LIKE '%anul%') `;

// Para consultas con alias de tabla (ej. FROM ventas v): pasar el alias.
export const filtroNoAnuladaAlias = (alias: string) =>
  sql.raw(` AND (${alias}.estado IS NULL OR LOWER(${alias}.estado) NOT LIKE '%anul%') `);
