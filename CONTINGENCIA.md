# 🔄 CONTINGENCIA Y RECUPERACIÓN — VidaFarma

> Documento de arranque rápido. Si el entorno de trabajo se reinició, seguir estos pasos
> para restaurar todo y continuar SIN interrupciones. Mantener este archivo actualizado.

---

## ⚡ RECUPERACIÓN RÁPIDA (copiar y pegar)

Cuando el entorno se reinicia, el repositorio, la config de git y el token se pierden.
Para restaurar todo de una vez (reemplazar `TOKEN` por el token vigente que el usuario provea en el chat):

```bash
cd /tmp && rm -rf vidafarma-repo && \
git clone https://github.com/leggia/vidafarma-os.git vidafarma-repo && \
cd vidafarma-repo && \
git config user.email "leggia@vidafarma.bo" && \
git config user.name "leggia" && \
git remote set-url origin https://leggia:TOKEN@github.com/leggia/vidafarma-os.git && \
echo "✅ Entorno restaurado. Versión actual:" && \
cat package.json | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])"
```

> ⚠️ El TOKEN NUNCA debe escribirse en ningún archivo del repo (quedaría público en GitHub).
> Solo se usa en memoria, en el comando `git remote set-url`. El usuario lo provee en el chat.

---

## 📍 DATOS CLAVE DEL PROYECTO

| Dato | Valor |
|------|-------|
| Repo | https://github.com/leggia/vidafarma-os |
| Directorio de trabajo | `/tmp/vidafarma-repo` |
| App en producción | https://vidafarmacia-osmanus-production.up.railway.app |
| Sistema integrado | https://vidafarmacia.inventarios365.com (login: superadmin/superadmin) |
| Despliegue | Railway (auto-deploy al hacer push a main) |
| Base de datos | MySQL en Railway (migraciones automáticas: drizzle-kit push al arrancar) |

---

## 🔁 FLUJO DE TRABAJO ESTÁNDAR (cada cambio)

1. **Verificar entorno**: si `/tmp/vidafarma-repo` no existe → ejecutar RECUPERACIÓN RÁPIDA.
2. Hacer los cambios en el código.
3. **Verificar compilación SIEMPRE antes de subir**:
   ```bash
   cd /tmp/vidafarma-repo
   # Servidor:
   npx esbuild server/_core/index.ts --platform=node --packages=external --bundle --format=esm --outdir=/tmp/tb 2>&1 | grep -E "error|Done|kb"
   # Cliente (página editada):
   npx esbuild client/src/pages/ARCHIVO.tsx --bundle --format=esm --jsx=automatic --external:react --external:react-dom --external:@/* --external:wouter --external:sonner --external:lucide-react --outfile=/tmp/t.js 2>&1 | tail -2
   ```
4. **Subir versión** (incrementar en package.json) y push:
   ```bash
   cd /tmp/vidafarma-repo && python3 -c "import json; p=json.load(open('package.json')); p['version']='X.Y.Z'; json.dump(p,open('package.json','w'),indent=2)"
   git add -A && git commit -m "mensaje" && git push origin main
   ```
5. Railway despliega solo en 3-4 minutos.

---

## ⚙️ RESTRICCIONES TÉCNICAS (no romper)

- **Node 20** requerido. Build con esbuild `--packages=external`.
- NO agregar dependencias npm que pnpm no resuelva (usar APIs nativas de Node 20, ej. FormData nativo).
- `app.set("trust proxy", 1)` necesario para login en Railway.
- Migraciones: `drizzle-kit push --force` corre en background al arrancar (server/_core/index.ts ~línea 138).
  Por eso las tablas nuevas en `drizzle/schema.ts` se crean solas al desplegar (NO hacen falta archivos de migración).
- Build del cliente: solo clases Tailwind core. publicDir `client/public` → `dist/public`.
- Verificación de llaves balanceadas antes de subir (útil en archivos grandes):
  ```bash
  node -e "const c=require('fs').readFileSync('ARCHIVO','utf8');let b=0,p=0;for(const x of c){if(x==='{')b++;if(x==='}')b--;if(x==='(')p++;if(x===')')p--;}console.log('Llaves',b,'Par',p)"
  ```

---

## 🔌 ENDPOINTS REALES DE inventarios365 (confirmados por captura de red)

> Estos son los endpoints reales descubiertos. NO inventar otros nombres.

### Autenticación
- `GET /` → token CSRF (`_token`) + cookie XSRF
- `POST /` (form-data usuario/contraseña) → laravel_session + XSRF
- Headers POST requeridos: Cookie, X-XSRF-TOKEN (decodificado), X-CSRF-TOKEN (=_token), X-Requested-With: XMLHttpRequest, Referer: BASE/main

### Compras (registro de 4 pasos)
1. `POST /ingreso/registrar` — campo `data:[detalle]` → crea ingreso, sube stock. Devuelve {id}.
2. `POST /inventarios/registrar` — campo `inventarios:[{idarticulo,idalmacen,cantidad,fecha_vencimiento}]` → guarda vencimientos.
3. `POST /articulo/actualizarPrecioVenta` — `{id, precio_uno}` → actualiza precio de venta.
4. (local) guarda historial de precios.

### Productos
- `GET /articulo/listarArticulo?buscar=X&criterio=todos&idProveedor=Y` — buscar productos (catálogo).
- `POST /articulo/registrar` (multipart form-data) — crear producto nuevo.
- `GET /categorianewview?page=1&buscar=&criterio=nombre` — listar categorías.

