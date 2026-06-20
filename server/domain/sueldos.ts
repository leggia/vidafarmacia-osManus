/**
 * Dominio: Cálculo de asistencia y sueldos.
 * Lógica PURA (sin IO).
 *
 * La hora de apertura de caja = hora de entrada del trabajador.
 * Retraso = apertura después de (hora esperada + tolerancia).
 * Descuento: proporcional (valor hora × tiempo) o monto fijo por retraso.
 */

import { formatearFechaLarga, tipoDia, nombreFeriado } from "./feriados";

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
  horaSalida?: string;       // "HH:MM" — hora esperada de cierre (para detectar cierre temprano)
  horasDia: number;
  diasMes: number;
  diasSemana?: number[];     // [0..6], 0=domingo. Para contar días del mes
  horasMesFijas: number;     // horas base del mes para el valor hora (ej. 192)
  montoPorDia: number;       // para tipo por_dia: lo que se paga por día trabajado
  montoTurnoExtra: number;   // pago extra por domingo/feriado cubierto (trabajadores fijos)
  sueldoMensual: number;     // para tipos fijos
  tipoDescuento: "proporcional" | "fijo";
  montoDescuentoFijo: number;
  toleranciaMin: number;     // tolerancia para retraso de entrada
  toleranciaSalidaMin: number; // minutos antes de la salida esperada que se permiten sin descuento
  diasPorTurno?: number;     // para fijo_turnos: cuántos días equivale 1 turno de 24h (ej. 3)
}

/**
 * Una justificación o corrección manual de un día específico.
 */
export interface AjusteDia {
  fecha: string;             // "YYYY-MM-DD"
  justificado?: boolean;     // si true, no se descuenta ese día (apagón, bloqueo, etc.)
  horaIngresoManual?: string; // "HH:MM:SS" corrige la hora de entrada
  esTurnoExtra?: boolean;    // marca que ese día fue un turno extra cubierto (domingo/feriado)
  motivo?: string;
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
  fecha: string;             // "YYYY-MM-DD" (fecha de apertura)
  horaApertura: string;      // "HH:MM:SS"
  horaCierre?: string;       // "HH:MM:SS"
  fechaCierre?: string;      // "YYYY-MM-DD" (fecha de cierre; permite turnos multi-día exactos)
}

export interface DiaCalculado {
  fecha: string;
  fechaLarga: string;            // "Lunes 21/04/2026"
  tipoDia: "feriado" | "domingo" | "normal";
  nombreFeriado: string | null;  // si es feriado, su nombre
  horaEntrada: string;
  horaSalida: string | null;
  minutosRetraso: number;        // retraso de entrada
  minutosCierreTemprano: number; // minutos que cerró antes de su salida esperada
  horasTrabajadas: number;
  justificado: boolean;          // día justificado (no descuenta)
  esTurnoExtra: boolean;         // turno extra cubierto (domingo/feriado)
}

export interface ResumenSueldo {
  diasTrabajados: number;
  horasTotales: number;
  cantidadRetrasos: number;
  minutosRetrasoTotal: number;
  minutosCierreTempranoTotal: number;
  turnosExtra: number;
  pagoTurnosExtra: number;
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
  const tolerancia = Number(cfg.toleranciaMin) || 0;
  const retraso = real - esperado - tolerancia;
  return isNaN(retraso) ? 0 : Math.max(0, retraso);
}

/** Calcula horas trabajadas entre apertura y cierre.
 * Si se conocen las fechas reales (apertura y cierre), calcula la diferencia EXACTA
 * (incluye turnos que cruzan uno o varios días, ej. 8:00 día 17 a 8:05 día 18 = 24.08h).
 * Si no hay fecha de cierre, cae al método aproximado por horas. */
export function calcularHoras(
  horaApertura: string,
  horaCierre?: string,
  esTurno24 = false,
  fechaApertura?: string,
  fechaCierre?: string,
): number {
  // Si NO se cerró la caja:
  // - Turno de 24h: asumir el cierre esperado 24h después (no se penaliza por olvido).
  // - Otros: 0 horas (no se puede saber).
  if (!horaCierre) return esTurno24 ? 24 : 0;

  // Método EXACTO: si tenemos ambas fechas, usar timestamps reales
  if (fechaApertura && fechaCierre) {
    const ini = new Date(`${fechaApertura}T${horaApertura.length === 5 ? horaApertura + ":00" : horaApertura}`);
    const fin = new Date(`${fechaCierre}T${horaCierre.length === 5 ? horaCierre + ":00" : horaCierre}`);
    const horas = (fin.getTime() - ini.getTime()) / (1000 * 60 * 60);
    if (!isNaN(horas) && horas > 0 && horas < 100) {
      // Acotar turnos de 24h a un máximo razonable (por si hubo error de cierre)
      if (esTurno24 && horas > 26) return 24;
      return redondear(horas);
    }
    // si el cálculo por fechas falla, continuar con el método por horas
  }

  // Método APROXIMADO (sin fecha de cierre): solo horas
  let diff = aMinutos(horaCierre) - aMinutos(horaApertura);
  if (diff < 0) diff += 24 * 60;     // cerró pasada la medianoche
  if (esTurno24 && diff < 60) diff += 24 * 60; // turno largo: el cierre real fue ~24h después
  if (!esTurno24 && diff > 16 * 60) return 0;  // dato inconsistente (no turno)
  if (esTurno24 && diff > 26 * 60) return 24;  // acotar turno a 24h
  return redondear(diff / 60);
}

