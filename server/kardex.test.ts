import { describe, expect, it } from "vitest";
import { NOMBRE_ALMACEN, claveArticulo, resolverSucursal } from "./kardex";

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

describe("kardex — normalización de sucursales", () => {
  it("lleva las variantes de cada fuente al mismo almacén", () => {
    // Las ventas de 365 dicen "Sucursal Lanza", los almacenes "Almacen Lanza"
    expect(resolverSucursal("Sucursal Lanza").almacenId).toBe(3);
    expect(resolverSucursal("Almacen Lanza").almacenId).toBe(3);
    expect(resolverSucursal("LANZA").almacenId).toBe(3);
    // Y todas muestran la misma etiqueta
    expect(resolverSucursal("Sucursal Lanza").sucursal).toBe(resolverSucursal("Almacen Lanza").sucursal);
  });

  it("NO confunde Casa Matriz con Casa Matriz Cobol", () => {
    // Trampa conocida: "Casa Matriz Cobol" contiene "Matriz" pero es Cobol
    expect(resolverSucursal("Casa Matriz Cobol").almacenId).toBe(4);
    expect(resolverSucursal("Almacen Cobol").almacenId).toBe(4);
    expect(resolverSucursal("Casa Matriz").almacenId).toBe(1);
    expect(resolverSucursal("ALMACEN PRINCIPAL").almacenId).toBe(1);
  });

  it("conserva una sucursal desconocida en vez de perderla", () => {
    expect(resolverSucursal("Sucursal Nueva").almacenId).toBeNull();
    expect(resolverSucursal("Sucursal Nueva").sucursal).toBe("Sucursal Nueva");
    expect(resolverSucursal("").sucursal).toBeNull();
    expect(resolverSucursal(null).almacenId).toBeNull();
  });
});

describe("kardex — orden cronológico dentro del mismo día", () => {
  it("una venta de la mañana va antes que el ajuste de la tarde", () => {
    // El saldo depende del ORDEN por hora, no solo por fecha
    const movs = [
      { hora: "2026-07-22T09:15:00", cantidad: -3 },  // venta 9:15
      { hora: "2026-07-22T15:40:00", cantidad: -2 },  // ajuste 15:40
      { hora: "2026-07-22T11:00:00", cantidad: +10 }, // compra 11:00
    ].sort((a, b) => a.hora.localeCompare(b.hora));
    expect(movs.map((m) => m.cantidad)).toEqual([-3, 10, -2]);
    let saldo = 20;
    const saldos = movs.map((m) => (saldo += m.cantidad));
    expect(saldos).toEqual([17, 27, 25]);
  });
});

describe("kardex — la farmacia tiene exactamente 4 almacenes", () => {
  it("los cuatro almacenes reales están definidos", () => {
    expect(Object.keys(NOMBRE_ALMACEN)).toHaveLength(4);
    expect(NOMBRE_ALMACEN[1]).toBe("Casa Matriz");   // ALMACEN PRINCIPAL
    expect(NOMBRE_ALMACEN[2]).toBe("Petrolera");
    expect(NOMBRE_ALMACEN[3]).toBe("Lanza");
    expect(NOMBRE_ALMACEN[4]).toBe("Cobol");         // Casa Matriz Cobol
  });

  it("consolida en 4 y agrupa lo no identificado en uno solo", () => {
    // Réplica de la consolidación de porProducto()
    const consolidar = (filas: any[]) => {
      const CANON = [1, 2, 3, 4];
      const out = CANON.map((id) => filas.find((f) => f.almacenId === id) ?? { sucursal: NOMBRE_ALMACEN[id], almacenId: id, saldo: 0 });
      const sueltos = filas.filter((f) => !CANON.includes(Number(f.almacenId)));
      if (sueltos.length > 0) {
        out.push({ sucursal: "Sin sucursal", almacenId: null, saldo: sueltos.reduce((t, x) => t + x.saldo, 0) });
      }
      return out;
    };
    // Dos etiquetas huérfanas distintas no deben producir dos sucursales extra
    const r = consolidar([
      { sucursal: "Casa Matriz", almacenId: 1, saldo: 10 },
      { sucursal: "Lanza", almacenId: 3, saldo: 5 },
      { sucursal: "(sin sucursal)", almacenId: null, saldo: 2 },
      { sucursal: "Deposito viejo", almacenId: null, saldo: 1 },
    ]);
    expect(r).toHaveLength(5);                      // 4 reales + 1 grupo
    expect(r.filter((x) => x.almacenId !== null)).toHaveLength(4);
    expect(r[r.length - 1].saldo).toBe(3);          // 2 + 1 juntos
  });

  it("las cuatro aparecen aunque no tengan movimientos", () => {
    const CANON = [1, 2, 3, 4];
    const out = CANON.map((id) => ({ sucursal: NOMBRE_ALMACEN[id], almacenId: id }));
    expect(out.map((x) => x.sucursal)).toEqual(["Casa Matriz", "Petrolera", "Lanza", "Cobol"]);
  });
});
