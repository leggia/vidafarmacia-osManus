/**
 * Cache local de productos — usando MySQL
 * Persiste aunque el Codespace se reinicie
 */

import { getDb } from "./db";
import { productosCache as productosCacheTable } from "../drizzle/schema";
import { eq, like, sql } from "drizzle-orm";
import { inventarios365, ArticuloAPI } from "./inventarios365";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
let ultimaActualizacion: number = 0;
let actualizando = false;

class ProductosCacheService {

  async estaDesactualizado(): Promise<boolean> {
    if (ultimaActualizacion === 0) {
      // Verificar si hay datos en la base de datos
      try {
        const db = await getDb();
        if (!db) return true;
        const count = await db.select({ count: sql<number>`count(*)` }).from(productosCacheTable);
        if (count[0]?.count === 0) return true;
        ultimaActualizacion = Date.now() - (CACHE_TTL_MS / 2); // Asume que fue hace 12h
      } catch {
        return true;
      }
    }
    return Date.now() - ultimaActualizacion > CACHE_TTL_MS;
  }

  async actualizar(forzar = false): Promise<void> {
    if (actualizando) {
      while (actualizando) await new Promise(r => setTimeout(r, 500));
      return;
    }
    if (!forzar && !(await this.estaDesactualizado())) {
      console.log("[Cache] Cache vigente");
      return;
    }

    actualizando = true;
    console.log("[Cache] Descargando todos los productos...");

    try {
      const db = await getDb();
      if (!db) return;

      const todos: ArticuloAPI[] = [];
      const base = await inventarios365.listarArticulos("");
      todos.push(...base);

      if (base.length < 200) {
        const letras = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
        for (const letra of letras) {
          const pagina = await inventarios365.listarArticulos(letra);
          for (const art of pagina) {
            if (!todos.find(a => a.id === art.id)) todos.push(art);
          }
          await new Promise(r => setTimeout(r, 150));
        }
      }

      // Guardar en MySQL en lotes de 100
      for (let i = 0; i < todos.length; i += 100) {
        const lote = todos.slice(i, i + 100);
        for (const art of lote) {
          await db.insert(productosCacheTable).values({
            articuloId: art.id,
            nombre: art.nombre,
            codigo: art.codigo || "",
            idProveedor: (art as any).idproveedor || null,
            nombreProveedor: (art as any).proveedor || null,
            precioCostoUnid: String(art.precio_costo_unid || 0),
            precioCostoPaq: String(art.precio_costo_paq || 0),
            precioUno: String(art.precio_uno || 0),
            unidadEnvase: art.unidad_envase || 1,
            imagenUrl: (art as any).imagen ?? (art as any).foto ?? (art as any).url_imagen ?? (art as any).imagen_url ?? null,
          }).onDuplicateKeyUpdate({
            set: {
              nombre: art.nombre,
              codigo: art.codigo || "",
              idProveedor: (art as any).idproveedor || null,
              precioCostoUnid: String(art.precio_costo_unid || 0),
              imagenUrl: (art as any).imagen ?? (art as any).foto ?? (art as any).url_imagen ?? (art as any).imagen_url ?? null,
            }
          });
        }
      }

      ultimaActualizacion = Date.now();
      console.log(`[Cache] ✅ ${todos.length} productos guardados en MySQL`);
    } catch (error) {
      console.error("[Cache] Error actualizando:", error);
    } finally {
      actualizando = false;
    }
  }

  buscarLocal(nombre: string, idProveedor?: number): ArticuloAPI | null {
    // Este método ahora es async pero lo mantenemos sync para compatibilidad
    // La búsqueda real se hace en buscarLocalAsync
    return null;
  }

  async buscarLocalAsync(nombre: string, idProveedor?: number): Promise<ArticuloAPI | null> {
    try {
      const db = await getDb();
      if (!db) return null;

      const tokenize = (s: string) =>
        s.toUpperCase()
          .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
          .replace(/[^A-Z0-9\s]/g, " ")
          .split(/\s+/)
          .filter(t => t.length > 1);

      const tokensNombre = tokenize(nombre);
      if (tokensNombre.length === 0) return null;

      const tokenPrincipal = tokensNombre[0];

      // Buscar en MySQL con el token principal
      let query = db.select().from(productosCacheTable)
        .where(like(productosCacheTable.nombre, `%${tokenPrincipal}%`));

      const candidatos = await query.limit(100);

      let mejorMatch: { art: any; score: number } | null = null;

      for (const art of candidatos) {
        // Filtrar por proveedor si está disponible
        if (idProveedor && art.idProveedor && art.idProveedor !== idProveedor) continue;

        const tokensCandidato = tokenize(art.nombre);
        const tokenPrincipalPresente = tokensCandidato.some(
          c => c.startsWith(tokenPrincipal) || tokenPrincipal.startsWith(c)
        );
        if (!tokenPrincipalPresente) continue;

        let matches = 0;
        for (const t of tokensNombre) {
          if (tokensCandidato.some(c => c.startsWith(t) || t.startsWith(c))) matches++;
        }

        const scoreAdelante = matches / tokensNombre.length;
        const scoreAtras = matches / tokensCandidato.length;
        const score = (scoreAdelante + scoreAtras) / 2;

        if (score > 0 && (!mejorMatch || score > mejorMatch.score)) {
          mejorMatch = { art, score };
        }
      }

      if (mejorMatch && mejorMatch.score >= 0.65) {
        console.log(`[Cache] "${nombre}" → "${mejorMatch.art.nombre}" (score:${mejorMatch.score.toFixed(2)})`);
        return {
          id: mejorMatch.art.articuloId,
          nombre: mejorMatch.art.nombre,
          codigo: mejorMatch.art.codigo,
          precio_costo_unid: parseFloat(mejorMatch.art.precioCostoUnid || "0"),
          precio_costo_paq: parseFloat(mejorMatch.art.precioCostoPaq || "0"),
          precio_uno: parseFloat(mejorMatch.art.precioUno || "0"),
          unidad_envase: mejorMatch.art.unidadEnvase,
          _score: mejorMatch.score,
        } as any;
      }

      return null;
    } catch (error) {
      console.error("[Cache] Error buscando:", error);
      return null;
    }
  }

  async obtenerTodos(): Promise<any[]> {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(productosCacheTable);
  }

  async inicializar(): Promise<void> {
    if (await this.estaDesactualizado()) {
      this.actualizar().catch(console.error);
    }
  }

  programarActualizacionAutomatica(): void {
    console.log("[Cache] Actualización automática cada 24 horas");
    setInterval(() => {
      this.actualizar(true).catch(console.error);
    }, CACHE_TTL_MS);
  }

  async estadisticas(): Promise<object> {
    try {
      const db = await getDb();
      if (!db) return {};
      const count = await db.select({ count: sql<number>`count(*)` }).from(productosCacheTable);
      return {
        total: count[0]?.count || 0,
        ultimaActualizacion: ultimaActualizacion
          ? new Date(ultimaActualizacion).toLocaleString()
          : "Pendiente",
        vigente: !(await this.estaDesactualizado()),
      };
    } catch {
      return {};
    }
  }
}

export const productosCache = new ProductosCacheService();
productosCache.inicializar().catch(console.error);
productosCache.programarActualizacionAutomatica();
