# VidaFarma — Sistema de Automatización de Compras

Documentación técnica del sistema de registro automático de compras para la farmacia VidaFarma, que extrae datos de facturas mediante IA y los registra en inventarios365.com.

---

## 1. Qué hace el sistema

El sistema automatiza el proceso de registrar compras a partir de facturas de proveedores:

1. El usuario sube una foto o PDF de la factura
2. La IA (Groq Llama 4 Scout) extrae los productos, cantidades, precios y fechas de vencimiento
3. El sistema empareja cada producto con su equivalente en inventarios365.com
4. Aprende de cada emparejamiento manual para reconocerlo en el futuro
5. Permite crear productos nuevos que no existen en el sistema
6. Evalúa el margen de venta y permite ajustar precios
7. Registra todo en inventarios365.com (stock, fechas de vencimiento, precios)

---

## 2. Arquitectura

### Stack tecnológico
- **Frontend:** React + TypeScript + Vite + Tailwind (componentes shadcn/ui)
- **Backend:** Node.js + tRPC + superjson
- **Base de datos:** MySQL (Railway)
- **IA:** Groq API con Llama 4 Scout (visión + extracción)
- **Despliegue:** Railway con CI/CD vía GitHub Actions
- **Integración:** inventarios365.com (Laravel + PrimeVue)

### Flujo de datos
```
Factura (foto/PDF)
   ↓
Groq Llama 4 Scout (extracción)
   ↓
Emparejamiento (confirmaciones aprendidas + búsqueda por similitud)
   ↓
Validación de margen + ajuste de precio
   ↓
Registro en inventarios365.com (3 pasos)
```

---

## 3. Integración con inventarios365.com

El sistema replica exactamente las peticiones que hace la interfaz web oficial. Todos los endpoints fueron descubiertos capturando el tráfico real de red.

### Autenticación
- `GET /` → obtiene token CSRF (`_token`) y cookie `XSRF-TOKEN`
- `POST /` con form-data (usuario/contraseña) → obtiene `laravel_session` y `XSRF-TOKEN` nuevos
- Se guarda el `_token` como `csrfToken` (requerido en peticiones POST)

### Headers requeridos en cada POST
- `Cookie`: XSRF-TOKEN + laravel_session
- `X-XSRF-TOKEN`: token decodificado de la URL
- `X-CSRF-TOKEN`: el `_token` del formulario
- `X-Requested-With: XMLHttpRequest`
- `Referer: {BASE_URL}/main`

### Registro de compra — proceso de 3 pasos
Este fue el descubrimiento clave: el sistema NO registra todo en una sola petición.

**Paso 1 — Crear ingreso y subir stock:**
```
POST /articulo/registrar... (vía /ingreso/registrar)
Campo: data: [...]
Respuesta: { id: N }
```

**Paso 2 — Guardar fechas de vencimiento:**
```
POST /inventarios/registrar
Campo: inventarios: [{ idarticulo, idalmacen, cantidad, fecha_vencimiento }]
```
Sin este paso, las fechas NO se guardan aunque el stock sí suba.

**Paso 3 — Actualizar precios de venta (si el usuario los editó):**
```
POST /articulo/actualizarPrecioVenta
Payload: { id: idarticulo, precio_uno: nuevoPrecio }
```

### Formato de fecha
El sistema usa **YYYY-MM-DD** (ej: 2028-05-31) en el campo `fecha_vencimiento`. El sistema internamente guarda en el campo `vencimiento`. Por seguridad se envía en ambos campos.

### Crear producto nuevo
```
POST /articulo/registrar (multipart form-data)
Campos: nombre, descripcion, unidad_envase, precio_costo_unid,
        precio_costo_paq, precio_uno (venta), stock, codigo,
        idcategoria, idproveedor, fechaVencimientoSeleccion: 0, etc.
```
Al crear NO se asigna fecha ni cantidad; eso se hace luego en el registro de compra.

### Listar categorías
```
GET /categorianewview?page=1&buscar=&criterio=nombre
```

### Almacenes disponibles
- 1: ALMACEN PRINCIPAL
- 2: Almacen Petrolera
- 3: Almacen Lanza
- 4: Almacen Cobol

---

## 4. Sistema de aprendizaje (confirmaciones)

El sistema "aprende" a emparejar productos mediante una tabla de confirmaciones.

### Cómo funciona
- Cada vez que el usuario empareja manualmente un producto de factura con uno del sistema, se guarda la relación
- La próxima vez que aparezca ese producto, se empareja automáticamente
- Esto es un patrón de memoria acumulada (no reentrenamiento del modelo de IA)

### Normalización robusta
El reto principal: el LLM no extrae nombres idénticos cada vez ("ACTRON 400 mg" vs "ACTRON 400mg" vs "ACTRON 400 MG x 10 Caps"). La normalización unifica estas variaciones:
- Quita tildes y puntuación
- Une número + unidad: "400 mg" → "400MG"
- Quita presentaciones: CAPS, COMP, TAB, JBE, GEL, AMPOLLA, etc.
- Quita cantidades de presentación: "x10", "x 100"

