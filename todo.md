# VidaFarma-OS - TODO

## Base de Datos y Esquema
- [x] Tabla de sucursales (branches)
- [x] Tabla de productos (products)
- [x] Tabla de compras (purchases) con estados
- [x] Tabla de items de compra (purchase_items)
- [x] Tabla de transferencias (transfers) con estados
- [x] Tabla de items de transferencia (transfer_items)
- [x] Tabla de cola de tareas pendientes (task_queue)
- [x] Tabla de historial de operaciones (operation_history)

## Tema Visual Swiss Style
- [x] Configurar paleta de colores: blanco prístino, acentos rojos, negro nítido
- [x] Tipografía sans-serif (Inter) con sistema de grilla estricto
- [x] Layout Dashboard con sidebar y navegación modular

## Módulo de Compras
- [x] Página de listado de compras con filtros y estados
- [x] Upload de foto/PDF de factura con almacenamiento S3
- [x] Extracción automática con IA (visión artificial) de productos, cantidades, proveedor
- [x] Vista previa y edición de datos extraídos antes de confirmar
- [x] Registro de compra en base de datos local
- [x] Preparación de datos para sincronización con inventarios365.com

## Módulo de Transferencias
- [x] Página de listado de transferencias con filtros y estados
- [x] Upload de foto de medicamentos a transferir
- [x] Extracción automática con IA de productos y cantidades
- [x] Selección de sucursal origen y destino
- [x] Vista previa y edición de datos extraídos
- [x] Registro de transferencia en base de datos local

## Cola de Tareas Pendientes
- [x] Sistema de cola para tareas no ejecutadas
- [x] Vista de tareas pendientes con opción de reintento
- [x] Ejecución manual de tareas en cola

## Historial de Operaciones
- [x] Registro completo de compras y transferencias
- [x] Estados: completado, pendiente, error
- [x] Opción de reintento para operaciones fallidas

## Alertas y Notificaciones
- [x] Alerta cuando sincronización falla
- [x] Alerta cuando cola de pendientes supera umbral
- [x] Alerta cuando compra/transferencia se completa exitosamente

## Backend / API
- [x] Router tRPC para sucursales
- [x] Router tRPC para compras
- [x] Router tRPC para transferencias
- [x] Router tRPC para cola de tareas
- [x] Router tRPC para historial
- [x] Integración LLM con visión artificial para extracción de datos
- [x] Helpers de almacenamiento S3 para imágenes/PDFs

## Testing
- [x] Tests vitest para autenticación y logout
- [x] Tests vitest para validación de inputs en todos los routers
- [x] Tests vitest para protección de rutas (auth required)

## Bugs Reportados - 12/04/2026
- [x] BUG: IA no interpreta correctamente cantidades farmacéuticas (x10 caps, cpr, comp) - debe multiplicar cajas x unidades por caja
- [x] BUG: Compras se quedan en estado BORRADOR sin opción de confirmar directamente - debe permitir confirmar y completar

## Bugs Reportados - 17/04/2026
- [x] BUG CRÍTICO: Botón Confirmar generaba error "Failed query: insert into purchases" - RESUELTO: la migración ALTER TABLE para agregar 'completed' al enum de status no estaba aplicada en la base de datos real

## Bugs Reportados - 19/04/2026
- [x] BUG: Al crear nueva compra el registro no aparecía en el listado - RESUELTO: se agregó invalidación de caché (purchases.list y dashboard.stats) después de crear la compra/transferencia

## Sincronización con inventarios365.com - 20/04/2026
- [ ] Analizar si inventarios365.com tiene API REST disponible
- [ ] Implementar servicio de sincronización en el backend (API directa o Puppeteer)
- [ ] Conectar sincronización al flujo de confirmación de compras
- [ ] Conectar sincronización al flujo de confirmación de transferencias
- [ ] Mostrar estado de sincronización en tiempo real en el frontend
- [ ] Guardar credenciales de inventarios365.com de forma segura en variables de entorno


## Optimización de Recursos - 14/05/2026
- [x] Remover notificaciones por correo en flujo de compras (innecesarias, gastan recursos)
- [x] Remover notificaciones por correo en flujo de transferencias
- [x] Verificar que sincronización funciona correctamente (prueba end-to-end exitosa: Ingreso ID 27)
- [x] Documentar el problema: la sincronización es asíncrona y tarda ~30 segundos

## Correcciones Críticas - 17/05/2026
- [x] Agregar selector de tipo de comprobante (FACTURA/BOLETA) en formulario de compras
- [x] Agregar selector de almacén/sucursal en formulario de compras
- [x] Pasar receiptType y almacenNombre desde el frontend al backend
- [x] Remover notificaciones por correo innecesarias
- [x] Diagnosticar fallo de sincronización: faltaba header X-CSRF-TOKEN
- [x] Cambiar payload de data a inventarios (estructura correcta de API)
- [x] Manejar ambos tipos de respuesta del servidor (id y message)
- [x] Verificar sincronización con tipo FACTURA (Ingreso ID 41 registrado exitosamente)

## Próximas Mejoras
- [ ] Crear UI de mapeo manual de artículos cuando la búsqueda automática falla
- [ ] Agregar historial y logs detallados de sincronización
- [ ] Crear documentación para desplegar en servidor propio (Docker, VPS, etc.)
- [ ] Mejorar algoritmo de similitud para mejor matching de artículos
