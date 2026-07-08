// Generación de IMAGEN para publicaciones de marketing — enchufable:
//   1. Servicio integrado (BUILT_IN_FORGE_*, si la plantilla lo tiene configurado).
//   2. Together AI (TOGETHER_API_KEY): FLUX.1-schnell, rápido y barato/gratis.
//   3. Sin credenciales → error amable (el post ya trae "sugerenciaImagen" para
//      tomar una foto real, que en farmacia de barrio suele funcionar mejor).
// La imagen se guarda en MySQL (MEDIUMBLOB, como las fotos de productos) y se sirve
// por GET /api/imagen-post/:id — esa URL pública se usa también al publicar en redes.
import { getDb } from "./db";
import { sql } from "drizzle-orm";

const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };

let colLista = false;
async function asegurarColumna() {
  if (colLista) return;
  const db = await getDb();
  if (!db) return;
  try { await db.execute(sql.raw("ALTER TABLE marketing_posts ADD COLUMN imagen MEDIUMBLOB")); } catch { /* ya existe */ }
  try { await db.execute(sql.raw("ALTER TABLE marketing_posts ADD COLUMN imagenMime VARCHAR(40)")); } catch { /* ya existe */ }
  colLista = true;
}

function proveedorImagen(): "forge" | "together" | null {
  if (process.env.BUILT_IN_FORGE_API_URL && process.env.BUILT_IN_FORGE_API_KEY) return "forge";
  if (process.env.TOGETHER_API_KEY) return "together";
  return null;
}

async function generarConForge(prompt: string): Promise<Buffer | null> {
  try {
    const { generateImage } = await import("./_core/imageGeneration");
    const r = await generateImage({ prompt });
    if (!r.url) return null;
    const resp = await fetch(r.url);
    if (!resp.ok) return null;
    return Buffer.from(await resp.arrayBuffer());
  } catch (e: any) {
    console.warn("[MarketingImagen] forge falló:", e?.message);
    return null;
  }
}

async function generarConTogether(prompt: string): Promise<Buffer | null> {
  try {
    const resp = await fetch("https://api.together.xyz/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.TOGETHER_IMAGE_MODEL || "black-forest-labs/FLUX.1-schnell-Free",
        prompt,
        width: 1024,
        height: 1024,
        steps: 4,
        n: 1,
        response_format: "b64_json",
      }),
    });
    if (!resp.ok) {
      console.warn("[MarketingImagen] together status:", resp.status, (await resp.text()).slice(0, 200));
      return null;
    }
    const data = await resp.json() as any;
    const b64 = data?.data?.[0]?.b64_json;
    if (b64) return Buffer.from(b64, "base64");
    const url = data?.data?.[0]?.url;
    if (url) {
      const img = await fetch(url);
      if (img.ok) return Buffer.from(await img.arrayBuffer());
    }
    return null;
  } catch (e: any) {
    console.warn("[MarketingImagen] together falló:", e?.message);
    return null;
  }
}

// Generar y guardar la imagen de un post (usa su sugerenciaImagen + branding)
export async function generarImagenPost(postId: number) {
  await asegurarColumna();
  const db = await getDb();
  if (!db) return { error: "Sin BD" };
  const prov = proveedorImagen();
  if (!prov) {
    return {
      error: "No hay generador de imágenes configurado. Opciones: (a) configura TOGETHER_API_KEY en Railway (Together AI, modelo FLUX gratis), o (b) usa una foto real siguiendo la 'imagen sugerida' del post — en farmacia de barrio las fotos reales conectan más.",
    };
  }
  const post = rows(await db.execute(sql`SELECT id, titulo, sugerenciaImagen, tipo FROM marketing_posts WHERE id = ${num(postId)} LIMIT 1`))[0];
  if (!post) return { error: "Post no encontrado" };

  // Prompt con identidad de marca (colores del logo) y estilo apto para redes
  const base = post.sugerenciaImagen || post.titulo || "productos de farmacia y bienestar";
  const prompt = `Professional social media marketing image for a friendly neighborhood pharmacy in Bolivia called VidaFarma. ${base}. Clean modern style, bright and warm, brand colors: green, red-orange and yellow accents, white background, high quality, appetizing composition, no text, no words, no letters, no logos.`;

  const buf = prov === "forge" ? await generarConForge(prompt) : await generarConTogether(prompt);
  if (!buf || buf.length < 1000) return { error: "El generador no devolvió una imagen válida. Intenta de nuevo." };
  if (buf.length > 8 * 1024 * 1024) return { error: "Imagen demasiado grande." };

  await db.execute(sql`UPDATE marketing_posts SET imagen = ${buf}, imagenMime = ${"image/png"} WHERE id = ${num(postId)}`);
  return { ok: true, url: `/api/imagen-post/${num(postId)}` };
}

// Servir la imagen del post (pública: la usan el panel y las redes al publicar)
export function registerImagenPostRoute(app: any) {
  app.get("/api/imagen-post/:id", async (req: any, res: any) => {
    try {
      await asegurarColumna();
      const db = await getDb();
      if (!db) return res.status(503).end();
      const r = rows(await db.execute(sql`SELECT imagen, imagenMime FROM marketing_posts WHERE id = ${num(req.params.id)} LIMIT 1`))[0];
      if (!r || !r.imagen) return res.status(404).end();
      res.setHeader("Content-Type", r.imagenMime || "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.end(Buffer.from(r.imagen));
    } catch {
      res.status(500).end();
    }
  });
}

// URL pública absoluta de la imagen (para pasarla a las redes al publicar)
export async function urlImagenPublica(postId: number): Promise<string | null> {
  await asegurarColumna();
  const db = await getDb();
  if (!db) return null;
  const r = rows(await db.execute(sql`SELECT imagen FROM marketing_posts WHERE id = ${num(postId)} LIMIT 1`))[0];
  if (!r || !r.imagen) return null;
  const base = process.env.APP_URL || "https://vidafarmacia-osmanus-production.up.railway.app";
  return `${base}/api/imagen-post/${num(postId)}`;
}

// Guardar una foto PROPIA subida por el dueño (farmacia, personal, producto real).
// Recibe base64 (ya comprimida en el cliente) y la guarda igual que las generadas.
export async function guardarImagenPost(postId: number, imagenBase64: string, mime?: string) {
  await asegurarColumna();
  const db = await getDb();
  if (!db) return { error: "Sin BD" };
  const post = rows(await db.execute(sql`SELECT id FROM marketing_posts WHERE id = ${num(postId)} LIMIT 1`))[0];
  if (!post) return { error: "Post no encontrado" };
  let buf: Buffer;
  try {
    const limpio = imagenBase64.replace(/^data:image\/\w+;base64,/, "");
    buf = Buffer.from(limpio, "base64");
  } catch { return { error: "Imagen inválida." }; }
  if (buf.length < 1000) return { error: "Imagen demasiado pequeña o corrupta." };
  if (buf.length > 6 * 1024 * 1024) return { error: "Imagen demasiado grande (máx 6MB). Se comprime en el cliente; intenta de nuevo." };
  const m = /^image\/(jpeg|png|webp)$/.test(mime || "") ? mime! : "image/jpeg";
  await db.execute(sql`UPDATE marketing_posts SET imagen = ${buf}, imagenMime = ${m} WHERE id = ${num(postId)}`);
  return { ok: true, url: `/api/imagen-post/${num(postId)}` };
}
