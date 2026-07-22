// Servicio del Asistente VidaFarma (Fase 1: solo consultas / lectura)
// Cada función es una "herramienta" que el asistente puede invocar.
import { getDb } from "./db";
import { sql } from "drizzle-orm";
import { FILTRO_NO_ANULADA } from "./ventas-comun";

const rows = (r: any): any[] => {
  const x = Array.isArray(r) ? r[0] : r?.rows ?? r;
  return Array.isArray(x) ? x : [];
};
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };
// Fragmento SQL " AND <col> LIKE %valor%" (o vacío) — el valor va parametrizado
// (nunca concatenado como texto), así que es seguro ante inyección SQL.
// `col` SIEMPRE debe ser un nombre de columna fijo escrito en el código, nunca input de usuario.
const filtroLike = (col: string, valor: string | undefined) =>
  valor ? sql`AND ${sql.raw(col)} LIKE ${"%" + valor + "%"}` : sql``;
// Condición AND de varias palabras sobre la misma columna (búsqueda por nombre)
const condPalabras = (col: string, texto: string) => {
  const palabras = texto.trim().split(/\s+/).filter(Boolean);
  let cond = sql`${sql.raw(col)} LIKE ${"%" + palabras[0] + "%"}`;
  for (let i = 1; i < palabras.length; i++) {
    cond = sql`${cond} AND ${sql.raw(col)} LIKE ${"%" + palabras[i] + "%"}`;
  }
  return cond;
};
const fmtBs = (n: any) => num(n).toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Rango de fechas según un período de texto
// Hora actual de BOLIVIA (UTC-4). El servidor corre en UTC: sin este ajuste,
// entre las 20:00 y medianoche de Bolivia "hoy" sería el día siguiente y las
// consultas de "hoy/ayer/este mes" darían datos incompletos o vacíos.
function ahoraBolivia(): Date {
  const utc = new Date();
  return new Date(utc.getTime() - 4 * 60 * 60 * 1000);
}

function rangoFechas(periodo: string): { desde: string; hasta: string; etiqueta: string } {
  const hoy = ahoraBolivia();
  const y = hoy.getUTCFullYear(), m = hoy.getUTCMonth(), d = hoy.getUTCDate();
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  const mk = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd));
  const p = (periodo || "hoy").toLowerCase();
  if (p.includes("hoy")) {
    const t = iso(hoy);
    return { desde: t, hasta: t, etiqueta: "hoy" };
  }
  if (p.includes("ayer") && !p.includes("antier") && !p.includes("anteayer")) {
    const a = mk(y, m, d - 1);
    return { desde: iso(a), hasta: iso(a), etiqueta: "ayer" };
  }
  // Antier / anteayer = hace 2 días
  if (p.includes("antier") || p.includes("anteayer") || p.includes("ante ayer")) {
    const a = mk(y, m, d - 2);
    return { desde: iso(a), hasta: iso(a), etiqueta: "antier" };
  }
  // "hace N días"
  const haceDias = p.match(/hace\s+(\d+)\s*d[ií]as?/);
  if (haceDias) {
    const n = parseInt(haceDias[1], 10);
    const a = mk(y, m, d - n);
    return { desde: iso(a), hasta: iso(a), etiqueta: `hace ${n} días` };
  }
  if (p.includes("semana")) {
    const ini = mk(y, m, d - 6);
    return { desde: iso(ini), hasta: iso(hoy), etiqueta: "los últimos 7 días" };
  }
  if (p.includes("mes")) {
    // "mes anterior" / "mes pasado" → el mes calendario previo completo
    if (p.includes("anterior") || p.includes("pasado")) {
      const iniAnt = mk(y, m - 1, 1);
      const finAnt = mk(y, m, 0);
      return { desde: iso(iniAnt), hasta: iso(finAnt), etiqueta: "el mes anterior" };
    }
    const ini = mk(y, m, 1);
    return { desde: iso(ini), hasta: iso(hoy), etiqueta: "este mes" };
  }
  // Fecha exacta YYYY-MM-DD (un solo día)
  const fechaISO = p.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (fechaISO) {
    const t = `${fechaISO[1]}-${fechaISO[2]}-${fechaISO[3]}`;
    return { desde: t, hasta: t, etiqueta: t };
  }
  // Fecha DD/MM/YYYY o DD-MM-YYYY (un solo día)
  const fechaDMY = p.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (fechaDMY) {
    const dd = fechaDMY[1].padStart(2, "0"), mm = fechaDMY[2].padStart(2, "0");
    const t = `${fechaDMY[3]}-${mm}-${dd}`;
    return { desde: t, hasta: t, etiqueta: `${dd}/${mm}/${fechaDMY[3]}` };
  }
  // "DD de <mes>" (ej: "15 de junio", "3 de julio de 2026")
  const meses: Record<string, number> = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
    julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  };
  const fechaTexto = p.match(/(\d{1,2})\s+de\s+([a-záéíóú]+)(?:\s+de\s+(\d{4}))?/);
  if (fechaTexto && meses[fechaTexto[2]]) {
    const dd = parseInt(fechaTexto[1], 10);
    const mmes = meses[fechaTexto[2]];
    const anio = fechaTexto[3] ? parseInt(fechaTexto[3], 10) : y;
    const t = iso(mk(anio, mmes - 1, dd));
    return { desde: t, hasta: t, etiqueta: `${dd} de ${fechaTexto[2]}` };
  }
  // Si viene formato YYYY-MM
  const match = p.match(/(\d{4})-(\d{2})/);
  if (match) {
    const anio = Number(match[1]), mes = Number(match[2]);
    const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
    return { desde: `${match[1]}-${match[2]}-01`, hasta: `${match[1]}-${match[2]}-${String(ultimo).padStart(2, "0")}`, etiqueta: `${match[1]}-${match[2]}` };
  }
  const t = iso(hoy);
  return { desde: t, hasta: t, etiqueta: "hoy" };
}

/**
 * Resumen de diferencias de caja (faltantes/sobrantes) en un rango de fechas.
 * Se alimenta de los cierres de caja de 365 capturados en `diferencias_caja`.
 * Solo se guardan los cierres CON diferencia, así que si no hay filas es que
 * todas las cajas cuadraron. Tolerante: si la tabla aún no existe, devuelve null.
 */
async function diferenciasCajaPeriodo(desde: string, hasta: string, sucursal?: string) {
  const db = await getDb();
  if (!db) return null;
  try {
    const filtroSuc = sucursal ? sql` AND sucursal LIKE ${"%" + sucursal + "%"}` : sql``;
    const r = rows(await db.execute(sql`
      SELECT COALESCE(SUM(saldoFaltante),0) AS falt, COALESCE(SUM(saldoSobrante),0) AS sobr, COUNT(*) AS n
      FROM diferencias_caja
      WHERE DATE(fechaCierre) >= ${desde} AND DATE(fechaCierre) <= ${hasta}${filtroSuc}
    `));
    const d = r[0] || {};
    const falt = num(d.falt), sobr = num(d.sobr), n = num(d.n);
    if (n === 0) {
      return { _faltNum: 0, _sobrNum: 0, mensaje: "Todas las cajas cuadraron (sin faltantes ni sobrantes).", faltante: "Bs 0.00", sobrante: "Bs 0.00", cierresConDiferencia: 0 };
    }
    // Detalle por caja para poder señalar dónde ocurrió
    const det = rows(await db.execute(sql`
      SELECT sucursal, usuario, fechaCierre, saldoFaltante, saldoSobrante
      FROM diferencias_caja
      WHERE DATE(fechaCierre) >= ${desde} AND DATE(fechaCierre) <= ${hasta}${filtroSuc}
      ORDER BY fechaCierre DESC LIMIT 20
    `));
    return {
      _faltNum: falt, _sobrNum: sobr,
      faltante: `Bs ${fmtBs(falt)}`,
      sobrante: `Bs ${fmtBs(sobr)}`,
      neto: `Bs ${fmtBs(sobr - falt)}`, // + sobró / − faltó
      cierresConDiferencia: n,
      detalle: det.map((c: any) => ({
        sucursal: c.sucursal,
        vendedor: c.usuario,
        cierre: String(c.fechaCierre).slice(0, 16),
        faltó: `Bs ${fmtBs(c.saldoFaltante)}`,
        sobró: `Bs ${fmtBs(c.saldoSobrante)}`,
      })),
    };
  } catch {
    return null; // la tabla puede no existir todavía
  }
}

