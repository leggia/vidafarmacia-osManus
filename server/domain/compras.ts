// Lógica PURA de inteligencia de compras (testeable sin BD).

export type EvalPrecio = {
  estado: "igual" | "subio" | "bajo" | "nuevo";
  diffPct: number | null;
  margenPct: number | null;
  alertaMargen: boolean;
};

const UMBRAL_IGUAL = 0.005;   // ±0.5% se considera "mismo precio" (redondeos)
const UMBRAL_MARGEN_BAJO = 20; // margen menor a 20% se marca

/**
 * Evalúa el costo NUEVO de un producto contra su referencia conocida (último
 * precio propio, o costo del sistema si no hay historial) y contra el precio de
 * venta actual (margen). Sin referencia → "nuevo" (nada con qué comparar).
 */
export function evaluarPrecio(costoNuevo: number, referencia: number | null, precioVenta: number | null): EvalPrecio {
  let estado: EvalPrecio["estado"] = "nuevo";
  let diffPct: number | null = null;
  if (referencia != null && referencia > 0) {
    const diff = (costoNuevo - referencia) / referencia;
    diffPct = Math.round(diff * 1000) / 10;
    estado = Math.abs(diff) <= UMBRAL_IGUAL ? "igual" : diff > 0 ? "subio" : "bajo";
  }
  let margenPct: number | null = null;
  let alertaMargen = false;
  if (precioVenta != null && precioVenta > 0) {
    margenPct = Math.round(((precioVenta - costoNuevo) / precioVenta) * 1000) / 10;
    alertaMargen = margenPct < UMBRAL_MARGEN_BAJO;
  }
  return { estado, diffPct, margenPct, alertaMargen };
}

/**
 * De todos los precios de venta editados en el historial de compras, deja SOLO el
 * MÁS RECIENTE por producto. Es imprescindible para auditar: si un producto se
 * compró en enero a Bs 5 y en julio a Bs 6, el precio correcto en 365 es Bs 6 —
 * comparar contra el de enero daría una falsa alarma.
 * Empate de fecha: gana el de id mayor (la carga más reciente).
 */
export type PrecioEditado = { productName: string; precioVenta: number; fecha: string; purchaseId: number; itemId?: number };
export function ultimoPrecioPorProducto(items: PrecioEditado[]): PrecioEditado[] {
  const porProducto = new Map<string, PrecioEditado>();
  for (const it of items) {
    if (!it.productName || !(it.precioVenta > 0)) continue;
    const clave = it.productName.trim().toLowerCase();
    const previo = porProducto.get(clave);
    if (!previo) { porProducto.set(clave, it); continue; }
    const masNuevo =
      it.fecha > previo.fecha ||
      (it.fecha === previo.fecha && (it.itemId ?? it.purchaseId) > (previo.itemId ?? previo.purchaseId));
    if (masNuevo) porProducto.set(clave, it);
  }
  return [...porProducto.values()];
}
