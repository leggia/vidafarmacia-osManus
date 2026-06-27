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
  async gananciaPeriodo(periodo: string) {
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const { desde, hasta, etiqueta } = rangoFechas(periodo || "mes");
    const rIngreso = rows(await db.execute(sql.raw(
      `SELECT COALESCE(SUM(total),0) as ingreso FROM ventas WHERE fecha >= ${esc(desde)} AND fecha <= ${esc(hasta)}`
    )));
    const rCosto = rows(await db.execute(sql.raw(
      `SELECT COALESCE(SUM(d.cantidad * c.precioCostoUnid),0) as costo
       FROM ventas_detalle d JOIN productos_cache c ON c.nombre = d.articuloNombre
       WHERE d.fecha >= ${esc(desde)} AND d.fecha <= ${esc(hasta)} AND c.precioCostoUnid > 0`
    )));
    const ingreso = num(rIngreso[0]?.ingreso);
    const costo = num(rCosto[0]?.costo);
    const ganancia = ingreso - costo;
    return {
      periodo: etiqueta,
      ingresos: `Bs ${fmtBs(ingreso)}`,
      costoProductos: `Bs ${fmtBs(costo)}`,
      gananciaBruta: `Bs ${fmtBs(ganancia)}`,
      nota: "Ganancia bruta = ventas - costo de productos vendidos (con costo conocido). No descuenta sueldos ni gastos.",
    };
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
};
