// Lógica PURA de tendencias (testeable sin BD): compara un período contra el
// anterior y decide si el cambio merece una alerta proactiva.

export type Tendencia = {
  cambioPct: number | null; // null si no hay período anterior con datos
  direccion: "subio" | "bajo" | "igual" | "sin_datos";
  alerta: boolean; // cambio "significativo" (umbral)
};

const UMBRAL_ALERTA = 15; // ±15% se considera cambio significativo

export function compararPeriodo(montoActual: number, montoAnterior: number): Tendencia {
  if (!montoAnterior || montoAnterior <= 0) {
    return { cambioPct: null, direccion: montoActual > 0 ? "subio" : "sin_datos", alerta: false };
  }
  const cambio = ((montoActual - montoAnterior) / montoAnterior) * 100;
  const cambioPct = Math.round(cambio * 10) / 10;
  const direccion = Math.abs(cambio) < 2 ? "igual" : cambio > 0 ? "subio" : "bajo";
  return { cambioPct, direccion, alerta: Math.abs(cambio) >= UMBRAL_ALERTA };
}
