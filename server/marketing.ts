// MÓDULO DE MARKETING (Company of One): un agente redacta las publicaciones con
// datos REALES del negocio (ofertas, más vendidos, temporada), Luis aprueba desde
// el panel /marketing, y un conector enchufable las publica (Facebook directo,
// API unificado para TikTok/IG, o modo manual copiar/pegar).
//
// SALVAGUARDAS LEGALES (ver SERVICIOS.md §10): el generador NO publicita
// medicamentos de venta con receta ni hace afirmaciones médicas (curar/tratar).
// Solo venta libre, cuidado personal y consejos generales con descargo.
import { getDb } from "./db";
import { sql } from "drizzle-orm";
import { invokeDeepSeek, deepseekDisponible } from "./_core/deepseek";

const rows = (r: any) => { const x = Array.isArray(r) ? r[0] : r?.rows ?? r; return Array.isArray(x) ? x : []; };
const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };

let tablasListas = false;
async function asegurarTablas() {
  if (tablasListas) return;
  const db = await getDb();
  if (!db) return;
  try {
    await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS marketing_posts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tipo VARCHAR(40) NOT NULL,
      titulo VARCHAR(200),
      contenido TEXT NOT NULL,
      hashtags VARCHAR(400),
      sugerenciaImagen VARCHAR(500),
      estado VARCHAR(20) NOT NULL DEFAULT 'borrador',
      redes VARCHAR(120) DEFAULT 'facebook',
      publicadoEn DATETIME,
      resultadoPublicacion VARCHAR(600),
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_mp_estado (estado)
    )`));
  } catch { /* ya existe */ }
  try { await db.execute(sql.raw("ALTER TABLE marketing_posts ADD COLUMN imagen MEDIUMBLOB")); } catch { /* ya existe */ }
  try { await db.execute(sql.raw("ALTER TABLE marketing_posts ADD COLUMN programadoPara DATETIME")); } catch { /* ya existe */ }
  try { await db.execute(sql.raw("ALTER TABLE marketing_posts ADD COLUMN imagenMime VARCHAR(40)")); } catch { /* ya existe */ }
  tablasListas = true;
}

// ─── Contexto real del negocio para alimentar al agente ───
async function contextoNegocio(): Promise<string> {
  const db = await getDb();
  const partes: string[] = [];
  if (!db) return "";
  // Ofertas activas
  try {
    const ofs = rows(await db.execute(sql.raw(
      `SELECT nombreProducto, precioNormal, precioOferta, hastaFecha FROM ofertas_tienda
       WHERE activa = 1 AND (hastaFecha IS NULL OR hastaFecha >= CURDATE()) LIMIT 8`
    )));
    if (ofs.length) partes.push("OFERTAS ACTIVAS: " + ofs.map((o: any) =>
      `${o.nombreProducto} (antes Bs ${num(o.precioNormal)}, ahora Bs ${num(o.precioOferta)}${o.hastaFecha ? ", hasta " + String(o.hastaFecha).slice(0, 10) : ""})`).join("; "));
  } catch { /* sin ofertas */ }
  // Más vendidos (60 días)
  try {
    const top = rows(await db.execute(sql.raw(
      `SELECT d.articuloNombre AS nombre, SUM(d.cantidad) AS v FROM ventas_detalle d
       WHERE d.fecha >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 60 DAY), '%Y-%m-%d')
       AND d.articuloNombre NOT LIKE '%venta menor%' GROUP BY d.articuloNombre ORDER BY v DESC LIMIT 8`
    )));
    if (top.length) partes.push("PRODUCTOS MÁS VENDIDOS: " + top.map((t: any) => t.nombre).join("; "));
  } catch { /* sin datos */ }
  // Temporada (hemisferio sur, Bolivia)
  const mes = new Date().getMonth() + 1;
  const temporada = mes >= 5 && mes <= 8 ? "invierno (época de resfríos, gripes y tos)"
    : mes >= 9 && mes <= 11 ? "primavera (época de alergias y polvo)"
    : mes === 12 || mes <= 2 ? "verano (época de calor, hidratación y protección solar)"
    : "otoño (cambios de temperatura)";
  partes.push(`TEMPORADA ACTUAL en Cochabamba, Bolivia: ${temporada}.`);
  return partes.join("\n");
}

// ─── Plantillas de post (cada una define el ángulo del contenido) ───
const PLANTILLAS: Record<string, { nombre: string; instruccion: string }> = {
  oferta_semana: {
    nombre: "Oferta de la semana",
    instruccion: "Crea un post promocionando las OFERTAS ACTIVAS (usa las reales del contexto; si no hay, invita a visitar la tienda online para ver precios). Destaca el ahorro con el precio antes/ahora. Llamado a la acción: reservar en la tienda online y recoger en sucursal.",
  },
  consejo_salud: {
    nombre: "Consejo de salud",
    instruccion: "Crea un post con un CONSEJO DE SALUD práctico y de temporada (usa la TEMPORADA del contexto). Debe ser útil por sí mismo (que la gente quiera guardarlo o compartirlo). Cierra recomendando visitar VidaFarma para productos de venta libre relacionados.",
  },
  producto_destacado: {
    nombre: "Producto destacado",
    instruccion: "Elige UNO de los PRODUCTOS MÁS VENDIDOS del contexto (solo si es de venta libre; si todos parecen de receta, elige vitaminas o cuidado personal) y crea un post destacándolo: para qué sirve en términos generales, por qué es popular, disponible en VidaFarma.",
  },
  puntos_fidelidad: {
    nombre: "Programa de puntos",
    instruccion: "Crea un post invitando a los clientes al programa de puntos de VidaFarma: 1 punto por cada Bs de compra, al juntar 1000 puntos reciben un vale de Bs 10. Se acumula comprando en mostrador (dando su teléfono) y en la tienda online. Tono entusiasta.",
  },
  tienda_online: {
    nombre: "Tienda online",
    instruccion: "Crea un post presentando la tienda online de VidaFarma: buscar el medicamento (hasta por su principio activo/genérico), ver disponibilidad por sucursal, reservar con un código y recoger sin filas. Enfatiza la comodidad.",
  },
  temporada: {
    nombre: "Campaña de temporada",
    instruccion: "Crea un post de campaña según la TEMPORADA del contexto: qué productos de venta libre conviene tener en casa esta época (botiquín de temporada) y por qué. Invita a encontrarlos en VidaFarma.",
  },
};

export const tiposDePost = Object.entries(PLANTILLAS).map(([id, p]) => ({ id, nombre: p.nombre }));

// ─── Generador de contenido (el agente redactor) ───
export async function generarPost(tipo: string, indicaciones?: string) {
  await asegurarTablas();
  if (!deepseekDisponible()) return { error: "El generador necesita DEEPSEEK_API_KEY configurada." };
  const plantilla = PLANTILLAS[tipo];
  if (!plantilla) return { error: `Tipo de post desconocido. Disponibles: ${Object.keys(PLANTILLAS).join(", ")}` };

  const contexto = await contextoNegocio();
  const sistema = `Eres el redactor de marketing de VidaFarma, una farmacia familiar de Cochabamba, Bolivia, con 4 sucursales y tienda online. Tu voz: cercana, confiable, de barrio — la farmacia que conoce a sus clientes por su nombre (a diferencia de las cadenas grandes e impersonales).

