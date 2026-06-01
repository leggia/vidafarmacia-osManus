/**
 * Sistema de Confirmaciones Aprendidas — usando MySQL
 * Persiste aunque el Codespace se reinicie
 */

import { getDb } from "./db";
import { confirmaciones as confirmacionesTable } from "../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { ArticuloAPI } from "./inventarios365";

class ConfirmacionesService {

  private normalizar(s: string): string {
    return s.toUpperCase().trim()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ");
  }

  async buscar(proveedor: string, nombreFactura: string): Promise<{ id: number; nombreSistema: string; codigo: string } | null> {
    try {
      const db = await getDb();
      if (!db) return null;

      const provNorm = this.normalizar(proveedor);
      const nombreNorm = this.normalizar(nombreFactura);

      // Buscar por proveedor y nombre normalizados
      const rows = await db.select().from(confirmacionesTable)
        .where(and(
          eq(confirmacionesTable.valido, 1)
        ));

      for (const row of rows) {
        if (
          this.normalizar(row.proveedor) === provNorm &&
          this.normalizar(row.nombreFactura) === nombreNorm
        ) {
          console.log(`[Confirmaciones] ✅ "${nombreFactura}" (${proveedor}) → "${row.articuloNombre}" (ID:${row.articuloId})`);
          return {
            id: row.articuloId,
            nombreSistema: row.articuloNombre,
            codigo: row.articuloCodigo || "",
          };
        }
      }
      return null;
    } catch (error) {
      console.error("[Confirmaciones] Error buscando:", error);
      return null;
    }
  }

  async confirmar(proveedor: string, nombreFactura: string, articulo: ArticuloAPI): Promise<void> {
    try {
      const db = await getDb();
      if (!db) return;

      const provNorm = this.normalizar(proveedor);
      const nombreNorm = this.normalizar(nombreFactura);

      // Buscar TODAS las confirmaciones y comparar normalizadas
      // (evita duplicados cuando el nombre tiene variaciones de mayúsculas/tildes/espacios)
      const todas = await db.select().from(confirmacionesTable);
      const existente = todas.find(row =>
        this.normalizar(row.proveedor) === provNorm &&
        this.normalizar(row.nombreFactura) === nombreNorm
      );

      if (existente) {
        // Actualizar la existente (corrige emparejamientos previos incorrectos)
        await db.update(confirmacionesTable)
          .set({
            articuloId: articulo.id,
            articuloNombre: articulo.nombre,
            articuloCodigo: articulo.codigo,
            valido: 1,
          })
          .where(eq(confirmacionesTable.id, existente.id));
        console.log(`[Confirmaciones] 🔄 Actualizado: "${nombreFactura}" (${proveedor}) → "${articulo.nombre}" (ID:${articulo.id})`);
      } else {
        // Insertar nuevo
        await db.insert(confirmacionesTable).values({
          proveedor,
          nombreFactura,
          articuloId: articulo.id,
          articuloNombre: articulo.nombre,
          articuloCodigo: articulo.codigo,
          valido: 1,
        });
        console.log(`[Confirmaciones] 💾 Guardado nuevo: "${nombreFactura}" (${proveedor}) → "${articulo.nombre}" (ID:${articulo.id})`);
      }
    } catch (error) {
      console.error("[Confirmaciones] Error guardando:", error);
    }
  }

  async invalidar(proveedor: string, nombreFactura: string): Promise<void> {
    try {
      const db = await getDb();
      if (!db) return;
      await db.update(confirmacionesTable)
        .set({ valido: 0 })
        .where(and(
          eq(confirmacionesTable.proveedor, proveedor),
          eq(confirmacionesTable.nombreFactura, nombreFactura)
        ));
      console.log(`[Confirmaciones] ❌ Invalidado: "${nombreFactura}" (${proveedor})`);
    } catch (error) {
      console.error("[Confirmaciones] Error invalidando:", error);
    }
  }

  async verificar(): Promise<{ verificados: number; invalidos: number }> {
    const { inventarios365 } = await import("./inventarios365");
    const db = await getDb();
    if (!db) return { verificados: 0, invalidos: 0 };

    const rows = await db.select().from(confirmacionesTable)
      .where(eq(confirmacionesTable.valido, 1));

    let verificados = 0;
    let invalidos = 0;

    for (const row of rows) {
      try {
        const articulos = await inventarios365.listarArticulos(row.articuloNombre.split(" ")[0]);
        const existe = articulos.some(a => a.id === row.articuloId);
        if (!existe) {
          await db.update(confirmacionesTable)
            .set({ valido: 0 })
            .where(eq(confirmacionesTable.id, row.id));
          invalidos++;
          console.warn(`[Confirmaciones] ID ${row.articuloId} ya no existe — invalidado`);
        } else {
          verificados++;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[Confirmaciones] Verificación: ${verificados} válidos, ${invalidos} invalidados`);
    return { verificados, invalidos };
  }

  async estadisticas(): Promise<object> {
    try {
      const db = await getDb();
      if (!db) return {};
      const rows = await db.select().from(confirmacionesTable);
      const porProveedor: Record<string, number> = {};
      let totalValidas = 0;
      let totalInvalidas = 0;
      for (const row of rows) {
        if (row.valido) {
          porProveedor[row.proveedor] = (porProveedor[row.proveedor] || 0) + 1;
          totalValidas++;
        } else {
          totalInvalidas++;
        }
      }
      return { totalValidas, totalInvalidas, proveedores: Object.keys(porProveedor).length, porProveedor };
    } catch {
      return {};
    }
  }

  async todos(): Promise<any[]> {
    try {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(confirmacionesTable).where(eq(confirmacionesTable.valido, 1));
    } catch {
      return [];
    }
  }
}

export const confirmacionesService = new ConfirmacionesService();

// Verificación automática cada 7 días
setInterval(() => {
  confirmacionesService.verificar().catch(console.error);
}, 7 * 24 * 60 * 60 * 1000);
