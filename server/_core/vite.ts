import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  // Servir estáticos con caché profesional:
  // - Assets con hash en el nombre (/assets/*): caché 1 año + immutable.
  //   Como el nombre cambia si el contenido cambia, es seguro cachear "para siempre".
  //   Esto evita re-descargar el JS/CSS (cientos de kB) en cada recarga.
  // - index.html y otros: sin caché (siempre la versión nueva).
  app.use(express.static(distPath, {
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders: (res, filePath) => {
      if (/[\/\\]assets[\/\\]/.test(filePath) || /\.[0-9a-f]{8,}\.(js|css|woff2?|png|jpg|jpeg|svg|gif|webp)$/i.test(filePath)) {
        // Archivos versionados (con hash): cachear agresivamente
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (/\.html?$/i.test(filePath)) {
        // HTML: nunca cachear (para tomar siempre los assets más recientes)
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      } else {
        // Otros estáticos: caché moderada de 1 hora
        res.setHeader("Cache-Control", "public, max-age=3600");
      }
    },
  }));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    // El HTML de entrada nunca se cachea: garantiza cargar la versión desplegada
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
