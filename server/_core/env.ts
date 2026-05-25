/**
 * Variables de entorno — VidaFarma OS
 * Configuración centralizada y tipada.
 */

function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback ?? "";
  if (!value && process.env.NODE_ENV === "production") {
    console.warn(`[ENV] Warning: ${key} no está configurado`);
  }
  return value;
}

export const ENV = {
  // App
  appId: requireEnv("VITE_APP_ID", "vidafarma"),
  isProduction: process.env.NODE_ENV === "production",
  port: parseInt(process.env.PORT ?? "3000", 10),

  // Auth
  cookieSecret: requireEnv("JWT_SECRET", "dev-secret-change-in-production"),
  adminUser: requireEnv("ADMIN_USER", "admin"),
  adminPass: requireEnv("ADMIN_PASS", "vidafarma2026"),
  adminEmail: requireEnv("ADMIN_EMAIL", "admin@vidafarma.com"),

  // Database
  databaseUrl: requireEnv("DATABASE_URL"),

  // IA — Groq API
  groqApiKey: requireEnv("BUILT_IN_FORGE_API_KEY"),

  // Session
  sessionSecret: requireEnv("SESSION_SECRET", "dev-session-secret"),
};
