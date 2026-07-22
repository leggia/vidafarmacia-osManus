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

## Endpoints REALES de inventarios365 (confirmados por captura de red)

No inventar endpoints ni payloads: si algo no está aquí, pedir a Luis una captura
(F12 → Network → acción → "Copy as cURL"). Ya pasó que un endpoint inventado
devolvía 200 sin registrar nada.

- **Traspaso (transferencia):** `POST /traspaso/registrar`
  ```json
  { "tipo_traspaso": "Salida", "almacen_origen": 1, "almacen_destino": 3,
    "fecha_traspaso": "2026-07-22",
    "data": [{ "idarticulo": 3247, "idalmacen": 1, "idalmacendes": 3,
               "codigo": "39066", "cantidad_traspaso": 2,
               "nombre_producto": "NOVADOL FORTE COMP",
               "precio_costo_unid": "5.0000", "saldo_stock": "4979" }] }
  ```
  (Antes se usaba `/traspasoproducto/registrar` con otro formato: 365 respondía
  200 y NO registraba. Esa fue la causa de las transferencias que no se reflejaban.)
- **Saldo de un artículo en un almacén:** `GET /inventarios/saldostock?idAlmacen=&idArticulo=`
- **Lista de traspasos (para verificar):** `GET /list/traspasos?fechaInicio=YYYY-MM-DD&fechaFin=YYYY-MM-DD`
- **Cabecera de una venta:** `GET /venta/obtenerCabecera?id=` → el estado real está
  ANIDADO en `cabecera.venta[0].estado`. El listado `/venta?page=` NO refleja
  anulaciones de ventas viejas.
- **Cajas:** `GET /caja?page=&buscar=&criterio=` → trae `fechaApertura`,
  `fechaCierre`, `ventas`, `saldoFaltante`, `saldoSobrante`, `idusuario`, etc.
- **Almacenes:** `GET /almacen/selectAlmacen` (cacheado 10 min).

Almacenes reales: 1 ALMACEN PRINCIPAL · 2 Almacen Petrolera · 3 Almacen Lanza · 4 Almacen Cobol.

## Estado de las ventas (crítico para que los reportes cuadren)

`ventas.estado` es un NÚMERO en texto, no una palabra:
- `"1"` = venta válida · `"0"` = cancelada · `"4"` = anulada/otro.
(En la interfaz de 365 se ve "Cancelado", pero internamente es 0.)

Usar SIEMPRE los filtros de `server/ventas-comun.ts`:
- `FILTRO_NO_ANULADA` → para consultas sobre `ventas` (cuenta solo estado '1').
- `FILTRO_DETALLE_NO_ANULADA` → para `ventas_detalle`, que NO tiene columna estado
  (excluye líneas cuya venta padre está anulada).
Aplicado en: asistente, flujo-caja, resumen-mensual, reportes, diagnosticoMes y
rentabilidad. Si se agrega un reporte nuevo, aplicarlo también o los números no
cuadrarán con 365.

La sincronización incremental solo trae ventas NUEVAS, así que una anulación
posterior no se veía: `refrescarEstadoVentasRecientes(dias)` en `sync-ventas.ts`
consulta la cabecera individual de cada venta reciente y corrige el estado. Corre
en el cron (2 días) y manualmente vía `GET /api/admin/refrescar-estados-ventas`.

## Lecciones críticas (v2.46 → v2.70)

- **Verificar en vivo, no confiar en el 200.** 365 puede responder sin error y no
  aplicar nada. Tras registrar un traspaso se comprueba contra `/list/traspasos`;
  tras ajustar inventario se verifica que el producto siga existiendo.
- **Todo o nada.** Si algún producto no existe en 365 o no hay saldo suficiente en
  el origen, se cancela la transferencia COMPLETA. Nunca dejar operaciones a medias.
- **Nunca buscar almacén/sucursal con `includes()`.** "Casa Matriz" engancha
  "Casa Matriz Cobol" según el orden que devuelva 365. Coincidencia exacta; parcial
  solo si es inequívoca; si es ambigua, rechazar con mensaje claro.
- **Una sola validación por regla.** Las compras se bloqueaban porque el check verde
  usaba `itemEmparejado()` (articuloId O mapa de nombres) pero la validación al
  confirmar solo miraba el mapa. Si dos lugares deciden lo mismo, deben usar la
  MISMA función.
