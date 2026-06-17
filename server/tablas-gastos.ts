/**
 * Tablas de GASTOS de la farmacia (SQL directo, no drizzle push).
 *
 * Dos tablas:
 *  - gastos_fijos: plantilla de gastos recurrentes (alquiler, luz, internet...).
 *    Se definen una vez; cada mes generan un registro a marcar.
 *  - gastos_registro: cada gasto real de un mes (fijo marcado o gasto ocasional).
 *
 * Se crean en background, después de que el server escucha.
 */
export async function crearTablasGastos(): Promise<void> {
  const { getDb } = await import("./db");
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return;

  const sentencias = [
    // Plantilla de gastos fijos recurrentes
    `CREATE TABLE IF NOT EXISTS gastos_fijos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(150) NOT NULL,
      categoria VARCHAR(40) NOT NULL DEFAULT 'servicios',
      montoEstimado DECIMAL(14,2) NOT NULL DEFAULT 0,
      diaVencimiento INT,
      activo INT NOT NULL DEFAULT 1,
      notas VARCHAR(300),
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    // Registro de gastos reales por mes (fijos marcados + ocasionales)
    `CREATE TABLE IF NOT EXISTS gastos_registro (
      id INT AUTO_INCREMENT PRIMARY KEY,
      anioMes VARCHAR(7) NOT NULL,
      gastoFijoId INT,
      nombre VARCHAR(150) NOT NULL,
      categoria VARCHAR(40) NOT NULL DEFAULT 'otros',
      monto DECIMAL(14,2) NOT NULL DEFAULT 0,
      pagado INT NOT NULL DEFAULT 0,
      fechaPago VARCHAR(10),
      esOcasional INT NOT NULL DEFAULT 0,
      notas VARCHAR(300),
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_gastos_aniomes (anioMes),
      INDEX idx_gastos_categoria (categoria)
    )`,
  ];

  for (const stmt of sentencias) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (e) {
      console.warn("[TablasGastos] Error creando tabla:", e);
    }
  }

  // Migraciones incrementales: agregar columna sucursal (si no existe).
  // ALTER TABLE ADD COLUMN falla si ya existe -> se ignora (idempotente).
  const migraciones = [
    "ALTER TABLE gastos_fijos ADD COLUMN sucursal VARCHAR(150)",
    "ALTER TABLE gastos_registro ADD COLUMN sucursal VARCHAR(150)",
    "ALTER TABLE gastos_registro ADD INDEX idx_gastos_sucursal (sucursal)",
  ];
  for (const m of migraciones) {
    try { await db.execute(sql.raw(m)); } catch { /* ya existe */ }
  }

  console.log("[TablasGastos] Tablas de gastos verificadas/creadas");
}