REGLAS LEGALES ESTRICTAS (no negociables):
- NUNCA promociones medicamentos de venta bajo receta (antibióticos, psicotrópicos, controlados). Solo productos de venta libre, vitaminas, cuidado personal, dermocosmética, bebé.
- NUNCA hagas afirmaciones médicas (curar, tratar, prevenir enfermedades). Usa lenguaje de bienestar general.
- Si mencionas síntomas, incluye siempre alguna variante de "consulta a tu médico o farmacéutico".
- No inventes precios ni ofertas: usa SOLO las del contexto.

FORMATO DE RESPUESTA: responde SOLO un JSON válido, sin markdown ni backticks:
{"titulo": "título corto y atractivo", "contenido": "el texto del post, con emojis moderados, 3-6 líneas, listo para publicar", "hashtags": "#VidaFarma #Cochabamba y 3-5 más relevantes", "sugerenciaImagen": "descripción breve de la foto/imagen ideal para acompañar"}`;

  const usuario = `CONTEXTO REAL DEL NEGOCIO:
${contexto}

TAREA: ${plantilla.instruccion}${indicaciones ? `\n\nINDICACIONES ADICIONALES DEL DUEÑO: ${indicaciones}` : ""}`;

  try {
    const r = await invokeDeepSeek({
      messages: [
        { role: "system", content: sistema },
        { role: "user", content: usuario },
      ],
      maxTokens: 800,
      temperature: 0.8, // creatividad para marketing (el asistente operativo usa 0)
    });
    const texto = (r.choices?.[0]?.message?.content || "").trim().replace(/```json|```/g, "").trim();
    let post: any;
    try { post = JSON.parse(texto); }
    catch { return { error: "El generador no devolvió un formato válido. Intenta de nuevo." }; }

    // Salvaguarda extra: rechazar si mencionó un controlado (defensa en profundidad)
    const { } = {} as any;
    let esControladoFn: ((n: string, d?: string | null) => boolean) | null = null;
    try { const t = await import("./tienda"); esControladoFn = (t as any).esControlado || null; } catch { /* opcional */ }
    const textoCompleto = `${post.titulo || ""} ${post.contenido || ""}`;
    if (esControladoFn && esControladoFn(textoCompleto)) {
      return { error: "El borrador mencionaba un medicamento controlado y fue descartado por seguridad. Genera de nuevo." };
    }

    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    await db.execute(sql`
      INSERT INTO marketing_posts (tipo, titulo, contenido, hashtags, sugerenciaImagen)
      VALUES (${tipo}, ${String(post.titulo || "").slice(0, 200)}, ${String(post.contenido || "").slice(0, 4000)},
              ${String(post.hashtags || "").slice(0, 400)}, ${String(post.sugerenciaImagen || "").slice(0, 500)})
    `);
    const nuevo = rows(await db.execute(sql.raw(`SELECT * FROM marketing_posts ORDER BY id DESC LIMIT 1`)))[0];
    return { ok: true, post: nuevo };
  } catch (e: any) {
    return { error: `Error generando: ${e?.message || "desconocido"}` };
  }
}

// ─── Gestión de la cola ───
export const marketing = {
  async listar(estado?: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return { posts: [] };
    const cond = estado ? sql`WHERE estado = ${estado}` : sql`WHERE estado != 'descartado'`;
    const posts = rows(await db.execute(sql`
      SELECT id, tipo, titulo, contenido, hashtags, sugerenciaImagen, estado, redes,
             publicadoEn, creadoEn, programadoPara, (imagen IS NOT NULL) AS tieneImagen
      FROM marketing_posts ${cond} ORDER BY creadoEn DESC LIMIT 50
    `));
    return { posts };
  },
  async editar(id: number, campos: { titulo?: string; contenido?: string; hashtags?: string }) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    if (campos.titulo != null) await db.execute(sql`UPDATE marketing_posts SET titulo = ${campos.titulo.slice(0, 200)} WHERE id = ${num(id)}`);
    if (campos.contenido != null) await db.execute(sql`UPDATE marketing_posts SET contenido = ${campos.contenido.slice(0, 4000)} WHERE id = ${num(id)}`);
    if (campos.hashtags != null) await db.execute(sql`UPDATE marketing_posts SET hashtags = ${campos.hashtags.slice(0, 400)} WHERE id = ${num(id)}`);
    return { ok: true };
  },
  async cambiarEstado(id: number, estado: string) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    if (!["borrador", "aprobado", "publicado", "descartado"].includes(estado)) throw new Error("Estado inválido");
    await db.execute(sql`UPDATE marketing_posts SET estado = ${estado}${estado === "publicado" ? sql`, publicadoEn = NOW()` : sql``} WHERE id = ${num(id)}`);
    return { ok: true };
  },
  // Programar (o desprogramar con fecha null) la publicación de un post aprobado.
  // fechaISO llega en hora de Bolivia (UTC-4) desde el panel; se guarda en UTC.
  async programar(id: number, fechaISO: string | null) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) throw new Error("Sin BD");
    if (!fechaISO) {
      await db.execute(sql`UPDATE marketing_posts SET programadoPara = NULL WHERE id = ${num(id)}`);
      return { ok: true, mensaje: "Programación cancelada." };
    }
    // Bolivia UTC-4 → UTC: sumar 4 horas
    const local = new Date(fechaISO + (fechaISO.length <= 16 ? ":00" : ""));
    if (isNaN(local.getTime())) return { error: "Fecha inválida." };
    const utc = new Date(local.getTime() + 4 * 3600 * 1000);
    const utcStr = utc.toISOString().slice(0, 19).replace("T", " ");
    await db.execute(sql`UPDATE marketing_posts SET programadoPara = ${utcStr} WHERE id = ${num(id)} AND estado = 'aprobado'`);
    return { ok: true, mensaje: `Programado. Se publicará automáticamente si hay redes conectadas.` };
  },

  // Publicar los posts aprobados cuya hora programada ya llegó (lo llama el scheduler).
  // Solo actúa si hay un conector real; en modo manual no puede publicar solo.
  async publicarProgramados() {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return { publicados: 0 };
    const { redesDisponibles } = await import("./publicacion-redes");
    if (redesDisponibles().modo === "manual") return { publicados: 0, motivo: "sin redes conectadas" };
    const pendientes = rows(await db.execute(sql.raw(
      `SELECT id FROM marketing_posts WHERE estado = 'aprobado' AND programadoPara IS NOT NULL AND programadoPara <= UTC_TIMESTAMP() LIMIT 5`
    )));
    let publicados = 0;
    for (const p of pendientes) {
      try {
        const r: any = await marketing.publicar(num(p.id));
        if (r?.ok) publicados++;
        else console.warn(`[Marketing] programado ${p.id} no publicado:`, r?.error || r?.modo);
      } catch (e: any) {
        console.warn(`[Marketing] programado ${p.id} error:`, e?.message);
      }
    }
    return { publicados };
  },

  // Publicar un post aprobado por el conector disponible
  async publicar(id: number) {
    await asegurarTablas();
    const db = await getDb();
    if (!db) return { error: "Sin BD" };
    const post = rows(await db.execute(sql`SELECT * FROM marketing_posts WHERE id = ${num(id)} LIMIT 1`))[0];
    if (!post) return { error: "Post no encontrado" };
    if (post.estado !== "aprobado") return { error: "Solo se publican posts APROBADOS. Apruébalo primero." };
    const { publicarEnRedes, redesDisponibles } = await import("./publicacion-redes");
    const texto = `${post.titulo ? post.titulo + "\n\n" : ""}${post.contenido}\n\n${post.hashtags || ""}`.trim();
    const { urlImagenPublica } = await import("./marketing-imagen");
    const imagenUrl = await urlImagenPublica(num(id));
    const resultado = await publicarEnRedes(texto, imagenUrl || undefined);
    if (resultado.modo === "manual") {
      // Sin credenciales: devolver el texto listo para copiar (no marcar publicado)
      return { modo: "manual", texto, mensaje: "Sin credenciales de redes configuradas: copia el texto y publícalo manualmente. Cuando lo hagas, márcalo como publicado.", redes: redesDisponibles() };
    }
    await db.execute(sql`UPDATE marketing_posts SET estado = 'publicado', publicadoEn = NOW(), resultadoPublicacion = ${JSON.stringify(resultado).slice(0, 600)} WHERE id = ${num(id)}`);
    return { ok: true, resultado };
  },
};
