/**
 * Cache local de productos de inventarios365.com
 *
 * - Se actualiza automáticamente cada 24 horas
 * - Se actualiza manualmente cuando se crea/edita un producto
 * - Permite matching fuzzy local sin llamadas a la API por cada búsqueda
 */

import fs from "fs";
import path from "path";
import { inventarios365, ArticuloAPI } from "./inventarios365";

const CACHE_FILE = path.join(process.cwd(), "productos-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

interface CacheData {
  productos: ArticuloAPI[];
  ultimaActualizacion: number;
  total: number;
}

class ProductosCacheService {
  private cache: CacheData | null = null;
  private actualizando = false;

  private cargarDesdeDisco(): void {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const raw = fs.readFileSync(CACHE_FILE, "utf-8");
        this.cache = JSON.parse(raw);
        console.log(
          `[Cache] Cargado desde disco: ${this.cache?.total} productos (${new Date(this.cache?.ultimaActualizacion || 0).toLocaleString()})`
        );
      }
    } catch {
      console.warn("[Cache] No se pudo cargar desde disco");
    }
  }

  private guardarEnDisco(): void {
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(this.cache, null, 2), "utf-8");
      console.log(`[Cache] Guardado en disco: ${this.cache?.total} productos`);
    } catch (error) {
      console.error("[Cache] Error guardando en disco:", error);
    }
  }

  private estaDesactualizado(): boolean {
    if (!this.cache) return true;
    return Date.now() - this.cache.ultimaActualizacion > CACHE_TTL_MS;
  }

  async actualizar(forzar = false): Promise<void> {
    if (this.actualizando) {
      while (this.actualizando) await new Promise((r) => setTimeout(r, 500));
      return;
    }
    if (!forzar && !this.estaDesactualizado()) {
      console.log("[Cache] Cache vigente");
      return;
    }

    this.actualizando = true;
    console.log("[Cache] Descargando todos los productos...");

    try {
      const todos: ArticuloAPI[] = [];

      // Descargar con búsqueda vacía primero
      const base = await inventarios365.listarArticulos("");
      todos.push(...base);

      // Si parece paginado, buscar por letra
      if (base.length < 200) {
        const letras = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");
        for (const letra of letras) {
          const pagina = await inventarios365.listarArticulos(letra);
          for (const art of pagina) {
            if (!todos.find((a) => a.id === art.id)) todos.push(art);
          }
          await new Promise((r) => setTimeout(r, 150));
        }
      }

      this.cache = {
        productos: todos,
        ultimaActualizacion: Date.now(),
        total: todos.length,
      };

      this.guardarEnDisco();
      console.log(`[Cache] ✅ ${todos.length} productos descargados`);
    } catch (error) {
      console.error("[Cache] Error actualizando:", error);
    } finally {
      this.actualizando = false;
    }
  }

  buscarLocal(nombre: string, idProveedor?: number): ArticuloAPI | null {
    // Filtrar por proveedor si está disponible para mayor precisión
    const pool = idProveedor && this.cache
      ? this.cache.productos.filter(p => (p as any).idproveedor === idProveedor)
      : this.cache?.productos || [];
    const useFiltered = pool.length > 0;
    if (!this.cache || this.cache.productos.length === 0) return null;
    if (!this.cache || this.cache.productos.length === 0) return null;

    const tokenize = (s: string) =>
      s.toUpperCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // quitar tildes
        .replace(/[^A-Z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1);

    const tokensNombre = tokenize(nombre);
    if (tokensNombre.length === 0) return null;

    // El primer token es el nombre principal del medicamento — debe coincidir obligatoriamente
    const tokenPrincipal = tokensNombre[0];

    let mejorMatch: { art: ArticuloAPI; score: number } | null = null;

    const searchPool = useFiltered ? pool : this.cache.productos;
    for (const art of searchPool) {
      const tokensCandidato = tokenize(art.nombre);

      // REGLA 1: El token principal DEBE estar presente en el candidato
      const tokenPrincipalPresente = tokensCandidato.some(
        (c) => c.startsWith(tokenPrincipal) || tokenPrincipal.startsWith(c)
      );
      if (!tokenPrincipalPresente) continue;

      // REGLA 2: Calcular score basado en tokens coincidentes
      let matches = 0;
      for (const t of tokensNombre) {
        if (tokensCandidato.some((c) => c.startsWith(t) || t.startsWith(c))) matches++;
      }

      // REGLA 3: Score bidireccional — penalizar si el candidato tiene muchos tokens extra
      const scoreAdelante = matches / tokensNombre.length;
      const scoreAtras = matches / tokensCandidato.length;
      const score = (scoreAdelante + scoreAtras) / 2;

      if (score > 0 && (!mejorMatch || score > mejorMatch.score)) {
        mejorMatch = { art, score };
      }
    }

    // REGLA 4: Umbral mínimo alto — 0.75 para evitar falsos positivos
    if (mejorMatch && mejorMatch.score >= 0.65) {
      console.log(`[Cache] "${nombre}" → "${mejorMatch.art.nombre}" (score:${mejorMatch.score.toFixed(2)})`);
      return mejorMatch.art;
    }

    if (mejorMatch) {
      console.warn(`[Cache] "${nombre}" → mejor candidato "${mejorMatch.art.nombre}" (score:${mejorMatch.score.toFixed(2)}) — descartado por score bajo`);
    }

    return null;
  }

  async obtenerTodos(): Promise<ArticuloAPI[]> {
    await this.inicializar();
    return this.cache?.productos || [];
  }

  async inicializar(): Promise<void> {
    if (!this.cache) this.cargarDesdeDisco();
    if (this.estaDesactualizado()) {
      this.actualizar().catch(console.error);
    }
  }

  programarActualizacionAutomatica(): void {
    console.log("[Cache] Actualización automática cada 24 horas");
    setInterval(() => {
      this.actualizar(true).catch(console.error);
    }, CACHE_TTL_MS);
  }

  estadisticas(): object {
    return {
      total: this.cache?.total || 0,
      ultimaActualizacion: this.cache?.ultimaActualizacion
        ? new Date(this.cache.ultimaActualizacion).toLocaleString()
        : "Nunca",
      proximaActualizacion: this.cache?.ultimaActualizacion
        ? new Date(this.cache.ultimaActualizacion + CACHE_TTL_MS).toLocaleString()
        : "Pendiente",
      vigente: !this.estaDesactualizado(),
    };
  }
}

export const productosCache = new ProductosCacheService();
productosCache.inicializar().catch(console.error);
productosCache.programarActualizacionAutomatica();
