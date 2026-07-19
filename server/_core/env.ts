/**
 * Variables de entorno — VidaFarma OS
 * Configuración centralizada y tipada.
 */
import crypto from "crypto";

function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback ?? "";
  if (!value && process.env.NODE_ENV === "production") {
    console.warn(`[ENV] Warning: ${key} no está configurado`);
  }
  return value;
}

// Para secretos: si falta la variable, NUNCA caer a un valor público conocido
// (quedaría en el código fuente en GitHub). Se genera uno aleatorio en el
// arranque — el servidor sigue funcionando, solo invalida sesiones existentes
// si el proceso se reinicia sin la variable configurada.
function requireSecret(key: string): string {
  const value = process.env[key];
  if (value) return value;
  console.warn(`[ENV] ${key} no configurado — usando secreto aleatorio temporal (se pierde al reiniciar). Configúralo en Railway.`);
  return crypto.randomBytes(32).toString("hex");
}

export const ENV = {
  // App
  appId: requireEnv("VITE_APP_ID", "vidafarma"),
  isProduction: process.env.NODE_ENV === "production",
  port: parseInt(process.env.PORT ?? "3000", 10),

  // Auth
  cookieSecret: requireSecret("JWT_SECRET"),

  // Database
  databaseUrl: requireEnv("DATABASE_URL"),

  // IA — Groq API
  groqApiKey: requireEnv("BUILT_IN_FORGE_API_KEY"),

  // IA — DeepSeek API (para el asistente)
  deepseekApiKey: requireEnv("DEEPSEEK_API_KEY"),

  // IA — Servicio de generación de imágenes (marketing). Opcionales: si no
  // están configuradas, generateImage lanza un error claro y controlado.
  forgeApiUrl: process.env.FORGE_API_URL ?? "",
  forgeApiKey: process.env.FORGE_API_KEY ?? "",
};
