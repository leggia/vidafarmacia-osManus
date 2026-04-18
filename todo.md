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
