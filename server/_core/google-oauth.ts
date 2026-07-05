// Login con Google para VidaFarma, con LISTA BLANCA de correos autorizados.
// Flujo: /api/oauth/google → Google → /api/oauth/google/callback → verificar que
// el correo esté autorizado (tabla correos_autorizados) → sesión con su rol.
// Quien no esté en la lista, NO entra aunque tenga cuenta de Google.
import type { Express, Request, Response } from "express";
import crypto from "crypto";
import * as db from "../db";
import { sdk } from "./sdk";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./cookies";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

const clientId = () => process.env.GOOGLE_CLIENT_ID || "";
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET || "";
export const googleDisponible = () => !!(clientId() && clientSecret());

// ─── Tabla de correos autorizados (lista blanca) ───
let tablaLista = false;
export async function asegurarTablaCorreos() {
  if (tablaLista) return;
  const { getDb } = await import("../db");
  const d = await getDb();
  if (!d) return;
  const { sql } = await import("drizzle-orm");
  try {
    await d.execute(sql.raw(`CREATE TABLE IF NOT EXISTS correos_autorizados (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(320) NOT NULL UNIQUE,
      rol VARCHAR(20) NOT NULL DEFAULT 'viewer',
      activo INT NOT NULL DEFAULT 1,
      creadoEn DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`));
  } catch { /* ya existe */ }
  // Sembrar el correo admin desde variable de entorno (primera vez)
  const adminEmail = (process.env.GOOGLE_ADMIN_EMAIL || "").trim().toLowerCase();
  if (adminEmail) {
    try {
      await d.execute(sql`
        INSERT INTO correos_autorizados (email, rol) VALUES (${adminEmail}, 'admin')
        ON DUPLICATE KEY UPDATE rol = 'admin', activo = 1
      `);
    } catch { /* ignorar */ }
  }
  tablaLista = true;
}

export async function rolDeCorreo(email: string): Promise<string | null> {
  const { getDb } = await import("../db");
  const d = await getDb();
  if (!d) return null;
  const { sql } = await import("drizzle-orm");
  await asegurarTablaCorreos();
  const r: any = await d.execute(sql`
    SELECT rol FROM correos_autorizados WHERE email = ${email.trim().toLowerCase()} AND activo = 1 LIMIT 1
  `);
  const filas = Array.isArray(r) ? r[0] : r?.rows ?? r;
  const fila = Array.isArray(filas) ? filas[0] : null;
  return fila?.rol || null;
}

