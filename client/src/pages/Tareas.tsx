import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { CalendarClock, AlertTriangle, CheckCircle2, Clock, Landmark, Receipt, ChevronDown, ChevronUp, RotateCcw , Users } from "lucide-react";

const bs = (n: number) => `Bs ${n.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * OBLIGACIONES DEL MES — centro empresarial de pagos comprometidos. Cada
 * obligación (cuota de crédito, gasto fijo) es una FICHA accionable con su fecha
 * límite: la fecha de pago del banco, o el día 10 por defecto (regla: cerrar el
 * mes anterior sin deudas). La ficha pasa a ALERTA roja desde la fecha indicada.
 */
export default function Tareas() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.obligaciones.delMes.useQuery({});
  const pagar = trpc.obligaciones.pagar.useMutation({
    onSuccess: (r) => { toast.success(r.mensaje); utils.obligaciones.delMes.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const [pagando, setPagando] = useState<string | null>(null);
  const [montoEditado, setMontoEditado] = useState<string>("");
  const [verSync, setVerSync] = useState(false);

  // Cola técnica de sincronización (la función anterior de esta ventana, ahora colapsada al final)
  const { data: tasks, refetch } = trpc.taskQueue.list.useQuery(undefined, { enabled: verSync });
  const retryTask = trpc.taskQueue.retry.useMutation({
    onSuccess: () => { toast.success("Tarea reencolada"); refetch(); },
    onError: (err) => toast.error(err.message),
  });

  const confirmarPago = (o: any) => {
    const monto = montoEditado ? parseFloat(montoEditado) : o.monto;
    if (!monto || monto <= 0) { toast.error("Monto inválido"); return; }
    pagar.mutate({ tipo: o.tipo, refId: o.refId, anioMes: data!.anioMes, monto });
    setPagando(null); setMontoEditado("");
  };

  const r = data?.resumen;

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">
      <div className="border-b pb-4">
        <div className="flex items-center gap-2">
          <CalendarClock className="w-6 h-6 text-emerald-600" />
          <h1 className="text-2xl font-black tracking-tight">Obligaciones del Mes</h1>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Pagos comprometidos del negocio: cuotas de bancos y gastos fijos. Cada ficha se vuelve
          <span className="font-bold text-red-600"> alerta</span> desde su fecha de pago (o desde el día 10 si no tiene fecha).
        </p>
      </div>

      {isLoading && <p className="text-center text-sm text-muted-foreground py-10">Cargando obligaciones…</p>}

      {/* Alerta principal */}
      {r && r.enAlerta > 0 && (
        <div className="p-3 rounded-2xl bg-red-50 dark:bg-red-950/20 border border-red-300 flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-black text-red-700">{r.enAlerta} pago(s) requieren tu atención — {bs(r.montoEnAlerta)}</p>
            <p className="text-xs text-red-600">Ya pasó (o es hoy) su fecha límite y aún no están registrados como pagados.</p>
          </div>
        </div>
      )}

      {/* Resumen del mes */}
      {r && (
        <div className="grid grid-cols-3 gap-2">
          <div className="p-3 rounded-2xl bg-white dark:bg-card border text-center">
            <p className="text-[10px] text-muted-foreground font-bold uppercase">Total del mes</p>
            <p className="text-base font-black">{bs(r.total)}</p>
          </div>
          <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-100 text-center">
            <p className="text-[10px] text-emerald-700 font-bold uppercase">Pagado</p>
            <p className="text-base font-black text-emerald-700">{bs(r.pagado)}</p>
          </div>
          <div className={`p-3 rounded-2xl border text-center ${r.pendiente > 0 ? "bg-amber-50 dark:bg-amber-950/20 border-amber-100" : "bg-white dark:bg-card"}`}>
            <p className="text-[10px] text-amber-700 font-bold uppercase">Pendiente</p>
            <p className="text-base font-black text-amber-700">{bs(r.pendiente)}</p>
          </div>
        </div>
      )}

      {/* Fichas de obligaciones */}
      {(data?.obligaciones?.length || 0) === 0 && !isLoading && (
        <div className="text-center py-12 border border-dashed rounded-2xl">
          <CheckCircle2 className="w-10 h-10 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm font-medium">Sin obligaciones registradas</p>
          <p className="text-xs text-muted-foreground">Registra tus créditos en /créditos y tus gastos fijos en /gastos — aparecerán aquí automáticamente como fichas con su fecha de pago.</p>
        </div>
      )}
      <div className="space-y-2">
        {(data?.obligaciones || []).map((o: any) => (
          <div key={o.clave} className={`rounded-2xl border p-3 ${
            o.estado === "alerta" ? "border-red-300 bg-red-50/50 dark:bg-red-950/10"
            : o.estado === "pagado" ? "border-emerald-200 bg-emerald-50/30 dark:bg-emerald-950/10 opacity-75"
            : "bg-white dark:bg-card"}`}>
            {/* Fila 1: icono + NOMBRE COMPLETO (hasta 2 líneas, todo el ancho) */}
            <div className="flex items-start gap-3 mb-1.5">
              <div className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 ${o.tipo === "credito" ? "bg-sky-100 text-sky-700" : o.tipo === "sueldo" ? "bg-violet-100 text-violet-700" : "bg-amber-100 text-amber-700"}`}>
                {o.tipo === "credito" ? <Landmark className="w-4 h-4" /> : o.tipo === "sueldo" ? <Users className="w-4 h-4" /> : <Receipt className="w-4 h-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-black leading-snug line-clamp-2">{o.nombre}</p>
                <p className="text-[11px] text-muted-foreground leading-snug line-clamp-2">{o.detalle} · vence el {o.diaLimite} de cada mes</p>
              </div>
            </div>
            {/* Fila 2: monto + estado */}
            <div className="flex items-center justify-between pl-12">
              <p className="text-sm font-black">{bs(o.monto)}</p>
              <div className="text-right shrink-0">
                {o.estado === "pagado" ? (
                  <p className="text-[10px] font-bold text-emerald-700 flex items-center gap-1 justify-end"><CheckCircle2 className="w-3 h-3" /> Pagado {o.fechaPago ? `el ${String(o.fechaPago).slice(8, 10)}` : ""}</p>
                ) : o.estado === "alerta" ? (
                  <p className="text-[10px] font-bold text-red-600 flex items-center gap-1 justify-end"><AlertTriangle className="w-3 h-3" /> {o.diasParaVencer < 0 ? `Venció hace ${-o.diasParaVencer} día(s)` : "Vence HOY"}</p>
                ) : (
                  <p className="text-[10px] font-bold text-muted-foreground flex items-center gap-1 justify-end"><Clock className="w-3 h-3" /> En {o.diasParaVencer} día(s)</p>
                )}
              </div>
            </div>
            {o.estado !== "pagado" && (
              pagando === o.clave ? (
                <div className="flex items-center gap-2 mt-2 pt-2 border-t">
                  <input type="number" inputMode="decimal" value={montoEditado} placeholder={String(o.monto)}
                    onChange={(e) => setMontoEditado(e.target.value)}
                    className="w-28 h-9 px-2 text-center text-sm font-bold border rounded-lg bg-white dark:bg-background" />
                  <button onClick={() => confirmarPago(o)} disabled={pagar.isPending}
                    className="flex-1 h-9 rounded-xl bg-emerald-600 text-white text-xs font-black disabled:opacity-50">Confirmar pago de hoy</button>
                  <button onClick={() => { setPagando(null); setMontoEditado(""); }} className="h-9 px-3 rounded-xl bg-muted text-xs font-bold">✕</button>
                </div>
              ) : (
                <button onClick={() => { setPagando(o.clave); setMontoEditado(""); }}
                  className={`w-full h-9 mt-2 rounded-xl text-xs font-black ${o.estado === "alerta" ? "bg-red-600 text-white" : "bg-muted"}`}>
                  Registrar pago
                </button>
              )
            )}
          </div>
        ))}
      </div>

      {/* Cola técnica de sincronización (función anterior de esta ventana) */}
      <div className="pt-4 border-t">
        <button onClick={() => setVerSync(!verSync)} className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground">
          {verSync ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          Cola de sincronización con inventarios365 {verSync ? "" : "(técnico)"}
        </button>
        {verSync && (
          <div className="mt-3 space-y-2">
            {(tasks?.length || 0) === 0 ? (
              <p className="text-xs text-muted-foreground">Sin tareas de sincronización pendientes. ✓</p>
            ) : tasks!.map((task: any) => (
              <div key={task.id} className="flex items-center justify-between p-2.5 rounded-xl border text-xs">
                <span className="truncate">{task.type} · {task.status} · intentos: {task.attempts}</span>
                <button onClick={() => retryTask.mutate({ id: task.id })} className="shrink-0 flex items-center gap-1 font-bold"><RotateCcw className="w-3 h-3" /> Reintentar</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
