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
  // El nombre de la etiqueta debe terminar exactamente ahí: o cierra con ">" o
  // sigue un espacio (atributos). Antes se usaba `<nombre[^>]*>`, que hacía que
  // "codigoProducto" enganchara "<codigoProductoSin>" y capturara basura entre
  // ambas etiquetas. Afectaba a todo nombre que fuera prefijo de otro
  // (codigoProducto/codigoProductoSin, cuf/cufd, montoTotal/montoTotalSujetoIva).
  const m = xml.match(new RegExp(`<${nombre}(?:\\s[^>]*)?>([\\s\\S]*?)</${nombre}\\s*>`));
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
  codigoProducto: string | null;      // código del proveedor (útil para emparejar)
  codigoProductoSin: string | null;   // código del producto según el SIN
  precioUnitario: number;             // precio de lista, ANTES del descuento
  unidadMedida: string | null;        // código de unidad de medida del SIN
  presentacion: string | null;        // "100 ml", "30 comprimidos" (leído de la descripción)
  unidadesPorEnvase: number | null;   // cuántas unidades trae la caja, si se pudo deducir
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
  montoTotalSujetoIva: number;         // base imponible
  // A quién está dirigida la factura: importante ahora que entran por correo,
  // para detectar una factura que no es de la farmacia.
  razonSocialCliente: string | null;
  nitCliente: string | null;
  // Datos de contacto del proveedor (útiles para su ficha)
  direccionEmisor: string | null;
  municipioEmisor: string | null;
  telefonoEmisor: string | null;
  // Detalle
  items: FacturaXmlItem[];
}

/** ¿El contenido parece una factura electrónica XML del SIN? */
export function esFacturaXml(contenido: string, fileName?: string): boolean {
  if (fileName && fileName.toLowerCase().endsWith(".xml")) return true;
  return /<facturaElectronica|<cabecera>[\s\S]*<detalle>/.test(contenido);
}

/**
 * Busca una fecha de vencimiento dentro de un texto (la descripción del producto
 * o una etiqueta suelta). Algunos proveedores lo incluyen ahí, otros no.
 * Devuelve YYYY-MM-DD (último día del mes si solo viene mes/año), o null.
 *
 * Solo acepta fechas plausibles como vencimiento: año entre el actual y +15, para
 * no confundir con contenidos tipo "x 12 g" o "100 ml".
 */