- **Cuidado con N+1 contra 365.** El panel de sueldos paginaba la lista completa de
  cajas por cada trabajador (N × 60 peticiones). Traer una vez + caché compartido y
  filtrar en memoria. Igual con los almacenes.
- **En `routers.ts` cada procedimiento importa `sql` dinámicamente.** Usar `sql`
  sin importarlo compila con esbuild pero revienta en runtime; `npx tsc --noEmit`
  sí lo detecta (por eso es obligatorio antes del push).
- Baseline de errores de tipos: **45**. Si sube, hay algo nuevo mal.

## Módulos agregados en esta etapa

- `server/factura-xml.ts` — lector de factura electrónica XML del SIN (productos,
  precios, descuentos exactos). El XML NO trae vencimiento.
- `server/bandeja.ts` + páginas `Bandeja`, `BandejaDetalle`, `CamaraFactura` —
  bandeja de facturas XML en espera (estados: recibida → emparejada →
  vencimientos_pendientes → validada) y cámara que reconoce la factura física
  contra la bandeja. Rutas: `/bandeja`, `/bandeja/:id`, `/escanear`.
- `server/diferencias-caja.ts` — captura faltantes/sobrantes de cada cierre de caja.
  Solo los SOBRANTES se usan para cuadrar el inventario: cada producto faltante
  contado, valorado a costo (si el costo es 0 se estima venta −20%), descuenta del
  sobrante acumulado desde el último inventario. Banner en Inventario.
- `server/ventas-comun.ts` — filtros de ventas anuladas (ver arriba).
- Obligaciones incluye SUELDOS (`pagos_sueldo`), además de créditos y gastos fijos.
- Reportes por mes: `ventas.mesesDisponibles` alimenta el selector "Otros meses".

## Endpoints de diagnóstico (GET, requieren sesión admin)

`/api/admin/` + `diag-estados-ventas` · `diag-ventas-dia?fecha=&sucursal=` ·
`diag-comparar-365?fecha=&sucursal=` · `diag-cabeceras?fecha=&sucursal=` ·
`diag-cabecera-cruda?id=` · `diag-caja-cruda` · `diag-almacenes` ·
`diag-transferencias` · `refrescar-estados-ventas` · `capturar-cierres-caja`

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
3. Para entender la estructura de negocio (áreas: operaciones, ventas, atención,
   finanzas, desarrollo, testing, marketing, inteligencia, cumplimiento) y la hoja
   de ruta Company of One, leer `SERVICIOS.md`.

## Antes de cada push (OBLIGATORIO)

Correr el chequeo pre-push, que detecta el error use-before-declaration (que esbuild
no ve y crashea en producción) y verifica compilación:

```bash
node scripts/verificar.mjs   # o: npm run verificar
```

No hacer push si falla. Ver `TESTING.md` para el checklist completo de release.

## Migraciones idempotentes (columnas nuevas en tablas existentes)

Si agregas una columna a una tabla existente con `ALTER TABLE ... ADD COLUMN`
(patrón try/catch), extráela a una función compartida nombrada
(`asegurarColumnasX(db)`) y llámala al **inicio de TODOS los endpoints** que leen
o escriben esa tabla — no solo el primero que se escribió. Si la dejas inline en
un solo endpoint, cualquier OTRO endpoint (típicamente uno de lectura, que corre
apenas se abre una pantalla) puede fallar con "Unknown column" antes de que la
migración se dispare, y el error se disfraza de "no hay datos" en el frontend.
Pasó en producción (v2.10.3, inventarios "desaparecidos"). `npm run verificar`
detecta el caso más simple (helper definido pero llamado 0-1 veces); igual
revisa manualmente cada endpoint que toque la tabla.

## Automatizaciones y DeepSeek (horario pico)

Si construyes una automatización que llame a DeepSeek SIN intervención humana
(scheduler, cron, tarea de fondo), evita que se dispare entre **9:00 PM–12:00 AM** y
**2:00 AM–6:00 AM hora Bolivia** (horario pico de DeepSeek, precio doble desde
mediados de julio 2026). Ver detalle en `SERVICIOS.md` §6. Hoy ninguna automatización
existente llama a DeepSeek sola, así que esto solo aplica a features nuevas.
