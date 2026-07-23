import { describe, expect, it } from "vitest";
import { claveArticulo } from "./kardex";

describe("kardex — clave del artículo", () => {
  it("agrupa el mismo producto escrito de formas distintas", () => {
    // El mismo producto entra por fuentes distintas con formatos distintos:
    // la venta de 365, la factura del proveedor y el conteo manual.
    const variantes = [
      "VASELINA sólida perfumada Plastico x 12 g.",
      "Vaselina Solida Perfumada Plastico X 12 G",
      "VASELINA  SÓLIDA   PERFUMADA PLASTICO X 12 G.",
    ];
    const claves = variantes.map(claveArticulo);
    expect(new Set(claves).size).toBe(1);
    expect(claves[0]).toBe("VASELINA SOLIDA PERFUMADA PLASTICO X 12 G");
  });

  it("no mezcla productos distintos", () => {
    expect(claveArticulo("NOVADOL 50 caps")).not.toBe(claveArticulo("NOVADOL 75 caps"));
    expect(claveArticulo("IBUFEN 200 mg")).not.toBe(claveArticulo("IBUFEN FUERTE 200 mg"));
  });

  it("tolera nombres vacíos o raros sin romper", () => {
    expect(claveArticulo("")).toBe("");
    expect(claveArticulo("   ")).toBe("");
    expect(claveArticulo("---")).toBe("");
    expect(claveArticulo(null as any)).toBe("");
  });

  it("limita el largo para que quepa en la columna indexada", () => {
    expect(claveArticulo("A".repeat(400)).length).toBeLessThanOrEqual(255);
  });
});

describe("kardex — saldo corriente", () => {
  // Réplica de la lógica de acumulación que usa porProducto()
  const saldoCorriente = (cantidades: number[]) => {
    let saldo = 0;
    return cantidades.map((c) => (saldo += c));
  };

  it("acumula entradas y salidas en orden cronológico", () => {
    // compra +100, venta −3, venta −2, transferencia salida −20, ajuste −5
    expect(saldoCorriente([100, -3, -2, -20, -5])).toEqual([100, 97, 95, 75, 70]);
  });

  it("refleja un ajuste que sube el stock", () => {
    expect(saldoCorriente([50, -10, 5])).toEqual([50, 40, 45]);
  });
});
