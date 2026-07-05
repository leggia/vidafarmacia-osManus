/**
 * Sistema de autenticación simple (reemplaza OAuth de Manus)
 * Login con usuario y contraseña local
 */
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";
import crypto from "crypto";

// Usuarios permitidos - configurable via env vars. Si falta la contraseña,
// NUNCA caer a un valor público conocido (quedaría expuesto en GitHub): se
// genera una aleatoria en el arranque y ese login queda deshabilitado hasta
// que se configure la variable real en Railway.
function passSegura(envVar: string, etiqueta: string): string {
  const v = process.env[envVar];
  if (v) return v;
  console.warn(`[Auth] ${envVar} no configurado — login de ${etiqueta} deshabilitado hasta que se configure en Railway.`);
  return crypto.randomBytes(24).toString("hex");
}

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = passSegura("ADMIN_PASS", "admin");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@vidafarma.com";
// Usuario de SOLO CONSULTA (ver precios y stock) — para contingencias (apagones, etc.)
const VIEWER_USER = process.env.VIEWER_USER || "consulta";
const VIEWER_PASS = passSegura("VIEWER_PASS", "consulta");

// Rate limiting simple en memoria para /api/auth/login (sin dependencias nuevas).
// Evita fuerza bruta: máximo 8 intentos fallidos cada 10 min por IP.
const INTENTOS_MAX = 8;
const VENTANA_MS = 10 * 60 * 1000;
const intentosPorIp = new Map<string, { intentos: number; desde: number }>();

function loginBloqueado(ip: string): boolean {
  const registro = intentosPorIp.get(ip);
  if (!registro) return false;
  if (Date.now() - registro.desde > VENTANA_MS) {
    intentosPorIp.delete(ip);
    return false;
  }
  return registro.intentos >= INTENTOS_MAX;
}

function registrarIntentoFallido(ip: string) {
  const registro = intentosPorIp.get(ip);
  if (!registro || Date.now() - registro.desde > VENTANA_MS) {
    intentosPorIp.set(ip, { intentos: 1, desde: Date.now() });
  } else {
    registro.intentos++;
  }
}

function limpiarIntentos(ip: string) {
  intentosPorIp.delete(ip);
}

export function registerOAuthRoutes(app: Express) {
  // ─── Página de login simple ───────────────────────────────────────────────
  app.get("/login", (_req: Request, res: Response) => {
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VidaFarma - Iniciar Sesión</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #1a3a5c 0%, #0d6efd 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: white;
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .logo {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo h1 { color: #1a3a5c; font-size: 28px; font-weight: 700; }
    .logo p { color: #666; font-size: 14px; margin-top: 4px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; font-size: 14px; font-weight: 600; color: #333; margin-bottom: 6px; }
    input {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid #e0e0e0;
      border-radius: 8px;
      font-size: 15px;
      transition: border-color 0.2s;
      outline: none;
    }
    input:focus { border-color: #0d6efd; }
    button {
      width: 100%;
      padding: 14px;
      background: #0d6efd;
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #0b5ed7; }
    .error {
      background: #fee2e2;
      color: #dc2626;
      padding: 12px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 20px;
      display: none;
    }
    .error.show { display: block; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <h1>💊 VidaFarma</h1>
      <p>Sistema de Gestión de Farmacia</p>
    </div>
    <div class="error" id="error"></div>
    <form id="loginForm">
      <div class="form-group">
        <label>Usuario</label>
        <input type="text" id="usuario" placeholder="Ingresa tu usuario" autofocus />
      </div>
      <div class="form-group">
        <label>Contraseña</label>
        <input type="password" id="password" placeholder="Ingresa tu contraseña" />
      </div>
      <button type="submit">Iniciar Sesión</button>
    </form>
    <div style="text-align:center;margin-top:16px;color:#999;font-size:13px">— o —</div>
    <a href="/api/oauth/google" style="display:flex;align-items:center;justify-content:center;gap:10px;margin-top:12px;padding:12px;border:2px solid #e0e0e0;border-radius:8px;text-decoration:none;color:#333;font-weight:600;font-size:15px;background:white">
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.6 39.6 16.3 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C41 35.3 44 30.1 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>
      Entrar con Google
    </a>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const usuario = document.getElementById('usuario').value;
      const password = document.getElementById('password').value;
      const errorEl = document.getElementById('error');

      try {
        const resp = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usuario, password })
        });
        const data = await resp.json();
        if (data.success) {
          window.location.href = '/';
        } else {
          errorEl.textContent = data.error || 'Usuario o contraseña incorrectos';
          errorEl.classList.add('show');
        }
      } catch {
        errorEl.textContent = 'Error de conexión. Intenta nuevamente.';
        errorEl.classList.add('show');
      }
    });
  </script>
</body>
</html>
    `);
  });

  // ─── API de login ─────────────────────────────────────────────────────────
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || "desconocida";
    if (loginBloqueado(ip)) {
      res.status(429).json({ success: false, error: "Demasiados intentos. Espera unos minutos e intenta de nuevo." });
      return;
    }

    const { usuario, password } = req.body;

    // Determinar qué usuario es y su rol
    let rol: "admin" | "viewer" | null = null;
    let nombre = "";
    let email = ADMIN_EMAIL;
    if (usuario === ADMIN_USER && password === ADMIN_PASS) {
      rol = "admin"; nombre = "Administrador"; email = ADMIN_EMAIL;
    } else if (usuario === VIEWER_USER && password === VIEWER_PASS) {
      rol = "viewer"; nombre = "Consulta"; email = "consulta@vidafarma.com";
    }

    if (!rol) {
      registrarIntentoFallido(ip);
      res.status(401).json({ success: false, error: "Usuario o contraseña incorrectos" });
      return;
    }
    limpiarIntentos(ip);

    try {
      console.log("[Auth] Login attempt for:", usuario, "rol:", rol);
      const openId = `local-${crypto.createHash("md5").update(usuario).digest("hex")}`;

      // Intentar guardar con rol; si el enum aún no acepta 'viewer' (migración pendiente),
      // reintentar sin el rol para no bloquear el acceso.
      try {
        await db.upsertUser({
          openId, name: nombre, email, loginMethod: "local", role: rol, lastSignedIn: new Date(),
        });
      } catch (roleErr) {
        console.warn("[Auth] upsert con rol falló, reintentando sin rol:", roleErr);
        await db.upsertUser({
          openId, name: nombre, email, loginMethod: "local", lastSignedIn: new Date(),
        });
      }

      const sessionToken = await sdk.createSessionToken(openId, {
        name: nombre,
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.json({ success: true, rol });
    } catch (error) {
      console.error("[Auth] Login failed", error);
      res.status(500).json({ success: false, error: "Error interno del servidor" });
    }
  });

  // ─── Callback OAuth legacy (redirige al login simple) ────────────────────
  app.get("/api/oauth/callback", (_req: Request, res: Response) => {
    res.redirect(302, "/login");
  });
}
