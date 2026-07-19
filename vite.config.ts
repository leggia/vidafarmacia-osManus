import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import { vitePluginManusRuntime } from "vite-plugin-manus-runtime";


// vitePluginManusRuntime viene del andamiaje original y NO se toca: es un paquete
// externo cuyo comportamiento no se puede verificar sin instalarlo y probarlo en
// un entorno real. Renombrarlo o quitarlo a ciegas rompería el build.
const plugins = [react(), tailwindcss(), jsxLocPlugin(), vitePluginManusRuntime()];

// Versión de la app leída de package.json e inyectada como constante en el
// bundle del cliente. OJO: el servidor importa este archivo en runtime (bundleado
// en dist/), donde import.meta.dirname es dist/ y no la raíz. Por eso se prueban
// varias rutas y NUNCA se lanza error (crashearía el servidor al arrancar).
function leerVersion(): string {
  const candidatos = [
    path.resolve(import.meta.dirname, "package.json"),
    path.resolve(import.meta.dirname, "..", "package.json"),
    path.resolve(process.cwd(), "package.json"),
  ];
  for (const ruta of candidatos) {
    try {
      const v = JSON.parse(readFileSync(ruta, "utf-8")).version;
      if (typeof v === "string") return v;
    } catch {
      // probar la siguiente ruta
    }
  }
  return "?";
}
const appVersion = leerVersion();

export default defineConfig({
  plugins,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  publicDir: path.resolve(import.meta.dirname, "client", "public"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Code-splitting: separar librerías grandes en chunks propios.
    // Como cambian poco, el navegador las mantiene en caché entre despliegues,
    // y solo re-descarga el código de la app cuando este cambia.
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "wouter"],
          "charts": ["recharts"],
          "icons": ["lucide-react"],
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },
  server: {
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1",
    ],
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
