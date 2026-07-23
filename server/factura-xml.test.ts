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
    <cufd>DQUE5Q0BIQ0JBNk0YzNUIxRjQ5NUY</cufd>
    <direccion>Calle Caritas No382</direccion>
    <municipio>Colcapirhua</municipio>
    <telefono>4226001</telefono>
    <fechaEmision>2026-06-11T09:04:32.000</fechaEmision>
    <nombreRazonSocial>LUIS OMAR TUCO TITO - FARMACIA JIREH</nombreRazonSocial>
    <numeroDocumento>6512529017</numeroDocumento>
    <montoTotal>244.72</montoTotal>
    <montoTotalSujetoIva>244.72</montoTotalSujetoIva>
    <descuentoAdicional>0</descuentoAdicional>
  </cabecera>
  <detalle>
    <codigoProductoSin>1001503</codigoProductoSin>
    <codigoProducto>PG3VAP01</codigoProducto>
    <unidadMedida>14</unidadMedida>
    <descripcion>VASELINA solida perfumada x 12 g.</descripcion>
    <cantidad>3</cantidad>
    <precioUnitario>43.28</precioUnitario>
    <montoDescuento>6.49</montoDescuento>
    <subTotal>123.35</subTotal>
  </detalle>
  <detalle>
    <codigoProductoSin>1001504</codigoProductoSin>
    <codigoProducto>NEO001</codigoProducto>
    <unidadMedida>14</unidadMedida>
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

  it("no confunde etiquetas cuyo nombre es prefijo de otra", () => {
    const f = parsearFacturaXml(XML);
    // codigoProducto NO debe engancharse con codigoProductoSin (bug corregido:
    // devolvía "1001503</codigoProductoSin>...<codigoProducto>PG3VAP01")
    expect(f.items[0].codigoProducto).toBe("PG3VAP01");
    expect(f.items[0].codigoProductoSin).toBe("1001503");
    expect(f.items[1].codigoProducto).toBe("NEO001");
    // cuf no debe traer el contenido de cufd
    expect(f.cuf).toBe("45D821867668B4142ACEBF2D7A014F42EF4346829791AC3F0E1BEAF74");
    // montoTotal no debe confundirse con montoTotalSujetoIva
    expect(f.montoTotal).toBe(244.72);
  });

  it("extrae a quién está dirigida la factura y el contacto del proveedor", () => {
    const f = parsearFacturaXml(XML);
    expect(f.razonSocialCliente).toContain("FARMACIA JIREH");
    expect(f.nitCliente).toBe("6512529017");
    expect(f.telefonoEmisor).toBe("4226001");
    expect(f.municipioEmisor).toBe("Colcapirhua");
  });

  it("guarda el precio de lista además del costo con descuento", () => {
    const f = parsearFacturaXml(XML);
    expect(f.items[0].precioUnitario).toBeCloseTo(43.28, 2);
    expect(f.items[0].unitCost).toBeCloseTo(41.1167, 3); // ya con descuento
    expect(f.items[0].unidadMedida).toBe("14");
  });

  it("suma correctamente los descuentos de línea", () => {
    const f = parsearFacturaXml(XML);
    expect(f.descuentoTotalLineas).toBeCloseTo(13.4, 2);
  });
});
