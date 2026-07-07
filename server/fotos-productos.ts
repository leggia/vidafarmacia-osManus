// FOTOS DE PRODUCTOS, guardadas en MySQL (persistencia real: el disco de Railway
// se borra en cada deploy). Comprimidas en el cliente (~50-80KB) → a esta escala
// (cientos de fotos) MySQL las maneja sin problema y con backup incluido.
import type { Express, Request, Response } from "express";
import { getDb } from "./db";
import { sql } from "drizzle-orm";

const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const MAX_BYTES = 300 * 1024; // 300KB máximo por foto (llegan ~50-80KB comprimidas)

let tablaLista = false;
async function asegurarTabla() {
  if (tablaLista) return;
  const db = await getDb();
  if (!db) return;
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS producto_fotos (
      articuloId INT PRIMARY KEY,
      mime VARCHAR(40) NOT NULL DEFAULT 'image/jpeg',
      datos MEDIUMBLOB NOT NULL,
      actualizadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`));
  } catch { /* ya existe */ }
  tablaLista = true;
}

export const fotosProductos = {
  // Guardar/reemplazar la foto de un producto y enlazarla en el catálogo
  async subir(articuloId: number, base64: string, mime: string) {
    await asegurarTabla();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    const id = Number(articuloId);
    if (!id || id <= 0) throw new Error("Producto inválido");
    const m = ["image/jpeg", "image/png", "image/webp"].includes(mime) ? mime : "image/jpeg";
    const buf = Buffer.from(String(base64 || ""), "base64");
    if (buf.length < 500) throw new Error("Imagen vacía o corrupta");
    if (buf.length > MAX_BYTES) throw new Error(`Imagen muy pesada (${Math.round(buf.length / 1024)}KB, máx 300KB)`);
    await db.execute(sql`
      INSERT INTO producto_fotos (articuloId, mime, datos) VALUES (${id}, ${m}, ${buf})
      ON DUPLICATE KEY UPDATE mime = ${m}, datos = ${buf}
    `);
    const url = `/api/foto-producto/${id}`;
    await db.execute(sql`UPDATE productos_cache SET imagenUrl = ${url} WHERE articuloId = ${id}`);
    return { ok: true, url };
  },

  async quitar(articuloId: number) {
    await asegurarTabla();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    const id = Number(articuloId);
    await db.execute(sql`DELETE FROM producto_fotos WHERE articuloId = ${id}`);
    await db.execute(sql`UPDATE productos_cache SET imagenUrl = NULL WHERE articuloId = ${id}`);
    return { ok: true };
  },
};

// Endpoint público para servir la foto, con caché fuerte del navegador
export function registerFotoProductoRoute(app: Express) {
  app.get("/api/foto-producto/:id", async (req: Request, res: Response) => {
    try {
      await asegurarTabla();
      const db = await getDb();
      const id = Number(req.params.id);
      if (!db || !id || id <= 0) { res.status(404).end(); return; }
      const r = rows(await db.execute(sql`SELECT mime, datos FROM producto_fotos WHERE articuloId = ${id} LIMIT 1`));
      if (r.length === 0) { res.status(404).end(); return; }
      res.setHeader("Content-Type", r[0].mime || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=604800"); // 7 días
      res.end(Buffer.from(r[0].datos));
    } catch {
      res.status(500).end();
    }
  });
}
