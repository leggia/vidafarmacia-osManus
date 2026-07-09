// Normalización PURA de teléfonos bolivianos (sin dependencias), extraída de
// puntos-fidelidad.ts. El teléfono normalizado es la LLAVE de identidad del cliente
// entre mostrador (365) y tienda online — casar formatos es crítico para que los
// puntos no se dividan en cuentas duplicadas.
// Regla: solo dígitos, últimos 8 (celular Bolivia); menos de 7 dígitos = inválido.
export function normTel(t: string | null | undefined): string | null {
  const d = String(t || "").replace(/\D/g, "");
  if (d.length < 7) return null;
  return d.slice(-8);
}