Así el mismo producto siempre coincide con su confirmación guardada, sin importar variaciones menores del LLM.

### Tabla `confirmaciones`
- `proveedor`, `nombreFactura` (clave de búsqueda, normalizada)
- `articuloId`, `articuloNombre`, `articuloCodigo` (producto del sistema)
- `valido` (1/0)

---

## 5. Funcionalidades del registro de compra

### Emparejamiento
- Búsqueda filtrada por proveedor cuando se identifica (threshold 0.50)
- Búsqueda sin filtro más estricta (threshold 0.80) para evitar falsos positivos
- Botón de lupa por fila para emparejar/corregir manualmente
- No permite confirmar la compra hasta que TODOS los productos estén emparejados (la factura se registra completa)

### Precios
- El costo unitario se recalcula como subtotal/cantidad
- Valida la suma contra el total de la factura
- Maneja cantidades en cajas (cajas × unidades por caja)

### Margen de venta
- Al emparejar, trae el precio de venta actual del sistema
- Calcula el margen: (precioVenta − costo) / precioVenta
- Alerta en rojo si el margen es menor al 20%
- Sugiere precio al 23% como referencia (editable, decisión del usuario)
- El precio editado se actualiza en el sistema al registrar

### Fechas de vencimiento
Soporta múltiples formatos:
- YYYY-MM-DD (se mantiene)
- MM/YYYY → último día del mes (06/2027 → 2027-06-30)
- DD/MM/YYYY → YYYY-MM-DD
- YYYY/MM/DD → YYYY-MM-DD
- Fechas dentro del nombre del producto (FV:2027/08/31)

### Creación automática de productos
- Cuando un producto no existe, se puede crear desde la fila
- Precio de venta sugerido = costo + 23% (editable)
- Categoría sugerida por IA de las categorías existentes
- Tras crear, se empareja automáticamente

---

## 6. Estructura del código

### Backend (server/)
- `inventarios365.ts` — Cliente de integración: login, registro, búsqueda, crear producto, actualizar precio, conversión de fechas, cálculo de similitud
- `routers.ts` — Endpoints tRPC: compras, confirmaciones, extracción con IA, categorías
- `confirmaciones.ts` — Sistema de aprendizaje: guardar/buscar/normalizar emparejamientos
- `_core/index.ts` — Servidor, health check, endpoints admin
- `_core/llm.ts` — Cliente de Groq (max_tokens 8000)
- `db.ts` — Acceso a MySQL (compras, items)
- `drizzle/schema.ts` — Esquema de base de datos

### Frontend (client/src/pages/)
- `NuevaCompra.tsx` — Pantalla principal: subida, extracción, emparejamiento, márgenes, creación de productos
- `Compras.tsx` — Lista de compras con botón eliminar y reintentar
- `Home.tsx` — Panel de control

### Configuración
- `nixpacks.toml` — Node 20, pnpm, graphicsmagick, ghostscript, poppler
- `.github/workflows/deploy.yml` — CI/CD con Railway CLI

---

## 7. Endpoints de administración (diagnóstico)

- `POST /api/admin/clear-cache` — Limpiar caché de productos
- `POST /api/admin/clear-confirmaciones` — Limpiar emparejamientos aprendidos
- `GET /api/admin/test-confirmaciones` — Verificar guardado/lectura de confirmaciones
- `GET /api/admin/test-registro` — Diagnóstico de registro

---

## 8. Historial de versiones (hitos)

- **v1.3.x** — Endpoints corregidos, X-CSRF-TOKEN, botón emparejar por fila
- **v1.4.x** — Emparejamiento manual persiste (await), nombre original preservado, cliente tRPC para superjson, manejo de errores del LLM
- **v1.5.x** — Registro en dos pasos (SOLUCIÓN de fechas), formato de fecha, fecha en nombre, último día del mes, validación de emparejamiento completo
- **v1.6.x** — Creación automática de productos, alerta de margen, precio editable, normalización robusta, actualización de precio de venta

---

## 9. Restricciones técnicas conocidas

- Especificaciones del PC de desarrollo: Intel i3 12va gen, 8GB RAM, Windows 11
- Gemini API está restringida geográficamente en Bolivia
- El proveedor Bagó no existe en el sistema, se usa idproveedor 0
- Railway tiene límite de 30 segundos por petición (el registro usa timeout de 25s)
- El LLM no es determinista: la normalización robusta compensa las variaciones

---

## 10. Próximos pasos sugeridos

- Migrar a DeepSeek manteniendo prompt fijo (cache-hit reduce costo ~98%)
- Construir servidor MCP exponiendo funciones de la farmacia
- Agente central con enrutamiento por complejidad de tarea
- Extracción desde código QR de facturas (SIN/Impuestos Bolivia)
- Transferencias entre sucursales
- Interacción por voz