// ─── Rutas ───
export function registerGoogleOAuth(app: Express) {
  // Paso 1: redirigir a Google
  app.get("/api/oauth/google", (req: Request, res: Response) => {
    if (!googleDisponible()) {
      res.status(503).send("Login con Google no configurado (faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
      return;
    }
    const state = crypto.randomBytes(16).toString("hex");
    const cookieOptions = getSessionCookieOptions(req);
    res.cookie("g_oauth_state", state, { ...cookieOptions, maxAge: 10 * 60 * 1000 });
    const redirectUri = `${req.protocol}://${req.get("host")}/api/oauth/google/callback`;
    const url = `${GOOGLE_AUTH_URL}?${new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    }).toString()}`;
    res.redirect(url);
  });

  // Paso 2: callback de Google
  app.get("/api/oauth/google/callback", async (req: Request, res: Response) => {
    try {
      const { code, state } = req.query as { code?: string; state?: string };
      const stateCookie = req.cookies?.g_oauth_state;
      if (!code || !state || !stateCookie || state !== stateCookie) {
        res.status(400).send("Solicitud inválida (state). Vuelve a intentar desde /login.");
        return;
      }
      res.clearCookie("g_oauth_state");
      const redirectUri = `${req.protocol}://${req.get("host")}/api/oauth/google/callback`;

      // Intercambiar el código por tokens
      const tokenResp = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId(),
          client_secret: clientSecret(),
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (!tokenResp.ok) {
        console.error("[GoogleOAuth] token exchange falló:", await tokenResp.text());
        res.status(401).send("No se pudo validar con Google. Intenta de nuevo.");
        return;
      }
      const tokens: any = await tokenResp.json();

      // Obtener el perfil (email verificado)
      const uiResp = await fetch(GOOGLE_USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!uiResp.ok) {
        res.status(401).send("No se pudo obtener el perfil de Google.");
        return;
      }
      const perfil: any = await uiResp.json();
      const email = String(perfil.email || "").trim().toLowerCase();
      const emailVerificado = perfil.email_verified === true || perfil.email_verified === "true";
      if (!email || !emailVerificado) {
        res.status(401).send("Tu cuenta de Google no tiene un correo verificado.");
        return;
      }

      // LISTA BLANCA: solo correos autorizados por el administrador
      const rol = await rolDeCorreo(email);
      if (!rol) {
        console.warn(`[GoogleOAuth] Correo NO autorizado intentó entrar: ${email}`);
        res.status(403).send(`
          <html><body style="font-family:sans-serif;text-align:center;padding:40px">
          <h2>Acceso no autorizado</h2>
          <p>El correo <b>${email.replace(/</g, "&lt;")}</b> no está autorizado en VidaFarma.</p>
          <p>Pide al administrador que autorice tu correo y vuelve a intentar.</p>
          <a href="/login">Volver</a></body></html>`);
        return;
      }

      // Crear/actualizar el usuario y la sesión (mismo mecanismo que el login local)
      const openId = `google-${perfil.sub}`;
      try {
        await db.upsertUser({
          openId, name: perfil.name || email, email,
          loginMethod: "google", role: rol as any, lastSignedIn: new Date(),
        });
      } catch (e) {
        console.warn("[GoogleOAuth] upsert con rol falló, reintentando sin rol:", e);
        await db.upsertUser({ openId, name: perfil.name || email, email, loginMethod: "google", lastSignedIn: new Date() });
      }
      const sessionToken = await sdk.createSessionToken(openId, { name: perfil.name || email });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      console.log(`[GoogleOAuth] Login OK: ${email} (rol ${rol})`);
      res.redirect("/");
    } catch (e: any) {
      console.error("[GoogleOAuth] error en callback:", e?.message);
      res.status(500).send("Error interno en el login con Google. Intenta de nuevo.");
    }
  });
}

// ─── Gestión de la lista blanca (para las acciones del asistente) ───
export const correosAutorizados = {
  async listar() {
    const { getDb } = await import("../db");
    const d = await getDb();
    if (!d) return [];
    const { sql } = await import("drizzle-orm");
    await asegurarTablaCorreos();
    const r: any = await d.execute(sql.raw(
      `SELECT email, rol, activo, creadoEn FROM correos_autorizados ORDER BY creadoEn DESC LIMIT 50`
    ));
    const filas = Array.isArray(r) ? r[0] : r?.rows ?? r;
    return Array.isArray(filas) ? filas : [];
  },
  async autorizar(email: string, rol: string) {
    const { getDb } = await import("../db");
    const d = await getDb();
    if (!d) throw new Error("Sin BD");
    const { sql } = await import("drizzle-orm");
    await asegurarTablaCorreos();
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error("Correo inválido");
    const r = rol === "admin" ? "admin" : "viewer";
    await d.execute(sql`
      INSERT INTO correos_autorizados (email, rol, activo) VALUES (${e}, ${r}, 1)
      ON DUPLICATE KEY UPDATE rol = ${r}, activo = 1
    `);
    return `Correo ${e} autorizado como ${r}.`;
  },
  async revocar(email: string) {
    const { getDb } = await import("../db");
    const d = await getDb();
    if (!d) throw new Error("Sin BD");
    const { sql } = await import("drizzle-orm");
    await asegurarTablaCorreos();
    const e = email.trim().toLowerCase();
    await d.execute(sql`UPDATE correos_autorizados SET activo = 0 WHERE email = ${e}`);
    return `Acceso de ${e} revocado.`;
  },
};
