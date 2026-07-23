import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, decimal, json, index, unique } from "drizzle-orm/mysql-core";

// ─── Users ───────────────────────────────────────────────────────────────────
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin", "viewer", "regente", "cliente"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Branches (Sucursales) ───────────────────────────────────────────────────
export const branches = mysqlTable("branches", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  address: text("address"),
  phone: varchar("phone", { length: 50 }),
  isMain: int("isMain").default(0).notNull(), // 1 = central/main branch
  isActive: int("isActive").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Branch = typeof branches.$inferSelect;
export type InsertBranch = typeof branches.$inferInsert;

// ─── Products (Productos) ────────────────────────────────────────────────────
export const products = mysqlTable("products", {
  id: int("id").autoincrement().primaryKey(),
  externalCode: varchar("externalCode", { length: 50 }), // code in inventarios365
  name: varchar("name", { length: 500 }).notNull(),
  genericName: varchar("genericName", { length: 500 }),
  supplier: varchar("supplier", { length: 255 }),
  unitCost: decimal("unitCost", { precision: 12, scale: 4 }).default("0"),
  salePrice: decimal("salePrice", { precision: 12, scale: 4 }).default("0"),
  category: varchar("category", { length: 255 }),
  isActive: int("isActive").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Product = typeof products.$inferSelect;
export type InsertProduct = typeof products.$inferInsert;

// ─── Purchases (Compras) ────────────────────────────────────────────────────
export const purchases = mysqlTable("purchases", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  branchId: int("branchId").notNull(),
  // Almacén REAL donde entró la mercadería (lo que se envía a 365). No es lo
  // mismo que branchId: esa es la sucursal del formulario, que viene
  // preseleccionada en Casa Matriz y no dice a qué almacén entró el stock.
  almacenNombre: varchar("almacenNombre", { length: 120 }),
  receiptNumber: varchar("receiptNumber", { length: 100 }),
  receiptType: varchar("receiptType", { length: 50 }).default("BOLETA"),
  supplier: varchar("supplier", { length: 255 }),
  totalAmount: decimal("totalAmount", { precision: 12, scale: 2 }).default("0"),
  status: mysqlEnum("status", ["draft", "pending_sync", "synced", "error", "completed"]).default("draft").notNull(),
  imageUrl: text("imageUrl"), // S3 URL of the uploaded invoice image/PDF
  imageKey: varchar("imageKey", { length: 500 }),
  extractedData: json("extractedData"), // Raw AI extraction result
  syncError: text("syncError"),
  syncAttempts: int("syncAttempts").default(0),
  // ID del "ingreso" creado en inventarios365 al sincronizar esta compra. Se
  // guarda para saber QUÉ registro de 365 le corresponde: si hay que
  // re-sincronizar (se subió dos veces, o con un precio mal), este ID dice
  // exactamente cuál borrar en 365 antes de reintentar — sin él, los duplicados
  // son indistinguibles.
  syncIngresoId: int("syncIngresoId"),
  // Nombres de los productos cuyo PRECIO DE VENTA no quedó aplicado en 365 tras
  // la sincronización (ya con verificación y reintentos). Si está vacío, la
  // compra quedó completa. Sirve para mostrar la reparación SOLO cuando hace
  // falta, en vez de tener un botón de precios suelto siempre visible.
  preciosFallidos: text("preciosFallidos"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Purchase = typeof purchases.$inferSelect;
export type InsertPurchase = typeof purchases.$inferInsert;

// ─── Purchase Items ──────────────────────────────────────────────────────────
export const purchaseItems = mysqlTable("purchase_items", {
  id: int("id").autoincrement().primaryKey(),
  purchaseId: int("purchaseId").notNull(),
  productId: int("productId"),
  productName: varchar("productName", { length: 500 }).notNull(),
  quantity: int("quantity").default(1).notNull(),
  unitCost: decimal("unitCost", { precision: 12, scale: 4 }).default("0"),
  subtotal: decimal("subtotal", { precision: 12, scale: 2 }).default("0"),
  matched: int("matched").default(0), // 1 = matched to local product
  nombreFactura: varchar("nombreFactura", { length: 500 }), // nombre original en la factura (preserva emparejamiento)
  expiryDate: varchar("expiryDate", { length: 20 }), // Fecha de vencimiento YYYY-MM-DD
  precioVenta: decimal("precioVenta", { precision: 12, scale: 4 }), // precio de venta definido al comprar
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});
export type PurchaseItem = typeof purchaseItems.$inferSelect;
export type InsertPurchaseItem = typeof purchaseItems.$inferInsert;

// ─── Transfers (Transferencias entre Sucursales) ─────────────────────────────
export const transfers = mysqlTable("transfers", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  fromBranchId: int("fromBranchId").notNull(),
  toBranchId: int("toBranchId").notNull(),
  referenceNumber: varchar("referenceNumber", { length: 100 }),
  status: mysqlEnum("status", ["draft", "pending_sync", "synced", "error", "completed", "pending", "reverted"]).default("draft").notNull(),
  imageUrl: text("imageUrl"),
  imageKey: varchar("imageKey", { length: 500 }),
  extractedData: json("extractedData"),
  syncError: text("syncError"),
  syncAttempts: int("syncAttempts").default(0),
  notes: text("notes"),
  // Reversión: cuándo, quién y por qué se revirtió (movimiento inverso en 365).
  revertedAt: timestamp("revertedAt"),
  revertedBy: int("revertedBy"),
  revertReason: text("revertReason"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Transfer = typeof transfers.$inferSelect;
export type InsertTransfer = typeof transfers.$inferInsert;

// ─── Transfer Items ──────────────────────────────────────────────────────────
export const transferItems = mysqlTable("transfer_items", {
  id: int("id").autoincrement().primaryKey(),
  transferId: int("transferId").notNull(),
  productId: int("productId"),
  productName: varchar("productName", { length: 500 }).notNull(),
  quantity: int("quantity").default(1).notNull(),
  matched: int("matched").default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type TransferItem = typeof transferItems.$inferSelect;
export type InsertTransferItem = typeof transferItems.$inferInsert;

// ─── Task Queue (Cola de Tareas Pendientes) ──────────────────────────────────
export const taskQueue = mysqlTable("task_queue", {
  id: int("id").autoincrement().primaryKey(),
  type: mysqlEnum("type", ["purchase_sync", "transfer_sync"]).notNull(),
  referenceId: int("referenceId").notNull(), // purchaseId or transferId
  status: mysqlEnum("status", ["pending", "processing", "completed", "failed"]).default("pending").notNull(),
  attempts: int("attempts").default(0),
  maxAttempts: int("maxAttempts").default(3),
  lastError: text("lastError"),
  payload: json("payload"),
  scheduledAt: timestamp("scheduledAt").defaultNow().notNull(),
  processedAt: timestamp("processedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type TaskQueueItem = typeof taskQueue.$inferSelect;
export type InsertTaskQueueItem = typeof taskQueue.$inferInsert;

// ─── Operation History (Historial de Operaciones) ────────────────────────────
export const operationHistory = mysqlTable("operation_history", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  type: mysqlEnum("type", ["purchase", "transfer"]).notNull(),
  referenceId: int("referenceId").notNull(),
  action: varchar("action", { length: 100 }).notNull(), // e.g. "created", "ai_extracted", "synced", "sync_failed"
  status: mysqlEnum("status", ["success", "error", "info"]).default("info").notNull(),
  details: text("details"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type OperationHistoryItem = typeof operationHistory.$inferSelect;
export type InsertOperationHistoryItem = typeof operationHistory.$inferInsert;

// ─── KARDEX: libro de movimientos de stock ───────────────────────────────────
// Libro APPEND-ONLY: cada movimiento se registra y NUNCA se edita ni se borra.
// Si algo sale mal se agrega un movimiento correctivo, igual que en contabilidad.
// De aquí salen el kardex por producto, la auditoría (quién movió qué y cuándo)
// y la reconciliación contra el stock real de 365.
export const movimientosStock = mysqlTable("movimientos_stock", {
  id: int("id").autoincrement().primaryKey(),
  fecha: timestamp("fecha").notNull(),              // cuándo ocurrió el movimiento
  articuloNombre: varchar("articuloNombre", { length: 500 }).notNull(),
  // Nombre normalizado (sin tildes/dobles espacios, en mayúsculas): es la llave
  // por la que se agrupa la historia de un producto.
  articuloClave: varchar("articuloClave", { length: 255 }).notNull(),
  articuloId: int("articuloId"),                    // código de 365 si se conoce
  almacenId: int("almacenId"),
  sucursal: varchar("sucursal", { length: 150 }),
  // venta · devolucion · compra · transferencia_entrada · transferencia_salida ·
  // ajuste_inventario · anulacion_venta
  tipo: varchar("tipo", { length: 30 }).notNull(),
  cantidad: decimal("cantidad", { precision: 14, scale: 2 }).notNull(), // + entra, − sale
  costoUnitario: decimal("costoUnitario", { precision: 12, scale: 4 }),
  // Quién lo hizo: el dato central para la auditoría
  usuario: varchar("usuario", { length: 150 }),
  // Trazabilidad: de qué documento salió (venta 69112, compra 40, transferencia 4…)
  referenciaTipo: varchar("referenciaTipo", { length: 30 }),
  referenciaId: varchar("referenciaId", { length: 60 }),
  detalle: varchar("detalle", { length: 300 }),
  // Procedencia del asiento — dato de auditoría: "vivo" se registró en el momento
  // en que ocurrió; "importado" se reconstruyó del histórico ya existente y por
  // eso puede no tener usuario ni hora exacta.
  origen: varchar("origen", { length: 12 }).notNull().default("vivo"),
  creadoEn: timestamp("creadoEn").defaultNow().notNull(),
}, (t) => ({
  idxClaveFecha: index("idx_mov_clave_fecha").on(t.articuloClave, t.fecha),
  idxFecha: index("idx_mov_fecha").on(t.fecha),
  idxUsuario: index("idx_mov_usuario").on(t.usuario),
  // Evita duplicar el mismo movimiento si una sincronización se repite
  uniqOrigen: unique("uniq_mov_origen").on(t.referenciaTipo, t.referenciaId, t.articuloClave, t.tipo),
}));

export type MovimientoStock = typeof movimientosStock.$inferSelect;

// ─── Diferencias de caja (faltantes/sobrantes por cierre) ────────────────────
// Cada cierre de caja en 365 reporta saldoFaltante/saldoSobrante: la diferencia
// entre lo que el sistema esperaba y el efectivo real. Se guardan aquí por caja
// (sucursal+fecha+usuario) para acumularlos por sucursal y mostrarlos en el
// próximo inventario, donde se van descontando con cada corrección.
export const diferenciasCaja = mysqlTable("diferencias_caja", {
  id: int("id").autoincrement().primaryKey(),
  cajaId: int("cajaId").notNull(),           // id de la caja en 365 (para no duplicar)
  idSucursal: int("idSucursal"),
  sucursal: varchar("sucursal", { length: 150 }),
  usuario: varchar("usuario", { length: 100 }),
  fechaCierre: varchar("fechaCierre", { length: 30 }),
  ventasSistema: decimal("ventasSistema", { precision: 12, scale: 2 }).default("0"),  // 'ventas' de 365
  saldoFaltante: decimal("saldoFaltante", { precision: 12, scale: 2 }).default("0"),
  saldoSobrante: decimal("saldoSobrante", { precision: 12, scale: 2 }).default("0"),
  // neto = sobrante - faltante (positivo = sobró dinero; negativo = faltó)
  registradoEn: timestamp("registradoEn").defaultNow().notNull(),
});

export type DiferenciaCaja = typeof diferenciasCaja.$inferSelect;

// ─── Bandeja de Facturas XML ─────────────────────────────────────────────────
// Cada factura XML (subida manual o, más adelante, llegada por correo) queda
// GUARDADA aquí en espera, con su estado. Es la base de la cámara-inteligente
// (que reconoce la factura física contra esta bandeja) y de la ingesta por
// correo. El detalle de productos + progreso (emparejamiento, vencimientos) se
// guarda en 'items' como JSON para poder retomar la factura donde se dejó.
export const bandejaFacturas = mysqlTable("bandeja_facturas", {
  id: int("id").autoincrement().primaryKey(),
  // Cabecera fiscal (del XML, exacta)
  nitEmisor: varchar("nitEmisor", { length: 30 }),
  proveedor: varchar("proveedor", { length: 255 }),
  // A nombre de quién viene la factura. Sirve para avisar si llegó una factura
  // que NO es de la farmacia (ahora que entran solas por correo).
  razonSocialCliente: varchar("razonSocialCliente", { length: 255 }),
  nitCliente: varchar("nitCliente", { length: 30 }),
  ajena: int("ajena").notNull().default(0), // 1 = no parece ser de la farmacia
  // Si no es mercadería sino un servicio (luz, internet, agua): guarda el rubro
  servicioDetectado: varchar("servicioDetectado", { length: 60 }),
  numeroFactura: varchar("numeroFactura", { length: 60 }),
  cuf: varchar("cuf", { length: 100 }),
  fechaEmision: varchar("fechaEmision", { length: 40 }),
  montoTotal: decimal("montoTotal", { precision: 12, scale: 2 }).default("0"),
  // Estado del ciclo de vida en la bandeja
  estado: mysqlEnum("estado", ["recibida", "emparejada", "vencimientos_pendientes", "validada"]).default("recibida").notNull(),
  // Origen: como se cargó (manual arrastrando XML, o correo automatico)
  origen: varchar("origen", { length: 20 }).default("manual").notNull(),
  // Detalle de productos + progreso: [{ productName, quantity, unitCost, subtotal,
  //   descuento, expiryDate, articuloId, articuloNombre }]. Se actualiza al
  //   emparejar y al cargar vencimientos.
  items: json("items"),
  totalItems: int("totalItems").default(0),
  itemsEmparejados: int("itemsEmparejados").default(0),
  itemsConVencimiento: int("itemsConVencimiento").default(0),
  // Vínculo con la compra real una vez validada/sincronizada
  purchaseId: int("purchaseId"),
  // Evita duplicados: un CUF identifica únicamente una factura del SIN
  recibidaEn: timestamp("recibidaEn").defaultNow().notNull(),
  actualizadaEn: timestamp("actualizadaEn").defaultNow().onUpdateNow().notNull(),
});

export type BandejaFactura = typeof bandejaFacturas.$inferSelect;
export type InsertBandejaFactura = typeof bandejaFacturas.$inferInsert;

// ─── Confirmaciones (Emparejamientos aprendidos) ─────────────────────────────
export const confirmaciones = mysqlTable("confirmaciones", {
  id: int("id").autoincrement().primaryKey(),
  proveedor: varchar("proveedor", { length: 255 }).notNull(),
  nombreFactura: varchar("nombreFactura", { length: 500 }).notNull(),
  articuloId: int("articuloId").notNull(),
  articuloNombre: varchar("articuloNombre", { length: 500 }).notNull(),
  articuloCodigo: varchar("articuloCodigo", { length: 100 }),
  valido: int("valido").default(1).notNull(),
  confirmadoEn: timestamp("confirmadoEn").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Confirmacion = typeof confirmaciones.$inferSelect;
export type InsertConfirmacion = typeof confirmaciones.$inferInsert;

// ─── Historial de Precios de Compra ──────────────────────────────────────────
// Registra el costo de cada producto en cada compra, para alertas y consultas
export const historialPrecios = mysqlTable("historial_precios", {
  id: int("id").autoincrement().primaryKey(),
  articuloId: int("articuloId").notNull(),
  articuloNombre: varchar("articuloNombre", { length: 500 }).notNull(),
  proveedor: varchar("proveedor", { length: 255 }),
  costoUnitario: decimal("costoUnitario", { precision: 12, scale: 4 }).notNull(),
  precioVenta: decimal("precioVenta", { precision: 12, scale: 4 }),
  numComprobante: varchar("numComprobante", { length: 100 }),
  registradoEn: timestamp("registradoEn").defaultNow().notNull(),
});

export type HistorialPrecio = typeof historialPrecios.$inferSelect;
export type InsertHistorialPrecio = typeof historialPrecios.$inferInsert;

// ─── Sesiones de Inventario ──────────────────────────────────────────────────
// Una sesión = un inventario con nombre, sucursal, que se hace por proveedor
export const inventarioSesiones = mysqlTable("inventario_sesiones", {
  id: int("id").autoincrement().primaryKey(),
  nombre: varchar("nombre", { length: 255 }).notNull(), // "Inventario MAYO Suc 1"
  tipo: varchar("tipo", { length: 30 }).notNull().default("anual"), // anual | ciclico_abc
  almacenId: int("almacenId").notNull(), // sucursal/almacén de inventarios365
  almacenNombre: varchar("almacenNombre", { length: 255 }),
  totalProveedores: int("totalProveedores").notNull().default(0),
  estado: varchar("estado", { length: 20 }).notNull().default("en_progreso"), // en_progreso | completado
  creadoEn: timestamp("creadoEn").defaultNow().notNull(),
  actualizadoEn: timestamp("actualizadoEn").defaultNow().onUpdateNow().notNull(),
});

export type InventarioSesion = typeof inventarioSesiones.$inferSelect;
export type InsertInventarioSesion = typeof inventarioSesiones.$inferInsert;

// Avance por proveedor dentro de una sesión, con los conteos guardados
export const inventarioProveedores = mysqlTable("inventario_proveedores", {
  id: int("id").autoincrement().primaryKey(),
  sesionId: int("sesionId").notNull(),
  proveedorId: varchar("proveedorId", { length: 50 }),
  proveedorNombre: varchar("proveedorNombre", { length: 255 }).notNull(),
  totalProductos: int("totalProductos").notNull().default(0),
  productosContados: int("productosContados").notNull().default(0),
  conDiferencia: int("conDiferencia").notNull().default(0),
  conteos: json("conteos"), // array de {articuloId, nombre, stockSistema, stockFisico, diferencia}
  estado: varchar("estado", { length: 20 }).notNull().default("en_progreso"),
  // Resultado del intento de ajuste REAL en inventarios365 (independiente de si el
  // conteo local se guardó, que siempre ocurre primero). null = no se intentó,
  // 'ok' = se aplicó, 'fallo' = no se aplicó (contingencia: reintentar con
  // verificación, nunca reenviar a ciegas). Ver reintentarAjuste en routers.ts.
  ajusteEstado: varchar("ajusteEstado", { length: 20 }),
  ajusteMensaje: varchar("ajusteMensaje", { length: 500 }),
  completadoEn: timestamp("completadoEn"),
  actualizadoEn: timestamp("actualizadoEn").defaultNow().onUpdateNow().notNull(),
});

export type InventarioProveedor = typeof inventarioProveedores.$inferSelect;
export type InsertInventarioProveedor = typeof inventarioProveedores.$inferInsert;

// ─── Confirmaciones de Proveedores ───────────────────────────────────────────
// Aprende: nombre de proveedor en factura → proveedor del sistema (como productos)
export const confirmacionesProveedores = mysqlTable("confirmaciones_proveedores", {
  id: int("id").autoincrement().primaryKey(),
  nombreFactura: varchar("nombreFactura", { length: 500 }).notNull(),
  proveedorId: varchar("proveedorId", { length: 50 }).notNull(),
  proveedorNombre: varchar("proveedorNombre", { length: 255 }).notNull(),
  valido: int("valido").default(1).notNull(),
  confirmadoEn: timestamp("confirmadoEn").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ConfirmacionProveedor = typeof confirmacionesProveedores.$inferSelect;
export type InsertConfirmacionProveedor = typeof confirmacionesProveedores.$inferInsert;

// ─── Productos Cache (Cache de artículos de inventarios365) ──────────────────
export const productosCache = mysqlTable("productos_cache", {
  id: int("id").autoincrement().primaryKey(),
  articuloId: int("articuloId").notNull().unique(),
  nombre: varchar("nombre", { length: 500 }).notNull(),
  codigo: varchar("codigo", { length: 100 }),
  idProveedor: int("idProveedor"),
  nombreProveedor: varchar("nombreProveedor", { length: 255 }),
  descripcion: varchar("descripcion", { length: 600 }),
  precioCostoUnid: decimal("precioCostoUnid", { precision: 12, scale: 4 }).default("0"),
  precioCostoPaq: decimal("precioCostoPaq", { precision: 12, scale: 4 }).default("0"),
  precioUno: decimal("precioUno", { precision: 12, scale: 4 }).default("0"),
  unidadEnvase: int("unidadEnvase").default(1),
  imagenUrl: varchar("imagenUrl", { length: 600 }),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type ProductoCache = typeof productosCache.$inferSelect;
export type InsertProductoCache = typeof productosCache.$inferInsert;


// ─── Inventarios365 Products (Productos de inventarios365.com) ────────────────
export const inventarios365Products = mysqlTable("inventarios365_products", {
  id: int("id").autoincrement().primaryKey(),
  idarticulo: int("idarticulo").notNull().unique(), // ID del artículo en inventarios365
  codigo: varchar("codigo", { length: 100 }).notNull(),
  nombre: varchar("nombre", { length: 500 }).notNull(),
  precio_costo: decimal("precio_costo", { precision: 12, scale: 4 }).default("0"),
  precio_venta: decimal("precio_venta", { precision: 12, scale: 4 }).default("0"),
  stock: int("stock").default(0),
  lastSyncedAt: timestamp("lastSyncedAt").defaultNow().onUpdateNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Inventarios365Product = typeof inventarios365Products.$inferSelect;
export type InsertInventarios365Product = typeof inventarios365Products.$inferInsert;

// ─── Asistencia del Personal ──────────────────────────────────────────────────
// Trabajadores: vinculados a su usuario de inventarios365 (la apertura de caja = entrada)
export const trabajadores = mysqlTable("trabajadores", {
  id: int("id").autoincrement().primaryKey(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  // Usuario de inventarios365 con el que abre caja (para cruzar las aperturas)
  usuarioSistemaId: varchar("usuarioSistemaId", { length: 50 }), // id del usuario en inventarios365
  sucursalFija: varchar("sucursalFija", { length: 150 }), // sucursal asignada (para reportes por sucursal)
  usuarioSistemaNombre: varchar("usuarioSistemaNombre", { length: 255 }), // nombre/login en el sistema
  horaIngreso: varchar("horaIngreso", { length: 5 }).notNull().default("08:00"), // HH:MM esperada
  horaSalida: varchar("horaSalida", { length: 5 }).notNull().default("00:00"), // HH:MM salida esperada (0=sin control)
  horasDia: decimal("horasDia", { precision: 4, scale: 2 }).notNull().default("8"), // horas diarias
  diasMes: int("diasMes").notNull().default(26), // días laborales al mes (respaldo si no hay diasSemana)
  // Días de la semana que trabaja: CSV de 0-6 (0=domingo, 1=lunes... 6=sábado). Ej: "1,2,3,4,5,6" = lun-sáb
  diasSemana: varchar("diasSemana", { length: 20 }).notNull().default("1,2,3,4,5,6"),
  // Tipo de cálculo: fijo_mensual, por_dia, fijo_horas, fijo_turnos
  tipoTrabajador: varchar("tipoTrabajador", { length: 20 }).notNull().default("fijo_mensual"),
  horasMesFijas: int("horasMesFijas").notNull().default(192), // horas base del mes (para valor hora)
  diasPorTurno: int("diasPorTurno").notNull().default(3), // para fijo_turnos: días que equivale 1 turno 24h
  montoPorDia: decimal("montoPorDia", { precision: 10, scale: 2 }).notNull().default("0"), // pago por día (tipo por_dia)
  montoTurnoExtra: decimal("montoTurnoExtra", { precision: 10, scale: 2 }).notNull().default("0"), // pago por turno extra cubierto
  toleranciaSalidaMin: int("toleranciaSalidaMin").notNull().default(10), // min antes de salida sin descuento
  sueldoMensual: decimal("sueldoMensual", { precision: 12, scale: 2 }).notNull().default("0"),
  // Regla de descuento por retraso: "proporcional" (valor hora × tiempo) o "fijo" (monto por retraso)
  tipoDescuento: varchar("tipoDescuento", { length: 20 }).notNull().default("proporcional"),
  montoDescuentoFijo: decimal("montoDescuentoFijo", { precision: 10, scale: 2 }).notNull().default("0"),
  toleranciaMin: int("toleranciaMin").notNull().default(5), // minutos de tolerancia antes de contar retraso
  activo: int("activo").notNull().default(1),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Trabajador = typeof trabajadores.$inferSelect;
export type InsertTrabajador = typeof trabajadores.$inferInsert;

// Aperturas de caja leídas de inventarios365 (caché para el resumen mensual)
export const marcaciones = mysqlTable("marcaciones", {
  id: int("id").autoincrement().primaryKey(),
  trabajadorId: int("trabajadorId").notNull(),
  fecha: varchar("fecha", { length: 10 }).notNull(), // YYYY-MM-DD
  horaEntrada: varchar("horaEntrada", { length: 8 }), // HH:MM:SS de apertura de caja
  horaSalida: varchar("horaSalida", { length: 8 }), // HH:MM:SS de cierre de caja (si existe)
  minutosRetraso: int("minutosRetraso").notNull().default(0),
  horasTrabajadas: decimal("horasTrabajadas", { precision: 5, scale: 2 }).default("0"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Marcacion = typeof marcaciones.$inferSelect;
export type InsertMarcacion = typeof marcaciones.$inferInsert;

// ─── Descuentos por Proveedor (aprendizaje) ───────────────────────────────────
// Recuerda los porcentajes típicos de descuento de cada laboratorio
export const descuentosProveedor = mysqlTable("descuentos_proveedor", {
  id: int("id").autoincrement().primaryKey(),
  proveedorNombre: varchar("proveedorNombre", { length: 255 }).notNull(),
  pctVolumen: decimal("pctVolumen", { precision: 5, scale: 2 }).default("0"),
  pctEfectivo: decimal("pctEfectivo", { precision: 5, scale: 2 }).default("0"),
  notas: varchar("notas", { length: 500 }),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type DescuentoProveedor = typeof descuentosProveedor.$inferSelect;
export type InsertDescuentoProveedor = typeof descuentosProveedor.$inferInsert;

// ─── Ajustes de día (justificaciones, hora manual, turno extra) ───────────────
export const ajustesDia = mysqlTable("ajustes_dia", {
  id: int("id").autoincrement().primaryKey(),
  trabajadorId: int("trabajadorId").notNull(),
  fecha: varchar("fecha", { length: 10 }).notNull(), // YYYY-MM-DD
  justificado: int("justificado").notNull().default(0), // 1 = no descontar ese día
  horaIngresoManual: varchar("horaIngresoManual", { length: 8 }), // HH:MM:SS corrige entrada
  esTurnoExtra: int("esTurnoExtra").notNull().default(0), // 1 = domingo/feriado cubierto
  motivo: varchar("motivo", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type AjusteDiaRow = typeof ajustesDia.$inferSelect;
export type InsertAjusteDia = typeof ajustesDia.$inferInsert;

// ─── Pagos de sueldo (marca de mes pagado) ────────────────────────────────────
export const pagosSueldo = mysqlTable("pagos_sueldo", {
  id: int("id").autoincrement().primaryKey(),
  trabajadorId: int("trabajadorId").notNull(),
  anioMes: varchar("anioMes", { length: 7 }).notNull(), // YYYY-MM
  montoPagado: decimal("montoPagado", { precision: 12, scale: 2 }).notNull().default("0"),
  pagado: int("pagado").notNull().default(1),
  fechaPago: timestamp("fechaPago").defaultNow().notNull(),
  notas: varchar("notas", { length: 255 }),
});

export type PagoSueldo = typeof pagosSueldo.$inferSelect;
export type InsertPagoSueldo = typeof pagosSueldo.$inferInsert;

// ─── Tablas de VENTAS (creadas por SQL directo en tablas-ventas.ts) ───────────
// Se declaran aquí para que drizzle-kit push --force las RECONOZCA y NO las borre.
// La estructura debe coincidir exactamente con el CREATE TABLE de tablas-ventas.ts.
export const ventas = mysqlTable("ventas", {
  id: int("id").primaryKey(),
  numComprobante: varchar("numComprobante", { length: 50 }),
  tipoComprobante: varchar("tipoComprobante", { length: 30 }),
  fechaHora: timestamp("fechaHora").notNull(),
  fecha: varchar("fecha", { length: 10 }).notNull(),
  diaSemana: int("diaSemana").notNull().default(0),
  total: decimal("total", { precision: 14, scale: 2 }).notNull().default("0"),
  descuentoTotal: decimal("descuentoTotal", { precision: 14, scale: 2 }).notNull().default("0"),
  vendedor: varchar("vendedor", { length: 100 }),
  nombreSucursal: varchar("nombreSucursal", { length: 150 }),
  idCliente: int("idCliente"),
  razonSocialCliente: varchar("razonSocialCliente", { length: 255 }),
  estado: varchar("estado", { length: 20 }),
  capturadoEn: timestamp("capturadoEn").notNull().defaultNow(),
}, (t) => ({
  idxFecha: index("idx_ventas_fecha").on(t.fecha),
  idxVendedor: index("idx_ventas_vendedor").on(t.vendedor),
  idxSucursal: index("idx_ventas_sucursal").on(t.nombreSucursal),
  idxDiaSemana: index("idx_ventas_diasemana").on(t.diaSemana),
}));

export const ventasDetalle = mysqlTable("ventas_detalle", {
  id: int("id").autoincrement().primaryKey(),
  ventaId: int("ventaId").notNull(),
  articuloNombre: varchar("articuloNombre", { length: 500 }).notNull(),
  cantidad: decimal("cantidad", { precision: 14, scale: 2 }).notNull().default("0"),
  precio: decimal("precio", { precision: 14, scale: 4 }).notNull().default("0"),
  descuento: decimal("descuento", { precision: 14, scale: 2 }).notNull().default("0"),
  subtotal: decimal("subtotal", { precision: 14, scale: 2 }).notNull().default("0"),
  fecha: varchar("fecha", { length: 10 }).notNull(),
  nombreSucursal: varchar("nombreSucursal", { length: 150 }),
}, (t) => ({
  idxVenta: index("idx_detalle_venta").on(t.ventaId),
  idxArticulo: index("idx_detalle_articulo").on(t.articuloNombre),
  idxFecha: index("idx_detalle_fecha").on(t.fecha),
}));

export const clientes = mysqlTable("clientes", {
  id: int("id").primaryKey(),
  nombre: varchar("nombre", { length: 255 }),
  tipoDocumento: varchar("tipoDocumento", { length: 10 }),
  numDocumento: varchar("numDocumento", { length: 50 }),
  complementoId: varchar("complementoId", { length: 20 }),
  telefono: varchar("telefono", { length: 50 }),
  email: varchar("email", { length: 150 }),
  direccion: varchar("direccion", { length: 500 }),
  creadoEnSistema: varchar("creadoEnSistema", { length: 25 }),
  capturadoEn: timestamp("capturadoEn").notNull().defaultNow(),
}, (t) => ({
  idxNombre: index("idx_clientes_nombre").on(t.nombre),
  idxDocumento: index("idx_clientes_documento").on(t.numDocumento),
}));

export const syncEstado = mysqlTable("sync_estado", {
  clave: varchar("clave", { length: 50 }).primaryKey(),
  ultimoId: int("ultimoId").notNull().default(0),
  ultimaSync: timestamp("ultimaSync").notNull().defaultNow(),
  notas: varchar("notas", { length: 255 }),
});
