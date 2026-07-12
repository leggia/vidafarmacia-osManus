// VENTAS DE CONTINGENCIA — lógica pura (testeable sin BD).
// Cuando inventarios365 está caído, cada sucursal registra sus ventas aquí y,
// al terminar la contingencia, se re-registran en 365 con un checklist asistido.

export type ItemContingencia = {
  articuloId?: number | null;
  nombre: string;
  cantidad: number;
  precioUnit: number;
};

export type ItemCalculado = ItemContingencia & { subtotal: number };

export function calcularVenta(items: ItemContingencia[]): { items: ItemCalculado[]; total: number } {
  const calc = items.map((i) => ({
    ...i,
    cantidad: Math.max(0, Math.round(Number(i.cantidad) || 0)),
    precioUnit: Math.max(0, Number(i.precioUnit) || 0),
    subtotal: 0,
  }));
  for (const i of calc) i.subtotal = Math.round(i.cantidad * i.precioUnit * 100) / 100;
  const total = Math.round(calc.reduce((s, i) => s + i.subtotal, 0) * 100) / 100;
  return { items: calc, total };
}

// Valida una venta antes de guardarla. Devuelve null si está bien, o el mensaje
// de error si no. Reglas: al menos 1 ítem, cada ítem con nombre, cantidad >= 1 y
// precio > 0 (una farmacia no vende gratis por error de tipeo).
export function validarVenta(items: ItemContingencia[]): string | null {
  if (!Array.isArray(items) || items.length === 0) return "La venta no tiene productos.";
  for (const i of items) {
    if (!i.nombre || !String(i.nombre).trim()) return "Hay un producto sin nombre.";
    const cant = Math.round(Number(i.cantidad) || 0);
    if (cant < 1) return `"${i.nombre}": la cantidad debe ser 1 o más.`;
    const precio = Number(i.precioUnit) || 0;
    if (precio <= 0) return `"${i.nombre}": el precio debe ser mayor a 0.`;
  }
  return null;
}
