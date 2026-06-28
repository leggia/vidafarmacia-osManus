// Servicio del Asistente VidaFarma (Fase 1: solo consultas / lectura)
// Cada función es una "herramienta" que el asistente puede invocar.
import { getDb } from "./db";
import { sql } from "drizzle-orm";

const rows = (r: any): any[] => {
  const x = Array.isArray(r) ? r[0] : r?.rows ?? r;
  return Array.isArray(x) ? x : [];
};
const esc = (v: string) => `'${String(v ?? "").replace(/'/g, "''")}'`;
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };
const fmtBs = (n: any) => num(n).toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Rango de fechas según un período de texto
function rangoFechas(periodo: string): { desde: string; hasta: string; etiqueta: string } {
  const hoy = new Date();
  const y = hoy.getFullYear(), m = hoy.getMonth(), d = hoy.getDate();
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  const p = (periodo || "hoy").toLowerCase();
  if (p.includes("hoy")) {
    const t = iso(hoy);
    return { desde: t, hasta: t, etiqueta: "hoy" };
  }
  if (p.includes("ayer")) {
    const a = new Date(y, m, d - 1);
    return { desde: iso(a), hasta: iso(a), etiqueta: "ayer" };
  }
  if (p.includes("semana")) {
    const ini = new Date(y, m, d - 6);
    return { desde: iso(ini), hasta: iso(hoy), etiqueta: "los últimos 7 días" };
  }
  if (p.includes("mes")) {
    // "mes anterior" / "mes pasado" → el mes calendario previo completo
    if (p.includes("anterior") || p.includes("pasado")) {
      const iniAnt = new Date(y, m - 1, 1);
      const finAnt = new Date(y, m, 0);
      return { desde: iso(iniAnt), hasta: iso(finAnt), etiqueta: "el mes anterior" };
    }
    const ini = new Date(y, m, 1);
    return { desde: iso(ini), hasta: iso(hoy), etiqueta: "este mes" };
  }
  // Si viene formato YYYY-MM
  const match = p.match(/(\d{4})-(\d{2})/);
  if (match) {
    const anio = Number(match[1]), mes = Number(match[2]);
    const ultimo = new Date(anio, mes, 0).getDate();
    return { desde: `${match[1]}-${match[2]}-01`, hasta: `${match[1]}-${match[2]}-${String(ultimo).padStart(2, "0")}`, etiqueta: `${match[1]}-${match[2]}` };
  }
  const t = iso(hoy);
  return { desde: t, hasta: t, etiqueta: "hoy" };
}

