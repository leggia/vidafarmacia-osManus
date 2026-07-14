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
