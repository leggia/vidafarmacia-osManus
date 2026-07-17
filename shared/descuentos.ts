// APRENDIZAJE DE DESCUENTOS POR PROVEEDOR — lógica PURA (testeable sin BD).
// Los laboratorios bolivianos (Bagó, Inti…) tienen patrones de descuento bastante
// estables por producto. Si una factura viene con MENOS descuento del habitual,
// es plata que se pierde en silencio: el objetivo es avisar a tiempo.

/**
 * Descuento "típico" de un historial: la MEDIANA, no el promedio.
 * La mediana no se deja arrastrar por una factura atípica (una promoción puntual
 * del 50% no debe convertirse en "lo normal").
 */
export function descuentoTipico(historial: number[]): number | null {
  const validos = historial.filter((n) => typeof n === "number" && !isNaN(n) && n >= 0);
  if (validos.length === 0) return null;
  const orden = [...validos].sort((a, b) => a - b);
  const medio = Math.floor(orden.length / 2);
  const mediana = orden.length % 2 === 0 ? (orden[medio - 1] + orden[medio]) / 2 : orden[medio];
  return Math.round(mediana * 10) / 10;
}

export type AlertaDescuento = {
  producto: string;
  pctActual: number;
  pctTipico: number;
  diferencia: number;       // negativo = te dan MENOS de lo habitual
  vecesObservado: number;
  peor: boolean;            // true si te dan menos (lo que cuesta plata)
};

const UMBRAL_PUNTOS = 5;   // diferencia mínima (en puntos %) para avisar
const MIN_HISTORIAL = 2;   // con una sola compra previa no hay "patrón" todavía

/**
 * Compara el descuento de una línea contra el típico del proveedor para ese
 * producto. Devuelve null si no hay patrón suficiente o si la diferencia es
 * despreciable — no se alerta por ruido.
 */
export function evaluarDescuento(
  producto: string,
  pctActual: number,
  historial: number[]
): AlertaDescuento | null {
  if (historial.length < MIN_HISTORIAL) return null; // aún no sabemos qué es "normal"
  const tipico = descuentoTipico(historial);
  if (tipico == null) return null;
  const diferencia = Math.round((pctActual - tipico) * 10) / 10;
  if (Math.abs(diferencia) < UMBRAL_PUNTOS) return null;
  return {
    producto,
    pctActual: Math.round(pctActual * 10) / 10,
    pctTipico: tipico,
    diferencia,
    vecesObservado: historial.length,
    peor: diferencia < 0,
  };
}