export function extraerVencimiento(texto: string): string | null {
  if (!texto) return null;
  const t = texto.replace(/\s+/g, " ");
  const anioActual = new Date().getFullYear();
  const MESES: Record<string, number> = {
    ene: 1, enero: 1, feb: 2, febrero: 2, mar: 3, marzo: 3, abr: 4, abril: 4,
    may: 5, mayo: 5, jun: 6, junio: 6, jul: 7, julio: 7, ago: 8, agosto: 8,
    sep: 9, set: 9, sept: 9, septiembre: 9, setiembre: 9, oct: 10, octubre: 10,
    nov: 11, noviembre: 11, dic: 12, diciembre: 12,
  };

  const armar = (anio: number, mes: number, dia?: number): string | null => {
    if (mes < 1 || mes > 12) return null;
    if (anio < 100) anio += 2000;
    // Un vencimiento razonable: desde el año pasado (puede estar vencido) hasta +15
    if (anio < anioActual - 1 || anio > anioActual + 15) return null;
    const ultimoDia = new Date(anio, mes, 0).getDate();
    const d = dia && dia >= 1 && dia <= ultimoDia ? dia : ultimoDia;
    return `${anio}-${String(mes).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };

  // Etiqueta explícita: VENC / VTO / VENCE / F.V. / EXP / CAD ...
  const etiqueta = /(?:venc\w*|vto\.?|vence\w*|f\.?\s*v\.?|exp\.?|cad\.?)\s*:?\s*/i;
  const conEtiqueta = t.match(new RegExp(etiqueta.source + /([0-9]{1,4}[\/\-.][0-9]{1,4}(?:[\/\-.][0-9]{2,4})?)/.source, "i"));
  const sueltas = [conEtiqueta?.[1]].filter(Boolean) as string[];

  // Mes en letras: "DIC-27", "VENC ENERO 2028"
  const conMesLetra = t.match(new RegExp(etiqueta.source + /([a-záéíóú]{3,10})\s*[\/\-. ]\s*([0-9]{2,4})/.source, "i"))
    || t.match(/\b([a-záéíóú]{3,10})\s*[\/\-]\s*(\d{2,4})\b/i);
  if (conMesLetra) {
    const mes = MESES[conMesLetra[1].toLowerCase().replace(/[.]/g, "")];
    if (mes) {
      const r = armar(Number(conMesLetra[2]), mes);
      if (r) return r;
    }
  }

  // Fechas sin etiqueta, pero solo con año de 4 dígitos (menos ambiguas)
  if (sueltas.length === 0) {
    const m = t.match(/\b(\d{1,2})[\/\-.](\d{4})\b/) || t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    if (m) sueltas.push(m[0]);
  }

  for (const s of sueltas) {
    const partes = s.split(/[\/\-.]/).map((x) => parseInt(x, 10));
    if (partes.some((n) => Number.isNaN(n))) continue;
    let r: string | null = null;
    if (partes.length === 2) {
      // MM/AAAA o MM/AA
      r = armar(partes[1], partes[0]);
    } else if (partes.length === 3) {
      // AAAA-MM-DD  o  DD/MM/AAAA
      r = String(partes[0]).length === 4
        ? armar(partes[0], partes[1], partes[2])
        : armar(partes[2], partes[1], partes[0]);
    }
    if (r) return r;
  }
  return null;
}

// Formas farmacéuticas que indican cuántas unidades trae el envase
const FORMAS = "c[aá]psulas?|caps?|comprimidos?|comp|tabletas?|tabs?|grageas?|sobres?|sbrs?\\.?|ampollas?|amp|viales?|supositorios?|[oó]vulos?|piezas?|unidades?|und|pastillas?|parches?|chicles?|jeringas?";

/**
 * Extrae de la descripción la presentación (contenido) y, si se puede, cuántas
 * unidades trae el envase. Ejemplos reales:
 *   "VASELINA sólida x 12 g."        → presentacion "12 g"
 *   "SULFATO DE MAGNESIA 50 sobres"  → presentacion "50 sobres", unidades 50
 *   "CALMATOS 25 sbrs. x 9 pastillas"→ presentacion "25 sbrs x 9 pastillas", unidades 225
 *   "IBUFEN 200 mg suspensió 100 ml" → presentacion "100 ml" (200 mg es concentración)
 */
export function extraerPresentacion(texto: string): { presentacion: string | null; unidadesPorEnvase: number | null } {
  if (!texto) return { presentacion: null, unidadesPorEnvase: null };
  const t = texto.replace(/\s+/g, " ").trim();

  // 1. Envase compuesto: "25 sbrs. x 9 pastillas" → multiplicar
  const compuesto = t.match(new RegExp(`(\\d+)\\s*(${FORMAS})\\s*[x×]\\s*(\\d+)\\s*(${FORMAS})`, "i"));
  if (compuesto) {
    const total = Number(compuesto[1]) * Number(compuesto[3]);
    return {
      presentacion: `${compuesto[1]} ${compuesto[2]} x ${compuesto[3]} ${compuesto[4]}`.replace(/\s+/g, " "),
      unidadesPorEnvase: Number.isFinite(total) && total > 0 ? total : null,
    };
  }

  // 2. Conteo simple de unidades: "50 sobres", "x 30 comprimidos", "x 20 piezas"
  const conteo = t.match(new RegExp(`(?:[x×]\\s*)?(\\d+)\\s*(${FORMAS})\\b`, "i"));

  // 3. Contenido/volumen: "12 g", "100 ml", "5 g". Se toma el ÚLTIMO, porque la
  //    concentración (200 mg) suele ir antes que el contenido del envase (100 ml).
  const volumenes = Array.from(t.matchAll(/(\d+(?:[.,]\d+)?)\s*(ml|l|g|gr|mg|mcg|kg|ui|%)\b\.?/gi));
  const contenido = volumenes.length > 0 ? volumenes[volumenes.length - 1] : null;

  if (conteo) {
    return {
      presentacion: `${conteo[1]} ${conteo[2]}`.replace(/\.$/, ""),
      unidadesPorEnvase: Number(conteo[1]) || null,
    };
  }
  if (contenido) {
    return { presentacion: `${contenido[1]} ${contenido[2].toLowerCase()}`, unidadesPorEnvase: null };
  }
  return { presentacion: null, unidadesPorEnvase: null };
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
  const montoTotalSujetoIva = tagNum(cab, "montoTotalSujetoIva");
  const razonSocialCliente = tag(cab, "nombreRazonSocial");
  const nitCliente = tag(cab, "numeroDocumento");
  const direccionEmisor = tag(cab, "direccion");
  const municipioEmisor = tag(cab, "municipio");
  const telefonoEmisor = tag(cab, "telefono");

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
    const codigoProductoSin = tag(d, "codigoProductoSin");
    const unidadMedida = tag(d, "unidadMedida");

    // Vencimiento: el XML estándar del SIN no lo trae, pero algunos proveedores
    // lo agregan en una etiqueta propia o lo escriben en la descripción.
    const vencTag = tag(d, "fechaVencimiento") || tag(d, "vencimiento")
      || tag(d, "fechaVenc") || tag(d, "fecha_vencimiento");
    const expiryDate = extraerVencimiento(vencTag || "") || extraerVencimiento(descripcion);

    // Presentación y unidades por envase, leídas de la descripción
    const { presentacion, unidadesPorEnvase } = extraerPresentacion(descripcion);

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
      expiryDate,
      codigoProducto,
      codigoProductoSin,
      precioUnitario: Number(precioUnitario.toFixed(4)),
      unidadMedida,
      presentacion,
      unidadesPorEnvase,
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
    montoTotalSujetoIva,
    razonSocialCliente,
    nitCliente,
    direccionEmisor,
    municipioEmisor,
    telefonoEmisor,
    items,
  };
}
