/**
 * Historial de Precios de Compra
 * Registra el costo de cada producto en cada compra para:
 *  - Alertar cuando un producto llega con costo más alto que antes
 *  - Sugerir ajuste de precio de venta
 *  - Consultas históricas: precio más bajo/alto, promedio, tendencia
 */

import { getDb } from "./db";
import { historialPrecios } from "../drizzle/schema";
import { eq, desc, and } from "drizzle-orm";

export interface RegistroPrecio {
  articuloId: number;
  articuloNombre: string;
  proveedor?: string;
  costoUnitario: number;
  precioVenta?: number;
  numComprobante?: string;
}

export interface AnalisisPrecio {
  esNuevo: boolean;           // primera vez que se compra
  costoActual: number;
  costoAnterior: number | null;
  costoMinimo: number | null;
  costoMaximo: number | null;
  costoPromedio: number | null;
  vecesComprado: number;
  subioRespectoAnterior: boolean;
  porcentajeSubida: number | null; // % de aumento vs la compra anterior
}

class HistorialPreciosService {
  /**
   * Registra el precio de compra de un producto.
   */
  async registrar(r: RegistroPrecio): Promise<void> {
    try {
      const db = await getDb();
      if (!db) return;
      await db.insert(historialPrecios).values({
        articuloId: r.articuloId,
        articuloNombre: r.articuloNombre,
        proveedor: r.proveedor || null,
        costoUnitario: String(r.costoUnitario),
        precioVenta: r.precioVenta != null ? String(r.precioVenta) : null,
        numComprobante: r.numComprobante || null,
      });
      console.log(`[Historial] 💲 Registrado: "${r.articuloNombre}" costo ${r.costoUnitario}`);
    } catch (error) {
      console.error("[Historial] Error registrando precio:", error);
    }
  }

  /**
   * Analiza el costo de un producto comparado con su historial,
   * ANTES de registrar el nuevo (para alertar al usuario).
   */
  async analizar(articuloId: number, costoActual: number): Promise<AnalisisPrecio> {
    const vacio: AnalisisPrecio = {
      esNuevo: true, costoActual, costoAnterior: null, costoMinimo: null,
      costoMaximo: null, costoPromedio: null, vecesComprado: 0,
      subioRespectoAnterior: false, porcentajeSubida: null,
    };
    try {
      const db = await getDb();
      if (!db) return vacio;

      const rows = await db.select().from(historialPrecios)
        .where(eq(historialPrecios.articuloId, articuloId))
        .orderBy(desc(historialPrecios.registradoEn));

      if (rows.length === 0) return vacio;

      const costos = rows.map(r => parseFloat(String(r.costoUnitario))).filter(c => c > 0);
      if (costos.length === 0) return vacio;

      const costoAnterior = costos[0]; // el más reciente
      const costoMinimo = Math.min(...costos);
      const costoMaximo = Math.max(...costos);
      const costoPromedio = costos.reduce((a, b) => a + b, 0) / costos.length;
      const subio = costoActual > costoAnterior;
      const porcentajeSubida = costoAnterior > 0
        ? ((costoActual - costoAnterior) / costoAnterior) * 100
        : null;

      return {
        esNuevo: false,
        costoActual,
        costoAnterior,
        costoMinimo,
        costoMaximo,
        costoPromedio: Math.round(costoPromedio * 10000) / 10000,
        vecesComprado: costos.length,
        subioRespectoAnterior: subio,
        porcentajeSubida: porcentajeSubida != null ? Math.round(porcentajeSubida * 10) / 10 : null,
      };
    } catch (error) {
      console.error("[Historial] Error analizando precio:", error);
      return vacio;
    }
  }

  /**
   * Historial completo de un producto (para consultas futuras del agente).
   */
  async historialDe(articuloId: number): Promise<Array<{ costo: number; precioVenta: number | null; proveedor: string | null; fecha: Date; comprobante: string | null }>> {
    try {
      const db = await getDb();
      if (!db) return [];
      const rows = await db.select().from(historialPrecios)
        .where(eq(historialPrecios.articuloId, articuloId))
        .orderBy(desc(historialPrecios.registradoEn));
      return rows.map(r => ({
        costo: parseFloat(String(r.costoUnitario)),
        precioVenta: r.precioVenta != null ? parseFloat(String(r.precioVenta)) : null,
        proveedor: r.proveedor,
        fecha: r.registradoEn,
        comprobante: r.numComprobante,
      }));
    } catch (error) {
      console.error("[Historial] Error obteniendo historial:", error);
      return [];
    }
  }
}

export const historialPreciosService = new HistorialPreciosService();
