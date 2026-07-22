## v2.46 → v2.70 — Era "Datos que cuadran" (julio 2026)

- **Facturas XML del SIN**: lector que extrae productos, precios y descuentos exactos (sin OCR). Bandeja de facturas en espera con estados, y cámara que reconoce la factura física contra esa bandeja (/bandeja, /escanear).
- **Ventas anuladas**: el estado en 365 es numérico ("1" válida, "0" cancelada, "4" anulada), no texto. Filtros compartidos (`ventas-comun.ts`) aplicados en asistente, reportes, flujo de caja, rentabilidad y diagnóstico del mes; refresco de estados leyendo la cabecera individual de cada venta.
- **Transferencias**: se usaba un endpoint inventado (365 respondía 200 sin registrar). Ahora `POST /traspaso/registrar` con el payload real, validación de saldo en origen, atómicas (todo o nada) y verificadas contra `/list/traspasos`. Historial con el mismo diseño que compras, detalle desplegable y reversión con doble confirmación.
- **Diferencias de caja**: se capturan faltantes/sobrantes de cada cierre. Los sobrantes se explican en el inventario descontando los faltantes de producto valorados a costo (o venta −20% si no hay costo).
- **Obligaciones**: incluye sueldos además de créditos y gastos fijos.
- **Reportes por mes**: selector de meses con datos ("MAYO 26") en vez de rango de fechas suelto.
- **Rendimiento**: la lista de cajas de 365 se paginaba por cada trabajador (N×60 peticiones) — ahora una vez con caché compartido; almacenes cacheados 10 min.
- **Compras**: se desbloqueó el registro cuando los productos ya estaban emparejados automáticamente; el emparejamiento ahora se aprende al sincronizar.
- **Vencimientos**: campo de edición libre (11/27 o 31/12/2027) con formato automático y escaneo por foto de la caja.

## v1.85 → v2.3 — Era "Tienda + Marketing" (julio 2026)

- **Tienda pública** (/tienda): búsqueda por principio activo (descripción 365 + diccionario), carrito, reservas VF-XXXX, home estilo CVS (recompensas, categorías, más vendidos, carrusel ofertas), barra sticky, PWA con símbolo de marca.
- **Promociones**: motor unificado (ofertas, cupones, promos por monto), cálculo server-side, gestionado por el asistente.
- **Fidelidad**: puntos unificados por TELÉFONO (mostrador 365 + online), 1 pt/Bs, vale a los 1000; recordatorios de recompra por tasa de consumo con registro de contacto.
- **Pagos QR**: arquitectura enchufable BNB/OpenBCB + modo manual con comprobante.
- **Cuentas de cliente**: Google sin lista blanca (rol cliente), mis reservas, recompra.
- **Seguridad**: filtro de controlados reforzado (nombre+principio+diccionario), roles, auditoría, política de privacidad (/privacidad).
- **Testing**: chequeo pre-push (scripts/verificar.mjs) — heurístico use-before-declaration + esbuild. Ver TESTING.md.
- **Marketing** (/marketing): agente redactor con datos reales, imagen IA (Together/FLUX) o foto propia, cola de aprobación, publicación enchufable (Facebook/Ayrshare), calendario con scheduler, sugerirOfertas (anti-merma) y segmentarClientes en el asistente.

# Changelog — VidaFarma OS

Formato: [Semantic Versioning](https://semver.org/)

## [1.0.2] — 2026-05-25

### Mejorado
- Threshold de matching subido a 0.80 — solo registra automáticamente coincidencias de alta confianza
- Productos con score 0.50-0.79 van al panel de confirmación con sugerencia visible
- Panel muestra sugerencia del sistema con % de similitud y botón Confirmar
- Score incluido en resultado de búsqueda para control preciso
- Proveedor no encontrado ya no bloquea búsqueda de productos

---

## [1.0.1] — 2026-05-25

### Corregido
- Fecha de vencimiento ahora se envía correctamente a inventarios365 (YYYY-MM-DD → MM/YYYY)
- Panel de productos no encontrados siempre visible cuando hay productos sin emparejar
- Mensaje claro cuando la compra no se registra por falta de emparejamientos
- Búsqueda de productos sin filtro de proveedor cuando el proveedor no existe en sistema
- idproveedor ya no hardcodeado a 1 cuando proveedor no se encuentra

---

## [1.0.0] — 2026-05-24

### Añadido
- Sistema de autenticación local (reemplaza OAuth de Manus)
- Extracción de datos de facturas con IA (Groq / Llama 4 Scout)
- Soporte para imágenes JPG/PNG y PDFs
- Sincronización automática con inventarios365.com
- Cache de 4715 productos en MySQL para matching rápido
- Sistema de confirmaciones aprendidas por proveedor
- Panel de productos no encontrados con búsqueda y creación
- Extracción automática de fechas de vencimiento (columna VCTO)
- Limpieza de códigos numéricos en nombres de productos
- Sincronización automática de almacenes al iniciar
- CI/CD con GitHub Actions + Railway
- Health check endpoint `/api/health`
- Auto-migración de base de datos en producción

### Técnico
- Migrado de archivos JSON a MySQL para persistencia
- Eliminada dependencia de Manus OAuth SDK
- Variables de entorno centralizadas y tipadas
- Versionado semántico
