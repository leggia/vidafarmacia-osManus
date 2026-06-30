# Historial del proyecto VidaFarma

Resumen de lo construido y aprendido. Para que cualquier sesión de Claude (chat o Claude Code) retome el contexto rápido.

## Qué es VidaFarma

App web (Node.js/TypeScript, React, tRPC, Drizzle/MySQL) de gestión para una farmacia en Cochabamba, Bolivia. Dueño: Luis (GitHub `leggia`). Se integra con **inventarios365** (sistema externo Laravel/PHP que Luis paga, usado para facturación fiscal SIN/SFE, login de vendedores y caja). VidaFarma construye todo lo demás: compras, inventario, reportes, gastos, asistencia/sueldos y un asistente conversacional.

- Producción: https://vidafarmacia-osmanus-production.up.railway.app
- Repo: https://github.com/leggia/vidafarmacia-osManus
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
- Pendiente: los modelos Llama de Groq se deprecian (lector de facturas usa Groq, migrar a modelo de visión vigente).

## Estado de la migración a Claude Code

Luis tiene una PC 24/7 en la sucursal Petrolera (también usada para ventas) y plan Pro. Planea usar Claude Code con Remote Control: la sesión corre en esa PC (terminal minimizada, no estorba ventas), y la controla desde el celular. Remote Control ya está disponible en Pro. Ver GUIA_CLAUDE_CODE.md.

## Pendientes

- Migrar lector de facturas (Groq) a modelo de visión vigente antes de que se deprecie.
- Consulta de retraso de vendedor (verificar estructura asistencia/sueldos).
- Fase 2 del asistente: acciones (cambiar precio, corregir inventario) con confirmación + auditoría (quién/qué/cuándo). Luis confirmó querer auditoría.
- Rotar token GitHub si se expuso.
- Ideas: módulo Redes Sociales/Facebook, importar ventas por Excel, pedido como archivo Excel descargable.