export const asistenteTools = {
  // 1. Cuánto vendí en un período
  async ventasPeriodo(periodo: string, sucursal?: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const { desde, hasta, etiqueta } = rangoFechas(periodo);
    const filtroSuc = sucursal ? ` AND nombreSucursal LIKE ${esc("%" + sucursal + "%")}` : "";
    const r = rows(await db.execute(sql.raw(
      `SELECT COUNT(*) as numVentas, COALESCE(SUM(total),0) as total
       FROM ventas WHERE fecha >= ${esc(desde)} AND fecha <= ${esc(hasta)}${filtroSuc}`
    )));
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
      const porSuc = rows(await db.execute(sql.raw(
        `SELECT nombreSucursal, COUNT(*) as numVentas, COALESCE(SUM(total),0) as total
         FROM ventas WHERE fecha >= ${esc(desde)} AND fecha <= ${esc(hasta)} AND nombreSucursal IS NOT NULL
         GROUP BY nombreSucursal ORDER BY total DESC`
      )));
      resultado.porSucursal = porSuc.map((s: any) => ({
        sucursal: s.nombreSucursal,
        ventas: num(s.numVentas),
        total: `Bs ${fmtBs(s.total)}`,
      }));
    }
    return resultado;
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
    const r = rows(await db.execute(sql.raw(
      `SELECT COUNT(*) as n, COALESCE(SUM(totalAmount),0) as total FROM purchases
       WHERE status='completed' AND supplier LIKE ${esc("%" + proveedor + "%")}
       AND createdAt >= ${esc(desde + " 00:00:00")} AND createdAt <= ${esc(hasta + " 23:59:59")}`
    )));
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
    const orden = porValor ? "SUM(subtotal)" : "SUM(cantidad)";
    const r = rows(await db.execute(sql.raw(
      `SELECT articuloNombre, SUM(cantidad) as cant, SUM(subtotal) as valor
       FROM ventas_detalle WHERE fecha >= ${esc(desde)} AND fecha <= ${esc(hasta)}
       AND articuloNombre NOT LIKE '%venta menor%'
       GROUP BY articuloNombre ORDER BY ${orden} DESC LIMIT 5`
    )));
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
    const filtroSuc = sucursal ? ` AND nombreSucursal LIKE ${esc("%" + sucursal + "%")}` : "";
    const filtroSucD = sucursal ? ` AND d.nombreSucursal LIKE ${esc("%" + sucursal + "%")}` : "";

    const rIngreso = rows(await db.execute(sql.raw(
      `SELECT COALESCE(SUM(total),0) as ingreso FROM ventas WHERE fecha >= ${esc(desde)} AND fecha <= ${esc(hasta)}${filtroSuc}`
    )));
    const rCosto = rows(await db.execute(sql.raw(
      `SELECT COALESCE(SUM(d.cantidad * c.precioCostoUnid),0) as costo
       FROM ventas_detalle d JOIN productos_cache c ON c.nombre = d.articuloNombre
       WHERE d.fecha >= ${esc(desde)} AND d.fecha <= ${esc(hasta)} AND c.precioCostoUnid > 0${filtroSucD}`
    )));
    // Gastos del mes. Si se filtra por sucursal, sumar SOLO los gastos de esa
    // sucursal (alquiler, sueldos, etc. que se registraron con sucursal). Si no,
    // sumar todos.
    const filtroGasto = sucursal
      ? ` AND sucursal LIKE ${esc("%" + sucursal + "%")}`
      : "";
    const rGastos = rows(await db.execute(sql.raw(
      `SELECT COALESCE(SUM(monto),0) as gastos FROM gastos_registro WHERE anioMes = ${esc(anioMes)}${filtroGasto}`
    )));

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
      nota: sucursal
        ? "Ganancia neta de la sucursal = ingresos - costo - gastos asignados a esta sucursal (alquiler, sueldos, etc.). Los gastos generales sin sucursal no se incluyen aquí."
        : "Ganancia neta = ventas - costo de productos - todos los gastos del mes. El costo solo cuenta productos con costo conocido.",
    };
    return resultado;
  },

  // 6. Precio y stock de un producto
  async infoProducto(nombre: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const palabras = nombre.trim().split(/\s+/).filter(Boolean);
    const cond = palabras.map(w => `nombre LIKE ${esc("%" + w + "%")}`).join(" AND ");
    // Primero contar cuántos coinciden
    const cont = rows(await db.execute(sql.raw(
      `SELECT COUNT(*) as n FROM productos_cache WHERE ${cond}`
    )));
    const total = num(cont[0]?.n);

    if (total === 0) {
      return { mensaje: `No encontré ningún producto que coincida con "${nombre}".` };
    }

    // Si hay demasiados (más de 10), pedir que afine la búsqueda
    if (total > 10) {
      const muestra = rows(await db.execute(sql.raw(
        `SELECT nombre FROM productos_cache WHERE ${cond} ORDER BY nombre LIMIT 6`
      )));
      return {
        demasiadosResultados: true,
        cantidad: total,
        mensaje: `Encontré ${total} productos que coinciden con "${nombre}". Es demasiado para listar. ¿Podrías darme el nombre más específico? Por ejemplo, algunos son: ${muestra.map((p: any) => p.nombre).join(", ")}.`,
      };
    }

    const r = rows(await db.execute(sql.raw(
      `SELECT nombre, codigo, precioUno, precioCostoUnid, nombreProveedor
       FROM productos_cache WHERE ${cond} ORDER BY nombre LIMIT 10`
    )));

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

    // 1-3 coincidencias: mostrar detalle completo
    return {
      productos: r.map((p: any) => ({
        nombre: p.nombre, codigo: p.codigo,
        precioVenta: `Bs ${fmtBs(p.precioUno)}`,
        precioCosto: `Bs ${fmtBs(p.precioCostoUnid)}`,
        proveedor: p.nombreProveedor || "no especificado",
      })),
      nota: "El stock en tiempo real se consulta en inventarios365, no está en estos datos.",
    };
  },

  // 7. Productos vendidos a un cliente
  async ventasCliente(cliente: string, periodo?: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const { desde, hasta, etiqueta } = periodo ? rangoFechas(periodo) : { desde: "2000-01-01", hasta: "2099-12-31", etiqueta: "todo el historial" };
    const r = rows(await db.execute(sql.raw(
      `SELECT d.articuloNombre, SUM(d.cantidad) as cant, SUM(d.subtotal) as valor
       FROM ventas_detalle d JOIN ventas v ON v.id = d.ventaId
       WHERE v.razonSocialCliente LIKE ${esc("%" + cliente + "%")}
       AND d.fecha >= ${esc(desde)} AND d.fecha <= ${esc(hasta)}
       GROUP BY d.articuloNombre ORDER BY cant DESC LIMIT 20`
    )));
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
    const filtroSuc = sucursal ? ` AND nombreSucursal LIKE ${esc("%" + sucursal + "%")}` : "";
    const r = rows(await db.execute(sql.raw(
      `SELECT vendedor, COUNT(*) as numVentas, COALESCE(SUM(total),0) as total
       FROM ventas WHERE fecha >= ${esc(desde)} AND fecha <= ${esc(hasta)}${filtroSuc}
       AND vendedor IS NOT NULL AND vendedor <> ''
       GROUP BY vendedor ORDER BY total DESC LIMIT 5`
    )));
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
    const r = rows(await db.execute(sql.raw(
      `SELECT nombre, sucursalFija, tipoTrabajador FROM trabajadores
       WHERE activo=1 AND LOWER(sucursalFija) LIKE ${esc("%" + s + "%")}`
    )));
    if (r.length > 0) {
      return { sucursal, trabajadores: r.map((t: any) => ({ nombre: t.nombre, tipo: t.tipoTrabajador })) };
    }
    // 2) Respaldo: inferir por las ventas (qué vendedores vendieron en esa sucursal últimamente)
    const vend = rows(await db.execute(sql.raw(
      `SELECT DISTINCT vendedor FROM ventas
       WHERE LOWER(nombreSucursal) LIKE ${esc("%" + s + "%")} AND vendedor IS NOT NULL AND vendedor <> ''
       ORDER BY vendedor LIMIT 20`
    )));
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
    const r = rows(await db.execute(sql.raw(
      `SELECT DISTINCT nombreSucursal FROM ventas WHERE nombreSucursal IS NOT NULL`
    )));
    return { sucursales: r.map((s: any) => s.nombreSucursal) };
  },

  // 10. Stock de un producto por ALMACÉN, consultando inventarios365 EN VIVO
  async stockProducto(nombre: string, almacen?: string) {
    try {
      const { inventarios365 } = await import("./inventarios365");
      // Almacenes conocidos (id → nombre legible)
      const ALMACENES: { id: number; nombre: string; alias: string[] }[] = [
        { id: 1, nombre: "Almacén Principal", alias: ["principal", "matriz", "casa matriz"] },
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
        const lista = await inventarios365.listarParaInventario(al.id, "");
        // Filtrar productos que coincidan con todas las palabras
        const matches = lista.filter((p: any) => {
          const texto = `${p.nombre} ${p.codigo || ""}`.toLowerCase();
          return palabras.every(w => texto.includes(w));
        });
        if (matches.length > 0) {
          // Si hay varios productos distintos que coinciden, tomar nota
          for (const m of matches.slice(0, 3)) {
            productoNombre = m.nombre;
            resultadoPorAlmacen.push({ almacen: al.nombre, producto: m.nombre, stock: m.stock });
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
    const palabras = nombre.trim().split(/\s+/).filter(Boolean);
    const cond = palabras.map(w => `i.productName LIKE ${esc("%" + w + "%")}`).join(" AND ");
    const r = rows(await db.execute(sql.raw(
      `SELECT i.productName, i.unitCost, p.supplier, p.createdAt
       FROM purchase_items i JOIN purchases p ON p.id = i.purchaseId
       WHERE ${cond} AND p.status='completed' AND i.unitCost > 0
       ORDER BY p.createdAt DESC`
    )));
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
      anioMes = new Date().toISOString().slice(0, 7);
    } else {
      // Default y "mes pasado/anterior": último mes concluido
      const hoy = new Date();
      const ant = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
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
        const h = new Date(); const a = new Date(h.getFullYear(), h.getMonth() - 1, 1);
        return a.toISOString().slice(0, 7);
      }
      return new Date().toISOString().slice(0, 7);
    })();
    const filtroSuc = sucursal ? ` AND sucursal LIKE ${esc("%" + sucursal + "%")}` : "";
    const r = rows(await db.execute(sql.raw(
      `SELECT nombre, categoria, monto, pagado, sucursal FROM gastos_registro
       WHERE anioMes = ${esc(anioMes)}${filtroSuc}
       ORDER BY pagado ASC, sucursal, monto DESC`
    )));
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
};
