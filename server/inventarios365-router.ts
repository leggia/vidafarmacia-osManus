import { protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import { inventarios365 } from "./inventarios365";

export const inventarios365Router = router({
  sincronizarProductos: protectedProcedure.mutation(async () => {
    try {
      console.log("[API] Iniciando sincronización de productos de inventarios365...");
      const productos = await inventarios365.descargarTodosLosProductos();
      if (productos.length === 0) {
        return { success: false, message: "No se descargaron productos" };
      }

      const productosDB = productos.map((p) => ({
        idarticulo: p.id,
        codigo: p.codigo,
        nombre: p.nombre,
        precio_costo: String(p.precio_costo_unid ? parseFloat(String(p.precio_costo_unid)) : 0),
        precio_venta: String(p.precio_uno ? parseFloat(String(p.precio_uno)) : 0),
        stock: 0,
      }));

      await db.bulkUpsertInventarios365Products(productosDB);

      return {
        success: true,
        message: `${productos.length} productos sincronizados exitosamente`,
        count: productos.length,
      };
    } catch (error: any) {
      console.error("[API] Error sincronizando productos:", error);
      return {
        success: false,
        message: error?.message || "Error desconocido",
      };
    }
  }),

  buscar: protectedProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ input }) => {
      return db.searchInventarios365Products(input.query);
    }),

  estadisticas: protectedProcedure.query(async () => {
    const count = await db.getInventarios365ProductCount();
    return { count, message: `${count} productos en cache` };
  }),

  limpiarCache: protectedProcedure.mutation(async () => {
    await db.clearInventarios365ProductsCache();
    return { success: true, message: "Cache limpiado" };
  }),
});