export const asistenteTools = {
  // 1. Cuánto vendí en un período
  async ventasPeriodo(periodo: string, sucursal?: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const { desde, hasta, etiqueta } = rangoFechas(periodo);
    const filtroSuc = filtroLike("nombreSucursal", sucursal);
    const r = rows(await db.execute(sql`
      SELECT COUNT(*) as numVentas, COALESCE(SUM(total),0) as total
       FROM ventas WHERE fecha >= ${desde} AND fecha <= ${hasta} ${filtroSuc}${FILTRO_NO_ANULADA}
    `));
    const data = r[0] || { numVentas: 0, total: 0 };
    const resultado: any = {
      periodo: etiqueta,
      sucursal: sucursal || "todas las sucursales",
      numeroVentas: num(data.numVentas),
      totalVendido: `Bs ${fmtBs(data.total)}`,
    };
    // Si NO se filtró por sucursal, incluir el desglose por sucursal en la MISMA
    // respuesta (así el modelo no necesita hacer varias llamadas).
    if (!sucursal) {
      const porSuc = rows(await db.execute(sql`
        SELECT nombreSucursal, COUNT(*) as numVentas, COALESCE(SUM(total),0) as total
         FROM ventas WHERE fecha >= ${desde} AND fecha <= ${hasta} AND nombreSucursal IS NOT NULL${FILTRO_NO_ANULADA}
         GROUP BY nombreSucursal ORDER BY total DESC
      `));
      resultado.porSucursal = porSuc.map((s: any) => ({
        sucursal: s.nombreSucursal,
        ventas: num(s.numVentas),
        total: `Bs ${fmtBs(s.total)}`,
      }));
    }
    // Diferencias de caja del mismo período (faltantes/sobrantes de los cierres).
    // Complementan la venta: el sistema dice X, pero el efectivo real pudo diferir.
    const dif = await diferenciasCajaPeriodo(desde, hasta, sucursal);
    if (dif) {
      const { _faltNum, _sobrNum, ...difPublico } = dif as any;
      resultado.diferenciasCaja = difPublico;
      // DOS NÚMEROS: lo registrado por el sistema vs el dinero realmente recibido.
      // La venta física/efectiva = venta del sistema + sobrantes de caja (dinero
      // que entró de más, típicamente producto vendido sin registrar).
      const ventaSistema = num(data.total);
      resultado.ventaSistema = `Bs ${fmtBs(ventaSistema)}`;
      resultado.ventaFisicaEfectivo = `Bs ${fmtBs(ventaSistema + (_sobrNum ?? 0))}`;
      resultado.notaDosNumeros = "ventaSistema = lo registrado; ventaFisicaEfectivo = sistema + sobrantes de caja (dinero real recibido).";
    }
    return resultado;
  },

  // 1b. Faltantes y sobrantes de caja en un período (cierres de turno)
  async diferenciasCaja(periodo: string, sucursal?: string) {
    const { desde, hasta, etiqueta } = rangoFechas(periodo || "mes");
    const dif = await diferenciasCajaPeriodo(desde, hasta, sucursal);
    if (!dif) return { error: "No hay datos de cierres de caja todavía." };
    return { periodo: etiqueta, sucursal: sucursal || "todas las sucursales", ...dif };
  },

  // 2. Productos por agotarse (stock bajo)
  // NOTA: el cache local no guarda stock. Esta función informa esa limitación
  // de forma honesta en vez de inventar datos.
  async productosPorAgotarse(limite = 15) {
    return {
      mensaje: "El stock en tiempo real no está disponible localmente. El sistema guarda precios y costos de los productos, pero el stock se consulta directamente en inventarios365. Para ver productos por agotarse, te recomiendo revisar el módulo de inventario.",
      disponible: false,
    };
  },

  // 3. Cuánto le compré a un proveedor en un período
  async comprasProveedor(proveedor: string, periodo: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const { desde, hasta, etiqueta } = rangoFechas(periodo || "mes");
    const r = rows(await db.execute(sql`
      SELECT COUNT(*) as n, COALESCE(SUM(totalAmount),0) as total FROM purchases
       WHERE status='completed' AND supplier LIKE ${"%" + proveedor + "%"}
       AND createdAt >= ${desde + " 00:00:00"} AND createdAt <= ${hasta + " 23:59:59"}
    `));
    const data = r[0] || { n: 0, total: 0 };
    return {
      proveedor, periodo: etiqueta,
      numeroCompras: num(data.n),
      totalComprado: `Bs ${fmtBs(data.total)}`,
    };
  },

  // 4. Producto más vendido en un período
  async productoMasVendido(periodo: string, porValor = false) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const { desde, hasta, etiqueta } = rangoFechas(periodo || "mes");
    const orden = sql.raw(porValor ? "SUM(subtotal)" : "SUM(cantidad)");
    const r = rows(await db.execute(sql`
      SELECT articuloNombre, SUM(cantidad) as cant, SUM(subtotal) as valor
       FROM ventas_detalle WHERE fecha >= ${desde} AND fecha <= ${hasta}
       AND articuloNombre NOT LIKE '%venta menor%'
       GROUP BY articuloNombre ORDER BY ${orden} DESC LIMIT 5
    `));
    if (r.length === 0) return { mensaje: `No hay ventas registradas en ${etiqueta}.` };
    return {
      periodo: etiqueta,
      criterio: porValor ? "por valor (Bs)" : "por cantidad",
      ranking: r.map((p: any, i: number) => ({
        puesto: i + 1, producto: p.articuloNombre,
        unidades: num(p.cant), valor: `Bs ${fmtBs(p.valor)}`,
      })),
    };
  },

  // 5. Cuánto gané en un período (ingresos - costo de productos)
  async gananciaPeriodo(periodo: string, sucursal?: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const { desde, hasta, etiqueta } = rangoFechas(periodo || "mes");
    const anioMes = desde.slice(0, 7); // YYYY-MM para gastos
    const filtroSuc = filtroLike("nombreSucursal", sucursal);
    const filtroSucD = filtroLike("d.nombreSucursal", sucursal);

    const rIngreso = rows(await db.execute(sql`
      SELECT COALESCE(SUM(total),0) as ingreso FROM ventas WHERE fecha >= ${desde} AND fecha <= ${hasta} ${filtroSuc}${FILTRO_NO_ANULADA}
    `));
    const rCosto = rows(await db.execute(sql`
      SELECT COALESCE(SUM(d.cantidad * c.precioCostoUnid),0) as costo
       FROM ventas_detalle d JOIN productos_cache c ON c.nombre = d.articuloNombre
       WHERE d.fecha >= ${desde} AND d.fecha <= ${hasta} AND c.precioCostoUnid > 0 ${filtroSucD}
    `));
    // COBERTURA de costo: qué parte de lo vendido tiene costo conocido. Si es baja,
    // la ganancia bruta está sobreestimada y hay que avisarlo (confiabilidad).
    const rCobertura = rows(await db.execute(sql`
      SELECT
         COALESCE(SUM(d.subtotal),0) as ventaTotal,
         COALESCE(SUM(CASE WHEN c.precioCostoUnid > 0 THEN d.subtotal ELSE 0 END),0) as ventaConCosto
       FROM ventas_detalle d LEFT JOIN productos_cache c ON c.nombre = d.articuloNombre
       WHERE d.fecha >= ${desde} AND d.fecha <= ${hasta} ${filtroSucD}
    `));
    const ventaTotal = num(rCobertura[0]?.ventaTotal);
    const ventaConCosto = num(rCobertura[0]?.ventaConCosto);
    const cobertura = ventaTotal > 0 ? Math.round((ventaConCosto / ventaTotal) * 100) : 0;
    // Gastos del mes. Si se filtra por sucursal, sumar SOLO los gastos de esa
    // sucursal (alquiler, sueldos, etc. que se registraron con sucursal). Si no,
    // sumar todos.
    const filtroGasto = filtroLike("sucursal", sucursal);
    const rGastos = rows(await db.execute(sql`
      SELECT COALESCE(SUM(monto),0) as gastos FROM gastos_registro WHERE anioMes = ${anioMes} ${filtroGasto}
    `));

    const ingreso = num(rIngreso[0]?.ingreso);
    const costo = num(rCosto[0]?.costo);
    const gastos = num(rGastos[0]?.gastos);
    const gananciaBruta = ingreso - costo;
    const gananciaNeta = gananciaBruta - gastos;

    const resultado: any = {
      periodo: etiqueta,
      sucursal: sucursal || "todas las sucursales",
      ingresos: `Bs ${fmtBs(ingreso)}`,
      costoProductos: `Bs ${fmtBs(costo)}`,
      gananciaBruta: `Bs ${fmtBs(gananciaBruta)}`,
      gastosDelMes: `Bs ${fmtBs(gastos)}`,
      gananciaNeta: `Bs ${fmtBs(gananciaNeta)}`,
      coberturaCosto: `${cobertura}%`,
      advertenciaConfiabilidad: cobertura < 90
        ? `ATENCIÓN: solo el ${cobertura}% de lo vendido tiene costo conocido. El costo real es mayor y la ganancia real es MENOR a la mostrada. Actualiza los costos de los productos faltantes para cifras confiables.`
        : null,
      instruccionEstricta: `Al final de tu respuesta incluye SIEMPRE una línea de confiabilidad: "Confiabilidad: ${cobertura}% de lo vendido tiene costo conocido${cobertura < 90 ? " — la ganancia real es menor a la mostrada" : ""}."`,
      nota: sucursal
        ? "Ganancia neta de la sucursal = ingresos - costo - gastos asignados a esta sucursal (alquiler, sueldos, etc.). Los gastos generales sin sucursal no se incluyen aquí."
        : "Ganancia neta = ventas - costo de productos - todos los gastos del mes. El costo solo cuenta productos con costo conocido.",
    };
    return resultado;
  },

  // 6. Precio y stock de un producto. incluirCodigo=true solo si el usuario pidió
  // explícitamente el código del producto (por defecto no se muestra).
  async infoProducto(nombre: string, incluirCodigo?: boolean) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const cond = condPalabras("nombre", nombre);
    // Primero contar cuántos coinciden
    const cont = rows(await db.execute(sql`
      SELECT COUNT(*) as n FROM productos_cache WHERE ${cond}
    `));
    const total = num(cont[0]?.n);

    if (total === 0) {
      return { mensaje: `No encontré ningún producto que coincida con "${nombre}".` };
    }

    // Si hay demasiados (más de 10), pedir que afine la búsqueda
    if (total > 10) {
      const muestra = rows(await db.execute(sql`
        SELECT nombre FROM productos_cache WHERE ${cond} ORDER BY nombre LIMIT 6
      `));
      return {
        demasiadosResultados: true,
        cantidad: total,
        mensaje: `Encontré ${total} productos que coinciden con "${nombre}". Es demasiado para listar. ¿Podrías darme el nombre más específico? Por ejemplo, algunos son: ${muestra.map((p: any) => p.nombre).join(", ")}.`,
      };
    }

    const r = rows(await db.execute(sql`
      SELECT nombre, codigo, precioUno, precioCostoUnid, nombreProveedor
       FROM productos_cache WHERE ${cond} ORDER BY nombre LIMIT 10
    `));

    // Si hay entre 4 y 10, mostrar lista resumida y pedir cuál si quiere detalle
    if (total > 3) {
      return {
        variasPresentaciones: true,
        cantidad: total,
        productos: r.map((p: any) => ({
          nombre: p.nombre,
          precioVenta: `Bs ${fmtBs(p.precioUno)}`,
        })),
        mensaje: `Hay ${total} presentaciones que coinciden con "${nombre}". Aquí están con su precio. Si quieres el detalle completo (costo, proveedor) de una, dime cuál.`,
      };
    }

    // 1-3 coincidencias: detalle completo, con el precio VERIFICADO contra 365.
    // El precio es un dato delicado: no se responde desde el cache local sin
    // comprobarlo. (Caso real: 365 tenía 112.5 y el cache 108 — el cache llevaba
    // días sin refrescar y el asistente afirmaba el precio viejo como si fuera
    // cierto.) Una consulta puntual de precio justifica una llamada a 365.
    let preciosReales = new Map<string, number>();
    let fuente = "cache local";
    try {
      const { inventarios365 } = await import("./inventarios365");
      const catalogo = await inventarios365.listarTodosArticulos(); // 1 sola llamada
      if (catalogo.length > 0) {
        preciosReales = new Map(catalogo.map((a: any) => [String(a.nombre), parseFloat(String(a.precio_uno || 0)) || 0]));
        fuente = "inventarios365 (en vivo)";
      }
    } catch { /* si 365 no responde, se usa el cache y se declara su antigüedad */ }

    const { productosCache } = await import("./productos-cache");
    const edad = await productosCache.edadMinutos();
    const desactualizado = fuente === "cache local" && edad != null && edad > 120;

    return {
      productos: r.map((p: any) => {
        const real = preciosReales.get(String(p.nombre));
        const precio = real != null && real > 0 ? real : Number(p.precioUno);
        return {
          nombre: p.nombre, ...(incluirCodigo ? { codigo: p.codigo } : {}),
          precioVenta: `Bs ${fmtBs(precio)}`,
          precioCosto: `Bs ${fmtBs(p.precioCostoUnid)}`,
          proveedor: p.nombreProveedor || "no especificado",
        };
      }),
      fuentePrecio: fuente,
      ...(desactualizado ? { advertencia: `⚠ No se pudo consultar inventarios365; este precio sale de una copia local de hace ${edad} minutos y puede estar desactualizado. Verifícalo en 365 antes de cobrarlo.` } : {}),
      nota: "El stock en tiempo real se consulta en inventarios365, no está en estos datos.",
    };
  },

  // 7. Productos vendidos a un cliente
  async ventasCliente(cliente: string, periodo?: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const { desde, hasta, etiqueta } = periodo ? rangoFechas(periodo) : { desde: "2000-01-01", hasta: "2099-12-31", etiqueta: "todo el historial" };
    const r = rows(await db.execute(sql`
      SELECT d.articuloNombre, SUM(d.cantidad) as cant, SUM(d.subtotal) as valor
       FROM ventas_detalle d JOIN ventas v ON v.id = d.ventaId
       WHERE v.razonSocialCliente LIKE ${"%" + cliente + "%"}
       AND d.fecha >= ${desde} AND d.fecha <= ${hasta}
       GROUP BY d.articuloNombre ORDER BY cant DESC LIMIT 20
    `));
    if (r.length === 0) return { mensaje: `No encontré ventas al cliente "${cliente}" en ${etiqueta}.` };
    return {
      cliente, periodo: etiqueta,
      productos: r.map((p: any) => ({ producto: p.articuloNombre, unidades: num(p.cant), valor: `Bs ${fmtBs(p.valor)}` })),
    };
  },

  // Mejores vendedores en un período (por total vendido)
  async mejoresVendedores(periodo: string, sucursal?: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const { desde, hasta, etiqueta } = rangoFechas(periodo || "mes");
    const filtroSuc = filtroLike("nombreSucursal", sucursal);
    const r = rows(await db.execute(sql`
      SELECT vendedor, COUNT(*) as numVentas, COALESCE(SUM(total),0) as total
       FROM ventas WHERE fecha >= ${desde} AND fecha <= ${hasta} ${filtroSuc}
       AND vendedor IS NOT NULL AND vendedor <> ''
       GROUP BY vendedor ORDER BY total DESC LIMIT 5
    `));
    if (r.length === 0) return { mensaje: `No hay ventas con vendedor registrado en ${etiqueta}.` };
    return {
      periodo: etiqueta,
      sucursal: sucursal || "todas las sucursales",
      ranking: r.map((v: any, i: number) => ({
        puesto: i + 1, vendedor: v.vendedor,
        ventas: num(v.numVentas), total: `Bs ${fmtBs(v.total)}`,
      })),
    };
  },

  // 8. Quién está en una sucursal (trabajadores con sucursalFija)
  async trabajadoresSucursal(sucursal: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const s = sucursal.toLowerCase();
    // 1) Buscar por sucursalFija (case-insensitive)
    const r = rows(await db.execute(sql`
      SELECT nombre, sucursalFija, tipoTrabajador FROM trabajadores
       WHERE activo=1 AND LOWER(sucursalFija) LIKE ${"%" + s + "%"}
    `));
    if (r.length > 0) {
      return { sucursal, trabajadores: r.map((t: any) => ({ nombre: t.nombre, tipo: t.tipoTrabajador })) };
    }
    // 2) Respaldo: inferir por las ventas (qué vendedores vendieron en esa sucursal últimamente)
    const vend = rows(await db.execute(sql`
      SELECT DISTINCT vendedor FROM ventas
       WHERE LOWER(nombreSucursal) LIKE ${"%" + s + "%"} AND vendedor IS NOT NULL AND vendedor <> ''
       ORDER BY vendedor LIMIT 20
    `));
    if (vend.length > 0) {
      return {
        sucursal,
        nota: "No hay trabajadores con sucursal fija asignada, pero estos vendedores han registrado ventas en esa sucursal:",
        vendedores: vend.map((v: any) => v.vendedor),
      };
    }
    return { mensaje: `No encontré trabajadores ni vendedores asociados a la sucursal "${sucursal}". Verifica el nombre o que tengan sucursal asignada.` };
  },

  // 9. Lista de sucursales disponibles (apoyo)
  async listarSucursales() {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const r = rows(await db.execute(sql`SELECT DISTINCT nombreSucursal FROM ventas WHERE nombreSucursal IS NOT NULL`));
    return { sucursales: r.map((s: any) => s.nombreSucursal) };
  },

  // 10. Stock de un producto por ALMACÉN, consultando inventarios365 EN VIVO
  async stockProducto(nombre: string, almacen?: string) {
    try {
      const { inventarios365 } = await import("./inventarios365");
      // Almacenes conocidos (id → nombre legible)
      const ALMACENES: { id: number; nombre: string; alias: string[] }[] = [
        { id: 1, nombre: "Almacén Principal", alias: ["principal", "matriz", "casa matriz", "honduras", "central"] },
        { id: 2, nombre: "Almacén Petrolera", alias: ["petrolera"] },
        { id: 3, nombre: "Almacén Lanza", alias: ["lanza"] },
        { id: 4, nombre: "Almacén Cobol", alias: ["cobol", "cob"] },
      ];

      // Si se pidió un almacén específico, filtrar a ese
      let almacenesConsultar = ALMACENES;
      if (almacen) {
        const a = almacen.toLowerCase();
        const encontrado = ALMACENES.filter(al =>
          al.nombre.toLowerCase().includes(a) || al.alias.some(x => a.includes(x) || x.includes(a))
        );
        if (encontrado.length > 0) almacenesConsultar = encontrado;
      }

      const palabras = nombre.toLowerCase().trim().split(/\s+/).filter(Boolean);
      const resultadoPorAlmacen: any[] = [];
      let productoNombre = "";

      for (const al of almacenesConsultar) {
        // Cache de stock: rápido si hay snapshot fresco; si 365 falla, responde del
        // último snapshot con su antigüedad — el asistente nunca queda mudo.
        const { obtenerStockAlmacen, textoAntiguedad } = await import("./stock-cache");
        const r = await obtenerStockAlmacen(al.id, { ttlSeg: 180, fallbackCache: true });
        const lista = r.lista;
        const notaCache = r.desdeCache && (r.antiguedadSeg ?? 0) > 300 ? ` (dato de ${textoAntiguedad(r.antiguedadSeg)}, sin conexión fresca a 365)` : "";
        // Filtrar productos que coincidan con todas las palabras
        const matches = lista.filter((p: any) => {
          const texto = `${p.nombre} ${p.codigo || ""}`.toLowerCase();
          return palabras.every(w => texto.includes(w));
        });
        if (matches.length > 0) {
          // Si hay varios productos distintos que coinciden, tomar nota
          for (const m of matches.slice(0, 3)) {
            productoNombre = m.nombre;
            resultadoPorAlmacen.push({ almacen: al.nombre + notaCache, producto: m.nombre, stock: m.stock });
          }
        }
      }

      if (resultadoPorAlmacen.length === 0) {
        return { mensaje: `No encontré stock para "${nombre}"${almacen ? ` en ${almacen}` : ""}. Verifica el nombre del producto.` };
      }

      // Si es un solo producto, resumir por almacén
      const total = resultadoPorAlmacen.reduce((s, r) => s + num(r.stock), 0);
      return {
        enVivo: true,
        producto: productoNombre,
        stockPorAlmacen: resultadoPorAlmacen,
        stockTotal: total,
        nota: "Stock consultado en tiempo real desde inventarios365.",
      };
    } catch (e: any) {
      return { error: `No pude consultar el stock en vivo: ${e?.message || "error"}` };
    }
  },

  // 11. Quién tiene caja abierta AHORA (en vivo desde 365)
  async cajasAbiertas() {
    try {
      const { inventarios365 } = await import("./inventarios365");
      const cajas = await inventarios365.cajasAbiertas();
      if (!cajas || cajas.length === 0) {
        return { mensaje: "No hay cajas abiertas en este momento." };
      }
      return {
        enVivo: true,
        cajasAbiertas: cajas.map((c: any) => ({
          usuario: c.nombreUsuario ?? c.nombre_usuario ?? c.usuario ?? c.nombre ?? `usuario ${c.idusuario ?? "?"}`,
          sucursal: c.nombreSucursal ?? c.nombre_sucursal ?? c.sucursal ?? c.almacen ?? "no especificada",
          apertura: c.fechaApertura ?? c.fecha_apertura ?? "",
        })),
        nota: "Cajas abiertas consultadas en tiempo real desde inventarios365.",
      };
    } catch (e: any) {
      return { error: `No pude consultar las cajas abiertas: ${e?.message || "error"}` };
    }
  },

  // 12. Historial de compra de un producto: precio más bajo y última compra
  async historialCompraProducto(nombre: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const cond = condPalabras("i.productName", nombre);
    const r = rows(await db.execute(sql`
      SELECT i.productName, i.unitCost, p.supplier, p.createdAt
       FROM purchase_items i JOIN purchases p ON p.id = i.purchaseId
       WHERE ${cond} AND p.status='completed' AND i.unitCost > 0
       ORDER BY p.createdAt DESC
    `));
    if (r.length === 0) {
      return { mensaje: `No encontré compras registradas del producto "${nombre}".` };
    }
    // Última compra (la más reciente, primera por el ORDER BY DESC)
    const ultima = r[0];
    // Precio más bajo
    let masBaja = r[0];
    for (const c of r) { if (num(c.unitCost) < num(masBaja.unitCost)) masBaja = c; }
    const ultimaEsMasBaja = num(ultima.unitCost) <= num(masBaja.unitCost);
    const fechaStr = (d: any) => { try { return new Date(d).toLocaleDateString("es-BO"); } catch { return String(d); } };
    return {
      producto: ultima.productName,
      numeroCompras: r.length,
      ultimaCompra: {
        costo: `Bs ${fmtBs(ultima.unitCost)}`,
        proveedor: ultima.supplier || "no especificado",
        fecha: fechaStr(ultima.createdAt),
      },
      precioMasBajo: {
        costo: `Bs ${fmtBs(masBaja.unitCost)}`,
        proveedor: masBaja.supplier || "no especificado",
        fecha: fechaStr(masBaja.createdAt),
      },
      ultimaEsLaMasBaja: ultimaEsMasBaja,
      nota: ultimaEsMasBaja
        ? "Tu última compra fue al precio más bajo registrado."
        : "Tu última compra NO fue la más baja; hubo un precio menor antes.",
    };
  },

  // 13. Rentabilidad por sucursal COMPLETA (ingresos, costo, sueldos por
  // asistencia, gastos, ganancia neta). Mismos números que el reporte.
  async rentabilidadSucursales(periodo: string) {
    // Por defecto: ÚLTIMO MES CONCLUIDO (no el actual, que daría números parciales).
    // Si el usuario pide un mes específico (YYYY-MM) o "mes anterior", se respeta.
    let anioMes: string;
    const p = (periodo || "").toLowerCase();
    const matchMes = p.match(/(\d{4})-(\d{2})/);
    if (matchMes) {
      anioMes = `${matchMes[1]}-${matchMes[2]}`;
    } else if (p.includes("este mes") || p.includes("mes actual") || p.includes("actual")) {
      // Si explícitamente pide el mes en curso, se lo damos (parcial)
      anioMes = ahoraBolivia().toISOString().slice(0, 7);
    } else {
      // Default y "mes pasado/anterior": último mes concluido
      const hoy = ahoraBolivia();
      const ant = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1));
      anioMes = ant.toISOString().slice(0, 7);
    }
    const { calcularRentabilidadPorSucursal } = await import("./rentabilidad");
    const r = await calcularRentabilidadPorSucursal(anioMes);
    if (r.error) return { error: r.error };
    if (!r.sucursales || r.sucursales.length === 0) {
      return { mensaje: `No hay datos de rentabilidad para ${anioMes}.` };
    }
    return {
      mes: anioMes,
      sucursales: r.sucursales.map((s) => ({
        sucursal: s.sucursal,
        ingresos: `Bs ${fmtBs(s.ingreso)}`,
        costoProductos: `Bs ${fmtBs(s.costo)}`,
        sueldos: `Bs ${fmtBs(s.sueldos)}`,
        gastos: `Bs ${fmtBs(s.gastos)}`,
        gananciaNeta: `Bs ${fmtBs(s.netaAntesGenerales)}`,
        cubreGastos: s.cubreGastos,
        coberturaCosto: s.coberturaCosto != null ? `${s.coberturaCosto}%` : undefined,
      })),
      gastosGenerales: `Bs ${fmtBs(r.gastosGenerales)}`,
      gastosNoCancelados: r.gastosNoCancelados,
      nota: r.nota + " (Mes concluido por defecto.)",
    };
  },

  // 14. Estado de pagos de gastos: qué se pagó y qué falta, por sucursal
  async estadoPagosGastos(periodo?: string, sucursal?: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    // Por defecto el mes actual (los pagos pendientes son del mes en curso)
    const anioMes = (() => {
      const m = (periodo || "").match(/(\d{4})-(\d{2})/);
      if (m) return `${m[1]}-${m[2]}`;
      if ((periodo || "").includes("anterior") || (periodo || "").includes("pasado")) {
        const h = ahoraBolivia(); const a = new Date(Date.UTC(h.getUTCFullYear(), h.getUTCMonth() - 1, 1));
        return a.toISOString().slice(0, 7);
      }
      return ahoraBolivia().toISOString().slice(0, 7);
    })();
    const filtroSuc = filtroLike("sucursal", sucursal);
    const r = rows(await db.execute(sql`
      SELECT nombre, categoria, monto, pagado, sucursal FROM gastos_registro
       WHERE anioMes = ${anioMes} ${filtroSuc}
       ORDER BY pagado ASC, sucursal, monto DESC
    `));
    if (r.length === 0) {
      return { mensaje: `No hay gastos registrados para ${anioMes}${sucursal ? " en " + sucursal : ""}.` };
    }
    const pagados = r.filter((g: any) => num(g.pagado) === 1);
    const pendientes = r.filter((g: any) => num(g.pagado) !== 1);
    const sumar = (arr: any[]) => arr.reduce((t, g) => t + num(g.monto), 0);
    return {
      mes: anioMes,
      sucursal: sucursal || "todas",
      pendientesDePago: pendientes.map((g: any) => ({
        nombre: g.nombre, categoria: g.categoria,
        monto: `Bs ${fmtBs(g.monto)}`, sucursal: g.sucursal || "general",
      })),
      totalPendiente: `Bs ${fmtBs(sumar(pendientes))}`,
      yaPagados: pagados.map((g: any) => ({
        nombre: g.nombre, monto: `Bs ${fmtBs(g.monto)}`, sucursal: g.sucursal || "general",
      })),
      totalPagado: `Bs ${fmtBs(sumar(pagados))}`,
      nota: "Los sueldos calculados por asistencia no están aquí; esto cubre los gastos del módulo de gastos (alquiler, luz, internet, etc.).",
    };
  },

  // 15. Productos urgentes de reponer: alta rotación (último mes concluido) + poco stock.
  // Opcional por proveedor y por sucursal.
  async productosUrgentes(proveedor?: string, sucursal?: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    // Rotación del último mes CONCLUIDO
    const hoy = ahoraBolivia();
    const ini = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1));
    const fin = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 0));
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const desde = iso(ini), hasta = iso(fin);
    const etiquetaMes = `${ini.getFullYear()}-${String(ini.getMonth() + 1).padStart(2, "0")}`;

    const filtroSuc = filtroLike("nombreSucursal", sucursal);
    // Top productos por cantidad vendida en el mes
    const ventas = rows(await db.execute(sql`
      SELECT articuloNombre, SUM(cantidad) as vendido
       FROM ventas_detalle WHERE fecha >= ${desde} AND fecha <= ${hasta} ${filtroSuc}
       AND articuloNombre NOT LIKE '%venta menor%' AND articuloNombre NOT LIKE '%ventas menores%'
       GROUP BY articuloNombre HAVING vendido > 0 ORDER BY vendido DESC LIMIT 40
    `));
    if (ventas.length === 0) {
      return { mensaje: `No hay ventas en el mes ${etiquetaMes}${sucursal ? " en " + sucursal : ""}.` };
    }

    // Stock en vivo desde 365 (filtrado por proveedor si se indicó)
    let articulos: any[] = [];
    try {
      const { inventarios365 } = await import("./inventarios365");
      let idProv = "";
      if (proveedor) {
        // Buscar idProveedor por nombre en el cache
        const pr = rows(await db.execute(sql`
          SELECT DISTINCT idProveedor, nombreProveedor FROM productos_cache
           WHERE nombreProveedor LIKE ${"%" + proveedor + "%"} AND idProveedor IS NOT NULL LIMIT 1
        `));
        if (pr[0]?.idProveedor) idProv = String(pr[0].idProveedor);
      }
      // Si se filtra por sucursal, usar el stock del ALMACÉN de esa sucursal
      // (stock por almacén). Si no, el stock total.
      const ALMACENES: Record<string, number> = { petrolera: 2, lanza: 3, cobol: 4, matriz: 1, principal: 1, honduras: 1, central: 1 };
      let idAlmacen: number | null = null;
      if (sucursal) {
        const s = sucursal.toLowerCase();
        for (const k of Object.keys(ALMACENES)) { if (s.includes(k)) { idAlmacen = ALMACENES[k]; break; } }
      }
      if (idAlmacen) {
        // Stock real del almacén de la sucursal
        const inv = await inventarios365.listarParaInventario(idAlmacen, idProv);
        articulos = inv.map((a: any) => ({ nombre: a.nombre, stock: a.stock, nombre_proveedor: a.proveedor }));
      } else {
        articulos = await inventarios365.listarArticulos("", idProv);
      }
    } catch (e: any) {
      return { error: `No pude consultar stock en 365: ${e?.message || "error"}` };
    }

    // Mapa de stock por nombre normalizado
    const norm = (s: string) => String(s || "").trim().toLowerCase();
    const stockPorNombre: Record<string, number> = {};
    const provPorNombre: Record<string, string> = {};
    for (const a of articulos) {
      stockPorNombre[norm(a.nombre)] = Number(a.stock) || 0;
      provPorNombre[norm(a.nombre)] = a.nombre_proveedor || "";
    }

    // Cruzar: urgente = alta rotación + poco stock. Si se filtró proveedor,
    // solo incluir productos de ese proveedor (los que están en la lista de 365).
    const UMBRAL_STOCK_BAJO = 10;
    const urgentes: any[] = [];
    for (const v of ventas) {
      const nombreN = norm(v.articuloNombre);
      const stock = stockPorNombre[nombreN];
      // Si filtramos por proveedor, omitir los que no están en la lista de ese proveedor
      if (proveedor && stock === undefined) continue;
      const stockNum = stock ?? null;
      const vendido = num(v.vendido);
      // Urgente si stock conocido y bajo respecto a lo que se vendió
      if (stockNum !== null && stockNum <= UMBRAL_STOCK_BAJO && vendido >= 3) {
        urgentes.push({
          producto: v.articuloNombre,
          vendidoEnElMes: vendido,
          stockActual: stockNum,
          proveedor: provPorNombre[nombreN] || undefined,
        });
      }
    }
    urgentes.sort((a, b) => (b.vendidoEnElMes / (a.stockActual + 1)) - (a.vendidoEnElMes / (b.stockActual + 1)));

    if (urgentes.length === 0) {
      return { mensaje: `No encontré productos urgentes de reponer (${etiquetaMes})${proveedor ? " del proveedor " + proveedor : ""}${sucursal ? " en " + sucursal : ""}. O bien hay stock suficiente, o no coinciden los nombres con 365.` };
    }
    return {
      mesRotacion: etiquetaMes,
      proveedor: proveedor || "todos",
      sucursal: sucursal || "todas (rotación global)",
      criterio: "Alta venta el mes pasado y stock actual bajo (≤10).",
      urgentes: urgentes.slice(0, 20),
      nota: sucursal ? "Rotación y stock son de la sucursal/almacén indicado." : "Rotación y stock totales (todas las sucursales).",
    };
  },

  // 16. PEDIDO de una sucursal según proveedor: usa índice de cobertura.
  // Rotación = promedio de últimos 3 meses concluidos. Entra al pedido si el stock
  // no cubre 1 mes de venta. Cantidad sugerida = rotación mensual - stock actual.
  async pedidoSucursal(sucursal?: string, proveedor?: string, dias?: number) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    // Cobertura objetivo en DÍAS (default 10: la farmacia repone cada ~10 días).
    const diasCobertura = Math.min(90, Math.max(1, Math.round(num(dias) || 10)));

    // Rango: últimos 3 meses CONCLUIDOS (no el mes actual)
    const hoy = ahoraBolivia();
    const finMesAnterior = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 0)); // último día del mes pasado
    const ini3Meses = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 3, 1));
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const desde = iso(ini3Meses), hasta = iso(finMesAnterior);

    // Nombre EXACTO de la sucursal en ventas: "matriz" con LIKE también arrastraría
    // "Casa Matriz Cobol", así que se mapea la palabra del usuario al nombre real.
    const sucExacta = (() => {
      if (!sucursal) return null;
      const s = sucursal.toLowerCase();
      if (s.includes("petrolera")) return "Sucursal Petrolera";
      if (s.includes("lanza")) return "Sucursal Lanza";
      if (s.includes("cobol")) return "Casa Matriz Cobol";
      if (s.includes("matriz") || s.includes("honduras") || s.includes("central") || s.includes("principal")) return "Casa Matriz";
      return sucursal; // desconocido: se intenta tal cual
    })();
    const filtroSuc = sucExacta ? sql` AND nombreSucursal = ${sucExacta}` : sql``;
    const ventas = rows(await db.execute(sql`
      SELECT articuloNombre, SUM(cantidad) as total3m, COUNT(DISTINCT DATE_FORMAT(fecha, '%Y-%m')) as mesesConVenta
       FROM ventas_detalle WHERE fecha >= ${desde} AND fecha <= ${hasta} ${filtroSuc}
       AND articuloNombre NOT LIKE '%venta menor%' AND articuloNombre NOT LIKE '%ventas menores%'
       GROUP BY articuloNombre HAVING total3m > 0
    `));
    if (ventas.length === 0) {
      return { mensaje: `No hay ventas en los últimos 3 meses${sucursal ? " en " + sucursal : ""} para calcular el pedido.` };
    }
    const rotMensual: Record<string, number> = {};
    const norm = (s: string) => String(s || "").trim().toLowerCase();
    // Dividir entre los meses con ventas reales (mín 1, máx 3): un producto nuevo
    // con 1 mes de historia no debe quedar subestimado a un tercio de su rotación.
    for (const v of ventas) {
      const meses = Math.min(3, Math.max(1, num(v.mesesConVenta)));
      rotMensual[norm(v.articuloNombre)] = num(v.total3m) / meses;
    }

    // Stock por almacén de la sucursal (o total si no hay sucursal), filtrado por proveedor
    let articulos: any[] = [];
    try {
      const { inventarios365 } = await import("./inventarios365");
      let idProv = "";
      if (proveedor) {
        const { resolverIdProveedor } = await import("./pedidos");
        idProv = await resolverIdProveedor(proveedor);
      }
      const ALMACENES: Record<string, number> = { petrolera: 2, lanza: 3, cobol: 4, matriz: 1, principal: 1, honduras: 1, central: 1 };
      let idAlmacen: number | null = null;
      if (sucursal) {
        const s = sucursal.toLowerCase();
        for (const k of Object.keys(ALMACENES)) { if (s.includes(k)) { idAlmacen = ALMACENES[k]; break; } }
      }
      if (idAlmacen) {
        const inv = await inventarios365.listarParaInventario(idAlmacen, idProv);
        articulos = inv.map((a: any) => ({ nombre: a.nombre, stock: a.stock, proveedor: a.proveedor }));
      } else {
        const lista = await inventarios365.listarArticulos("", idProv);
        articulos = lista.map((a: any) => ({ nombre: a.nombre, stock: Number(a.stock) || 0, proveedor: a.nombre_proveedor }));
      }
    } catch (e: any) {
      return { error: `No pude consultar stock en 365: ${e?.message || "error"}` };
    }

    // Construir el pedido con rotación DIARIA: venta mensual promedio ÷ 30.
    // Entra si el stock no cubre los días de cobertura pedidos.
    const pedido: any[] = [];
    for (const a of articulos) {
      const rot = rotMensual[norm(a.nombre)];
      if (!rot || rot <= 0) continue; // solo productos que rotan
      const rotDiaria = rot / 30;
      const stockReal = num(a.stock);
      // Stock negativo = descuadre de inventario en 365. Para calcular cuánto pedir
      // lo tratamos como 0 (no inflar el pedido con un dato dudoso), pero avisamos.
      const stock = Math.max(0, stockReal);
      const objetivo = rotDiaria * diasCobertura;
      if (stock < objetivo) {
        const aPedir = Math.ceil(objetivo - stock);
        const coberturaDias = rotDiaria > 0 ? stock / rotDiaria : 0;
        pedido.push({
          producto: a.nombre,
          ventaDiariaProm: Math.round((rot / 30) * 100) / 100,
          ventaMensualProm: Math.round(rot * 10) / 10,
          stockActual: stockReal,
          descuadreInventario: stockReal < 0 ? "Stock negativo en 365: revisar inventario de este producto" : undefined,
          coberturaDias: Math.round(coberturaDias * 10) / 10,
          cantidadSugerida: aPedir,
          proveedor: a.proveedor || undefined,
        });
      }
    }
    // Ordenar por menor cobertura (más crítico primero)
    pedido.sort((a, b) => a.coberturaDias - b.coberturaDias);

    if (pedido.length === 0) {
      return { mensaje: `No hay productos que requieran pedido${proveedor ? " del proveedor " + proveedor : ""}${sucursal ? " en " + sucursal : ""}. El stock cubre ${diasCobertura} días de venta.` };
    }
    const MOSTRAR = 15;
    return {
      sucursal: sucursal || "todas",
      proveedor: proveedor || "todos",
      diasCobertura,
      totalProductosEnPedido: pedido.length,
      mostrando: Math.min(MOSTRAR, pedido.length),
      pedido: pedido.slice(0, MOSTRAR),
      instruccionEstricta: `Muestra EXACTAMENTE estos ${Math.min(MOSTRAR, pedido.length)} productos de la lista 'pedido'. NO agregues ningún producto que no esté en esta lista. NO inventes una segunda tabla. Si hay más de ${MOSTRAR}, solo menciona que hay ${pedido.length} en total y que se puede ver el resto en el módulo de pedidos.`,
      nota: `Pedido para cubrir ${diasCobertura} días de venta. Cobertura (días) = stock ÷ venta diaria promedio (últimos 3 meses concluidos). cantidadSugerida = lo que falta para llegar a ${diasCobertura} días.`,
    };
  },

  // 17. COMPARAR PERÍODOS: crecimiento de ventas entre dos meses (por defecto,
  // los dos últimos meses concluidos). La pregunta gerencial básica.
  async compararPeriodos(mesA?: string, mesB?: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const hoy = ahoraBolivia();
    const mes = (offset: number) => {
      const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - offset, 1));
      return d.toISOString().slice(0, 7);
    };
    // Defaults: mes anterior (concluido) vs el previo. Acepta YYYY-MM explícitos.
    const a = /^\d{4}-\d{2}$/.test(mesA || "") ? mesA! : mes(1);
    const b = /^\d{4}-\d{2}$/.test(mesB || "") ? mesB! : mes(2);
    const datosMes = async (m: string) => {
      const r = rows(await db.execute(sql`
        SELECT COALESCE(SUM(total),0) as total, COUNT(*) as ventas FROM ventas
        WHERE DATE_FORMAT(fecha, '%Y-%m') = ${m}${FILTRO_NO_ANULADA}
      `));
      const porSuc = rows(await db.execute(sql`
        SELECT nombreSucursal, COALESCE(SUM(total),0) as total FROM ventas
        WHERE DATE_FORMAT(fecha, '%Y-%m') = ${m} AND nombreSucursal IS NOT NULL${FILTRO_NO_ANULADA}
        GROUP BY nombreSucursal
      `));
      return { total: num(r[0]?.total), ventas: num(r[0]?.ventas), porSuc };
    };
    const [dA, dB] = await Promise.all([datosMes(a), datosMes(b)]);
    if (dA.total === 0 && dB.total === 0) return { mensaje: `No hay ventas en ${a} ni en ${b}.` };
    const pct = (nuevo: number, viejo: number) =>
      viejo > 0 ? `${nuevo >= viejo ? "+" : ""}${(((nuevo - viejo) / viejo) * 100).toFixed(1)}%` : "sin base";
    const sucB: Record<string, number> = {};
    for (const s of dB.porSuc) sucB[s.nombreSucursal] = num(s.total);
    return {
      mesReciente: a,
      mesAnterior: b,
      ventas: { [a]: `Bs ${fmtBs(dA.total)} (${dA.ventas} ventas)`, [b]: `Bs ${fmtBs(dB.total)} (${dB.ventas} ventas)` },
      crecimiento: pct(dA.total, dB.total),
      porSucursal: dA.porSuc.map((s: any) => ({
        sucursal: s.nombreSucursal,
        [a]: `Bs ${fmtBs(s.total)}`,
        [b]: `Bs ${fmtBs(sucB[s.nombreSucursal] || 0)}`,
        crecimiento: pct(num(s.total), sucB[s.nombreSucursal] || 0),
      })),
      nota: "Comparación de meses calendario completos. Crecimiento = variación % del mes reciente vs el anterior.",
    };
  },

  // 18. PRODUCTOS SIN ROTACIÓN (capital muerto): con stock pero sin ventas en N meses.
  // Dinero inmovilizado que además corre riesgo de vencer.
  async productosSinRotacion(mesesSinVenta?: number, proveedor?: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const meses = Math.min(12, Math.max(1, num(mesesSinVenta) || 3));
    const hoy = ahoraBolivia();
    const corte = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - meses, hoy.getUTCDate()))
      .toISOString().slice(0, 10);
    // Última venta por producto
    const ultimas = rows(await db.execute(sql`
      SELECT articuloNombre, MAX(fecha) as ultimaVenta FROM ventas_detalle
      GROUP BY articuloNombre
    `));
    const ultimaPorNombre: Record<string, string> = {};
    const norm = (s: string) => String(s || "").trim().toLowerCase();
    for (const u of ultimas) ultimaPorNombre[norm(u.articuloNombre)] = String(u.ultimaVenta).slice(0, 10);
    // Stock y costo en vivo desde 365
    let articulos: any[] = [];
    try {
      const { inventarios365 } = await import("./inventarios365");
      let idProv = "";
      if (proveedor) {
        const pr = rows(await db.execute(sql`
          SELECT DISTINCT idProveedor FROM productos_cache
          WHERE nombreProveedor LIKE ${"%" + proveedor + "%"} AND idProveedor IS NOT NULL LIMIT 1
        `));
        if (pr[0]?.idProveedor) idProv = String(pr[0].idProveedor);
      }
      articulos = await inventarios365.listarArticulos("", idProv);
    } catch (e: any) {
      return { error: `No pude consultar stock en 365: ${e?.message || "error"}` };
    }
    const muertos: any[] = [];
    for (const art of articulos) {
      const stock = num(art.stock);
      if (stock <= 0) continue;
      const ultima = ultimaPorNombre[norm(art.nombre)];
      // Sin ventas NUNCA, o última venta antes del corte
      if (!ultima || ultima < corte) {
        const costo = num(art.precio_costo_unid);
        muertos.push({
          producto: art.nombre,
          stock,
          ultimaVenta: ultima || "nunca (sin registro)",
          valorInmovilizado: costo > 0 ? Math.round(stock * costo * 100) / 100 : null,
        });
      }
    }
    muertos.sort((x, y) => (y.valorInmovilizado || 0) - (x.valorInmovilizado || 0));
    const totalInmovilizado = muertos.reduce((t, m) => t + (m.valorInmovilizado || 0), 0);
    if (muertos.length === 0) {
      return { mensaje: `No hay productos con stock sin ventas en los últimos ${meses} meses${proveedor ? " de " + proveedor : ""}.` };
    }
    const MOSTRAR = 15;
    return {
      criterio: `Productos con stock que no se venden hace ${meses}+ meses`,
      totalProductos: muertos.length,
      capitalInmovilizadoTotal: `Bs ${fmtBs(totalInmovilizado)}`,
      productos: muertos.slice(0, MOSTRAR).map(m => ({
        ...m,
        valorInmovilizado: m.valorInmovilizado != null ? `Bs ${fmtBs(m.valorInmovilizado)}` : "sin costo cargado",
      })),
      instruccionEstricta: `Muestra SOLO estos productos de la lista. NO inventes productos. Si hay más de ${MOSTRAR}, menciona que son ${muertos.length} en total.`,
      nota: "Ordenados por valor inmovilizado (stock × costo). Considera promociones o devolución al proveedor.",
    };
  },

  // 19. VENCIMIENTOS PRÓXIMOS: productos comprados cuyo vencimiento cae en los
  // próximos N meses (según las fechas registradas en compras).
  // MARKETING: segmentación de clientes para campañas dirigidas por WhatsApp.
  // Usa ventas reales enlazadas a clientes con teléfono (misma llave que puntos).
  async segmentarClientes() {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    // Base: clientes con teléfono y sus métricas de compra
    const base = rows(await db.execute(sql`
      SELECT c.id, c.nombre, c.telefono,
             COUNT(DISTINCT v.id) AS compras,
             COALESCE(SUM(v.total), 0) AS gastoTotal,
             MAX(v.fecha) AS ultimaCompra,
             MIN(v.fecha) AS primeraCompra,
             COALESCE(SUM(CASE WHEN v.fecha >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 90 DAY), '%Y-%m-%d') THEN v.total ELSE 0 END), 0) AS gasto90
      FROM clientes c
      JOIN ventas v ON v.idCliente = c.id
      WHERE c.telefono IS NOT NULL AND c.telefono != ''
      GROUP BY c.id, c.nombre, c.telefono
      HAVING compras >= 1
    `));
    if (base.length === 0) return { mensaje: "No hay clientes con teléfono y compras registradas. Recuerda: las vendedoras deben registrar el teléfono del cliente en 365 al facturar." };
    const hoyStr = ahoraBolivia().toISOString().slice(0, 10);
    const diasDesde = (fecha: string) => {
      const [y, m, d] = String(fecha).slice(0, 10).split("-").map(Number);
      const hoy = ahoraBolivia();
      return Math.round((Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate()) - Date.UTC(y, m - 1, d)) / 86400000);
    };
    const frecuentes: any[] = [], altoValor: any[] = [], inactivos: any[] = [], nuevos: any[] = [];
    for (const c of base) {
      const dias = diasDesde(c.ultimaCompra);
      const item = {
        cliente: c.nombre || "Sin nombre", telefono: String(c.telefono),
        compras: num(c.compras), gastoTotal: `Bs ${num(c.gastoTotal).toFixed(0)}`,
        ultimaCompra: String(c.ultimaCompra).slice(0, 10), haceDias: dias,
      };
      if (num(c.compras) >= 2 && dias > 45) inactivos.push(item);
      else if (diasDesde(c.primeraCompra) <= 30) nuevos.push(item);
      if (num(c.compras) >= 4) frecuentes.push(item);
      if (num(c.gasto90) > 0) altoValor.push({ ...item, gasto90dias: `Bs ${num(c.gasto90).toFixed(0)}` });
    }
    altoValor.sort((a, b) => parseFloat(b.gasto90dias?.replace(/\D/g, "") || "0") - parseFloat(a.gasto90dias?.replace(/\D/g, "") || "0"));
    inactivos.sort((a, b) => b.haceDias - a.haceDias);
    frecuentes.sort((a, b) => b.compras - a.compras);
    const TOP = 10;
    return {
      criterio: "Segmentos sobre clientes con teléfono registrado y compras enlazadas.",
      resumen: {
        totalClientesConCompras: base.length,
        frecuentes: frecuentes.length,
        altoValor90dias: altoValor.filter((a: any) => parseFloat(String(a.gasto90dias).replace(/\D/g, "")) > 0).length,
        inactivos45dias: inactivos.length,
        nuevosUltimos30dias: nuevos.length,
      },
      segmentos: {
        frecuentes: { descripcion: "4+ compras — tus leales; ideales para el programa de puntos", top: frecuentes.slice(0, TOP) },
        altoValor: { descripcion: "Mayor gasto en 90 días — cuídalos con atención preferente", top: altoValor.slice(0, TOP) },
        inactivos: { descripcion: "Compraban (2+) y llevan 45+ días sin volver — campaña de recuperación por WhatsApp con un cupón", top: inactivos.slice(0, TOP) },
        nuevos: { descripcion: "Primera compra hace menos de 30 días — dales la bienvenida e invítalos a los puntos", top: nuevos.slice(0, TOP) },
      },
      accionesSugeridas: [
        "Inactivos: mensaje de WhatsApp con un cupón de retorno (crea uno: 'crea un cupón VUELVE de 10%').",
        "Nuevos: bienvenida + invitación al programa de puntos y la tienda online.",
        "Frecuentes/alto valor: aviso temprano de ofertas de la semana.",
      ],
      instruccionEstricta: "Muestra SOLO estos datos reales. NO inventes clientes ni cifras.",
    };
  },

  // MARKETING: sugerir qué poner en OFERTA cruzando vencimiento + rotación + margen.
  // Objetivo Company of One: mover stock por vencer con descuento = menos merma + más venta.
  async sugerirOfertas() {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const hoyStr = ahoraBolivia().toISOString().slice(0, 10);
    const hoy = ahoraBolivia();
    const limite = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + 5, hoy.getUTCDate()))
      .toISOString().slice(0, 10);
    // 1. Lotes comprados que vencen en los próximos 5 meses
    const lotes = rows(await db.execute(sql`
      SELECT pi.productName, MIN(pi.expiryDate) AS vence, SUM(pi.quantity) AS comprado
      FROM purchase_items pi
      WHERE pi.expiryDate IS NOT NULL AND pi.expiryDate != ''
        AND pi.expiryDate >= ${hoyStr} AND pi.expiryDate <= ${limite}
      GROUP BY pi.productName ORDER BY vence ASC LIMIT 60
    `));
    if (lotes.length === 0) return { mensaje: "No hay productos con vencimiento próximo (5 meses) registrado en compras. Nada urgente que ofertar por vencimiento." };
    // 2. Rotación: unidades vendidas en los últimos 60 días por producto
    const nombres = lotes.map((l: any) => l.productName);
    const ventas = rows(await db.execute(sql`
      SELECT d.articuloNombre AS nombre, SUM(d.cantidad) AS vendido60
      FROM ventas_detalle d
      WHERE d.fecha >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 60 DAY), '%Y-%m-%d')
        AND d.articuloNombre IN (${sql.join(nombres.map((n: string) => sql`${n}`), sql`, `)})
      GROUP BY d.articuloNombre
    `));
    const ventasMap: Record<string, number> = {};
    for (const v of ventas) ventasMap[String(v.nombre).toLowerCase()] = num(v.vendido60);
    // 3. Precio y costo desde el cache
    const info = rows(await db.execute(sql`
      SELECT nombre, precioUno, precioCostoUnid FROM productos_cache
      WHERE nombre IN (${sql.join(nombres.map((n: string) => sql`${n}`), sql`, `)})
    `));
    const infoMap: Record<string, any> = {};
    for (const i of info) infoMap[String(i.nombre).toLowerCase()] = i;
    // 4. Armar sugerencias: prioridad = vence pronto Y rota lento
    const candidatos = [];
    for (const l of lotes) {
      const k = String(l.productName).toLowerCase();
      const vendido60 = ventasMap[k] || 0;
      const inf = infoMap[k];
      const precio = num(inf?.precioUno);
      const costo = num(inf?.precioCostoUnid);
      if (precio <= 0) continue;
      const vence = String(l.vence).slice(0, 10);
      const [vy, vm, vd] = vence.split("-").map(Number);
      const diasParaVencer = Math.round((Date.UTC(vy, vm - 1, vd) - Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate())) / 86400000);
      const comprado = num(l.comprado);
      // Ritmo diario de venta y cuánto se vendería antes del vencimiento
      const ritmoDiario = vendido60 / 60;
      const seVenderiaAntes = Math.round(ritmoDiario * diasParaVencer);
      const riesgoMerma = comprado > seVenderiaAntes; // no alcanza a venderse al ritmo actual
      if (!riesgoMerma && vendido60 > 0) continue; // rota bien, no necesita oferta
      // Precio de oferta sugerido: 15-25% de descuento según urgencia, SIN bajar del costo+10%
      const pctDesc = diasParaVencer <= 60 ? 0.25 : diasParaVencer <= 100 ? 0.2 : 0.15;
      const pisoCosto = costo > 0 ? costo * 1.1 : precio * 0.6;
      const ofertaSugerida = Math.max(pisoCosto, precio * (1 - pctDesc));
      const redondeada = Math.max(0.5, Math.round(ofertaSugerida * 2) / 2);
      if (redondeada >= precio) continue; // sin espacio para descuento rentable
      candidatos.push({
        producto: l.productName,
        vence,
        diasParaVencer,
        compradoConEseVencimiento: comprado,
        vendidoUltimos60Dias: vendido60,
        precioActual: `Bs ${precio.toFixed(2)}`,
        ofertaSugerida: `Bs ${redondeada.toFixed(2)}`,
        descuento: `${Math.round((1 - redondeada / precio) * 100)}%`,
        razon: vendido60 === 0
          ? "Sin ventas en 60 días y con vencimiento en camino"
          : `Al ritmo actual (${vendido60} en 60d) no se vendería todo antes del vencimiento`,
      });
      if (candidatos.length >= 12) break;
    }
    if (candidatos.length === 0) return { mensaje: "Buenas noticias: los productos con vencimiento próximo rotan bien al ritmo actual. No hay ofertas urgentes que sugerir." };
    return {
      criterio: "Productos que al ritmo de venta actual no se venderían antes de su vencimiento (o sin rotación). Precio sugerido con descuento 15-25% según urgencia, sin bajar del costo+10%.",
      sugerencias: candidatos,
      comoAplicar: "Para activar una, pide: 'pon en oferta [producto] a [precio] hasta [fecha de vencimiento menos 15 días]'. También puedes generar el post de marketing de la oferta en /marketing.",
      instruccionEstricta: "Muestra SOLO estas sugerencias con sus datos. NO inventes productos ni precios.",
    };
  },

  async vencimientosProximos(meses?: number) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const n = Math.min(12, Math.max(1, num(meses) || 4));
    const hoyStr = ahoraBolivia().toISOString().slice(0, 10);
    const hoy = ahoraBolivia();
    const limite = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + n, hoy.getUTCDate()))
      .toISOString().slice(0, 10);
    const items = rows(await db.execute(sql`
      SELECT pi.productName, pi.expiryDate, pi.quantity, p.supplier
      FROM purchase_items pi JOIN purchases p ON p.id = pi.purchaseId
      WHERE pi.expiryDate IS NOT NULL AND pi.expiryDate != ''
        AND pi.expiryDate >= ${hoyStr} AND pi.expiryDate <= ${limite}
      ORDER BY pi.expiryDate ASC
    `));
    if (items.length === 0) {
      return { mensaje: `No hay productos comprados con vencimiento en los próximos ${n} meses (según fechas registradas en compras).` };
    }
    const MOSTRAR = 20;
    return {
      criterio: `Vencimientos entre hoy y ${limite} (según compras registradas)`,
      totalItems: items.length,
      proximosAVencer: items.slice(0, MOSTRAR).map((it: any) => ({
        producto: it.productName,
        vence: String(it.expiryDate).slice(0, 10),
        cantidadComprada: num(it.quantity),
        proveedor: it.supplier || undefined,
      })),
      instruccionEstricta: `Muestra SOLO estos items. NO inventes. Si hay más de ${MOSTRAR}, menciona el total (${items.length}).`,
      nota: "Fechas de vencimiento registradas al COMPRAR. La cantidad es la comprada en ese lote, no el stock actual: verifica el stock antes de actuar.",
    };
  },

  // 20. MARGEN POR PRODUCTO: dónde ganas bien y dónde casi regalas, entre los
  // productos VENDIDOS el último mes concluido (relevancia real).
  async margenProductos(orden?: string, sucursal?: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const buscarBajo = !orden || /bajo|menor|poco|peor/i.test(orden);
    const hoy = ahoraBolivia();
    const ini = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
    const fin = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 0)).toISOString().slice(0, 10);
    const filtroSuc = filtroLike("d.nombreSucursal", sucursal);
    const vendidos = rows(await db.execute(sql`
      SELECT d.articuloNombre, SUM(d.cantidad) as vendido, SUM(d.subtotal) as ingreso,
             c.precioUno, c.precioCostoUnid
      FROM ventas_detalle d JOIN productos_cache c ON c.nombre = d.articuloNombre
      WHERE d.fecha >= ${ini} AND d.fecha <= ${fin} ${filtroSuc}
        AND c.precioUno > 0 AND c.precioCostoUnid > 0
        AND d.articuloNombre NOT LIKE '%venta menor%' AND d.articuloNombre NOT LIKE '%ventas menores%'
      GROUP BY d.articuloNombre, c.precioUno, c.precioCostoUnid
      HAVING vendido > 0
    `));
    if (vendidos.length === 0) return { mensaje: "No hay productos vendidos con precio y costo conocidos el mes pasado." };
    const conMargen = vendidos.map((v: any) => {
      const precio = num(v.precioUno), costo = num(v.precioCostoUnid);
      const margenPct = precio > 0 ? ((precio - costo) / precio) * 100 : 0;
      return {
        producto: v.articuloNombre,
        precioVenta: `Bs ${fmtBs(precio)}`,
        costo: `Bs ${fmtBs(costo)}`,
        margen: `${margenPct.toFixed(1)}%`,
        _m: margenPct,
        vendidoMesPasado: num(v.vendido),
        gananciaDelMes: `Bs ${fmtBs((precio - costo) * num(v.vendido))}`,
      };
    });
    conMargen.sort((a, b) => buscarBajo ? a._m - b._m : b._m - a._m);
    const MOSTRAR = 15;
    return {
      criterio: buscarBajo ? "Productos vendidos el mes pasado con MENOR margen" : "Productos vendidos el mes pasado con MAYOR margen",
      mes: ini.slice(0, 7),
      productos: conMargen.slice(0, MOSTRAR).map(({ _m, ...resto }) => resto),
      instruccionEstricta: `Muestra SOLO estos productos. NO inventes datos.`,
      nota: "Margen = (precio venta − costo) ÷ precio venta. Solo productos con precio y costo conocidos. Los de margen negativo se venden POR DEBAJO del costo: revisar precio urgente.",
    };
  },

  // 21. RESUMEN EJECUTIVO: el panorama del negocio en una sola consulta.
  // Ventas de hoy, ritmo del mes vs mes anterior al mismo día, pagos pendientes,
  // vencimientos cercanos y cajas abiertas.
  // Directorio: teléfono de un cliente o proveedor ("el número de Bagó")
  async buscarContacto(consulta: string, tipo?: string) {
    const { contactos } = await import("./contactos");
    const t = tipo === "cliente" || tipo === "proveedor" ? tipo : undefined;
    const r = await contactos.buscar(consulta || "", t as any);
    if (r.length === 0) return { nota: `No tengo a "${consulta}" en el directorio de contactos.` };
    return {
      contactos: r.slice(0, 5).map((c: any) => ({
        nombre: c.nombre, telefono: c.telefono, tipo: c.tipo,
        ...(c.empresa ? { empresa: c.empresa } : {}),
      })),
    };
  },

  // Uso y costo del propio asistente (DeepSeek V4 Flash), con hit-rate del caché
  async usoIA(dias?: number) {
    const { getDb } = await import("./db");
    const { sql } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const n = Math.min(Math.max(dias ?? 30, 1), 90);
    let filasUso: any[] = [];
    try {
      const r: any = await db.execute(sql`SELECT fecha, llamadas, hitTokens, missTokens, outTokens FROM llm_uso_diario ORDER BY fecha DESC LIMIT ${n}`);
      const x = Array.isArray(r) ? r[0] : r?.rows ?? r;
      filasUso = Array.isArray(x) ? x : [];
    } catch { return { nota: "Aún no hay registros de uso (empiezan a acumularse desde hoy)." }; }
    if (filasUso.length === 0) return { nota: "Aún no hay registros de uso (empiezan a acumularse desde hoy)." };
    const sum = (k: string) => filasUso.reduce((s, f) => s + Number(f[k] || 0), 0);
    const hit = sum("hitTokens"), miss = sum("missTokens"), out = sum("outTokens"), llamadas = sum("llamadas");
    const totalIn = hit + miss;
    const hitRate = totalIn > 0 ? Math.round((hit / totalIn) * 100) : 0;
    // Tarifas DeepSeek V4 Flash (jul 2026): hit $0.0028/M, miss $0.14/M, salida $0.28/M
    const costoUSD = (hit * 0.0028 + miss * 0.14 + out * 0.28) / 1_000_000;
    const costoSinCacheUSD = (totalIn * 0.14 + out * 0.28) / 1_000_000;
    return {
      periodo: `últimos ${filasUso.length} día(s) con actividad`,
      llamadas,
      tokensEntrada: totalIn, tokensSalida: out,
      cacheHitRate: `${hitRate}%`,
      costoEstimado: `$${costoUSD.toFixed(3)} USD`,
      ahorroPorCache: `$${(costoSinCacheUSD - costoUSD).toFixed(3)} USD`,
      nota: "Tarifas DeepSeek V4 Flash. El caché se aprovecha manteniendo idénticos el prompt del sistema y las herramientas en cada llamada.",
    };
  },

  async resumenEjecutivo() {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const hoy = ahoraBolivia();
    const hoyStr = hoy.toISOString().slice(0, 10);
    const diaDelMes = hoy.getUTCDate();
    const mesActual = hoyStr.slice(0, 7);
    const iniMes = `${mesActual}-01`;
    const mesAnt = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 1));
    const mesAntStr = mesAnt.toISOString().slice(0, 7);
    const iniMesAnt = `${mesAntStr}-01`;
    // Mismo día del mes anterior (con tope al último día de ese mes)
    const ultimoDiaMesAnt = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 0)).getUTCDate();
    const corteMesAnt = `${mesAntStr}-${String(Math.min(diaDelMes, ultimoDiaMesAnt)).padStart(2, "0")}`;
    const limVenc = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1, hoy.getUTCDate())).toISOString().slice(0, 10);

    // Consultas de BD en paralelo (rápidas)
    const [ventasHoy, ventasHoySuc, acumMes, acumMesAnt, pagosPend, vencCercanos] = await Promise.all([
      db.execute(sql`SELECT COALESCE(SUM(total),0) as total, COUNT(*) as n FROM ventas WHERE fecha = ${hoyStr}${FILTRO_NO_ANULADA}`),
      db.execute(sql`SELECT nombreSucursal, COALESCE(SUM(total),0) as total FROM ventas WHERE fecha = ${hoyStr} AND nombreSucursal IS NOT NULL${FILTRO_NO_ANULADA} GROUP BY nombreSucursal ORDER BY total DESC`),
      db.execute(sql`SELECT COALESCE(SUM(total),0) as total FROM ventas WHERE fecha >= ${iniMes} AND fecha <= ${hoyStr}${FILTRO_NO_ANULADA}`),
      db.execute(sql`SELECT COALESCE(SUM(total),0) as total FROM ventas WHERE fecha >= ${iniMesAnt} AND fecha <= ${corteMesAnt}${FILTRO_NO_ANULADA}`),
      db.execute(sql`SELECT COUNT(*) as n, COALESCE(SUM(monto),0) as total FROM gastos_registro WHERE anioMes = ${mesActual} AND pagado = 0`),
      db.execute(sql`SELECT COUNT(*) as n FROM purchase_items WHERE expiryDate IS NOT NULL AND expiryDate != '' AND expiryDate >= ${hoyStr} AND expiryDate <= ${limVenc}`),
    ]);
    const vHoy = rows(ventasHoy)[0] || {};
    const acum = num(rows(acumMes)[0]?.total);
    const acumAnt = num(rows(acumMesAnt)[0]?.total);
    const ritmo = acumAnt > 0 ? (((acum - acumAnt) / acumAnt) * 100) : null;
    const pp = rows(pagosPend)[0] || {};
    const nVenc = num(rows(vencCercanos)[0]?.n);

    // Cajas abiertas desde 365 (puede fallar sin tumbar el resumen)
    let cajas: any = "no disponible ahora";
    try {
      const { inventarios365 } = await import("./inventarios365");
      const abiertas = await inventarios365.cajasAbiertas();
      if (Array.isArray(abiertas)) {
        cajas = abiertas.length === 0 ? "ninguna caja abierta" : abiertas.map((c: any) =>
          `${c.nombreUsuario ?? c.nombre_usuario ?? c.usuario ?? c.nombre ?? "?"} (${c.nombreSucursal ?? c.nombre_sucursal ?? c.sucursal ?? "?"})`
        ).join(", ");
      }
    } catch { /* mantener "no disponible" */ }

    return {
      fecha: hoyStr,
      ventasDeHoy: {
        total: `Bs ${fmtBs(vHoy.total)}`,
        numeroVentas: num(vHoy.n),
        porSucursal: rows(ventasHoySuc).map((s: any) => ({ sucursal: s.nombreSucursal, total: `Bs ${fmtBs(s.total)}` })),
      },
      ritmoDelMes: {
        acumulado: `Bs ${fmtBs(acum)} (del 1 al ${diaDelMes} de ${mesActual})`,
        mismoPuntoMesAnterior: `Bs ${fmtBs(acumAnt)} (del 1 al ${corteMesAnt.slice(-2)} de ${mesAntStr})`,
        ritmo: ritmo == null ? "sin base de comparación" : `${ritmo >= 0 ? "+" : ""}${ritmo.toFixed(1)}% vs el mes pasado a esta altura`,
      },
      pagosPendientesDelMes: { cantidad: num(pp.n), total: `Bs ${fmtBs(pp.total)}` },
      vencimientosProximos30Dias: nVenc,
      cajasAbiertasAhora: cajas,
      instruccionEstricta: "Presenta esto como un parte ejecutivo breve y ordenado. NO inventes datos que no estén aquí. Destaca el ritmo del mes (es la métrica clave).",
      nota: "Ritmo del mes = ventas acumuladas del mes en curso vs las del mes anterior hasta el mismo día.",
    };
  },
};
