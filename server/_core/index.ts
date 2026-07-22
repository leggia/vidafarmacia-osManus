import "dotenv/config";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { sdk } from "./sdk";
import { serveStatic, setupVite } from "./vite";
import { inventarios365 } from "../inventarios365";
import { getDb } from "../db";
import { sql } from "drizzle-orm";
import { productosCache } from "../productos-cache";

// Exige sesión con rol admin. Protege /api/admin/* — antes eran accesibles
// por cualquiera en internet sin login (borraban datos y filtraban info interna).
async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (user.role !== "admin") {
      res.status(403).json({ error: "Solo administradores" });
      return;
    }
    next();
  } catch {
    res.status(401).json({ error: "No autenticado" });
  }
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Confiar en el proxy de Railway para HTTPS
  app.set("trust proxy", 1);

  // Todas las rutas /api/admin/* requieren sesión con rol admin.
  app.use("/api/admin", requireAdmin);

  // Endpoint admin para limpiar cache (solo en producción)
  // Diagnóstico: qué valores de 'estado' existen en las ventas (para confirmar
  // cómo 365 marca las anuladas) + fuerza el refresco de estados recientes.
  // Muestra el objeto CRUDO de las cajas de 365 (para ver si el cierre incluye
  // el monto de ventas, y así comparar contra lo local). Uso: /api/admin/diag-caja-cruda
  app.get("/api/admin/diag-caja-cruda", async (_req, res) => {
    try {
      const { inventarios365 } = await import("../inventarios365");
      const crudo = await inventarios365.diagRaw("/caja?page=1&buscar=&criterio=");
      const arr = crudo?.cajas ?? crudo?.data ?? crudo?.movimientos ?? (Array.isArray(crudo) ? crudo : []);
      const lista = Array.isArray(arr) ? arr : arr?.data ?? [];
      const ejemplos = lista.slice(0, 2);
      res.json({
        keys: crudo && typeof crudo === "object" ? Object.keys(crudo) : typeof crudo,
        ejemplos: ejemplos.map((c: any) => ({ campos: Object.keys(c), valores: c })),
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  // Muestra el objeto CRUDO de la cabecera de una venta en 365, para ver los
  // nombres reales de los campos (estado, etc.). Uso: /api/admin/diag-cabecera-cruda?id=69112
  app.get("/api/admin/diag-cabecera-cruda", async (req: any, res) => {
    try {
      const id = Number(req.query.id);
      if (!id) return res.status(400).json({ error: "id requerido" });
      const { inventarios365 } = await import("../inventarios365");
      const cab = await inventarios365.obtenerCabeceraVenta(id);
      res.json({ id, cabecera: cab });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  // Consulta la CABECERA individual en 365 de cada venta local del día. Revela el
  // estado REAL en 365 (no el del listado) y si la venta existe allá.
  // Uso: /api/admin/diag-cabeceras?fecha=2026-07-19&sucursal=Lanza
  app.get("/api/admin/diag-cabeceras", async (req: any, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(500).json({ error: "DB no disponible" });
      const fecha = String(req.query.fecha || "");
      const sucursal = String(req.query.sucursal || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: "fecha YYYY-MM-DD" });
      const filtroSuc = sucursal ? sql` AND nombreSucursal LIKE ${"%" + sucursal + "%"}` : sql``;
      const r: any = await db.execute(sql`
        SELECT id, total, estado, numComprobante FROM ventas WHERE fecha = ${fecha}${filtroSuc} ORDER BY id
      `);
      const locales = (Array.isArray(r) ? r[0] : r?.rows ?? r) as any[];
      const { inventarios365 } = await import("../inventarios365");
      const detalle = [];
      let noExisten = 0, distintoEstado = 0;
      for (const v of locales) {
        const cab = await inventarios365.obtenerCabeceraVenta(Number(v.id));
        const filaV = cab?.venta?.[0] ?? cab?.[0] ?? cab;
        const estado365 = filaV?.estado != null ? String(filaV.estado) : (cab ? "?" : "NO EXISTE");
        if (!cab) noExisten++;
        else if (String(v.estado) !== estado365) distintoEstado++;
        detalle.push({ id: v.id, total: v.total, comp: v.numComprobante, local: String(v.estado), en365: estado365 });
        await new Promise((r) => setTimeout(r, 60));
      }
      res.json({
        fecha, sucursal: sucursal || "(todas)",
        totalLocales: locales.length, noExisten, distintoEstado,
        detalle,
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  // Compara el estado LOCAL vs el estado REAL en 365 para las ventas de un día.
  // Revela ventas que localmente están "1" pero en 365 fueron canceladas.
  // Uso: /api/admin/diag-comparar-365?fecha=2026-07-19&sucursal=Lanza
  app.get("/api/admin/diag-comparar-365", async (req: any, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(500).json({ error: "DB no disponible" });
      const fecha = String(req.query.fecha || "");
      const sucursal = String(req.query.sucursal || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: "fecha YYYY-MM-DD" });
      const filtroSuc = sucursal ? sql` AND nombreSucursal LIKE ${"%" + sucursal + "%"}` : sql``;
      // Ventas locales de ese día
      const r: any = await db.execute(sql`
        SELECT id, total, estado FROM ventas WHERE fecha = ${fecha}${filtroSuc} ORDER BY id
      `);
      const locales = (Array.isArray(r) ? r[0] : r?.rows ?? r) as any[];
      // Traer los estados actuales de 365 (varias páginas recientes)
      const { inventarios365 } = await import("../inventarios365");
      const estado365 = new Map<number, string>();
      for (let page = 1; page <= 10; page++) {
        const { ventas } = await inventarios365.listarVentasPagina(page);
        if (!ventas || ventas.length === 0) break;
        for (const v of ventas) estado365.set(Number(v.id), String(v.estado ?? ""));
        await new Promise((r) => setTimeout(r, 80));
      }
      // Comparar
      const discrepancias = [];
      let localValidas = 0, localValidasMonto = 0;
      for (const v of locales) {
        const eLocal = String(v.estado);
        const e365 = estado365.has(Number(v.id)) ? estado365.get(Number(v.id)) : "(no está en páginas recientes)";
        if (eLocal === "1") { localValidas++; localValidasMonto += Number(v.total); }
        if (eLocal !== e365 && e365 !== "(no está en páginas recientes)") {
          discrepancias.push({ id: v.id, total: v.total, estadoLocal: eLocal, estado365: e365 });
        }
      }
      res.json({
        fecha, sucursal: sucursal || "(todas)",
        totalLocales: locales.length,
        localValidas, localValidasMonto: localValidasMonto.toFixed(2),
        discrepancias,
        nota: "discrepancias = ventas cuyo estado local difiere del actual en 365 (deberían actualizarse)",
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  // Compara los nombres de sucursal de VidaFarma con los almacenes reales de 365.
  // Sirve para detectar por qué una transferencia no se refleja (nombre que no
  // coincide o que es ambiguo, ej. "Casa Matriz" vs "Casa Matriz Cobol").
  app.get("/api/admin/diag-almacenes", async (_req, res) => {
    try {
      const db = await getDb();
      const { inventarios365 } = await import("../inventarios365");
      const almacenes = await inventarios365.listarAlmacenes();
      let sucursales: any[] = [];
      if (db) {
        const r: any = await db.execute(sql`SELECT id, name FROM branches ORDER BY id`);
        sucursales = (Array.isArray(r) ? r[0] : r?.rows ?? r) as any[];
      }
      const norm = (x: string) => String(x || "").toLowerCase().trim();
      const cruce = sucursales.map((s: any) => {
        const exactos = almacenes.filter((a: any) => norm(a.nombre_almacen) === norm(s.name));
        const parciales = almacenes.filter((a: any) => norm(a.nombre_almacen).includes(norm(s.name)) || norm(s.name).includes(norm(a.nombre_almacen)));
        return {
          sucursalVidaFarma: s.name,
          coincidenciaExacta: exactos.map((a: any) => `${a.id}: ${a.nombre_almacen}`),
          coincidenciasParciales: parciales.map((a: any) => `${a.id}: ${a.nombre_almacen}`),
          estado: exactos.length === 1 ? "OK (exacta)" : parciales.length === 1 ? "OK (única parcial)" : parciales.length > 1 ? "AMBIGUA — puede transferir al almacén equivocado" : "SIN COINCIDENCIA",
        };
      });
      res.json({ almacenes365: almacenes.map((a: any) => ({ id: a.id, nombre: a.nombre_almacen })), cruce });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  // Captura manual de cierres de caja (faltantes/sobrantes). GET para el navegador.
  app.get("/api/admin/capturar-cierres-caja", async (_req, res) => {
    try {
      const { diferenciasCajaService } = await import("../diferencias-caja");
      const r = await diferenciasCajaService.capturarCierres();
      res.json({ success: true, ...r });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e?.message });
    }
  });

  // Diagnóstico por fecha+sucursal: desglose por estado para comparar con 365.
  // Uso: /api/admin/diag-ventas-dia?fecha=2026-07-20&sucursal=Lanza
  app.get("/api/admin/diag-ventas-dia", async (req: any, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(500).json({ error: "DB no disponible" });
      const fecha = String(req.query.fecha || "");
      const sucursal = String(req.query.sucursal || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: "fecha debe ser YYYY-MM-DD" });
      const filtroSuc = sucursal ? sql` AND nombreSucursal LIKE ${"%" + sucursal + "%"}` : sql``;
      const r: any = await db.execute(sql`
        SELECT estado, COUNT(*) AS n, COALESCE(SUM(total),0) AS total
        FROM ventas WHERE fecha = ${fecha}${filtroSuc}
        GROUP BY estado ORDER BY estado
      `);
      const filas = Array.isArray(r) ? r[0] : r?.rows ?? r;
      // También el desglose de sucursales exactas ese día (para ver el nombre real)
      const s: any = await db.execute(sql`
        SELECT DISTINCT nombreSucursal FROM ventas WHERE fecha = ${fecha}
      `);
      const sucs = Array.isArray(s) ? s[0] : s?.rows ?? s;
      res.json({ fecha, sucursal: sucursal || "(todas)", porEstado: filas, sucursalesDelDia: sucs });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  app.get("/api/admin/diag-estados-ventas", async (_req, res) => {
    try {
      const db = await getDb();
      if (!db) return res.status(500).json({ error: "DB no disponible" });
      // 1. Estados guardados localmente
      const r: any = await db.execute(sql`
        SELECT COALESCE(estado,'(null)') AS estado, COUNT(*) AS n, COALESCE(SUM(total),0) AS total
        FROM ventas GROUP BY estado ORDER BY n DESC
      `);
      const filas = Array.isArray(r) ? r[0] : r?.rows ?? r;
      // 2. Qué devuelve 365 en crudo para las 3 ventas más recientes (para ver el
      //    nombre exacto del campo y el valor cuando está cancelada)
      let muestra365: any = null;
      try {
        const { inventarios365 } = await import("../inventarios365");
        const { ventas } = await inventarios365.listarVentasPagina(1);
        muestra365 = (ventas || []).slice(0, 3).map((v: any) => ({
          id: v.id, estado: v.estado, campos: Object.keys(v),
        }));
      } catch (e: any) {
        muestra365 = { error: e?.message };
      }
      res.json({ estadosLocales: filas, muestra365 });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  app.post("/api/admin/refrescar-estados-ventas", async (_req, res) => {
    try {
      const { refrescarEstadoVentasRecientes } = await import("../sync-ventas");
      const r = await refrescarEstadoVentasRecientes(3);
      res.json({ success: true, ...r });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e?.message });
    }
  });

  // Versión GET para dispararlo fácil desde el navegador (refresca 5 días).
  app.get("/api/admin/refrescar-estados-ventas", async (_req, res) => {
    try {
      const { refrescarEstadoVentasRecientes } = await import("../sync-ventas");
      const r = await refrescarEstadoVentasRecientes(5);
      res.json({ success: true, ...r });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e?.message });
    }
  });

  app.post("/api/admin/clear-cache", async (_req, res) => {
    try {
      const db = await getDb();
      if (db) {
        await db.execute(sql`DELETE FROM productos_cache`);
        console.log("[Admin] Cache de productos limpiado");
        res.json({ success: true, message: "Cache limpiado. Se recargará en el próximo uso." });
        productosCache.actualizar(true).catch(console.error);
      } else {
        res.status(500).json({ success: false, message: "DB no disponible" });
      }
    } catch (e: any) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Endpoint de diagnóstico — registra compra de prueba y devuelve respuesta cruda
  // Endpoint para limpiar confirmaciones incorrectas
  app.post("/api/admin/clear-confirmaciones", async (_req, res) => {
    try {
      const db = await getDb();
      if (db) {
        await db.execute(sql`DELETE FROM confirmaciones`);
        console.log("[Admin] Confirmaciones limpiadas");
        res.json({ success: true, message: "Confirmaciones limpiadas. Vuelve a emparejar." });
      } else {
        res.status(500).json({ success: false, message: "DB no disponible" });
      }
    } catch (e: any) {
      res.status(500).json({ success: false, message: e.message });
    }
  });

  // Diagnóstico de confirmaciones: guarda, lee y lista
  app.get("/api/admin/test-confirmaciones", async (_req, res) => {
    try {
      const { confirmacionesService } = await import("../confirmaciones");
      const db = await getDb();
      const resultado: any = {};

      // 1. Verificar que la tabla existe y contar registros
      try {
        const existentes = await db.execute(sql`SELECT COUNT(*) as total FROM confirmaciones`);
        resultado.totalActual = existentes;
      } catch (e: any) {
        resultado.errorTabla = e.message;
      }

      // 2. Guardar una confirmación de prueba
      await confirmacionesService.confirmar("TEST-PROVEEDOR", "PRODUCTO-TEST-FACTURA", {
        id: 9999,
        nombre: "PRODUCTO TEST SISTEMA",
        codigo: "TEST123",
      } as any);
      resultado.guardado = "intentado";

      // 3. Leer de vuelta
      const leido = await confirmacionesService.buscar("TEST-PROVEEDOR", "PRODUCTO-TEST-FACTURA");
      resultado.leido = leido;

      // 4. Listar todas
      try {
        const todas = await db.execute(sql`SELECT proveedor, nombreFactura, articuloNombre, valido FROM confirmaciones LIMIT 20`);
        resultado.todas = todas;
      } catch (e: any) {
        resultado.errorListar = e.message;
      }

      res.json(resultado);
    } catch (e: any) {
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  });

  app.get("/api/admin/test-registro", async (_req, res) => {
    try {
      const result = await inventarios365.diagnosticoRegistro();
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  });

  // Diagnóstico: usuarios del sistema y aperturas de caja
  app.get("/api/admin/test-usuarios", async (_req, res) => {
    try {
      const usuarios = await inventarios365.listarUsuarios();
      res.json({ total: usuarios.length, usuarios: usuarios.slice(0, 10) });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  app.get("/api/admin/test-caja", async (req, res) => {
    try {
      const usuario = String(req.query.usuario || "");
      const mes = String(req.query.mes || new Date().toISOString().slice(0, 7));
      // Estructura cruda de la primera página
      const raw = await inventarios365.diagRaw("/caja?page=1&buscar=&criterio=");
      let arr: any = raw?.cajas ?? raw?.data ?? raw?.movimientos ?? raw;
      if (arr?.data) arr = arr.data;
      const ejemplo = Array.isArray(arr) ? arr[0] : null;
      const aperturas = usuario ? await inventarios365.aperturasCajaDelMes(usuario, mes) : [];
      res.json({
        keys: raw && typeof raw === "object" ? Object.keys(raw) : typeof raw,
        camposCaja: ejemplo ? Object.keys(ejemplo) : [],
        ejemploCaja: ejemplo,
        aperturasUsuario: aperturas.length,
        aperturas: aperturas.slice(0, 5),
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Diagnóstico: total de proveedores del sistema
  app.get("/api/admin/test-proveedores", async (_req, res) => {
    try {
      const result = await inventarios365.contarProveedores();
      const todos = await inventarios365.listarTodosProveedores();
      let muestra: any = null;
      try {
        const raw = await inventarios365.diagRaw("/proveedor?page=1&buscar=&criterio=todos");
        const personas = raw?.personas;
        muestra = {
          personasEsArray: Array.isArray(personas),
          personasTieneData: !!personas?.data,
          ejemplo: Array.isArray(personas) ? personas[0] : (personas?.data?.[0] ?? personas),
        };
      } catch {}
      res.json({ ...result, totalListado: todos.length, primeros3: todos.slice(0, 3), muestra });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Diagnóstico: estructura cruda del endpoint de ajuste de inventario
  // Uso: /api/admin/test-inventario?almacen=1&proveedor=96
  app.get("/api/admin/test-inventario", async (req, res) => {
    try {
      const almacen = parseInt(String(req.query.almacen || "1"));
      const proveedor = String(req.query.proveedor || "");
      const raw = await inventarios365.articuloAjusteInven(almacen, proveedor);
      res.json({
        total: raw.length,
        primerProducto: raw[0] || null,
        camposDelPrimero: raw[0] ? Object.keys(raw[0]) : [],
        primeros3: raw.slice(0, 3),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  });

  // Health check endpoint — responde inmediatamente para Railway
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version: "1.0.0", timestamp: new Date().toISOString() });
  });

  // Migraciones en background (no bloquea el arranque)
  if (process.env.NODE_ENV === "production") {
    setTimeout(async () => {
      try {
        console.log("[DB] Corriendo migraciones en background...");
        // Asegurar que el enum de role acepte 'viewer' (drizzle push no siempre altera enums)
        try {
          const { getDb } = await import("../db");
          const { sql } = await import("drizzle-orm");
          const dbConn = await getDb();
          if (dbConn) {
            await dbConn.execute(
              sql.raw("ALTER TABLE users MODIFY COLUMN role ENUM('user','admin','viewer') NOT NULL DEFAULT 'user'")
            );
            console.log("[DB] Enum role actualizado (viewer habilitado)");
          }
        } catch (enumErr) {
          console.warn("[DB] No se pudo alterar enum role (puede ya estar correcto):", enumErr);
        }
        // Agregar columna diasPorTurno a trabajadores (si no existe). Idempotente.
        try {
          const { getDb } = await import("../db");
          const { sql } = await import("drizzle-orm");
          const dbConn = await getDb();
          if (dbConn) {
            await dbConn.execute(sql.raw("ALTER TABLE trabajadores ADD COLUMN diasPorTurno INT NOT NULL DEFAULT 3"));
            console.log("[DB] Columna diasPorTurno agregada");
          }
        } catch { /* ya existe */ }
        // Agregar columna nombreFactura a purchaseItems (preserva emparejamiento en borradores)
        try {
          const { getDb } = await import("../db");
          const { sql } = await import("drizzle-orm");
          const dbConn = await getDb();
          if (dbConn) {
            await dbConn.execute(sql.raw("ALTER TABLE purchaseItems ADD COLUMN nombreFactura VARCHAR(500)"));
            console.log("[DB] Columna nombreFactura agregada");
          }
        } catch { /* ya existe */ }
        // Agregar columna syncIngresoId a purchases (para re-sincronizar compras:
        // identifica QUÉ ingreso de 365 creó cada compra). Va aquí, en el
        // arranque, porque la consultan varios módulos — lección v2.22.1.
        try {
          const { getDb } = await import("../db");
          const { sql } = await import("drizzle-orm");
          const dbConn = await getDb();
          if (dbConn) {
            await dbConn.execute(sql.raw("ALTER TABLE purchases ADD COLUMN syncIngresoId INT"));
            console.log("[DB] Columna syncIngresoId agregada");
          }
        } catch { /* ya existe */ }
        try {
          const { getDb } = await import("../db");
          const { sql } = await import("drizzle-orm");
          const dbConn = await getDb();
          if (dbConn) {
            await dbConn.execute(sql.raw("ALTER TABLE purchases ADD COLUMN preciosFallidos TEXT"));
            console.log("[DB] Columna preciosFallidos agregada");
          }
        } catch { /* ya existe */ }
        // Agregar columna sucursalFija a trabajadores (para sueldos por sucursal)
        try {
          const { getDb } = await import("../db");
          const { sql } = await import("drizzle-orm");
          const dbConn = await getDb();
          if (dbConn) {
            await dbConn.execute(sql.raw("ALTER TABLE trabajadores ADD COLUMN sucursalFija VARCHAR(150)"));
            console.log("[DB] Columna sucursalFija agregada");
          }
        } catch { /* ya existe */ }
        // NOTA: se eliminó "drizzle-kit push --force" del arranque.
        // Era DESTRUCTIVO: borraba las tablas que no están en el schema (ventas,
        // ventas_detalle, clientes, sync_estado), perdiendo datos en cada deploy.
        // Las tablas ya existen y se crean/verifican con SQL directo (idempotente).
        console.log("[DB] Migraciones completadas (sin push destructivo)");
      } catch (e) {
        console.warn("[DB] Error en migraciones:", e);
      }
    }, 3000);
  }

  // Servir archivos subidos localmente
  app.use("/api/storage", express.static(
    (await import("path")).default.join(process.cwd(), "uploads")
  ));

  // Sincronizar almacenes desde inventarios365 (en BACKGROUND, no bloquea el arranque)
  setTimeout(async () => {
    try {
      const almacenes = await inventarios365.listarAlmacenes();
      const { upsertBranchByName } = await import("../db");
      for (let i = 0; i < almacenes.length; i++) {
        const a = almacenes[i] as any;
        await upsertBranchByName(a.nombre_almacen, i === 0 ? 1 : 0);
      }
      console.log(`[Sync] ${almacenes.length} almacenes sincronizados`);
    } catch (e) {
      console.warn("[Sync] No se pudieron sincronizar almacenes:", e);
    }
  }, 8000);

  // ─── Sincronización automática de ventas ───────────────────────────────────
  // Mantiene los reportes al día sin intervención. Diseño SEGURO:
  // - Nunca corre al arrancar (espera 2 min para no afectar el arranque)
  // - Luego cada hora (cubre varios días acumulados gracias al límite de 60 páginas)
  // - Si detecta hueco (demasiadas ventas), repite hasta cerrarlo
  // - Todo en background, con try/catch; jamás bloquea el servidor
  const sincronizarVentasAuto = async () => {
    try {
      const { sincronizarVentasIncremental, refrescarEstadoVentasRecientes } = await import("../sync-ventas");
      let intentos = 0;
      let huboHueco = true;
      // Repetir mientras haya hueco (hasta 5 veces) para cerrar acumulaciones grandes
      while (huboHueco && intentos < 5) {
        const r = await sincronizarVentasIncremental();
        huboHueco = !!r.huboHueco;
        intentos++;
        if (r.nuevas > 0) console.log(`[CronVentas] +${r.nuevas} ventas${huboHueco ? " (hay más, repitiendo)" : ""}`);
        if (huboHueco) await new Promise((res) => setTimeout(res, 1500));
      }
      // Refrescar estados recientes: captura ANULACIONES de ventas ya sincronizadas
      // (la incremental no las ve porque no son ventas nuevas).
      const est = await refrescarEstadoVentasRecientes(2);
      if (est.actualizadas > 0) console.log(`[CronVentas] ${est.actualizadas} estados actualizados (anulaciones)`);
      // Capturar diferencias de caja (faltantes/sobrantes) de cierres nuevos.
      try {
        const { diferenciasCajaService } = await import("../diferencias-caja");
        await diferenciasCajaService.capturarCierres();
      } catch (e) { console.warn("[CronVentas] Error capturando cierres de caja:", e); }
    } catch (e) {
      console.warn("[CronVentas] Error en sincronización automática:", e);
    }
  };
  // Primera corrida 2 min tras arrancar; luego cada hora
  setTimeout(() => {
    sincronizarVentasAuto();
    setInterval(sincronizarVentasAuto, 60 * 60 * 1000); // cada hora
  }, 120000);

  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // Login con Google (lista blanca de correos autorizados)
  const { registerGoogleOAuth } = await import("./google-oauth");
  registerGoogleOAuth(app);
  // Fotos de productos (servidas desde MySQL con caché)
  const { registerFotoProductoRoute } = await import("../fotos-productos");
  registerFotoProductoRoute(app);
  const { registerImagenPostRoute } = await import("../marketing-imagen");
  registerImagenPostRoute(app);
  // Scheduler de publicaciones programadas (cada 5 min, arranca tras 60s).
  // Solo consulta la BD y las APIs de redes; jamás llama a inventarios365.
  setTimeout(() => {
    setInterval(async () => {
      try {
        const { marketing } = await import("../marketing");
        const r = await marketing.publicarProgramados();
        if ((r as any)?.publicados > 0) console.log(`[Marketing] ${(r as any).publicados} post(s) programado(s) publicado(s).`);
      } catch (e: any) { console.warn("[Marketing] scheduler:", e?.message); }
    }, 5 * 60 * 1000);
  }, 60 * 1000);
  // Webhook de pago del banco (BNB/OpenBCB llaman aquí al confirmarse un pago QR)
  app.post("/api/pagos/webhook", async (req: any, res: any) => {
    try {
      // El banco envía el id externo del QR. Aceptamos varios nombres de campo.
      const b = req.body || {};
      const qrId = String(b.qrId || b.id || b.QRId || b.transactionId || b.operationId || "");
      const monto = Number(b.amount || b.monto || 0) || undefined;
      // Validación opcional por secreto compartido
      const secret = process.env.PAGO_WEBHOOK_SECRET;
      if (secret && req.headers["x-webhook-secret"] !== secret && b.secret !== secret) {
        return res.status(401).json({ ok: false });
      }
      if (!qrId) return res.status(400).json({ ok: false, motivo: "sin id" });
      const { pagos } = await import("../pagos");
      const r = await pagos.confirmarPagoWebhook(qrId, monto);
      return res.json(r);
    } catch (e: any) {
      console.error("[Webhook pago] error:", e?.message);
      return res.status(500).json({ ok: false });
    }
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // Endpoint de diagnóstico temporal para probar sincronización desde Cloud Run
  app.get("/api/diag-sync", async (_req, res) => {
    const steps: Record<string, unknown> = {};
    try {
      // Paso 1: Login
      steps.step1_login = "iniciando";
      // Paso 1: Login implícito via listarAlmacenes
      const almacenes = await inventarios365.listarAlmacenes();
      steps.step1_login = "OK";
      steps.step2_almacenes = almacenes.map((a: any) => `${a.id}:${a.nombre_almacen}`);
      // Paso 3: Buscar artículo de prueba
      const articulo = await inventarios365.buscarArticulo("ACTRON");
      steps.step3_buscar_actron = articulo ? `encontrado: ${articulo.nombre} (ID:${articulo.id})` : "NO ENCONTRADO";
      // Paso 4: Buscar proveedor de prueba
      const proveedor = await inventarios365.buscarProveedor("BAGO");
      steps.step4_proveedor_bago = proveedor ? `encontrado: ${proveedor.nombre} (ID:${proveedor.id})` : "NO ENCONTRADO";
      res.json({ ok: true, steps });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message, stack: err?.stack?.split("\n").slice(0, 5), steps });
    }
  });

  // Endpoint de diagnóstico completo: prueba registrarCompra real desde Cloud Run
  app.get("/api/diag-sync-full", async (_req, res) => {
    try {
      const result = await inventarios365.registrarCompra({
        proveedor: "Bago",
        tipoComprobante: "BOLETA",
        numComprobante: `DIAG-${Date.now()}`,
        almacenNombre: "ALMACEN PRINCIPAL",
        items: [{
          nombre: "ACTRON 400",
          cantidad: 1,
          precio: 10,
          fechaVencimiento: null,
        }],
        total: 10,
      });
      res.json({ ok: result.success, result });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message, stack: err?.stack?.split("\n").slice(0, 8) });
    }
  });

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  // Producción (Railway): usar EXACTAMENTE el puerto asignado (buscar otro rompe el ruteo)
  const port = process.env.NODE_ENV === "production"
    ? preferredPort
    : await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  // Timeout extendido a 120s para permitir sincronización con inventarios365.com (puede tardar 30s)
  server.timeout = 120000;
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    // Crear tablas de ventas en background, DESPUÉS de que el server ya escucha.
    // No bloquea el arranque (a diferencia del drizzle-kit push que colgó el sistema).
    if (process.env.NODE_ENV === "production") {
      setTimeout(async () => {
        try {
          const { crearTablasVentas } = await import("../tablas-ventas");
          await crearTablasVentas();
          const { crearTablasGastos } = await import("../tablas-gastos");
          await crearTablasGastos();
          // Columnas de tienda (productos_cache.descripcion/imagenUrl,
          // reservas_tienda.emailCliente/estadoPago): las consultan varios
          // módulos, así que deben existir sí o sí, no solo cuando alguien entra
          // a la tienda. Ver TESTING.md (lección v2.10.3 / v2.22.1).
          const { asegurarTablasTienda } = await import("../tienda");
          await asegurarTablasTienda();
        } catch (e) {
          console.warn("[Startup] Error creando tablas de ventas:", e);
        }
        // CACHE DE PRODUCTOS (precios): estas dos llamadas EXISTÍAN pero NADIE las
        // invocaba — el cache solo se refrescaba si alguien tocaba el botón de
        // "limpiar cache" a mano. Por eso la app podía mostrar un precio viejo
        // (365 en 112.5 y la app en 108) durante días.
        // inicializar() refresca si está realmente vencido; programar… deja la
        // recarga periódica corriendo.
        try {
          const { productosCache } = await import("../productos-cache");
          const edad = await productosCache.edadMinutos();
          console.log(`[Startup] Cache de productos: ${edad == null ? "vacío" : `${edad} min de antigüedad`}`);
          await productosCache.inicializar();
          productosCache.programarActualizacionAutomatica();
        } catch (e) {
          console.warn("[Startup] Error inicializando cache de productos:", e);
        }
      }, 10000); // 10s después de arrancar, sin prisa
    }
  });
}

startServer().catch(console.error);
