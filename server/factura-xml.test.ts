import { describe, expect, it } from "vitest";
import { esFacturaXml, parsearFacturaXml } from "./factura-xml";

// XML mínimo con la estructura real del SIN (2 productos).
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<facturaElectronicaCompraVenta>
  <cabecera>
    <nitEmisor>1020775026</nitEmisor>
    <razonSocialEmisor>INDUSTRIA FARMACEUTICA BOLIVIANA IFARBO LTDA</razonSocialEmisor>
    <numeroFactura>2628</numeroFactura>
    <cuf>45D821867668B4142ACEBF2D7A014F42EF4346829791AC3F0E1BEAF74</cuf>
    <fechaEmision>2026-06-11T09:04:32.000</fechaEmision>
    <montoTotal>244.72</montoTotal>
    <descuentoAdicional>0</descuentoAdicional>
  </cabecera>
  <detalle>
    <codigoProducto>PG3VAP01</codigoProducto>
    <descripcion>VASELINA solida perfumada x 12 g.</descripcion>
    <cantidad>3</cantidad>
    <precioUnitario>43.28</precioUnitario>
    <montoDescuento>6.49</montoDescuento>
    <subTotal>123.35</subTotal>
  </detalle>
  <detalle>
    <codigoProducto>NEO001</codigoProducto>
    <descripcion>NEO BAC Pomo Amarillo x 12 g</descripcion>
    <cantidad>2</cantidad>
    <precioUnitario>64.10</precioUnitario>
    <montoDescuento>6.91</montoDescuento>
    <subTotal>121.37</subTotal>
  </detalle>
</facturaElectronicaCompraVenta>`;

describe("factura-xml", () => {
  it("reconoce una factura XML del SIN", () => {
    expect(esFacturaXml(XML, "factura.xml")).toBe(true);
    expect(esFacturaXml("cualquier texto", "foto.jpg")).toBe(false);
  });

  it("extrae cabecera fiscal exacta", () => {
    const f = parsearFacturaXml(XML);
    expect(f.nitEmisor).toBe("1020775026");
    expect(f.razonSocialEmisor).toContain("IFARBO");
    expect(f.numeroFactura).toBe("2628");
    expect(f.cuf).toHaveLength(57);
    expect(f.montoTotal).toBe(244.72);
  });

  it("extrae los productos con precio unitario ya con descuento", () => {
    const f = parsearFacturaXml(XML);
    expect(f.items).toHaveLength(2);
    // unitCost = subtotal/cantidad = 123.35/3 = 41.1167
    expect(f.items[0].unitCost).toBeCloseTo(41.1167, 3);
    expect(f.items[0].descuento).toBe(6.49);
    expect(f.items[1].quantity).toBe(2);
  });

  it("la suma de subtotales cuadra con el monto total", () => {
    const f = parsearFacturaXml(XML);
    const suma = f.items.reduce((s, i) => s + i.subtotal, 0);
    expect(suma).toBeCloseTo(f.montoTotal, 2);
  });

  it("suma correctamente los descuentos de línea", () => {
    const f = parsearFacturaXml(XML);
    expect(f.descuentoTotalLineas).toBeCloseTo(13.4, 2);
  });
});