### Proveedores
- `GET /proveedor/selectProveedor?filtro=X` → {proveedores:[{id,nombre}]} (requiere filtro ≥2 letras).
- `GET /proveedor?page=1&buscar=&criterio=todos` → lista TODOS los proveedores (para contar el total). **criterio=todos, NO nombre.**

### Inventario físico / Ajuste
- `GET /articuloAjusteInven?page=N&buscar=&criterio=nombre&idAlmacen=X&idProveedor=Y` → lista para ajuste.
  - Campos REALES: `id`, `codigo`, `nombre`, `idproveedor`, `nombre_categoria`, `nombre_proveedor`, `stock_total` (← el stock), `fechas_vencimiento:[{fecha_vencimiento, stock, id}]`.
  - El `id` dentro de fechas_vencimiento = inventario_id (lote) para el ajuste.
  - NO trae costo ni precio de venta.
  - Tiene paginación.
- `POST /ajuste/registrar-multiple` — ajustar stock tras conteo. Payload:
  ```
  {almacen_id, motivo_id, productos:[{producto_id, inventario_id, cantidad,
    tipo_movimiento:"salida"|"entrada", stock_anterior, stock_real, es_padre:1,
    producto_padre_id:null, fecha_vencimiento, fecha_vencimiento_original}]}
  ```
  - motivo_id=2 = "Ajuste periodico". tipo "salida" si físico<sistema, "entrada" si físico>sistema. cantidad=diferencia absoluta.

### Almacenes (sucursales)
1: ALMACEN PRINCIPAL · 2: Almacen Petrolera · 3: Almacen Lanza · 4: Almacen Cobol

---

## 📊 ENDPOINTS DE DIAGNÓSTICO (abrir en navegador, ya logueado)

- `/api/admin/test-inventario?almacen=1&proveedor=96` — estructura cruda del listado de ajuste.
- `/api/admin/test-proveedores` — total de proveedores y qué endpoint funcionó.
- `/api/admin/test-confirmaciones` — verifica guardado/lectura de confirmaciones.
- `/api/admin/clear-confirmaciones` (POST) — limpiar emparejamientos aprendidos.

---

## 🧠 SISTEMAS INTELIGENTES (cómo funcionan)

- **Confirmaciones de productos** (`server/confirmaciones.ts`): aprende nombre factura → producto. Hasta 4 alias por producto. Match exacto + aproximado (Levenshtein). Números/concentraciones deben coincidir EXACTO (400≠600).
- **Confirmaciones de proveedores** (`server/confirmaciones-proveedores.ts`): aprende nombre factura → proveedor. Normaliza quitando S.A., SRL, LABORATORIOS, DE BOLIVIA, etc.
- **Historial de precios** (`server/historial-precios.ts`): registra costo de cada compra. Alerta si sube ≥5%.
- **Inventario** (`server/routers.ts` inventarioRouter + `client/src/pages/Inventario.tsx`): sesiones con nombre/sucursal, conteo por proveedor (anual) o ABC (cíclico), progreso sobre total de proveedores, ajuste real de stock.

---

## ⏳ PENDIENTES

- **PENDIENTE 1**: probar emparejamiento inteligente multi-alias con facturas reales (usuario no tenía a mano).
- **PENDIENTE 2**: consulta del agente "¿cuál es el precio más bajo que compré X?" (infraestructura lista en historial-precios.ts).
- Probar ajuste real de stock con cuidado (1 producto, diferencia pequeña) antes de inventario completo.
- Revocar y rotar el token de GitHub al terminar cada sesión.

---

## 📜 HISTORIAL DE VERSIONES (resumen)

- v1.6.x: creación de productos, margen, precio editable, normalización robusta, actualizar precio venta
- v1.7.x: móvil (cámara, compresión), PWA Android, cropper, descuento INTI, panel emparejamiento, filtro proveedor
- v1.8.0: emparejamiento multi-alias + match aproximado (con seguridad de concentraciones)
- v1.9.0: historial de precios + alerta de costo elevado
- v1.10.0–1.13.0: módulo de inventario (ABC, sesiones, ajuste real de stock, progreso global)
- v1.14.x: proveedores inteligentes (aprenden) + filtro productos por proveedor + endpoint proveedores correcto
- v1.15.0–1.17.0: PDF de conteo optimizado, doble descuento, autoguardado + protección de cierre
- v1.18.0–1.21.0: continuar borradores, ABC global, conteo puntual con caché, descuento distribuido, layout tarjeta
- v1.22.0–1.23.0: módulo de asistencia (aperturas de caja), descuentos en cascada por laboratorio
- v1.24.0: arquitectura — lógica de dominio pura en server/domain/ (descuentos, ABC, sueldos) con tests

## 🏛️ ARQUITECTURA Y EVOLUCIÓN
> Ver **ARQUITECTURA.md** para el mapa completo del sistema, deuda técnica,
> plan de reestructuración por fases y roadmap de futuras mejoras.

Lógica de negocio pura (testeable, sin IO) en `server/domain/`:
- `descuentos.ts` — cálculo de descuentos en cascada (comercial + volumen + efectivo)
- `abc.ts` — clasificación ABC de inventario
- `sueldos.ts` — cálculo de asistencia, retrasos y sueldos
- `domain.test.ts` — tests de toda la lógica de dominio

> Para detalles técnicos completos ver DOCUMENTACION.md y ARQUITECTURA.md
