/**
 * Dominio: Cálculo de asistencia y sueldos.
 * Lógica PURA (sin IO).
 *
 * La hora de apertura de caja = hora de entrada del trabajador.
 * Retraso = apertura después de (hora esperada + tolerancia).
 * Descuento: proporcional (valor hora × tiempo) o monto fijo por retraso.
 */

/**
 * Tipos de trabajador (modo de cálculo del sueldo):
 *  - fijo_mensual:    sueldo fijo, valor hora = sueldo / horasMesFijas (192 por defecto)
 *  - por_dia:         sueldo = días trabajados × montoPorDia (domingos/feriados)
 *  - fijo_horas:      sueldo fijo, pero las horas/mes las define el usuario (ej. 120h)
 *  - fijo_turnos:     sueldo fijo por turnos largos (ej. 24h cada 3 días), valor hora = sueldo / horasMesFijas
 * Todos aplican descuento por retraso (apertura tardía).
 */
export type TipoTrabajador = "fijo_mensual" | "por_dia" | "fijo_horas" | "fijo_turnos";

export interface ConfigTrabajador {
  tipoTrabajador: TipoTrabajador;
  horaIngreso: string;       // "HH:MM" — hora esperada de apertura (o inicio de turno)
  horasDia: number;
  diasMes: number;
  diasSemana?: number[];     // [0..6], 0=domingo. Para contar días del mes
  horasMesFijas: number;     // horas base del mes para el valor hora (ej. 192)
  montoPorDia: number;       // para tipo por_dia: lo que se paga por día trabajado
  sueldoMensual: number;     // para tipos fijos
  tipoDescuento: "proporcional" | "fijo";
  montoDescuentoFijo: number;
  toleranciaMin: number;
}

/**
 * Cuenta cuántos días de la semana indicados caen en un mes dado.
 * @param anioMes "YYYY-MM"
 * @param diasSemana array de 0..6 (0=domingo, 1=lunes... 6=sábado)
 * Ej: contar domingos de 2026-06 → contarDiasDelMes("2026-06", [0])
 */
export function contarDiasDelMes(anioMes: string, diasSemana: number[]): number {
  const [anio, mes] = anioMes.split("-").map(Number);
  if (!anio || !mes || diasSemana.length === 0) return 0;
  const ultimoDia = new Date(anio, mes, 0).getDate();
  let cuenta = 0;
  for (let dia = 1; dia <= ultimoDia; dia++) {
    const diaSemana = new Date(anio, mes - 1, dia).getDay(); // 0=domingo
    if (diasSemana.includes(diaSemana)) cuenta++;
  }
  return cuenta;
}

export interface Apertura {
  fecha: string;             // "YYYY-MM-DD"
  horaApertura: string;      // "HH:MM:SS"
  horaCierre?: string;       // "HH:MM:SS"
}

export interface DiaCalculado {
  fecha: string;
  horaEntrada: string;
  horaSalida: string | null;
  minutosRetraso: number;
  horasTrabajadas: number;
}

export interface ResumenSueldo {
  diasTrabajados: number;
  horasTotales: number;
  cantidadRetrasos: number;
  minutosRetrasoTotal: number;
  valorHora: number;
  descuento: number;
  sueldoBase: number;           // sueldo antes de descuentos (según el tipo)
  sueldoFinal: number;
  detalle: DiaCalculado[];
  diasLaborablesMes?: number;   // días que debía trabajar en el mes (según días de semana)
  horasLaborablesMes?: number;  // horas que debía trabajar en el mes
}

const redondear = (n: number, dec = 2) => Math.round(n * 10 ** dec) / 10 ** dec;
const aMinutos = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Calcula minutos de retraso de una apertura respecto a la config del trabajador. */
export function calcularRetraso(horaApertura: string, cfg: ConfigTrabajador): number {
  const esperado = aMinutos(cfg.horaIngreso);
  const real = aMinutos(horaApertura);
  return Math.max(0, real - esperado - cfg.toleranciaMin);
}

/** Calcula horas trabajadas entre apertura y cierre, manejando cruce de medianoche. */
export function calcularHoras(horaApertura: string, horaCierre?: string): number {
  if (!horaCierre) return 0;
  let diff = aMinutos(horaCierre) - aMinutos(horaApertura);
  if (diff < 0) diff += 24 * 60;     // cerró pasada la medianoche
  if (diff > 16 * 60) return 0;       // dato inconsistente, ignorar
  return redondear(diff / 60);
}

/** Construye el resumen mensual de sueldo a partir de las aperturas de caja. */
export function calcularResumenMensual(aperturas: Apertura[], cfg: ConfigTrabajador, anioMes?: string): ResumenSueldo {
  const detalle: DiaCalculado[] = aperturas.map((a) => ({
    fecha: a.fecha,
    horaEntrada: a.horaApertura,
    horaSalida: a.horaCierre || null,
    minutosRetraso: calcularRetraso(a.horaApertura, cfg),
    horasTrabajadas: calcularHoras(a.horaApertura, a.horaCierre),
  }));

  const diasTrabajados = detalle.length;
  const horasTotales = redondear(detalle.reduce((s, d) => s + d.horasTrabajadas, 0));
  const retrasos = detalle.filter((d) => d.minutosRetraso > 0);
  const minutosRetrasoTotal = detalle.reduce((s, d) => s + d.minutosRetraso, 0);

  // Días laborables esperados del mes (según días de la semana configurados)
  let diasLaborables = cfg.diasMes;
  if (cfg.diasSemana && cfg.diasSemana.length > 0 && anioMes) {
    diasLaborables = contarDiasDelMes(anioMes, cfg.diasSemana);
  }

  // ── Cálculo del sueldo base según el TIPO de trabajador ──
  let sueldoBase = 0;       // lo que ganaría sin descuentos
  let valorHora = 0;        // para el descuento por retraso
  let horasBase = 0;        // horas del mes usadas para el valor hora

  if (cfg.tipoTrabajador === "por_dia") {
    // Pago por día trabajado (domingos/feriados): días con caja × monto por día
    sueldoBase = diasTrabajados * cfg.montoPorDia;
    // valor hora para descuento: monto por día / horas por día
    valorHora = cfg.horasDia > 0 ? cfg.montoPorDia / cfg.horasDia : 0;
    horasBase = diasTrabajados * cfg.horasDia;
  } else {
    // Tipos fijos: sueldo mensual fijo
    sueldoBase = cfg.sueldoMensual;
    // horas base: las fijas configuradas (192, 120, etc.); si no, días esperados × horas/día
    horasBase = cfg.horasMesFijas > 0 ? cfg.horasMesFijas : diasLaborables * cfg.horasDia;
    valorHora = horasBase > 0 ? cfg.sueldoMensual / horasBase : 0;
  }

  // ── Descuento por retraso (aplica a TODOS los tipos) ──
  let descuento = 0;
  if (cfg.tipoDescuento === "fijo") {
    descuento = retrasos.length * cfg.montoDescuentoFijo;
  } else {
    descuento = valorHora * (minutosRetrasoTotal / 60);
  }
  descuento = redondear(descuento);

  return {
    diasTrabajados,
    horasTotales,
    cantidadRetrasos: retrasos.length,
    minutosRetrasoTotal,
    valorHora: redondear(valorHora),
    descuento,
    sueldoBase: redondear(sueldoBase),
    sueldoFinal: redondear(sueldoBase - descuento),
    detalle,
    diasLaborablesMes: diasLaborables,
    horasLaborablesMes: redondear(horasBase),
  };
}
