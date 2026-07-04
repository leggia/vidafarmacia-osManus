import { useState, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Send, Bot, User, Loader2, Sparkles, Mic, MicOff, Volume2, VolumeX, X } from "lucide-react";

type Mensaje = { rol: "user" | "assistant"; texto: string; herramienta?: string };

// Quita marcado y símbolos que la voz no debe leer literalmente.
function limpiarParaVoz(texto: string): string {
  return texto.replace(/\*\*/g, "").replace(/[_#`]/g, "").replace(/\n+/g, ". ").trim();
}

const TIPOS_AUDIO = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
function elegirMimeType(): string {
  for (const t of TIPOS_AUDIO) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "audio/webm";
}

function blobABase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

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
  const transcribir = trpc.asistente.transcribir.useMutation();
  const finRef = useRef<HTMLDivElement>(null);

  // ─── Voz: escuchar (Groq Whisper) y hablar (Text-to-Speech del navegador) ───
  const soportaVoz = typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
  const [escuchando, setEscuchando] = useState(false);
  const [transcribiendo, setTranscribiendo] = useState(false);
  const [hablando, setHablando] = useState(false);
  const [vozActiva, setVozActiva] = useState(() => typeof window !== "undefined" && localStorage.getItem("asistente_voz") !== "0");
  const [modoConversacion, setModoConversacionState] = useState(false);
  const modoConversacionRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const setModoConversacion = (v: boolean) => { modoConversacionRef.current = v; setModoConversacionState(v); };

  useEffect(() => {
    localStorage.setItem("asistente_voz", vozActiva ? "1" : "0");
    if (!vozActiva) window.speechSynthesis?.cancel();
  }, [vozActiva]);

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [mensajes, preguntar.isPending, transcribiendo]);

  const hablar = (texto: string, alTerminar?: () => void) => {
    if (!vozActiva || !("speechSynthesis" in window)) { alTerminar?.(); return; }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(limpiarParaVoz(texto));
    utter.lang = "es-ES";
    utter.onstart = () => setHablando(true);
    utter.onend = () => { setHablando(false); alTerminar?.(); };
    utter.onerror = () => { setHablando(false); alTerminar?.(); };
    window.speechSynthesis.speak(utter);
  };

  const enviar = async (texto?: string, porVoz = false) => {
    const q = (texto ?? pregunta).trim();
    if (!q || preguntar.isPending) return;
    if (!porVoz) setModoConversacion(false); // escribir a mano sale del modo conversación
    setPregunta("");
    const nuevoHistorial = [...mensajes, { rol: "user" as const, texto: q }];
    setMensajes(nuevoHistorial);
    try {
      const res = await preguntar.mutateAsync({
        pregunta: q,
        modoVoz: porVoz,
        historial: mensajes.slice(-8).map(m => ({ rol: m.rol, texto: m.texto })),
      });
      setMensajes(prev => [...prev, { rol: "assistant", texto: res.respuesta, herramienta: res.usoHerramienta || undefined }]);
      hablar(res.respuesta, () => {
        if (porVoz && modoConversacionRef.current) iniciarEscucha();
      });
    } catch (e: any) {
      setMensajes(prev => [...prev, { rol: "assistant", texto: "Hubo un problema al procesar tu pregunta. Intenta de nuevo." }]);
    }
  };

  const iniciarEscucha = async () => {
    if (!soportaVoz || escuchando || transcribiendo || preguntar.isPending) return;
    window.speechSynthesis?.cancel();
    setModoConversacion(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = elegirMimeType();
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setEscuchando(false);
        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size < 500) return; // grabación vacía/demasiado corta
        setTranscribiendo(true);
        try {
          const audioBase64 = await blobABase64(blob);
          const r = await transcribir.mutateAsync({ audioBase64, mimeType });
          if (r.texto) {
            enviar(r.texto, true);
          } else {
            toast.error(r.error || "No se entendió el audio.");
          }
        } catch (e: any) {
          toast.error(e?.message || "No se pudo transcribir el audio.");
        } finally {
          setTranscribiendo(false);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setEscuchando(true);
    } catch (e: any) {
      setModoConversacion(false);
      toast.error("No se pudo acceder al micrófono. Revisa los permisos del navegador.");
    }
  };

  const detenerEscucha = () => {
    mediaRecorderRef.current?.stop();
  };

  const salirModoConversacion = () => {
    setModoConversacion(false);
    window.speechSynthesis?.cancel();
    if (escuchando) mediaRecorderRef.current?.stop();
    setHablando(false);
  };

  const estadoVoz = escuchando ? "escuchando" : transcribiendo ? "transcribiendo" : hablando ? "hablando" : preguntar.isPending ? "pensando" : null;

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
        {modoConversacion && (
          <button
            onClick={salirModoConversacion}
            className="inline-flex items-center gap-1.5 text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 px-2.5 py-1 rounded-full border border-emerald-200 dark:border-emerald-900"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Modo conversación <X className="h-3 w-3 ml-0.5" />
          </button>
        )}
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
              <p className="text-xs text-muted-foreground mt-1">Escribe una pregunta, o toca el micrófono para hablar:</p>
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

        {(preguntar.isPending || transcribiendo) && (
          <div className="flex gap-2.5">
            <div className="h-8 w-8 rounded-lg shrink-0 bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
              <Bot className="h-4 w-4 text-white" />
            </div>
            <div className="bg-muted rounded-2xl rounded-tl-sm px-3.5 py-2.5 flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{transcribiendo ? "Entendiendo tu voz..." : "Consultando..."}</span>
            </div>
          </div>
        )}
        <div ref={finRef} />
      </div>

      {/* Indicador de estado de voz */}
      {estadoVoz && (
        <div className="flex items-center justify-center gap-2 text-xs mt-2 mb-1">
          {estadoVoz === "escuchando" && <><span className="h-2 w-2 rounded-full bg-red-600 animate-pulse" /><span className="text-red-600">Escuchando... toca el micrófono para enviar</span></>}
          {estadoVoz === "transcribiendo" && <span className="text-muted-foreground">Entendiendo tu voz...</span>}
          {estadoVoz === "hablando" && <span className="text-emerald-600">🔊 Respondiendo...</span>}
          {estadoVoz === "pensando" && !transcribiendo && <span className="text-muted-foreground">Pensando...</span>}
        </div>
      )}

      {/* Caja de texto */}
      <div className="flex gap-2 mt-3">
        <Input
          value={pregunta}
          onChange={(e) => setPregunta(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") enviar(); }}
          placeholder={escuchando ? "Escuchando..." : "Escribe tu pregunta..."}
          className="flex-1"
          disabled={preguntar.isPending || escuchando || transcribiendo}
        />
        {soportaVoz && (
          <Button
            type="button"
            onClick={escuchando ? detenerEscucha : iniciarEscucha}
            disabled={preguntar.isPending || transcribiendo}
            size="icon"
            variant={escuchando ? "destructive" : "outline"}
            className="shrink-0"
            title={escuchando ? "Detener y enviar" : "Hablar"}
          >
            {escuchando ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>
        )}
        <Button
          type="button"
          onClick={() => setVozActiva(v => !v)}
          size="icon"
          variant="outline"
          className="shrink-0"
          title={vozActiva ? "Silenciar respuestas" : "Activar voz en respuestas"}
        >
          {vozActiva ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
        </Button>
        <Button onClick={() => enviar()} disabled={preguntar.isPending || !pregunta.trim()} size="icon" className="shrink-0">
          <Send className="h-4 w-4" />
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground text-center mt-2">
        {soportaVoz ? "Toca el micrófono para hablar, vuelve a tocarlo para enviar. Sigue la conversación por voz automáticamente. " : ""}
        Las acciones (precios, gastos) siempre piden tu confirmación y quedan auditadas.
      </p>
    </div>
  );
}
