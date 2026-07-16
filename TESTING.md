# 🧪 Testing / QA — VidaFarma

> Objetivo: **cero crashes en producción.** En un sistema que maneja dinero,
> inventario y clientes, un error cuesta ventas y confianza.

## Chequeo pre-push (obligatorio antes de cada push)

```bash
node scripts/verificar.mjs        # verifica los archivos que cambiaste
node scripts/verificar.mjs --all  # verifica todo el proyecto
```

Corre dos verificaciones sobre cada archivo `.ts/.tsx` tocado:

1. **Heurístico use-before-declaration** (solo `.tsx`): detecta el patrón que causó el
   crash de la tienda — un hook (`useEffect`/`useMemo`/etc.) que usa en su array de
   dependencias una variable declarada *después*. Este error **esbuild NO lo detecta**;
   solo aparece en producción minificada como *"No se puede acceder a 'X' antes de la
   inicialización"*. Por eso el heurístico es valioso.
2. **Compilación esbuild**: el juez fiable de sintaxis. Si un archivo no compila, bloquea.

Si algo falla, el script termina con error (exit 1) y **no debes hacer push** hasta
corregirlo.

> El balance de llaves/paréntesis se probó pero se quitó como bloqueante: daba falsos
> positivos con regex y template literals. La compilación esbuild ya cubre la sintaxis.

## Checklist de release (versiones importantes)

Antes de subir una versión que toca la tienda o flujos críticos:

- [ ] `node scripts/verificar.mjs` pasa sin errores.
- [ ] Compilación del servidor completo: `npx esbuild server/_core/index.ts --platform=node --packages=external --bundle --format=esm --outdir=/tmp/tb`
- [ ] Subir versión en `package.json`.
- [ ] Tras desplegar, **abrir en el navegador** la(s) página(s) que cambiaste (los
      errores de inicialización solo aparecen en producción, no al compilar).
- [ ] Probar el flujo afectado de punta a punta (ej. si tocaste reservas: crear una
      reserva real y verificar que aparece en el panel de staff).

## Casos de prueba de seguridad (críticos por rubro farmacia)

Verificar manualmente cuando se toca la tienda o los permisos:

1. **Controlados nunca visibles:** buscar en la tienda un medicamento controlado (por
   nombre, por principio activo, y por marca conocida) → no debe aparecer.
2. **Roles:** un usuario no-admin no accede a finanzas (reportes, ganancias, gastos).
3. **Precios server-side:** el total de una reserva se calcula en el servidor; no se
   confía en el precio que manda el cliente.
4. **Idempotencia de puntos:** una misma venta/reserva no otorga puntos dos veces.

## Lecciones aprendidas (errores reales que no deben repetirse)

- **Use-before-declaration** en React → crash total en producción. (Cubierto por el
  heurístico.)
- **`drizzle-kit push --force`** borró ventas una vez → PROHIBIDO. Columnas nuevas con
  ALTER idempotente (try/catch).
- **Llamadas a 365 al arrancar** → el servidor debe escuchar primero.
- **Zona horaria** (servidor UTC, Bolivia UTC-4) → usar `ahoraBolivia()`.
- **365 rechaza peticiones muy rápidas** → reintentos + pausa.
- **Migración idempotente que solo corre en UN endpoint** → si una tabla tiene
  columnas nuevas agregadas por `ALTER TABLE ... ADD COLUMN` (patrón try/catch
  correcto), esa migración debe llamarse al **inicio de TODOS los endpoints que
  leen o escriben esa tabla**, no solo el primero que se escribió. Si un endpoint
  de solo LECTURA corre antes de que cualquier endpoint de escritura haya
  disparado el ALTER, la consulta falla con "Unknown column" y el error se
  disfraza de "no hay datos" en el frontend — pasó con Inventario (v2.10.3): los
  inventarios existían, pero `listarSesiones` reventaba en silencio antes de que
  nadie completara un conteo nuevo. **Patrón correcto:** extraer la migración a
  una función compartida nombrada (`asegurarColumnasX(db)`) y llamarla al inicio
  de cada endpoint que toca esa tabla — nunca dejarla inline en un solo lugar.
  Cubierto parcialmente por `scripts/verificar.mjs` (ver más abajo), pero requiere
  también revisión manual al agregar columnas a una tabla existente.
- **La misma trampa, CRUZANDO ARCHIVOS** (v2.22.1, Reservas colgada): la columna
  `reservas_tienda.estadoPago` la agregaba un `ALTER TABLE` dentro de `pagos.ts`,
  pero `tienda.ts` la SELECCIONABA en `listarReservas`. Al abrir /reservas antes de
  que corriera cualquier endpoint de pagos, la query fallaba con "Unknown column",
  react-query reintentaba, y la UI **se quedaba cargando para siempre** (no mostraba
  error porque solo miraba `isFetching && !data`). Dos aprendizajes:
  1. **La migración de una columna consultada por VARIOS módulos debe correr al
     ARRANCAR** (bloque de `_core/index.ts`, junto a `crearTablasVentas` /
     `crearTablasGastos`), no de forma perezosa dentro del `asegurarTablas` de un
     módulo. Así ningún módulo puede ganarle la carrera.
  2. **En el frontend, un error nunca debe verse como carga.** Toda pantalla que
     muestre "Cargando…" debe capturar `error` de la query y mostrar un estado de
     error con botón de reintentar (igual que se hizo en Inventario en v2.10.3).
  Ambos casos los detecta ahora `verificar.mjs` (chequeo cruzado de archivos).
