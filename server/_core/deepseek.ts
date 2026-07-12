/**
 * Integración con DeepSeek API (para el asistente VidaFarma).
 *
 * DeepSeek es compatible con el formato de OpenAI (mismo esquema de mensajes,
 * tools y tool_calls). Aprovecha CACHÉ DE CONTEXTO automático: si el prefijo
 * del prompt (system + tools) es idéntico entre llamadas, ese contenido se cobra
 * a tarifa de cache-hit (~98% más barato). Por eso, el system prompt y las
 * definiciones de herramientas deben ir SIEMPRE idénticos y al inicio.
 */
import { ENV } from "./env";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODELO = "deepseek-v4-flash"; // modelo actual (deepseek-chat se deprecia 24/07/2026)

export type DSMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: any[];
  tool_call_id?: string;
};

export type DSTool = {
  type: "function";
  function: { name: string; description: string; parameters: any };
};

export type DSParams = {
  messages: DSMessage[];
  tools?: DSTool[];
  toolChoice?: "auto" | "none" | "required";
  maxTokens?: number;
  temperature?: number;
};

export type DSResult = {
  choices: Array<{
    message: { role: string; content: string | null; tool_calls?: any[] };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
};

export function deepseekDisponible(): boolean {
  return !!ENV.deepseekApiKey;
}

export async function invokeDeepSeek(params: DSParams): Promise<DSResult> {
  if (!ENV.deepseekApiKey) {
    throw new Error("DEEPSEEK_API_KEY no está configurada");
  }

  const payload: Record<string, unknown> = {
    model: MODELO,
    messages: params.messages,
    max_tokens: params.maxTokens ?? 1024,
    temperature: params.temperature ?? 0,
    stream: false,
  };

  if (params.tools && params.tools.length > 0) {
    payload.tools = params.tools;
    payload.tool_choice = params.toolChoice ?? "auto";
  }

  const resp = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ENV.deepseekApiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`DeepSeek invoke failed: ${resp.status} ${resp.statusText} – ${errText}`);
  }

  const resultado = (await resp.json()) as DSResult;
  // REGISTRO PERSISTENTE del uso (regla del proyecto: todo dato queda en nuestra
  // BD): acumula por día llamadas, tokens de cache-hit/miss y salida — permite
  // ver el hit-rate real y el costo estimado del asistente en cualquier momento.
  registrarUsoLLM(resultado.usage).catch(() => { /* nunca bloquea la respuesta */ });
  return resultado;
}

let tablaUsoLista = false;
async function registrarUsoLLM(usage?: DSResult["usage"]) {
  if (!usage) return;
  try {
    const { getDb } = await import("../db");
    const { sql } = await import("drizzle-orm");
    const db = await getDb();
    if (!db) return;
    if (!tablaUsoLista) {
      try {
        await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS llm_uso_diario (
          fecha VARCHAR(10) PRIMARY KEY,
          llamadas INT NOT NULL DEFAULT 0,
          hitTokens BIGINT NOT NULL DEFAULT 0,
          missTokens BIGINT NOT NULL DEFAULT 0,
          outTokens BIGINT NOT NULL DEFAULT 0
        )`));
      } catch { /* existe */ }
      tablaUsoLista = true;
    }
    const hoy = new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10); // día Bolivia (UTC-4)
    const hit = usage.prompt_cache_hit_tokens ?? 0;
    const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens || 0) - hit);
    const out = usage.completion_tokens || 0;
    await db.execute(sql`
      INSERT INTO llm_uso_diario (fecha, llamadas, hitTokens, missTokens, outTokens)
      VALUES (${hoy}, 1, ${hit}, ${miss}, ${out})
      ON DUPLICATE KEY UPDATE llamadas = llamadas + 1, hitTokens = hitTokens + ${hit}, missTokens = missTokens + ${miss}, outTokens = outTokens + ${out}
    `);
  } catch { /* medición best-effort */ }
}
