import { useState, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, Bot, User, Loader2, Sparkles } from "lucide-react";

type Mensaje = { rol: "user" | "assistant"; texto: string; herramienta?: string };

const SUGERENCIAS = [
  "¿Cuánto vendí hoy?",
  "¿Cuál es mi producto más vendido este mes?",
  "¿Cuánto gané este mes?",
  "¿Cuánto le compré a Bago este mes?",
  "¿Cuánto cuesta el paracetamol?",
];

export default function Asistente() {
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [pregunta, setPregunta] = useState("");
  const preguntar = trpc.asistente.preguntar.useMutation();
  const finRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mensajes, preguntar.isPending]);

  const enviar = async (texto?: string) => {
    const q = (texto ?? pregunta).trim();
    if (!q || preguntar.isPending) return;
    setPregunta("");
    const nuevoHistorial = [...mensajes, { rol: "user" as const, texto: q }];
    setMensajes(nuevoHistorial);
    try {
      const res = await preguntar.mutateAsync({
        pregunta: q,
        historial: mensajes.slice(-8).map(m => ({ rol: m.rol, texto: m.texto })),
      });
      setMensajes(prev => [...prev, { rol: "assistant", texto: res.respuesta, herramienta: res.usoHerramienta || undefined }]);
    } catch (e: any) {
      setMensajes(prev => [...prev, { rol: "assistant", texto: "Hubo un problema al procesar tu pregunta. Intenta de nuevo." }]);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] max-w-3xl mx-auto">
      {/* Encabezado */}
      <div className="flex items-center gap-2 mb-3 px-1">
        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
          <Sparkles className="h-5 w-5 text-white" />
        </div>
        <div className="flex-1">
          <h1 className="text-lg font-bold leading-tight">Asistente VidaFarma</h1>
          <p className="text-[11px] text-muted-foreground">Pregúntame sobre ventas, compras, productos y más</p>
        </div>
      </div>

      {/* Conversación */}
      <div className="flex-1 overflow-auto rounded-xl border bg-card p-4 space-y-4">
        {mensajes.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center gap-4 py-8">
            <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
              <Bot className="h-7 w-7 text-white" />
            </div>
            <div>
              <p className="font-semibold">¿En qué te ayudo hoy?</p>
              <p className="text-xs text-muted-foreground mt-1">Escribe una pregunta o prueba una de estas:</p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center max-w-md">
              {SUGERENCIAS.map((s, i) => (
                <button key={i} onClick={() => enviar(s)}
                  className="text-xs px-3 py-1.5 rounded-full border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950 transition">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {mensajes.map((m, i) => (
          <div key={i} className={`flex gap-2.5 ${m.rol === "user" ? "flex-row-reverse" : ""}`}>
            <div className={`h-8 w-8 rounded-lg shrink-0 flex items-center justify-center ${m.rol === "user" ? "bg-blue-600" : "bg-gradient-to-br from-emerald-500 to-teal-600"}`}>
              {m.rol === "user" ? <User className="h-4 w-4 text-white" /> : <Bot className="h-4 w-4 text-white" />}
            </div>
            <div className={`max-w-[80%] ${m.rol === "user" ? "items-end" : "items-start"} flex flex-col`}>
              <div className={`rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap ${m.rol === "user" ? "bg-blue-600 text-white rounded-tr-sm" : "bg-muted rounded-tl-sm"}`}>
                {m.texto}
              </div>
              {m.herramienta && (
                <span className="text-[9px] text-muted-foreground mt-1 px-1">consultó: {m.herramienta}</span>
              )}
            </div>
          </div>
        ))}

        {preguntar.isPending && (
          <div className="flex gap-2.5">
            <div className="h-8 w-8 rounded-lg shrink-0 bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
              <Bot className="h-4 w-4 text-white" />
            </div>
            <div className="bg-muted rounded-2xl rounded-tl-sm px-3.5 py-2.5 flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">Consultando...</span>
            </div>
          </div>
        )}
        <div ref={finRef} />
      </div>

      {/* Caja de texto */}
      <div className="flex gap-2 mt-3">
        <Input
          value={pregunta}
          onChange={(e) => setPregunta(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") enviar(); }}
          placeholder="Escribe tu pregunta..."
          className="flex-1"
          disabled={preguntar.isPending}
        />
        <Button onClick={() => enviar()} disabled={preguntar.isPending || !pregunta.trim()} size="icon" className="shrink-0">
          <Send className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground text-center mt-2">
        Las acciones (precios, gastos) siempre piden tu confirmación y quedan auditadas. Verifica cifras importantes en sus reportes.
      </p>
    </div>
  );
}
