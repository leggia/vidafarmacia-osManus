# Historial del proyecto VidaFarma OS

Resumen de lo construido y aprendido. Para que cualquier sesión de Claude (chat o Claude Code) retome el contexto rápido.

**Desarrollo y diseño:** Luis Omar Tuco Tito — Técnico Superior en Sistemas Informáticos.
_(Autoría del proyecto. Es información interna: NO se muestra en la app ni en la tienda de clientes.)_

## Qué es VidaFarma

App web (Node.js/TypeScript, React, tRPC, Drizzle/MySQL) de gestión para una farmacia en Cochabamba, Bolivia. Dueño: Luis (GitHub `leggia`). Se integra con **inventarios365** (sistema externo Laravel/PHP que Luis paga, usado para facturación fiscal SIN/SFE, login de vendedores y caja). VidaFarma construye todo lo demás: compras, inventario, reportes, gastos, asistencia/sueldos y un asistente conversacional.

- Producción: https://vidafarmacia-osmanus-production.up.railway.app
- Repo: https://github.com/leggia/vidafarma-os
- Deploy: push a `main` → GitHub Actions → Railway (auto). MySQL en Railway.

## Módulos construidos

### Compras
- Registro de compras desde foto de factura (extracción con IA de visión de Groq).
- Sincroniza con 365: registra ingreso (sube stock), actualiza precio de costo (`/articulo/actualizarPrecios`) y precio de venta (`/articulo/actualizarPrecioVenta`).
- Detalle de compra permanente en BD (no se pierde al sincronizar): productos, cantidad, costo, subtotal, vencimiento, y precio de venta.
- Robustez de precios (v1.73.1): reintentos (3x con espera incremental) y pausa entre peticiones, porque 365 rechazaba precios en compras grandes por saturación. Si aún falla, avisa cuáles revisar manualmente.
- Crear producto nuevo con categoría editable, código con prefijo "A".

### Reportes
- Rentabilidad por sucursal: ingresos, costo de productos, sueldos (calculados por asistencia/aperturas de caja), gastos por sucursal, ganancia neta. Lógica compartida en `server/rentabilidad.ts` (usada por reporte Y asistente para que den los mismos números).
- Compras del mes, con detección de duplicados.
- Gastos no cancelados (pagado=0) por sucursal, mostrados en rojo.

### Fidelización de clientes crónicos (v1.75.0) — diferenciador comercial
- `server/fidelizacion.ts`: detecta clientes que compran el MISMO medicamento en intervalos regulares (tratamientos crónicos: hipertensión, diabetes, tiroides) cruzando ventas + ventas_detalle + clientes. Predice cuándo se le acaba (última compra + intervalo promedio entre compras).
- Genera la lista diaria de "clientes por recordar": por acabar (recompra próxima, dentro de N días) o atrasados (ya debieron volver, riesgo de perderlos ante la competencia).
- Solo clientes con teléfono registrado (los contactables); descarta consumidor final. Botón de WhatsApp con mensaje ya redactado (wa.me, celular boliviano normalizado a 591XXXXXXXX).
- Página `client/src/pages/Fidelizacion.tsx`, ruta `/fidelizacion`, router `fidelizacion.porRecordar`. Configurable: umbral de compras, anticipación, tolerancia de atraso, sucursal, filtro por estado.
- LIMITACIÓN honesta: solo sirve si los clientes de crónicos están registrados con teléfono en 365. La UI muestra la cobertura (cuántos clientes con teléfono hay) para no dar falsa sensación.

### Asistente conversacional (DeepSeek) — el trabajo más grande
- Chat en `/asistente`. Solo lectura (Fase 1). Arquitectura segura: el modelo NO toca la BD; usa "herramientas" (funciones con SQL fijo). El modelo solo elige cuál llamar.
- Modelo: DeepSeek `deepseek-v4-flash` (vía `server/_core/deepseek.ts`). Variable Railway `DEEPSEEK_API_KEY`. Caché de contexto (system prompt + tools fijos al inicio → 98% más barato). Temperatura 0 (anti-alucinación).
- Herramientas (`server/asistente.ts`): ventasPeriodo (con desglose porSucursal), comprasProveedor, productoMasVendido, gananciaPeriodo (neta con gastos), infoProducto, ventasCliente, trabajadoresSucursal, mejoresVendedores, listarSucursales, stockProducto (por almacén, en vivo), cajasAbiertas (quién tiene caja abierta ahora), historialCompraProducto (precio más bajo + última compra), rentabilidadSucursales, estadoPagosGastos (qué falta pagar), productosUrgentes (reponer), pedidoSucursal (pedido con índice de cobertura).
- Red de seguridad: DeepSeek a veces escribe la llamada de función como texto (patrón DSML/tool_calls). Se detecta y se ejecuta por intención (`intentarHerramientaPorIntencion` en routers.ts).
- Anti-alucinación reforzado: el modelo inventaba nombres/cifras/tablas. Regla estricta de no inventar + temperatura 0 + recordatorio antes de redactar.

