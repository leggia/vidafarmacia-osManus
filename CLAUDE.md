# CLAUDE.md — VidaFarma

Instrucciones para trabajar en este proyecto. (Claude Code lee este archivo automáticamente.)

## Qué es

App web Node.js/TypeScript (React + tRPC + Drizzle/MySQL) de gestión para una farmacia en Cochabamba, Bolivia. Dueño: Luis (`leggia`). Idioma: español. Se integra con inventarios365 (sistema externo de facturación). Para el contexto completo del proyecto, leer `HISTORIAL_PROYECTO.md`.

## Reglas de trabajo

- Responde en español, conciso y directo.
- **Verifica compilación SIEMPRE antes de hacer commit.** El build de vite falla localmente (falta `@builder.io/vite-plugin-jsx-loc`, solo existe en Railway) — eso NO es un error real. Verifica con esbuild:
  - Servidor completo: `npx esbuild server/_core/index.ts --platform=node --packages=external --bundle --format=esm --outdir=/tmp/tb`
  - Un archivo servidor: `npx esbuild server/X.ts --platform=node --packages=external --bundle --format=esm --outfile=/tmp/x.js`
  - Cliente: `npx esbuild client/src/pages/X.tsx --bundle --format=esm --jsx=automatic --external:react --external:react-dom --external:@/* --external:wouter --external:sonner --external:lucide-react --external:recharts --outfile=/tmp/x.js`
- Sube la versión en `package.json` en cada commit (vX.Y.Z).
- Deploy automático: push a `main` → Railway. No hay que hacer nada más.
- Mensajes de commit descriptivos, en español.

## Reglas críticas (no romper)

- **NUNCA** `drizzle-kit push --force` (borra tablas de ventas).
- Columnas nuevas: `ALTER TABLE ... ADD COLUMN` idempotente (try/catch) justo antes de usarlas.
- El servidor debe ESCUCHAR primero; cero llamadas a inventarios365 al arrancar (nada bloqueante).
- Schemas Zod tolerantes (nullable/optional) + sanitizar en el handler. Zod estricto rechaza null/NaN antes del handler y causa error 500 incapturable.
- Variables `const` dentro de un `try` NO son visibles en el `catch`; declararlas antes si el catch las usa.

## Estructura

- `server/routers.ts` — appRouter (asistente, ventas, compras, gastos, confirmaciones, asistencia).
- `server/asistente.ts` — herramientas de consulta del asistente (solo lectura).
- `server/rentabilidad.ts` — cálculo de rentabilidad por sucursal (compartido reporte+asistente).
- `server/inventarios365.ts` — integración con 365 (compras, precios, stock, caja).
- `server/_core/deepseek.ts` — DeepSeek (asistente). `server/_core/llm.ts` — Groq (facturas).
- `server/db.ts` — createPurchase y consultas de compras.
- `client/src/pages/` — Asistente, NuevaCompra, Compras, Inventario, Reportes, Gastos.
- `drizzle/schema.ts` — esquema de la BD.

## Datos del entorno

- Sucursales (nombres exactos en ventas): "Sucursal Petrolera", "Casa Matriz", "Sucursal Lanza", "Casa Matriz Cobol".
- Almacenes: ALMACEN PRINCIPAL=1, Almacen Petrolera=2, Almacen Lanza=3, Almacen Cobol=4.
- Endpoints reales de 365 y más detalle: ver el skill `vidafarma` y `HISTORIAL_PROYECTO.md`.

## Antes de empezar cualquier sesión

1. `git pull` para traer los últimos cambios (Luis trabaja desde varias máquinas).
2. Leer `HISTORIAL_PROYECTO.md` si necesitas contexto de qué se hizo y por qué.
