import { describe, expect, it } from "vitest";
import { calcularDescuentosCascada, cuadraConTotal } from "./descuentos";
import { clasificarABC } from "./abc";
import { calcularResumenMensual, calcularRetraso, calcularHoras } from "./sueldos";

describe("descuentos en cascada", () => {
  it("aplica volumen y efectivo en cascada y cuadra con el total", () => {
    // 10 productos que suman 2000 (ya con descuento comercial), volumen 2% + efectivo 3%
    const lineas = Array.from({ length: 10 }, () => ({ precioLista: 200, cantidad: 1 }));
    const r = calcularDescuentosCascada(lineas, { pctVolumen: 2, pctEfectivo: 3 });
    expect(r.subtotal).toBe(2000);
    expect(r.totalFinal).toBe(1901.2); // 2000 × 0.98 × 0.97
    expect(cuadraConTotal(r.totalFinal, 1901.2)).toBe(true);
  });

  it("maneja descuento comercial por línea", () => {
    const lineas = [{ precioLista: 31, cantidad: 6, descuentoComercial: 36 }];
    const r = calcularDescuentosCascada(lineas);
    expect(r.subtotal).toBe(150); // 186 − 36
    expect(r.costoUnitarioPorLinea[0]).toBe(25); // 150 / 6
  });

  it("sin descuentos globales el total = subtotal", () => {
    const lineas = [{ precioLista: 100, cantidad: 2 }];
    const r = calcularDescuentosCascada(lineas);
    expect(r.totalFinal).toBe(200);
    expect(r.descuentoGlobalBs).toBe(0);
  });
});

describe("clasificación ABC", () => {
  it("clasifica por valor cuando hay costo", () => {
    const items = [
      { stock: 10, costoUnit: 100, valorStock: 1000 }, // alto
      { stock: 5, costoUnit: 10, valorStock: 50 },     // medio
      { stock: 1, costoUnit: 1, valorStock: 1 },       // bajo
    ];
    const r = clasificarABC(items);
    expect(r.resumen.criterio).toBe("valor");
    expect(r.items[0].clase).toBe("A"); // el de mayor valor
  });

  it("usa cantidad cuando no hay costo", () => {
    const items = [
      { stock: 100, costoUnit: 0, valorStock: 0 },
      { stock: 1, costoUnit: 0, valorStock: 0 },
    ];
    const r = clasificarABC(items);
    expect(r.resumen.criterio).toBe("cantidad");
  });
});

describe("cálculo de sueldos", () => {
  const cfg = {
    horaIngreso: "08:00", horasDia: 8, diasMes: 26, sueldoMensual: 2600,
    tipoDescuento: "proporcional" as const, montoDescuentoFijo: 0, toleranciaMin: 5,
  };

  it("no hay retraso dentro de la tolerancia", () => {
    expect(calcularRetraso("08:04:00", cfg)).toBe(0); // 4 min < 5 tolerancia
  });

  it("cuenta retraso pasada la tolerancia", () => {
    expect(calcularRetraso("08:20:00", cfg)).toBe(15); // 20 − 5 tolerancia
  });

  it("calcula horas con cruce de medianoche", () => {
    expect(calcularHoras("20:00:00", "04:00:00")).toBe(8);
  });

  it("ignora horas con dato inconsistente", () => {
    expect(calcularHoras("08:00:00", "07:59:00")).toBeLessThanOrEqual(24);
  });

  it("resumen mensual con descuento proporcional", () => {
    const aperturas = [
      { fecha: "2026-06-01", horaApertura: "08:00:00", horaCierre: "16:00:00" },
      { fecha: "2026-06-02", horaApertura: "08:30:00", horaCierre: "16:00:00" }, // 25 min retraso
    ];
    const r = calcularResumenMensual(aperturas, cfg);
    expect(r.diasTrabajados).toBe(2);
    expect(r.cantidadRetrasos).toBe(1);
    expect(r.minutosRetrasoTotal).toBe(25);
    expect(r.sueldoFinal).toBeLessThan(2600); // hubo descuento
  });
});
