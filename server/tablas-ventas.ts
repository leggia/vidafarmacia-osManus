/**
 * Creación de tablas de ventas mediante SQL directo (CREATE TABLE IF NOT EXISTS).
 *
 * Por qué SQL directo y no drizzle-kit push:
 * El push compara TODO el esquema y crear muchas tablas+índices de golpe bloqueaba
 * el arranque en recursos limitados (causó "Application failed to respond").
 * Esto es quirúrgico, idempotente y asíncrono: no bloquea el event loop ni el arranque.
 *
 * Se llama UNA vez, en background, después de que el servidor ya escucha.
 */

export async function crearTablasVentas(): Promise<void> {
  const { getDb } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) {
    console.warn("[TablasVentas] Sin BD, se omite creación");
    return;
  }

  // Cada CREATE es independiente e idempotente (IF NOT EXISTS).
  const sentencias = [
    // Ventas (cabecera)
    `CREATE TABLE IF NOT EXISTS ventas (
      id INT PRIMARY KEY,
      numComprobante VARCHAR(50),
      tipoComprobante VARCHAR(30),
      fechaHora DATETIME NOT NULL,
      fecha VARCHAR(10) NOT NULL,
      diaSemana INT NOT NULL DEFAULT 0,
      total DECIMAL(14,2) NOT NULL DEFAULT 0,
      descuentoTotal DECIMAL(14,2) NOT NULL DEFAULT 0,
      vendedor VARCHAR(100),
      nombreSucursal VARCHAR(150),
      idCliente INT,
      razonSocialCliente VARCHAR(255),
      estado VARCHAR(20),
      capturadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ventas_fecha (fecha),
      INDEX idx_ventas_vendedor (vendedor),
      INDEX idx_ventas_sucursal (nombreSucursal),
      INDEX idx_ventas_diasemana (diaSemana)
    )`,
    // Detalle de ventas (productos)
    `CREATE TABLE IF NOT EXISTS ventas_detalle (
      id INT AUTO_INCREMENT PRIMARY KEY,
      ventaId INT NOT NULL,
      articuloNombre VARCHAR(500) NOT NULL,
      cantidad DECIMAL(14,2) NOT NULL DEFAULT 0,
      precio DECIMAL(14,4) NOT NULL DEFAULT 0,
      descuento DECIMAL(14,2) NOT NULL DEFAULT 0,
      subtotal DECIMAL(14,2) NOT NULL DEFAULT 0,
      fecha VARCHAR(10) NOT NULL,
      nombreSucursal VARCHAR(150),
      INDEX idx_detalle_venta (ventaId),
      INDEX idx_detalle_articulo (articuloNombre),
      INDEX idx_detalle_fecha (fecha)
    )`,
    // Clientes
    `CREATE TABLE IF NOT EXISTS clientes (
      id INT PRIMARY KEY,
      nombre VARCHAR(255),
      tipoDocumento VARCHAR(10),
      numDocumento VARCHAR(50),
      complementoId VARCHAR(20),
      telefono VARCHAR(50),
      email VARCHAR(150),
      direccion VARCHAR(500),
      creadoEnSistema VARCHAR(25),
      capturadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_clientes_nombre (nombre),
      INDEX idx_clientes_documento (numDocumento)
    )`,
    // Estado de sincronización
    `CREATE TABLE IF NOT EXISTS sync_estado (
      clave VARCHAR(50) PRIMARY KEY,
      ultimoId INT NOT NULL DEFAULT 0,
      ultimaSync DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      notas VARCHAR(255)
    )`,
  ];

  for (const stmt of sentencias) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (e) {
      console.warn("[TablasVentas] Error creando tabla:", e);
      // Continúa con las demás; una falla no debe detener el resto
    }
  }
  console.log("[TablasVentas] Tablas de ventas verificadas/creadas");
}
