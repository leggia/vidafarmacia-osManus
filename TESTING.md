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

## Pendiente (mejoras futuras)

- Entorno de staging (rama/deploy de prueba) antes de producción.
- Integrar `verificar.mjs` + `smoke.mjs` como git hook (pre-push) para que corran solos.
