import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { inventarios365 } from "../inventarios365";
import { getDb } from "../db";
import { sql } from "drizzle-orm";
import { productosCache } from "../productos-cache";

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

  // Endpoint admin para limpiar cache (solo en producción)
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

  // Diagnóstico: estructura de clientes
  app.get("/api/admin/test-clientes", async (_req, res) => {
    try {
      const raw = await inventarios365.diagRaw("/cliente?page=1&buscar=&criterio=global&usuarioid=1");
      // La clave real parece ser "usuarios" — inspeccionar su forma
      const usuarios = raw?.usuarios;
      let arr: any[] = [];
      let formaUsuarios = "desconocida";
      if (Array.isArray(usuarios)) { arr = usuarios; formaUsuarios = "array directo"; }
      else if (Array.isArray(usuarios?.data)) { arr = usuarios.data; formaUsuarios = "paginado .data"; }
      else if (usuarios && typeof usuarios === "object") { formaUsuarios = `objeto con keys: ${Object.keys(usuarios).join(",")}`; }
      const ejemplo = arr[0] || null;
      res.json({
        rawKeys: raw && typeof raw === "object" ? Object.keys(raw) : typeof raw,
        total: raw?.total ?? "?",
        formaUsuarios,
        cantidad: arr.length,
        camposCliente: ejemplo ? Object.keys(ejemplo) : [],
        ejemploCliente: ejemplo,
        primeros3: arr.slice(0, 3),
        // Si usuarios es objeto raro, mostrar un pedazo crudo para ver su forma
        usuariosCrudo: Array.isArray(usuarios) ? `array[${usuarios.length}]` : JSON.stringify(usuarios).substring(0, 500),
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Diagnóstico: estructura de ventas y detalle de productos vendidos
  app.get("/api/admin/test-ventas", async (req, res) => {
    try {
      const { ventas, pagination, raw } = await inventarios365.listarVentasPagina(1);
      const ejemplo = ventas[0] || null;
      // Si hay una venta, traer su detalle de productos
      let detalleEjemplo: any[] = [];
      let cabeceraEjemplo: any = null;
      if (ejemplo?.id) {
        detalleEjemplo = await inventarios365.obtenerDetallesVenta(ejemplo.id);
        cabeceraEjemplo = await inventarios365.obtenerCabeceraVenta(ejemplo.id);
      }
      res.json({
        rawKeys: raw && typeof raw === "object" ? Object.keys(raw) : typeof raw,
        totalVentas: pagination?.total ?? "?",
        ultimaPagina: pagination?.last_page ?? "?",
        camposVenta: ejemplo ? Object.keys(ejemplo) : [],
        ejemploVenta: ejemplo,
        camposDetalle: detalleEjemplo[0] ? Object.keys(detalleEjemplo[0]) : [],
        detalleEjemplo: detalleEjemplo.slice(0, 3),
        cabeceraEjemplo,
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
        const { execSync } = await import("child_process");
        execSync("npx drizzle-kit push --force", { stdio: "inherit" });
        console.log("[DB] Migraciones completadas");
      } catch (e) {
        console.warn("[DB] Error en migraciones:", e);
      }
      // NOTA: la carga histórica de ventas NO corre al arrancar (saturaba el sistema:
      // miles de llamadas a inventarios365). Se hará bajo demanda y por lotes pequeños.
    }, 3000);

    // ── Cron diario de ventas DESHABILITADO temporalmente ──
    // Se reactivará una vez confirmado que el arranque es 100% estable.
    // (Evita cualquier proceso en background que pueda afectar recursos limitados.)
    /* let ultimoDiaSync = "";
    setInterval(async () => {
      try {
        const ahora = new Date();
        const hora = ahora.getHours();
        const min = ahora.getMinutes();
        const hoy = ahora.toISOString().slice(0, 10);
        if (hora === 8 && min < 5 && ultimoDiaSync !== hoy) {
          ultimoDiaSync = hoy;
          console.log("[SyncVentas] Sincronización diaria 8 AM iniciada");
          const { sincronizarVentasIncremental } = await import("../sync-ventas");
          const r = await sincronizarVentasIncremental();
          console.log(`[SyncVentas] Diaria completada: +${r.nuevas} ventas nuevas`);
        }
      } catch (e) {
        console.warn("[SyncVentas] Error en cron diario:", e);
      }
    }, 5 * 60 * 1000); */
  }

  // Servir archivos subidos localmente
  app.use("/api/storage", express.static(
    (await import("path")).default.join(process.cwd(), "uploads")
  ));

  // Sincronizar almacenes desde inventarios365 (NO bloquea el arranque)
  // Se mueve a background: si inventarios365 está lento, el server igual escucha.
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
  }, 5000);

  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
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
  // En producción (Railway/Cloud) usar EXACTAMENTE el puerto asignado.
  // Buscar otro puerto rompería el ruteo de la plataforma ("failed to respond").
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
  });
}

startServer().catch(console.error);
