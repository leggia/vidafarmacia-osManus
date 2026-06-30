---
name: vidafarma
description: Conocimiento del proyecto VidaFarma (app web de gestión para una farmacia en Cochabamba, Bolivia, dueño Luis/leggia). Úsalo SIEMPRE que Luis pida trabajar en VidaFarma, su farmacia, el repo vidafarmacia-osManus, el asistente con DeepSeek, el módulo de compras/inventario/reportes/gastos, la integración con inventarios365, o cualquier tarea de código en este proyecto. Contiene credenciales de recuperación, comandos de compilación, endpoints reales de 365, lecciones críticas, las herramientas del asistente y estructura de archivos. Consúltalo al inicio de cada sesión de VidaFarma porque el entorno se reinicia y se pierde el contexto.
---

# VidaFarma — Conocimiento del proyecto

App web Node.js/TypeScript (React + tRPC + Drizzle/MySQL) para gestión de una farmacia. Dueño: Luis (GitHub leggia). Español. Soluciones efectivas, óptimas, escalables.

## Recuperación rápida del entorno (se REINICIA)

cd /tmp && rm -rf vidafarma-repo && git clone https://leggia:TOKEN@github.com/leggia/vidafarmacia-osManus.git vidafarma-repo && cd vidafarma-repo && git config user.email "leggia@vidafarma.bo" && git config user.name "leggia"

- Dir: /tmp/vidafarma-repo. Repo: github.com/leggia/vidafarmacia-osManus.
- Producción: https://vidafarmacia-osmanus-production.up.railway.app
- Deploy: push a main -> Railway auto. MySQL en Railway.
- Token GitHub: pedir a Luis el actual (no inventar). Al push filtrar: sed 's/ghp_[A-Za-z0-9]*/ghp_***/g'.
- Docs en repo: CLAUDE.md, HISTORIAL_PROYECTO.md, GUIA_CLAUDE_CODE.md.

## Verificar compilación SIEMPRE antes de push

El build de vite FALLA localmente (falta @builder.io/vite-plugin-jsx-loc, solo en Railway). NO es error real. Usar esbuild:
- Servidor: npx esbuild server/_core/index.ts --platform=node --packages=external --bundle --format=esm --outdir=/tmp/tb
- Cliente: npx esbuild client/src/pages/X.tsx --bundle --format=esm --jsx=automatic --external:react --external:react-dom --external:@/* --external:wouter --external:sonner --external:lucide-react --external:recharts --outfile=/tmp/x.js
Subir versión en package.json cada commit. Actual: ~v1.73.1.

## Restricciones técnicas

- Node 20. recharts SÍ; lucide-react NO local (sí Railway).
- DB drizzle-orm/mysql2. db.execute(sql.raw()) -> [rows,fields]. Helper rows.
- Sucursales exactas: "Sucursal Petrolera", "Casa Matriz", "Sucursal Lanza", "Casa Matriz Cobol".
- Almacenes: PRINCIPAL=1, Petrolera=2, Lanza=3, Cobol=4.

## Lecciones críticas

- Servidor ESCUCHA primero; cero llamadas a 365 al arrancar.
- NUNCA drizzle-kit push --force (borra ventas). Columnas nuevas: ALTER idempotente.
- try/catch: const dentro del try NO visible en catch.
- Zod estricto rechaza null/NaN antes del handler -> 500. Schemas tolerantes + sanitizar.
- 365 rechaza peticiones muy rápidas (compras grandes): reintentos + pausa.

## Endpoints reales 365

- Ventas: GET /venta?page=N. Pág 1 = más reciente.
- Detalle: GET /venta/obtenerDetalles?id=X.
- Ingreso compra: POST /ingreso/registrar (+ /inventarios/registrar).
- Costo: POST /articulo/actualizarPrecios (precio_costo_unidad/paquete, precio_uno..cuatro).
- Precio venta: POST /articulo/actualizarPrecioVenta {id, precio_uno}.
- Crear producto: POST /articulo/registrar (multipart).
- Listar (stock total): GET /articulo/listarArticulo?buscar=&criterio=todos&idProveedor=.
- Stock POR ALMACÉN: listarParaInventario(idAlmacen, idProveedor).
- Cajas: GET /caja?page=N. Caja abierta = fechaApertura sin fechaCierre.

## Asistente (DeepSeek) — Fase 1 solo lectura

- Modelo deepseek-v4-flash. server/_core/deepseek.ts. Var DEEPSEEK_API_KEY. Caché de contexto. Temp 0.
- Arquitectura segura: herramientas con SQL fijo; el modelo solo elige cuál llamar.
- Anti-alucinación estricto. Red de seguridad función-como-texto (intentarHerramientaPorIntencion).
- Herramientas (server/asistente.ts): ventasPeriodo, comprasProveedor, productoMasVendido, gananciaPeriodo (neta), infoProducto, ventasCliente, trabajadoresSucursal, mejoresVendedores, listarSucursales, stockProducto (por almacén), cajasAbiertas, historialCompraProducto, rentabilidadSucursales, estadoPagosGastos, productosUrgentes, pedidoSucursal (índice de cobertura).
- Lector de facturas: Groq (server/_core/llm.ts). PENDIENTE migrar a visión vigente.

## Estructura

- server/routers.ts — appRouter (asistenteRouter con preguntar/ejecutarHerramienta/intentarHerramientaPorIntencion; ventas, purchases, confirmaciones, gastos, asistencia).
- server/asistente.ts — herramientas consulta.
- server/rentabilidad.ts — calcularRentabilidadPorSucursal (compartido).
- server/inventarios365.ts — compras, precios (con reintentos), stock, caja.
- server/db.ts — createPurchase (guarda precioVenta).
- server/_core/ — deepseek.ts, llm.ts (Groq), env.ts.
- client/src/pages/ — Asistente, NuevaCompra, Compras, Inventario, Reportes, Gastos.
- drizzle/schema.ts — ventas, ventas_detalle, trabajadores, purchases, purchaseItems (precioVenta), productos_cache (sin stock), gastos_registro (sucursal, pagado).

## Pendientes

- Migrar lector de facturas (Groq) a visión vigente.
- Retraso de vendedor (verificar asistencia/sueldos).
- Fase 2 asistente: acciones con confirmación + auditoría.
- Rotar token GitHub. Ideas: Redes Sociales, ventas por Excel, pedido como Excel.

## Migración a Claude Code

Luis: PC 24/7 en Petrolera (también vende), plan Pro. Remote Control: sesión en esa PC (terminal minimizada), control desde celular. Ver GUIA_CLAUDE_CODE.md.

## Estilo

Respuestas puntuales, pocos tokens. Verificar compilación antes de push. Subir versión. Filtrar token. Honesto (no inventar capacidades ni datos).