### Pedido inteligente (índice de cobertura)
- `pedidoSucursal`: genera el pedido por sucursal y proveedor. Cobertura = stock ÷ venta mensual promedio (3 meses concluidos). Entra al pedido si cobertura < 1 mes. Cantidad sugerida = lo justo para 1 mes. Funciona igual para alta rotación (200/mes) y baja (2/mes, leches/jarabes).
- Usa stock POR ALMACÉN (`listarParaInventario(idAlmacen, idProveedor)`). Mapeo: Petrolera=2, Lanza=3, Cobol=4, Matriz/Principal=1.

## Lecciones técnicas clave (no repetir errores)

- El build de vite FALLA localmente (falta `@builder.io/vite-plugin-jsx-loc`, solo en Railway). NO es error real. Verificar con esbuild.
- NUNCA `drizzle-kit push --force` (borra tablas de ventas). Columnas nuevas: ALTER idempotente antes de usarlas.
- Zod estricto rechaza null/undefined/NaN antes del handler → 500 incapturable. Usar schemas tolerantes + sanitizar.
- Variables `const` dentro del try NO son visibles en el catch.
- Servidor escucha primero; cero llamadas a 365 al arrancar.

## Historia del asistente (resumen de la odisea de modelos)

1. Empezó con Groq (Llama 3.3 70B) → preciso pero saturaba rate limit (6K TPM gratis).
2. Probamos GPT-OSS 20B → rompía tool calling (formato "harmony": "Tools should have a name").
3. Llama 3.1 8B → resolvía rate limit pero generaba funciones mal formadas.
4. **DeepSeek v4-flash** (final): barato, estable, buen español, caché de contexto. Luis cargó $2 de saldo y funciona.
- Lector de facturas (Groq): migrado a `qwen/qwen3.6-27b` (v1.74.1, jul 2026) porque llama-4-scout se apagaba el 17/07/2026. Es el multimodal en producción de Groq. Override con env `GROQ_VISION_MODEL`.

## Estado de la migración a Claude Code

Luis tiene una PC 24/7 en la sucursal Petrolera (también usada para ventas) y plan Pro. Planea usar Claude Code con Remote Control: la sesión corre en esa PC (terminal minimizada, no estorba ventas), y la controla desde el celular. Remote Control ya está disponible en Pro. Ver GUIA_CLAUDE_CODE.md.

## Pendientes

- Verificar con una factura real que la extracción funciona bien con qwen3.6-27b (migrado v1.74.1; v1.74.4 ajustó max_tokens=3000 por límite TPM 8000 del tier gratuito de Groq).
- **Migrar lector de facturas a DeepSeek cuando su API soporte visión** (jul 2026: V4-Flash ya tiene visión en el chat pero NO en la API; en pruebas desde abril 2026). Luis quiere la opción más económica y ya paga DeepSeek. Revisar api-docs.deepseek.com periódicamente.
- Consulta de retraso de vendedor (verificar estructura asistencia/sueldos).
- Fase 2 del asistente: acciones (cambiar precio, corregir inventario) con confirmación + auditoría (quién/qué/cuándo). Luis confirmó querer auditoría.
- Rotar token GitHub si se expuso.
- Ideas: módulo Redes Sociales/Facebook, importar ventas por Excel, pedido como archivo Excel descargable.

## Hoja de ruta empresarial (definida jul 2026 con Luis)

Prioridades para diferenciarse de la competencia, en orden:
1. **Fidelización de clientes crónicos**: detectar patrones de recompra mensual (hipertensión, diabetes) y generar lista diaria de clientes por recordar vía WhatsApp. La mayor oportunidad de ingresos recurrentes.
2. **Alerta de vencimientos**: panel de productos por vencer (60/90 días) con valor en Bs, para rematar a tiempo. Ya se captura fecha de vencimiento en compras.
3. **Alerta de quiebres de stock**: convertir productosUrgentes en aviso automático matutino por sucursal.


## Era Tienda + Marketing (v1.85 → v2.3, julio 2026)

Se construyó la cara al cliente y el área comercial completa, con enfoque **Company of One** (documentado en `SERVICIOS.md`): tienda pública profesional (nivel Farmacorp/Chávez, con búsqueda por principio activo como diferenciador), programa de puntos unificado por teléfono entre mostrador y online, recordatorios de recompra por tasa de consumo, pagos QR enchufables, y un módulo de marketing donde un agente redacta publicaciones con datos reales del negocio (ofertas, más vendidos, temporada), genera o recibe imagen, y publica a redes por conector enchufable con aprobación humana obligatoria. Se agregó el sistema de testing pre-push (`scripts/verificar.mjs`, ver `TESTING.md`) tras un crash en producción por use-before-declaration. Análisis de competencia boliviana y estructura de las 9 áreas de negocio en `SERVICIOS.md`.
