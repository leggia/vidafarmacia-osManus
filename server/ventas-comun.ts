/**
 * Filtro compartido para EXCLUIR ventas anuladas de los totales.
 *
 * Problema que resuelve: la tabla `ventas` guarda el `estado` tal como viene de
 * 365. Cuando una venta se anula en 365, su estado pasa a "Cancelado" (así lo
 * marca la interfaz de 365). Si los reportes suman TODAS las filas, inflan el
 * total con ventas canceladas (bug: Lanza mostraba Bs 2000.5/81 ventas vs
 * Bs 1749.3/70 reales — la diferencia eran cancelaciones del día).
 *
 * 365 puede escribir el estado con distinta capitalización ("Cancelado",
 * "CANCELADO", "cancelada"). Por eso se filtra por coincidencia de "cancel"
 * (case-insensitive) y también "anul" por si alguna versión usara esa palabra.
 * Las ventas vigentes tienen otro estado (vacío, "Vigente", "Facturado", null,
 * etc.) y se conservan; solo se descartan las canceladas/anuladas.
 *
 * Uso: agregar `${FILTRO_NO_ANULADA}` a la cláusula WHERE de cualquier SUM/COUNT
 * sobre `ventas`.
 */
import { sql } from "drizzle-orm";

// Para consultas sin alias: ... WHERE fecha >= X ${FILTRO_NO_ANULADA}
export const FILTRO_NO_ANULADA = sql` AND (estado IS NULL OR (LOWER(estado) NOT LIKE '%cancel%' AND LOWER(estado) NOT LIKE '%anul%')) `;

// Para consultas con alias de tabla (ej. FROM ventas v): pasar el alias.
export const filtroNoAnuladaAlias = (alias: string) =>
  sql.raw(` AND (${alias}.estado IS NULL OR (LOWER(${alias}.estado) NOT LIKE '%cancel%' AND LOWER(${alias}.estado) NOT LIKE '%anul%')) `);
