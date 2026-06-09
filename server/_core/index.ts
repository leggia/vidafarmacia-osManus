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
      const aperturas = await inventarios365.aperturasCajaDelMes(usuario, mes);
      res.json({ total: aperturas.length, aperturas: aperturas.slice(0, 10) });
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
        const { execSync } = await import("child_process");
        execSync("npx drizzle-kit push --force", { stdio: "inherit" });
        console.log("[DB] Migraciones completadas");
      } catch (e) {
        console.warn("[DB] Error en migraciones:", e);
      }
    }, 3000);
  }

  // Servir archivos subidos localmente
  app.use("/api/storage", express.static(
    (await import("path")).default.join(process.cwd(), "uploads")
  ));

  // Sincronizar almacenes desde inventarios365 al arrancar
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
  const port = await findAvailablePort(preferredPort);

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
