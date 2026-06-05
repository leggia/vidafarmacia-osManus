/**
 * Confirmaciones de Proveedores
 * Aprende a emparejar el nombre del proveedor en la factura con el proveedor
 * real del sistema, igual que las confirmaciones de productos.
 * Ej: "LABORATORIOS BAGO DE BOLIVIA S.A." → "Bagó" (id 12)
 */

import { getDb } from "./db";
import { confirmacionesProveedores } from "../drizzle/schema";
import { eq } from "drizzle-orm";

class ConfirmacionesProveedoresService {
  private normalizar(s: string): string {
    return s.toUpperCase().trim()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[.,;:()\[\]]/g, " ")
      // quitar sufijos societarios y palabras genéricas
      .replace(/\b(S\s*A|S\s*R\s*L|SRL|SA|LTDA|LTD|SAC|EIRL|CIA|COMPANIA|LABORATORIOS?|LAB|DISTRIBUIDORA|DIST|IMPORTADORA|IMPORT|FARMACEUTICA|PHARMA|DE BOLIVIA|BOLIVIA)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private distanciaLevenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j], dp[j - 1]) + 1;
        prev = tmp;
      }
    }
    return dp[n];
  }

  private similitud(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;
    // Uno contiene al otro → muy similar
    if (a.includes(b) || b.includes(a)) return 0.9;
    const tokensA = a.split(" ").filter(t => t.length >= 2);
    const tokensB = b.split(" ").filter(t => t.length >= 2);
    if (tokensA.length === 0 || tokensB.length === 0) return 0;
    let compartidos = 0;
    for (const t of tokensA) {
      if (tokensB.some(u => u === t || this.distanciaLevenshtein(t, u) <= 1)) compartidos++;
    }
    return (compartidos / tokensA.length + compartidos / tokensB.length) / 2;
  }

  /** Busca el proveedor del sistema aprendido para un nombre de factura. */
  async buscar(nombreFactura: string): Promise<{ id: string; nombre: string } | null> {
    try {
      const db = await getDb();
      if (!db) return null;
      const nombreNorm = this.normalizar(nombreFactura);
      const rows = await db.select().from(confirmacionesProveedores).where(eq(confirmacionesProveedores.valido, 1));

      // 1. Match exacto normalizado
      for (const row of rows) {
        if (this.normalizar(row.nombreFactura) === nombreNorm) {
          console.log(`[ConfProv] ✅ exacto "${nombreFactura}" → "${row.proveedorNombre}" (${row.proveedorId})`);
          return { id: row.proveedorId, nombre: row.proveedorNombre };
        }
      }
      // 2. Match aproximado
      let mejor: { row: any; score: number } | null = null;
      for (const row of rows) {
        const score = this.similitud(nombreNorm, this.normalizar(row.nombreFactura));
        if (score >= 0.7 && (!mejor || score > mejor.score)) mejor = { row, score };
      }
      if (mejor) {
        console.log(`[ConfProv] ≈ aprox "${nombreFactura}" → "${mejor.row.proveedorNombre}" (score ${mejor.score.toFixed(2)})`);
        return { id: mejor.row.proveedorId, nombre: mejor.row.proveedorNombre };
      }
      return null;
    } catch (error) {
      console.error("[ConfProv] Error buscando:", error);
      return null;
    }
  }

  /** Guarda/actualiza el emparejamiento de un proveedor. */
  async confirmar(nombreFactura: string, proveedorId: string, proveedorNombre: string): Promise<void> {
    try {
      const db = await getDb();
      if (!db) return;
      const nombreNorm = this.normalizar(nombreFactura);
      const todas = await db.select().from(confirmacionesProveedores);
      const existente = todas.find(row => this.normalizar(row.nombreFactura) === nombreNorm);
      if (existente) {
        await db.update(confirmacionesProveedores)
          .set({ proveedorId, proveedorNombre, valido: 1 })
          .where(eq(confirmacionesProveedores.id, existente.id));
        console.log(`[ConfProv] 🔄 Actualizado "${nombreFactura}" → "${proveedorNombre}"`);
      } else {
        await db.insert(confirmacionesProveedores).values({ nombreFactura, proveedorId, proveedorNombre, valido: 1 });
        console.log(`[ConfProv] 💾 Guardado "${nombreFactura}" → "${proveedorNombre}"`);
      }
    } catch (error) {
      console.error("[ConfProv] Error guardando:", error);
    }
  }
}

export const confirmacionesProveedoresService = new ConfirmacionesProveedoresService();
