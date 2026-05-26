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

// Usuarios permitidos - configurable via env vars
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "vidafarma2026";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@vidafarma.com";

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
    const { usuario, password } = req.body;

    if (usuario !== ADMIN_USER || password !== ADMIN_PASS) {
      res.status(401).json({ success: false, error: "Usuario o contraseña incorrectos" });
      return;
    }

    try {
      console.log("[Auth] Login attempt for:", usuario);
      console.log("[Auth] JWT_SECRET configured:", !!process.env.JWT_SECRET);
      const openId = `local-${crypto.createHash("md5").update(usuario).digest("hex")}`;

      await db.upsertUser({
        openId,
        name: "Administrador",
        email: ADMIN_EMAIL,
        loginMethod: "local",
        lastSignedIn: new Date(),
      });

      const sessionToken = await sdk.createSessionToken(openId, {
        name: "Administrador",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.json({ success: true });
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