- **Un endpoint que "actualiza" puede REESCRIBIR campos que no le pediste**
  (v2.25.2, precios de venta que volvían solos al valor viejo): en 365,
  `/articulo/actualizarPrecios` (usado para el COSTO) reescribe **todos** los
  precios del artículo, incluido `precio_uno` (venta). Como el paso de costos
  corría DESPUÉS del de precios de venta y rellenaba `precio_uno` con lo que
  devolvía 365 (que no refleja el cambio al instante), **revertía el precio recién
  puesto**. Solo afectaba a los productos con cambio de costo Y de venta a la vez
  — de ahí el desconcertante "solo cambió la mitad". Reglas que quedan:
  1. Si un endpoint recibe un payload con varios campos, asumir que **reescribe
     todos**: hay que mandarle los valores que queremos que queden, nunca releer y
     reenviar (eso reintroduce datos viejos).
  2. **Verificar releyendo** después de escribir (patrón ya usado en ajustes de
     inventario): 365 puede responder 200 OK sin haber aplicado nada.
  3. El orden importa: lo más delicado (el precio) se aplica y verifica **al
     final**, después de cualquier operación que pueda tocarlo.
  4. **Nunca escribir el cache local con un valor "esperado"**: hacerlo antes de
     confirmar que 365 lo aplicó hace que la app muestre un precio que 365 no
     tiene (el usuario ve el precio nuevo en la lista y el viejo en 365, y no
     entiende nada). El cache se refresca solo DESPUÉS de verificar.

  **Puntos que escriben precios en 365** (revisar los tres al tocar precios):
  `registrarCompra` (PASO 3 venta / 3b costo / 3c verificación),
  `actualizarPrecioCosto` y la acción `cambiarPrecioVenta` del asistente. Las
  TRANSFERENCIAS no tocan precios (verificado). Todas usan el mismo motor
  `verificarYReintentarPrecios`.

## Smoke tests (lógica crítica, sin BD)

```bash
npm run smoke     # compila server/tests/smoke.ts con esbuild y lo ejecuta
```

12 pruebas sobre los módulos PUROS (`server/domain/*` + diccionario), ejecutables en
cualquier entorno incluso sin `node_modules`:

1. **Controlados** (5): tramadol/codeína por nombre, controlado en la DESCRIPCIÓN
   (principio activo), benzodiacepinas y precursores, y que la venta libre NO se
   bloquee. → Garantiza el caso de seguridad #1: un controlado nunca aparece en la
   tienda.
2. **Diccionario** (4): principio→marcas (ibuprofeno→advil), marca→principio
   (panadol→paracetamol), reconocimiento dentro de nombres completos.
3. **Teléfono** (2): formatos distintos (+591, guiones, espacios) → misma llave de
   puntos; inválidos → null. Protege la identidad cross-canal de la fidelidad.
4. **Descuentos en cascada** (1): la matemática del dinero de compras.

La lógica se extrajo a módulos puros para poder testearla: `server/domain/controlados.ts`
(esControlado, re-exportado por tienda.ts) y `server/domain/telefono.ts` (normTel).
Los tests de vitest (`server/domain/*.test.ts`) siguen disponibles para la PC/CI con
`npm test`.

## Entorno de staging (antes de producción)

**Protección de código YA construida** (`MODO_STAGING=true`): en `server/inventarios365.ts`,
el método `post()` — el ÚNICO punto por donde pasan TODAS las escrituras a
inventarios365 (compras, ajustes de stock, transferencias, precios) — intercepta
la llamada y la SIMULA (no llega a 365 real, se loguea `[STAGING] Simulado...`).
Las LECTURAS (`get()`) siguen yendo a 365 real sin cambios (no hay riesgo en leer).
Por eso el staging puede usar las MISMAS credenciales de 365 sin peligro: nada se
modifica de verdad, pase lo que pase en las pruebas.

Aviso visible: un banner ámbar fijo arriba de toda la app ("🧪 MODO STAGING…"),
visible incluso sin iniciar sesión, para que nadie confunda este entorno con
producción. Se activa solo con la variable de entorno, sin tocar código.

**Pasos en Railway (esto lo hace Luis — Claude Code no tiene acceso a Railway):**
1. En el proyecto de Railway, crear un nuevo servicio ("New Service" → "GitHub Repo",
   mismo repo `vidafarmacia-osManus`, rama `main`).
2. Agregar una base de datos MySQL NUEVA para ese servicio (para que las ventas y
   compras de prueba no se mezclen con las reales) — Railway la conecta sola vía
   variable `DATABASE_URL` si se usa su plugin de MySQL.
3. Copiar las demás variables de entorno del servicio de producción (credenciales
   de 365, DEEPSEEK_API_KEY, etc. — es seguro reusarlas porque las escrituras a 365
   quedan simuladas).
4. Agregar la variable `MODO_STAGING` = `true` a este servicio nuevo (y NO
   agregarla al de producción).
5. Railway genera una URL propia para este servicio (ej.
   `vidafarmacia-osmanus-staging.up.railway.app`) — esa es tu URL de pruebas.
6. Antes de un cambio importante: probar ahí primero. El código es idéntico al de
   producción (mismo repo/rama), solo cambia la base de datos y el modo staging.

## Pendiente (mejoras futuras)

- Entorno de staging (rama/deploy de prueba) antes de producción.
- Integrar `verificar.mjs` + `smoke.mjs` como git hook (pre-push) para que corran solos.
