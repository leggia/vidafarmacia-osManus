/**
 * Lector de FACTURA ELECTRÓNICA XML del SIN (Bolivia).
 *
 * El XML del SIN trae el detalle EXACTO de la compra: por cada producto su
 * descripción, cantidad, precioUnitario, montoDescuento (descuento por línea) y
 * subTotal (ya con el descuento aplicado). Esto es muy superior a leer una foto:
 * cero errores de OCR, precios y descuentos oficiales.
 *
 * El precio de costo REAL por unidad es subTotal/cantidad (el subTotal ya
 * descuenta el montoDescuento), que es justo lo que se usa para actualizar
 * precios tras la compra.
 *
 * Devuelve el MISMO formato que uploadAndExtract (extracción por foto) para que
 * el frontend de NuevaCompra lo consuma igual, venga de foto o de XML.
 */

// Extrae el contenido de <tag>...</tag> (primer match) dentro de un bloque.
function tag(xml: string, nombre: string): string | null {
  const m = xml.match(new RegExp(`<${nombre}[^>]*>([\\s\\S]*?)</${nombre}>`));
  return m ? decodeXml(m[1].trim()) : null;
}
function tagNum(xml: string, nombre: string): number {
  const v = tag(xml, nombre);
  const n = v ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}
function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

export interface FacturaXmlItem {
  productName: string;
  productNameFactura: string;
  quantity: number;
  unitCost: number;        // costo real por unidad (subtotal/cantidad, ya con descuento)
  subtotal: number;        // subtotal de la línea (con descuento)
  descuento: number;       // descuento de la línea
  expiryDate: string | null;
  codigoProducto: string | null; // código del proveedor (útil para emparejar)
}

export interface FacturaXmlResult {
  esXml: true;
  // Cabecera fiscal (exacta, del XML)
  nitEmisor: string | null;
  razonSocialEmisor: string | null;   // proveedor
  numeroFactura: string | null;
  cuf: string | null;
  fechaEmision: string | null;
  montoTotal: number;
  descuentoAdicional: number;          // descuento a nivel factura (si hay)
  descuentoTotalLineas: number;        // suma de descuentos por producto
  // Detalle
  items: FacturaXmlItem[];
}

/** ¿El contenido parece una factura electrónica XML del SIN? */
export function esFacturaXml(contenido: string, fileName?: string): boolean {
  if (fileName && fileName.toLowerCase().endsWith(".xml")) return true;
  return /<facturaElectronica|<cabecera>[\s\S]*<detalle>/.test(contenido);
}

export function parsearFacturaXml(xml: string): FacturaXmlResult {
  // Cabecera: tomar solo el bloque <cabecera> para no confundir con <detalle>
  const cabMatch = xml.match(/<cabecera>([\s\S]*?)<\/cabecera>/);
  const cab = cabMatch ? cabMatch[1] : xml;

  const nitEmisor = tag(cab, "nitEmisor");
  const razonSocialEmisor = tag(cab, "razonSocialEmisor");
  const numeroFactura = tag(cab, "numeroFactura");
  const cuf = tag(cab, "cuf");
  const fechaEmision = tag(cab, "fechaEmision");
  const montoTotal = tagNum(cab, "montoTotal");
  const descuentoAdicional = tagNum(cab, "descuentoAdicional");

  // Detalle: todos los bloques <detalle>...</detalle>
  const items: FacturaXmlItem[] = [];
  let descuentoTotalLineas = 0;
  const detalleRegex = /<detalle>([\s\S]*?)<\/detalle>/g;
  let m: RegExpExecArray | null;
  while ((m = detalleRegex.exec(xml)) !== null) {
    const d = m[1];
    const descripcion = tag(d, "descripcion") || "";
    const cantidad = Math.max(1, tagNum(d, "cantidad"));
    const precioUnitario = tagNum(d, "precioUnitario");
    const descuento = tagNum(d, "montoDescuento");
    const subTotal = tagNum(d, "subTotal");
    const codigoProducto = tag(d, "codigoProducto");

    descuentoTotalLineas += descuento;

    // Costo real por unidad = subtotal (con descuento) / cantidad.
    // Si no hay subtotal, caer al precio unitario menos descuento prorrateado.
    const subtotalReal = subTotal > 0 ? subTotal : Math.max(0, precioUnitario * cantidad - descuento);
    const unitCost = subtotalReal / cantidad;

    items.push({
      productName: descripcion,
      productNameFactura: descripcion,
      quantity: cantidad,
      unitCost: Number(unitCost.toFixed(4)),
      subtotal: Number(subtotalReal.toFixed(2)),
      descuento: Number(descuento.toFixed(2)),
      expiryDate: null, // el XML del SIN no incluye vencimiento por línea
      codigoProducto,
    });
  }

  return {
    esXml: true,
    nitEmisor,
    razonSocialEmisor,
    numeroFactura,
    cuf,
    fechaEmision,
    montoTotal,
    descuentoAdicional,
    descuentoTotalLineas: Number(descuentoTotalLineas.toFixed(2)),
    items,
  };
}