/** Calcula minutos de cierre temprano respecto a la salida esperada (con tolerancia). */
export function calcularCierreTemprano(horaCierre: string | undefined, horaSalidaEsperada: string | undefined, toleranciaMin: number): number {
  if (!horaCierre || !horaSalidaEsperada) return 0;
  const esperado = aMinutos(horaSalidaEsperada);
  const real = aMinutos(horaCierre);
  // Solo cuenta si cerró ANTES de la salida esperada, más allá de la tolerancia
  const antes = esperado - real;
  return antes > toleranciaMin ? antes : 0;
}

/** Construye el resumen mensual de sueldo a partir de las aperturas de caja. */
export function calcularResumenMensual(
  aperturas: Apertura[],
  cfg: ConfigTrabajador,
  anioMes?: string,
  ajustes: AjusteDia[] = []
): ResumenSueldo {
  const esTurno24 = cfg.tipoTrabajador === "fijo_turnos";
  const ajustePorFecha = new Map(ajustes.map((a) => [a.fecha, a]));

  const detalle: DiaCalculado[] = aperturas.map((a) => {
    const aj = ajustePorFecha.get(a.fecha);
    // Hora de entrada: la manual si se justificó/corrigió, si no la real
    const horaEntrada = aj?.horaIngresoManual || a.horaApertura;
    const justificado = aj?.justificado ?? false;
    const esTurnoExtra = aj?.esTurnoExtra ?? false;

    // Los días de turno extra y los justificados no penalizan el sueldo fijo
    const sinPenalizar = justificado || esTurnoExtra;
    const minutosRetraso = sinPenalizar ? 0 : calcularRetraso(horaEntrada, cfg);
    const minutosCierreTemprano = sinPenalizar ? 0 : calcularCierreTemprano(a.horaCierre, cfg.horaSalida, cfg.toleranciaSalidaMin);
    const horasTrabajadas = calcularHoras(horaEntrada, a.horaCierre, esTurno24, a.fecha, a.fechaCierre);

    return { fecha: a.fecha,
      fechaLarga: formatearFechaLarga(a.fecha),
      tipoDia: tipoDia(a.fecha),
      nombreFeriado: nombreFeriado(a.fecha),
      horaEntrada, horaSalida: a.horaCierre || null,
      minutosRetraso, minutosCierreTemprano, horasTrabajadas, justificado, esTurnoExtra };
  });

  // Días normales (no extra): cuentan para el sueldo del mes
  const diasNormales = detalle.filter((d) => !d.esTurnoExtra);
  // En turnos de 24h, cada turno equivale a varios días (ej. 3). Configurable.
  const factorDias = cfg.tipoTrabajador === "fijo_turnos" ? (cfg.diasPorTurno || 3) : 1;
  const turnosNormales = diasNormales.length;        // cantidad de turnos/aperturas
  const diasTrabajados = turnosNormales * factorDias; // días equivalentes
  const horasTotales = redondear(detalle.reduce((s, d) => s + d.horasTrabajadas, 0));
  const retrasos = detalle.filter((d) => d.minutosRetraso > 0);
  const minutosRetrasoTotal = detalle.reduce((s, d) => s + d.minutosRetraso, 0);
  const minutosCierreTempranoTotal = detalle.reduce((s, d) => s + d.minutosCierreTemprano, 0);
  const turnosExtra = detalle.filter((d) => d.esTurnoExtra).length;

  // Días laborables esperados del mes
  let diasLaborables = cfg.diasMes;
  if (cfg.diasSemana && cfg.diasSemana.length > 0 && anioMes) {
    diasLaborables = contarDiasDelMes(anioMes, cfg.diasSemana);
  }

  // ── Sueldo base según el tipo (sin contar días extra) ──
  let sueldoBase = 0, valorHora = 0, horasBase = 0;
  if (cfg.tipoTrabajador === "por_dia") {
    sueldoBase = diasTrabajados * cfg.montoPorDia;
    valorHora = cfg.horasDia > 0 ? cfg.montoPorDia / cfg.horasDia : 0;
    horasBase = diasTrabajados * cfg.horasDia;
  } else {
    sueldoBase = cfg.sueldoMensual;
    horasBase = cfg.horasMesFijas > 0 ? cfg.horasMesFijas : diasLaborables * cfg.horasDia;
    valorHora = horasBase > 0 ? cfg.sueldoMensual / horasBase : 0;
  }

  // ── Pago por turnos extra: se paga APARTE (cada día), NO se suma al sueldo del mes ──
  const pagoTurnosExtra = redondear(turnosExtra * cfg.montoTurnoExtra);

  // ── Descuento del sueldo fijo: retraso + cierre temprano (solo días normales) ──
  const minutosPenalizables = minutosRetrasoTotal + minutosCierreTempranoTotal;
  let descuento = 0;
  if (cfg.tipoDescuento === "fijo") {
    const eventos = retrasos.length + detalle.filter((d) => d.minutosCierreTemprano > 0).length;
    descuento = eventos * cfg.montoDescuentoFijo;
  } else {
    descuento = valorHora * (minutosPenalizables / 60);
  }
  descuento = redondear(descuento);

  // El sueldo final del MES NO incluye los turnos extra (esos ya se pagaron aparte)
  const descuentoSeguro = isNaN(descuento) ? 0 : descuento;
  const sueldoFinal = redondear((isNaN(sueldoBase) ? 0 : sueldoBase) - descuentoSeguro);

  return {
    diasTrabajados,
    horasTotales,
    cantidadRetrasos: retrasos.length,
    minutosRetrasoTotal,
    minutosCierreTempranoTotal,
    turnosExtra,
    pagoTurnosExtra,
    valorHora: redondear(valorHora),
    descuento,
    sueldoBase: redondear(sueldoBase),
    sueldoFinal,
    detalle,
    diasLaborablesMes: diasLaborables,
    horasLaborablesMes: redondear(horasBase),
  };
}
